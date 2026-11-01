import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  decidePoolerRetry,
  handlePoolerTurnFailed,
  maximumWaitMs,
  RETRY_REASON,
  RETRY_SETTINGS,
  type PoolerRetryDeps,
} from "./pooler-retry.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function failure(overrides: Parameters<typeof makeTurnFailedEvent>[0] = {}) {
  return makeTurnFailedEvent({
    threadId: "thr_one",
    requestId: "creq_one",
    attemptNumber: 1,
    errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
    ...overrides,
  });
}

function deps(overrides: Partial<PoolerRetryDeps> = {}) {
  const logs: string[] = [];
  const base: PoolerRetryDeps = {
    now: () => NOW,
    random: () => 0.5,
    maxWaitMs: () => 6 * HOUR,
    providerOf: vi.fn(async () => "claude-code"),
    routes: vi.fn(async () => true),
    turnModel: vi.fn(async () => "claude-opus-5-5"),
    nextEligibleAt: vi.fn(async () => NOW + HOUR),
    sessionRetryAt: vi.fn(async () => null),
    retry: vi.fn(async () => ({ ok: true })),
    log: (message) => logs.push(message),
  };
  return { deps: { ...base, ...overrides }, logs };
}

describe("decidePoolerRetry", () => {
  it("retries 15 to 45 seconds after the next account frees up", () => {
    for (const [random, offset] of [
      [0, 15_000],
      [0.5, 30_000],
      [0.999_999, 44_999],
    ] as const) {
      expect(
        decidePoolerRetry({ eligibleAt: NOW + HOUR, maxWaitMs: 6 * HOUR, now: NOW, random }),
      ).toEqual({ kind: "retry", eligibleAt: NOW + HOUR, sendAt: NOW + HOUR + offset });
    }
  });

  it("waits 30 seconds first when an account can already serve", () => {
    expect(
      decidePoolerRetry({ eligibleAt: NOW - HOUR, maxWaitMs: 6 * HOUR, now: NOW, random: 0 }),
    ).toEqual({ kind: "retry", eligibleAt: NOW + 30_000, sendAt: NOW + 45_000 });
  });

  it("declines when no reset is known or the wait exceeds the maximum", () => {
    expect(decidePoolerRetry({ eligibleAt: null, maxWaitMs: 6 * HOUR, now: NOW, random: 0 }).kind).toBe(
      "decline",
    );
    expect(
      decidePoolerRetry({ eligibleAt: NOW + 6 * HOUR + 1, maxWaitMs: 6 * HOUR, now: NOW, random: 0 }).kind,
    ).toBe("decline");
    expect(
      decidePoolerRetry({ eligibleAt: NOW + 6 * HOUR, maxWaitMs: 6 * HOUR, now: NOW, random: 0 }).kind,
    ).toBe("retry");
    expect(
      decidePoolerRetry({
        eligibleAt: NOW + 7 * 24 * HOUR,
        maxWaitMs: Number.POSITIVE_INFINITY,
        now: NOW,
        random: 0,
      }).kind,
    ).toBe("retry");
  });
});

describe("maximum automatic wait setting", () => {
  it("defaults to 6 hours, like BB's provider-retry", () => {
    expect(RETRY_SETTINGS.autoRetryMaximumWait.default).toBe("6 hours");
    expect(maximumWaitMs(RETRY_SETTINGS.autoRetryMaximumWait.default)).toBe(6 * HOUR);
    expect(RETRY_SETTINGS.autoRetryMaximumWait.options).toEqual([
      "Off",
      "1 hour",
      "6 hours",
      "24 hours",
      "No limit",
    ]);
  });

  it("maps each choice, and an unknown one to the default", () => {
    expect(maximumWaitMs("Off")).toBe(0);
    expect(maximumWaitMs("24 hours")).toBe(24 * HOUR);
    expect(maximumWaitMs("No limit")).toBe(Number.POSITIVE_INFINITY);
    expect(maximumWaitMs("3 days")).toBe(6 * HOUR);
    expect(maximumWaitMs("toString")).toBe(6 * HOUR);
  });
});

