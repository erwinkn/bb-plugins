import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTAGE_DEFAULT_MS, outageResetAt, reviewerOutUntil } from "../lib/reviewer-fallback";
import { projectFixture } from "./fake-native";

// W560 (Erwin, 2026-11-01): once Muse is out of quota, every later round failed on it again before
// switching (demo#3 round 18, thr_k7whwgkts3). The plugin now remembers the outage until its reset.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const muse = { providerId: "muse", model: "muse-wonder-full-1.0", reasoningLevel: "xhigh" } as const;
const sol = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" } as const;
// thr_k7whwgkts3's provider/error, word for word.
const MUSE_QUOTA =
  "Muse usage limit reached: API error 429 [request_id=16cecbd8-4d08-4b1f-bdfe-a1403c52350a]: Subscription quota exhausted. Your usage window resets at 2026-11-02T00:00:00Z. (rate_limit_error). It resets at 2026-11-02T00:00:00.000Z.";
const RESET = Date.parse("2026-11-02T00:00:00Z");
const NOW = Date.parse("2026-11-01T05:17:23Z");
const PROMPT = [{ type: "text", text: "You are the code reviewer (round 18). Review demo#3.", mentions: [] }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: muse, reviewFallback: sol }) });
  const [w] = await tool(f, "initiative_spawn", { label: "Demo", purpose: "demo", text: "Build it." });
  f.history.splice(0);
  let seq = 100;
  /** A Muse reviewer child of W1, its first request written; `status` as BB shows it. */
  const reviewer = (id: string, status: string, round = 18) => {
    f.threads.set(id, {
      ...makeThreadResponse({ id, projectId: "proj_a", environmentId: "env_w", parentThreadId: w.threadId, providerId: muse.providerId, status: status as never, title: `Review r${round} demo#3` }),
    });
    f.execution.set(id, { model: muse.model, reasoningLevel: "xhigh", permissionMode: "full" });
    row(id, "client/turn/requested", { source: "spawn", input: PROMPT });
    return id;
  };
  const row = (threadId: string, type: string, data: Record<string, unknown>) => f.history.push({ type, seq: seq++, threadId, createdAt: seq, data });
  const failOnQuota = async (id: string, message = MUSE_QUOTA) => {
    row(id, "provider/error", { message, errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 } });
    row(id, "turn/completed", { status: "failed" });
    f.threads.set(id, { ...f.threads.get(id)!, status: "error" });
    await f.harness.emitThreadEvent("thread.failed", { thread: f.threads.get(id)!, error: message });
  };
  const sends = () => f.send.mock.calls.map((call) => call[0] as { threadId: string; input: { text: string }[] }).filter((call) => call.threadId === w.threadId);
  const fallbackSpawns = () => f.spawn.mock.calls.map((call) => call[0] as Record<string, any>).filter((input) => input.pluginMetadata?.role === "fallback-reviewer");
  const nextBrief = async () => {
    await tool(f, "initiative_spawn", { label: "Next", purpose: "next", text: "Next change." });
    return f.spawn.mock.calls.at(-1)![0].prompt as string;
  };
  return { f, project, w, reviewer, row, failOnQuota, sends, fallbackSpawns, nextBrief };
}

describe("W560 when a reviewer's quota comes back", () => {
  it("reads the provider's reset time, else an hour", () => {
    expect(outageResetAt(MUSE_QUOTA, null, NOW)).toBe(RESET);
    // A blocked window's reset is the provider's account state: it wins over the text, nearer or later.
    expect(outageResetAt(MUSE_QUOTA, RESET + 3_600_000, NOW)).toBe(RESET + 3_600_000);
    expect(outageResetAt(MUSE_QUOTA, NOW + 300_000, NOW)).toBe(NOW + 300_000);
    expect(outageResetAt(MUSE_QUOTA, NOW - 1, NOW)).toBe(RESET);
    expect(outageResetAt("Claude AI usage limit reached|1793577600", null, NOW)).toBe(1793577600_000);
    expect(outageResetAt("You've hit your usage limit. Try again in 2 hours 5 minutes.", null, NOW)).toBe(NOW + 125 * 60_000);
    expect(outageResetAt("You've hit your usage limit. try again in 1d 3h", null, NOW)).toBe(NOW + 27 * 3_600_000);
    // No time, a time already past, an offset-less time, or one weeks away: an hour.
    for (const text of ["Subscription quota exhausted.", "Window reset at 2026-10-31T00:00:00Z", "resets at 2026-11-02T00:00:00", "resets at 2027-01-01T00:00:00Z", null])
      expect(outageResetAt(text, null, NOW)).toBe(NOW + OUTAGE_DEFAULT_MS);
  });
});