describe("handlePoolerTurnFailed", () => {
  it("schedules one retry of the failed request when the next account frees up", async () => {
    const { deps: d, logs } = deps();
    await handlePoolerTurnFailed(d, failure());
    expect(d.nextEligibleAt).toHaveBeenCalledWith("claude", "opus");
    expect(d.turnModel).toHaveBeenCalledWith("thr_one", "creq_one");
    expect(d.retry).toHaveBeenCalledTimes(1);
    expect(d.retry).toHaveBeenCalledWith({
      threadId: "thr_one",
      turnRequestId: "creq_one",
      sendAt: NOW + HOUR + 30_000,
      reason: RETRY_REASON,
    });
    expect(logs).toEqual([
      expect.stringContaining("retries thr_one (request creq_one, attempt 1) at"),
    ]);
  });

  it("waits until the session's own Retry-After when that is later", async () => {
    const later = deps({
      nextEligibleAt: vi.fn(async () => NOW - HOUR),
      sessionRetryAt: vi.fn(async () => NOW + 20 * 60_000),
    });
    await handlePoolerTurnFailed(later.deps, failure());
    expect(later.deps.sessionRetryAt).toHaveBeenCalledWith("claude", "thr_one");
    expect(later.deps.retry).toHaveBeenCalledWith(
      expect.objectContaining({ sendAt: NOW + 20 * 60_000 + 30_000 }),
    );
    // An earlier one (the session's account freed up meanwhile) changes nothing.
    const earlier = deps({ sessionRetryAt: vi.fn(async () => NOW + 60_000) });
    await handlePoolerTurnFailed(earlier.deps, failure());
    expect(earlier.deps.retry).toHaveBeenCalledWith(
      expect.objectContaining({ sendAt: NOW + HOUR + 30_000 }),
    );
  });

  it("takes a Codex thread's family from its model", async () => {
    const { deps: d } = deps({
      providerOf: vi.fn(async () => "codex"),
      turnModel: vi.fn(async () => "gpt-6.1-sol"),
    });
    await handlePoolerTurnFailed(d, failure({ attemptNumber: 4 }));
    expect(d.routes).toHaveBeenCalledWith("codex", "thr_one");
    expect(d.nextEligibleAt).toHaveBeenCalledWith("codex", "other");
    expect(d.retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no error info", { errorInfo: null }, "not a 429"],
    [
      "another status",
      { errorInfo: { category: "overloaded", httpStatusCode: 529, providerCode: null } },
      "not a 429",
    ],
    ["the fifth attempt", { attemptNumber: 5 }, "attempt 5 reached"],
  ] as const)("declines %s before reading anything", async (_label, overrides, reason) => {
    const { deps: d, logs } = deps();
    await handlePoolerTurnFailed(d, failure(overrides));
    expect(d.providerOf).not.toHaveBeenCalled();
    expect(d.retry).not.toHaveBeenCalled();
    expect(logs).toEqual([expect.stringContaining(reason)]);
  });

  it.each([
    ["retries are off", { maxWaitMs: () => 0 }, "automatic retries are off"],
    ["the provider is not pooled", { providerOf: async () => "muse" }, "provider muse is not pooled"],
    ["the Pooler does not route the thread", { routes: async () => false }, "does not route"],
    ["the model is unknown", { turnModel: async () => null }, "model is unknown"],
    ["no account is known to free up", { nextEligibleAt: async () => null }, "no account is known"],
    [
      "the wait exceeds the maximum",
      { nextEligibleAt: async () => NOW + 6 * HOUR + 60_000 },
      "beyond the maximum wait of 360 minutes",
    ],
  ] satisfies Array<[string, Partial<PoolerRetryDeps>, string]>)(
    "declines when %s",
    async (_label, overrides, reason) => {
      const { deps: d, logs } = deps(overrides);
      await handlePoolerTurnFailed(d, failure());
      expect(d.retry).not.toHaveBeenCalled();
      expect(logs).toEqual([expect.stringContaining(reason)]);
    },
  );

  it("counts a retry already queued as scheduled", async () => {
    const conflict = Object.assign(new Error("HTTP 409: already queued"), {
      name: "BbHttpError",
      status: 409,
      code: "retry_already_queued",
      body: { code: "retry_already_queued" },
    });
    const { deps: d, logs } = deps({ retry: vi.fn(async () => Promise.reject(conflict)) });
    await expect(handlePoolerTurnFailed(d, failure())).resolves.toBeUndefined();
    expect(logs).toEqual([expect.stringContaining("found a retry already queued")]);
  });

  it("logs any other failure instead of throwing", async () => {
    const { deps: d, logs } = deps({
      retry: vi.fn(async () =>
        Promise.reject(Object.assign(new Error("HTTP 409: no failed turn"), { status: 409, code: "no_failed_turn" })),
      ),
    });
    await expect(handlePoolerTurnFailed(d, failure())).resolves.toBeUndefined();
    expect(logs).toEqual([expect.stringContaining("could not schedule a retry of thr_one")]);
    const { deps: unreadable, logs: unreadableLogs } = deps({
      providerOf: async () => Promise.reject(new Error("timed out")),
    });
    await handlePoolerTurnFailed(unreadable, failure());
    expect(unreadableLogs).toEqual([expect.stringContaining("timed out")]);
  });
});