describe("W560 the plugin remembers a reviewer outage", () => {
  it("a quota failure with a reset: the next round starts on the fallback, without a failed round", async () => {
    const { f, w, reviewer, failOnQuota, sends, fallbackSpawns, nextBrief } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    expect(reviewerOutUntil(f.store, muse)).toBe(RESET);
    expect(fallbackSpawns()).toHaveLength(1);
    // The switch note says how long to keep starting on the fallback.
    expect(sends().at(-1)!.input[0]!.text).toContain("Until 2026-11-02 00:00 UTC, start each new round with the fallback reviewer command from your brief");

    // New briefs and work messages name the fallback first, and until when.
    const brief = await nextBrief();
    const fallbackAt = brief.indexOf("--provider codex --model gpt-6.1-sol");
    expect(brief).toContain("Fallback reviewer command, for every round until 2026-11-02 00:00 UTC: muse-wonder-full-1.0 xhigh is out");
    expect(fallbackAt).toBeGreaterThan(0);
    expect(fallbackAt).toBeLessThan(brief.indexOf("--provider muse --model muse-wonder-full-1.0"));
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a call.", question: "Keep it?", report: "r18: P2 open." }, w.threadId);
    await tool(f, "initiative_message", { to: "W1", text: "One more fix.", work: true });
    expect(sends().at(-1)!.input.map((part) => part.text).join("")).toContain("Fallback reviewer command, for every round until 2026-11-02 00:00 UTC");

    // A worker on its old brief starts round 19 on Muse: switched as it starts, before it fails.
    const r19 = reviewer("thr_r19", "active", 19);
    await f.harness.emitThreadEvent("thread.active", { thread: f.threads.get(r19)! });
    expect(f.stop).toHaveBeenCalledWith({ threadId: r19 });
    expect(f.threads.get(r19)!.archivedAt).not.toBeNull();
    expect(fallbackSpawns()).toHaveLength(2);
    expect(fallbackSpawns()[1]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", input: PROMPT, title: "Review r19 demo#3 (fallback)" });
    const note = sends().at(-1)!.input[0]!.text;
    expect(note).toContain("muse-wonder-full-1.0 xhigh is out (an earlier round hit a usage limit or an unavailable model) → round 19 rerun on gpt-6.1-sol xhigh.");
    expect(note).toContain("the plugin keeps it out until 2026-11-02 00:00 UTC");
    // Its quota failure arriving anyway switches nothing more.
    await failOnQuota(r19);
    expect(fallbackSpawns()).toHaveLength(2);
  });

  it("once the reset passes, Muse is the reviewer again with no manual step", async () => {
    const { f, reviewer, failOnQuota, fallbackSpawns, nextBrief } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    vi.setSystemTime(RESET);
    expect(reviewerOutUntil(f.store, muse)).toBeNull();
    const brief = await nextBrief();
    expect(brief).toContain("Fallback reviewer command: when a usage limit");
    expect(brief.indexOf("--provider muse")).toBeLessThan(brief.indexOf("--provider codex"));
    const r19 = reviewer("thr_r19", "active", 19);
    await f.harness.emitThreadEvent("thread.active", { thread: f.threads.get(r19)! });
    expect(f.stop).not.toHaveBeenCalledWith({ threadId: r19 });
    expect(fallbackSpawns()).toHaveLength(1);
  });

  it("an error without a reset time keeps the reviewer out for about an hour", async () => {
    const { f, reviewer, failOnQuota } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"), "Muse usage limit reached: Subscription quota exhausted.");
    expect(reviewerOutUntil(f.store, muse)).toBe(NOW + OUTAGE_DEFAULT_MS);
    vi.setSystemTime(NOW + OUTAGE_DEFAULT_MS);
    expect(reviewerOutUntil(f.store, muse)).toBeNull();
  });

  it("a blocked window's reset from turn.failed counts when the text names none", async () => {
    const { f, reviewer, row } = await setup();
    const id = reviewer("thr_r18", "error");
    row(id, "turn/completed", { status: "failed" });
    await f.harness.emitThreadEvent("turn.failed", {
      threadId: id, requestId: "creq_1", turnId: null, errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null }, inputAccepted: false, attemptNumber: 1,
      rateLimits: { providerId: "muse", kind: "subscription-window", status: "blocked", reachedReason: null, overageStatus: null, overageReason: null,
        windows: [{ label: "5h", providerKey: null, status: "blocked", resetsAtMs: NOW + 7_200_000 }, { label: "week", providerKey: null, status: "allowed", resetsAtMs: NOW + 86_400_000 }] } as never,
    });
    expect(reviewerOutUntil(f.store, muse)).toBe(NOW + 7_200_000);
  });

  it("a turn that completes on Muse clears the mark early; a stopped one does not", async () => {
    const { f, reviewer, row, failOnQuota, nextBrief } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    // The plugin's own stop of a switched reviewer ends idle too: no proof that Muse runs.
    const stopped = reviewer("thr_stopped", "idle", 19);
    row(stopped, "turn/completed", { status: "interrupted" });
    await f.harness.emitThreadEvent("thread.idle", { thread: f.threads.get(stopped)!, lastAssistantText: null });
    expect(reviewerOutUntil(f.store, muse)).toBe(RESET);
    // Any thread on that model finishing a turn does.
    const other = "thr_other";
    f.threads.set(other, { ...makeThreadResponse({ id: other, projectId: "proj_a", providerId: "muse", status: "idle" }) });
    f.execution.set(other, { model: muse.model, reasoningLevel: "xhigh" });
    row(other, "turn/completed", { status: "completed" });
    await f.harness.emitThreadEvent("thread.idle", { thread: f.threads.get(other)!, lastAssistantText: "Done." });
    expect(reviewerOutUntil(f.store, muse)).toBeNull();
    expect(await nextBrief()).toContain("Fallback reviewer command: when a usage limit");
  });

  it("a reviewer given more work after a finished turn is left to run during an outage (R8)", async () => {
    const { f, reviewer, row, failOnQuota, fallbackSpawns } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    const earlier = reviewer("thr_r17", "active", 17);
    row(earlier, "turn/completed", { status: "completed" });
    await f.harness.emitThreadEvent("thread.active", { thread: f.threads.get(earlier)! });
    expect(f.stop).not.toHaveBeenCalledWith({ threadId: earlier });
    expect(fallbackSpawns()).toHaveLength(1);
  });

  it("threads on other providers cost no BB call while a profile is out", async () => {
    const { f, reviewer, failOnQuota } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    const before = { exec: 0 };
    f.intercept((path, _args, call) => {
      if (path === "threads.defaultExecutionOptions") before.exec++;
      return call();
    });
    const codex = { ...makeThreadResponse({ id: "thr_codex", projectId: "proj_a", providerId: "codex", status: "idle" }) };
    f.threads.set(codex.id, codex);
    await f.harness.emitThreadEvent("thread.idle", { thread: codex, lastAssistantText: null });
    await f.harness.emitThreadEvent("thread.active", { thread: codex });
    f.intercept();
    expect(before.exec).toBe(0);
  });
});

describe("W560 review round 1 fixes", () => {
  it("R8: a reviewer that finishes while the early switch reads its prompt is left alone", async () => {
    const { f, reviewer, row, failOnQuota, sends, fallbackSpawns } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    const r19 = reviewer("thr_r19", "active", 19);
    f.intercept((path, args, call) => {
      if (path === "threads.stop" && (args as { threadId: string }).threadId === r19) row(r19, "turn/completed", { status: "completed" });
      return call();
    });
    await f.harness.emitThreadEvent("thread.active", { thread: f.threads.get(r19)! });
    f.intercept();
    expect(f.archive).not.toHaveBeenCalledWith({ threadId: r19 });
    expect(fallbackSpawns()).toHaveLength(1);
    expect(sends().at(-1)!.input[0]!.text).toContain("finished a turn before the plugin could switch it, so the plugin left it");
  });

  it("a blocked window's reset in the second failure event still lengthens the mark", async () => {
    const { f, reviewer, failOnQuota, sends } = await setup();
    const id = reviewer("thr_r18", "idle");
    await failOnQuota(id, "Muse usage limit reached: Subscription quota exhausted.");
    expect(reviewerOutUntil(f.store, muse)).toBe(NOW + OUTAGE_DEFAULT_MS);
    await f.harness.emitThreadEvent("turn.failed", {
      threadId: id, requestId: "creq_1", turnId: null, errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null }, inputAccepted: true, attemptNumber: 1,
      rateLimits: { providerId: "muse", kind: "subscription-window", status: "blocked", reachedReason: null, overageStatus: null, overageReason: null,
        windows: [{ label: "5h", providerKey: null, status: "blocked", resetsAtMs: NOW + 7 * 3_600_000 }] } as never,
    });
    expect(reviewerOutUntil(f.store, muse)).toBe(NOW + 7 * 3_600_000);
    expect(sends().at(-1)!.input[0]!.text).toContain("Correction: muse-wonder-full-1.0 xhigh is out until 2026-11-01 12:17 UTC");
  });

  it("a window reset sooner than the hour estimated from text replaces the estimate (r2)", async () => {
    const { f, reviewer, failOnQuota, sends } = await setup();
    const id = reviewer("thr_r18", "idle");
    await failOnQuota(id, "Muse usage limit reached: Subscription quota exhausted.");
    await f.harness.emitThreadEvent("turn.failed", {
      threadId: id, requestId: "creq_1", turnId: null, errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null }, inputAccepted: true, attemptNumber: 1,
      rateLimits: { providerId: "muse", kind: "subscription-window", status: "blocked", reachedReason: null, overageStatus: null, overageReason: null,
        windows: [{ label: "5h", providerKey: null, status: "blocked", resetsAtMs: NOW + 300_000 }] } as never,
    });
    expect(reviewerOutUntil(f.store, muse)).toBe(NOW + 300_000);
    // r3: the worker, told 06:17, hears the new deadline (05:22).
    expect(sends()[0]!.input[0]!.text).toContain("Until 2026-11-01 06:17 UTC, start each new round with the fallback");
    expect(sends().at(-1)!.input[0]!.text).toContain("Correction: muse-wonder-full-1.0 xhigh is out until 2026-11-01 05:22 UTC (its provider's rate-limit window), not 2026-11-01 06:17 UTC. Until 2026-11-01 05:22 UTC, start each new round with the fallback reviewer command");
    expect(sends()).toHaveLength(2);
  });

  it("a window reset within the announced minute is applied exactly, without a note (r4 P3)", async () => {
    const { f, reviewer, failOnQuota, sends } = await setup();
    const id = reviewer("thr_r18", "idle");
    await failOnQuota(id, "Muse usage limit reached: Subscription quota exhausted.");
    const notes = sends().length;
    await f.harness.emitThreadEvent("turn.failed", {
      threadId: id, requestId: "creq_1", turnId: null, errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null }, inputAccepted: true, attemptNumber: 1,
      rateLimits: { providerId: "muse", kind: "subscription-window", status: "blocked", reachedReason: null, overageStatus: null, overageReason: null,
        windows: [{ label: "5h", providerKey: null, status: "blocked", resetsAtMs: NOW + OUTAGE_DEFAULT_MS - 20_000 }] } as never,
    });
    expect(reviewerOutUntil(f.store, muse)).toBe(NOW + OUTAGE_DEFAULT_MS - 20_000);
    expect(sends()).toHaveLength(notes);
  });

  it("a later failure without a reset never shortens a known one", async () => {
    const { f, reviewer, failOnQuota } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    await failOnQuota(reviewer("thr_r18b", "idle"), "Muse usage limit reached: Subscription quota exhausted.");
    expect(reviewerOutUntil(f.store, muse)).toBe(RESET);
  });

  it("an older success behind a request stopped early clears nothing; nor does a check a newer failure overtook", async () => {
    const { f, reviewer, row, failOnQuota } = await setup();
    await failOnQuota(reviewer("thr_r18", "idle"));
    const old = reviewer("thr_old", "idle", 17);
    row(old, "turn/completed", { status: "completed" });
    row(old, "client/turn/requested", { source: "user", input: PROMPT });
    await f.harness.emitThreadEvent("thread.idle", { thread: f.threads.get(old)!, lastAssistantText: null });
    expect(reviewerOutUntil(f.store, muse)).toBe(RESET);

    const done = reviewer("thr_done", "idle", 20);
    row(done, "turn/completed", { status: "completed" });
    f.intercept((path, _args, call) => {
      // Another reviewer's failure marks Muse out for longer while this check reads.
      if (path === "threads.defaultExecutionOptions") f.store.upsertFlag("reviewer-out:muse/muse-wonder-full-1.0", RESET + 3_600_000);
      return call();
    });
    await f.harness.emitThreadEvent("thread.idle", { thread: f.threads.get(done)!, lastAssistantText: "Done." });
    f.intercept();
    expect(reviewerOutUntil(f.store, muse)).toBe(RESET + 3_600_000);
  });
});
