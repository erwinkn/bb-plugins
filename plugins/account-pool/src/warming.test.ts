import { describe, expect, it } from "vitest";
import type { CacheUsage } from "./cache-usage.js";
import type { ModelFamily } from "./contracts.js";
import type { ThreadContext } from "./thread-context.js";
import {
  CacheWarmer,
  type KeepAliveRequest,
  type KeepAliveResult,
  type NativeRequestStart,
  type WarmingOutcome,
} from "./warming.js";
import {
  loadWarmingConfig,
  warmingConfigSchema,
  type WarmingConfig,
} from "./warming-config.js";
import {
  PRIOR_SAMPLES,
  ResumeHistory,
  type WaitState,
} from "./warming-economics.js";
import { fakeClock as baseClock, flush } from "./testing/fake-clock.js";

const T0 = Date.UTC(2026, 9, 5, 12);
const fakeClock = () => baseClock(T0);
const SECOND = 1_000;
const MINUTE = 60_000;
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const URL_ = "https://api.anthropic.example/v1/messages?beta=true";

type Cc = { type: "ephemeral"; ttl?: "1h" | "5m" };
const cc = (ttl: "5m" | "1h"): Cc =>
  ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

function requestBody(
  options: {
    systemTtl?: "5m" | "1h";
    messageTtl?: "5m" | "1h" | null;
    automatic?: "5m" | "1h";
    model?: string;
    extra?: Record<string, unknown>;
    turn?: string;
  } = {},
): Uint8Array {
  const messageTtl =
    options.messageTtl === undefined ? "5m" : options.messageTtl;
  return new TextEncoder().encode(
    JSON.stringify({
      model: options.model ?? "claude-opus-5-5",
      max_tokens: 64_000,
      stream: true,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: cc(options.systemTtl ?? messageTtl ?? "5m"),
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: options.turn ?? "first turn",
              ...(messageTtl === null ? {} : { cache_control: cc(messageTtl) }),
            },
          ],
        },
      ],
      ...(options.automatic === undefined
        ? {}
        : { cache_control: cc(options.automatic) }),
      metadata: { user_id: '{"session_id":"s-1"}' },
      ...options.extra,
    }),
  );
}

function sse(usage: Record<string, unknown> | null): Uint8Array {
  const start =
    usage === null
      ? ""
      : `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg", model: "claude-opus-5-5", usage } })}\n\n`;
  return new TextEncoder().encode(
    `${start}event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } })}\n\n`,
  );
}

const NATIVE_USAGE = {
  input_tokens: 3,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 10_000,
  cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 },
  output_tokens: 1,
};

function hit(prefix = 100_000): CacheUsage {
  return {
    inputTokens: 3,
    outputTokens: 0,
    cacheReadTokens: prefix,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

type Member = Extract<ThreadContext, { kind: "member" }>;
const COORDINATOR: Member = {
  kind: "member",
  memberKind: "coordinator",
  role: "coordinator",
  state: "active",
  archived: false,
  paused: false,
  worker: null,
  assignment: null,
  next: null,
  reportedAt: null,
  review: null,
};
function worker(
  phase: "pending" | "active" | "reported" | "accepted" | "rejected" | null,
  overrides: Partial<Member> = {},
): Member {
  return {
    ...COORDINATOR,
    memberKind: "worker",
    role: "work",
    assignment: phase === null ? null : { ref: "A1", phase },
    ...overrides,
  };
}

interface Harness {
  clock: ReturnType<typeof fakeClock>;
  warmer: CacheWarmer;
  config: WarmingConfig;
  context: Map<string, ThreadContext>;
  // What a fresh (cache-bypassing) read returns, when it differs from the classification read.
  freshContext: Map<string, ThreadContext>;
  contextReads: Array<{ threadId: string; fresh: boolean }>;
  // When set, a context read waits on this instead of answering from the maps.
  readHook: ((threadId: string, fresh: boolean, signal: AbortSignal) => Promise<ThreadContext>) | null;
  sessionHook: ((threadId: string) => void) | null;
  // BB's current provider session per thread, as its latest thread/identity event reports it.
  sessions: Map<string, string>;
  // What each thread waits on at a refresh decision; "tool" (mid-turn) when unset.
  waits: Map<string, WaitState | null>;
  // BB's latest turn/started per thread (0 when unset); null makes the read fail. turnReads counts reads.
  turnStarts: Map<string, number | null>;
  turnReads: string[];
  // When set, a waiting-state read returns this instead of answering from the map.
  waitHook: ((threadId: string) => Promise<WaitState | null>) | null;
  history: ResumeHistory;
  // Sessions the warmer asked BB to resolve, and the outcomes it recorded.
  resolved: string[];
  outcomes: WarmingOutcome[];
  sent: Array<KeepAliveRequest & { at: number; signal: AbortSignal }>;
  replies: Array<
    KeepAliveResult | ((request: KeepAliveRequest, signal: AbortSignal) => Promise<KeepAliveResult>)
  >;
  native(options?: {
    // The thread the request belongs to; its session is "s-<thread>", linked as BB would on the
    // thread's lifecycle events unless link is false. null sends no session id at all.
    threadId?: string | null;
    link?: boolean;
    // Overrides the session id "s-<thread>".
    session?: string;
    parentSessionId?: string | null;
    family?: ModelFamily;
    body?: Uint8Array;
    usage?: Record<string, unknown> | null;
    status?: number;
    durationMs?: number;
    completed?: boolean;
  }): Promise<void>;
  events(): string[];
}

function harness(overrides: Partial<WarmingConfig> = {}): Harness {
  const clock = fakeClock();
  const config = warmingConfigSchema.parse({ mode: "warm", ...overrides });
  const context = new Map<string, ThreadContext>([["thr_coord", COORDINATOR]]);
  const freshContext = new Map<string, ThreadContext>();
  const contextReads: Harness["contextReads"] = [];
  const sessions = new Map<string, string>();
  const waits = new Map<string, WaitState | null>();
  const turnStarts = new Map<string, number | null>();
  const turnReads: string[] = [];
  const resolved: string[] = [];
  const outcomes: WarmingOutcome[] = [];
  const sent: Harness["sent"] = [];
  const replies: Harness["replies"] = [];
  const warmer = new CacheWarmer({
    now: clock.now,
    timers: clock.timers,
    config: () => config,
    switchThreshold: () => 0.98,
    readContext: async (threadId, signal, options) => {
      contextReads.push({ threadId, fresh: options?.fresh === true });
      if (h.readHook !== null) return h.readHook(threadId, options?.fresh === true, signal);
      return (
        (options?.fresh ? freshContext.get(threadId) : undefined) ??
        context.get(threadId) ?? { kind: "unknown", reason: "no stub" }
      );
    },
    threadSession: async (threadId) => {
      h.sessionHook?.(threadId);
      return sessions.get(threadId) ?? null;
    },
    resolveSession: (sessionId) => resolved.push(sessionId),
    turnStartedAt: async (threadId) => {
      turnReads.push(threadId);
      return turnStarts.has(threadId) ? turnStarts.get(threadId)! : 0;
    },
    waitState: (threadId) =>
      h.waitHook?.(threadId) ?? Promise.resolve(waits.has(threadId) ? waits.get(threadId)! : "tool"),
    resumeHistory: () => h.history,
    recordOutcome: (outcome) => outcomes.push(outcome),
    // Like the hub: the send-time confirmation runs first, and a refusal sends nothing.
    keepAlive: async (request, signal) => {
      const refused = await request.confirm(signal);
      if (refused !== null) return { kind: "skipped", reason: refused };
      sent.push({ ...request, at: clock.now() - T0, signal });
      const reply = replies.shift() ?? {
        kind: "response",
        status: 200,
        usage: hit(),
        outputEmpty: true,
        startedAt: clock.now(),
      };
      if (typeof reply === "function") return reply(request, signal);
      return reply.kind === "response" ? { ...reply, startedAt: clock.now() } : reply;
    },
  });
  const h: Harness = {
    clock,
    warmer,
    config,
    context,
    freshContext,
    contextReads,
    readHook: null,
    sessionHook: null,
    sessions,
    waits,
    turnStarts,
    turnReads,
    waitHook: null,
    history: new ResumeHistory(PRIOR_SAMPLES),
    resolved,
    outcomes,
    sent,
    replies,
    async native(options = {}) {
      const threadId = options.threadId === undefined ? "thr_coord" : options.threadId;
      const sessionId =
        threadId === null ? null : (options.session ?? `s-${threadId}`);
      if (threadId !== null && sessionId !== null && options.link !== false) {
        sessions.set(threadId, sessionId);
        warmer.linkSession(threadId, sessionId);
      }
      const start: NativeRequestStart = {
        sessionId,
        parentSessionId: options.parentSessionId ?? null,
        family: options.family ?? "opus",
      };
      const observation = warmer.observe(start);
      if (observation === null) return;
      const startedAt = clock.now();
      const tap = observation.responded({
        accountId: ACCOUNT,
        url: URL_,
        body: options.body ?? requestBody(),
        headers: new Headers({ "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219" }),
        startedAt,
        status: options.status ?? 200,
        contentType: "text/event-stream",
      });
      tap.push(sse(options.usage === undefined ? NATIVE_USAGE : options.usage));
      await clock.advanceTo(startedAt - T0 + (options.durationMs ?? 30 * SECOND));
      tap.finish(options.completed ?? true);
      await flush();
    },
    events: () => warmer.status().events.map((event) => `${event.kind}: ${event.message}`),
  };
  return h;
}

describe("cache warmer timing", () => {
  it("refreshes a 5m entry at start + TTL - margin while mid-turn, until maxWaitMinutes", async () => {
    const h = harness({ maxWaitMinutes: 20 });
    await h.native({ durationMs: 30 * SECOND });
    // Entry written at T0 lasts until T0+5m; the wait started at T0+30s.
    expect(h.warmer.status().leases[0]).toMatchObject({
      ttl: "5m",
      coveredUntil: T0 + 5 * MINUTE,
      nextRefreshAt: T0 + 4 * MINUTE,
      prefixTokens: 100_000,
      role: "coordinator",
    });
    await h.clock.advanceTo(60 * MINUTE);
    // Each confirmed refresh starts a new 5m lifetime from its own start. The fifth would be due at
    // 1200 s, 19.5 minutes into the wait, so it is sent; the sixth would be at 1440 s, past the
    // 20-minute limit, so the lease ends as soon as the fifth is confirmed.
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720, 960, 1200]);
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: the wait reached maxWaitMinutes (20)");
    expect(h.warmer.status().totals).toMatchObject({
      leasesStarted: 1,
      refreshesSent: 5,
      refreshesConfirmed: 5,
      cacheMisses: 0,
      refreshCacheReadTokens: 500_000,
      refreshOutputTokens: 0,
    });
    // The ledger learns what the thread waited on and why warming stopped.
    expect(h.outcomes).toEqual([
      {
        at: T0 + 1200 * SECOND,
        sessionId: "s-thr_coord",
        threadId: "thr_coord",
        model: "claude-opus-5-5",
        role: "coordinator",
        state: "tool",
        waitStartedAt: T0 + 30 * SECOND,
        firstDecisionAt: T0 + 240 * SECOND,
        prefixTokens: 100_000,
        ttl: "5m",
        refreshes: 5,
        kind: "end",
        reason: "the wait reached maxWaitMinutes (20)",
        reviewHold: null,
      },
    ]);
  });

  it("re-sends the exact native body with only max_tokens 0 and no stream, to the same account", async () => {
    const h = harness();
    const body = requestBody({ turn: "exact prefix" });
    await h.native({ body });
    await h.clock.advanceTo(4 * MINUTE);
    expect(h.sent).toHaveLength(1);
    const original = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const resent = JSON.parse(new TextDecoder().decode(h.sent[0]?.body)) as Record<string, unknown>;
    const { stream: _stream, max_tokens: _max, ...rest } = original;
    expect(resent).toEqual({ ...rest, max_tokens: 0 });
    expect(Object.keys(resent)).not.toContain("stream");
    expect(h.sent[0]).toMatchObject({ accountId: ACCOUNT, url: URL_, family: "opus", reserve: 0.9 });
    expect(Object.fromEntries(h.sent[0]?.headers ?? [])).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
    });
  });

  it("does not lease a 1h entry that already outlasts maxWaitMinutes, and never reads context for it", async () => {
    const h = harness({ maxWaitMinutes: 30 });
    await h.native({ body: requestBody({ messageTtl: "1h" }) });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("skip: the 1h cache entry already outlasts maxWaitMinutes (30)");
    expect(h.outcomes).toMatchObject([
      { kind: "skip", ttl: "1h", reason: "the 1h cache entry already outlasts maxWaitMinutes (30)" },
    ]);
    await h.clock.advanceTo(90 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.contextReads).toHaveLength(0);
  });

  it("uses the TTL of the last breakpoint actually sent, not a configured main TTL", async () => {
    // 1h on the system prompt, 5m on the conversation tail: the tail entry expires in 5 minutes.
    const mixed = harness();
    await mixed.native({ body: requestBody({ systemTtl: "1h", messageTtl: "5m" }) });
    expect(mixed.warmer.status().leases[0]?.ttl).toBe("5m");
    // An automatic top-level breakpoint renders last.
    const automatic = harness();
    await automatic.native({
      body: requestBody({ systemTtl: "1h", messageTtl: null, automatic: "5m" }),
    });
    expect(automatic.warmer.status().leases[0]?.ttl).toBe("5m");
    const hour = harness({ maxWaitMinutes: 30 });
    await hour.native({ body: requestBody({ systemTtl: "5m", messageTtl: null, automatic: "1h" }) });
    expect(hour.warmer.status().leases).toHaveLength(0);
  });

  it("after the turn ends, refreshes only while the thread's resume odds repay them", async () => {
    // Idle workers: half resume within 8 minutes, half never.
    const h = harness();
    h.history = new ResumeHistory(
      [3, 4, 5, 6, 8, null, null, null, null, null].map((minutes) => ({
        state: "idle" as const,
        role: "worker" as const,
        waitMs: minutes === null ? null : minutes * MINUTE,
      })),
    );
    h.context.set("thr_coord", worker("reported"));
    h.waits.set("thr_coord", "idle");
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(60 * MINUTE);
    // At 3.5 minutes into the wait the entry lasts until 4.5; of the 9 waits still running, 3
    // resume between 4.5 and the refreshed expiry at 8.5. At 7.5 minutes the one wait left to
    // resume (at 8) is covered already, and only waits that never resume remain after it.
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240]);
    expect(h.events().at(-1)).toMatch(
      /^end: stopped \(idle\): expected savings no longer cover refreshes: P\(resume between expiry and \d+ min from now\) 0\.\d\d from 10 idle\/worker waits$/,
    );
    expect(h.outcomes.at(-1)).toMatchObject({ role: "worker", state: "idle", refreshes: 1 });
  });

  it("warms while a background task runs, whatever the odds, and stops when it ends without a resume", async () => {
    const h = harness();
    // Idle coordinators always resume soon; they still do not carry a finished background wait on.
    h.history = new ResumeHistory(
      Array.from({ length: 20 }, () => ({ state: "idle" as const, role: "coordinator" as const, waitMs: 12 * MINUTE })),
    );
    h.waits.set("thr_coord", "background");
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(2);
    expect(h.warmer.status().leases[0]).toMatchObject({ waitingOn: "background", resumeChance: 1 });
    h.waits.set("thr_coord", "idle");
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(2);
    expect(h.events().at(-1)).toBe("end: stopped: the background task ended without the thread resuming");
    // The ledger keeps the state of the first decision: the one the wait is calibrated by.
    expect(h.outcomes.at(-1)).toMatchObject({ state: "background", refreshes: 2 });
  });

  it("W211 2: a check that never answers ends the lease when the entry expires", async () => {
    // The waiting-state read gives up after 10 seconds, after the entry expires.
    const h = harness({ safetyMarginSeconds: 5 });
    await h.native({ durationMs: 30 * SECOND });
    h.waitHook = () => new Promise(() => {});
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.warmer.status()).toMatchObject({ leases: [], retainedBodyBytes: 0 });
    expect(h.clock.pendingAt()).toEqual([]);
    expect(h.events().at(-1)).toBe("end: the entry expired while its refresh was being checked");
    expect(h.outcomes).toMatchObject([{ kind: "end", reason: "the entry expired while its refresh was being checked" }]);
  });

  it("W233: a context read that never answers counts as unknown after 3 seconds", async () => {
    const h = harness();
    await h.native({ durationMs: 30 * SECOND });
    const signals: AbortSignal[] = [];
    h.readHook = (_threadId, _fresh, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    };
    await h.clock.advanceTo(4 * MINUTE + 2 * SECOND);
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(4 * MINUTE + 3 * SECOND);
    expect(h.warmer.status()).toMatchObject({ leases: [], retainedBodyBytes: 0 });
    expect(h.clock.pendingAt()).toEqual([]);
    expect(h.events().at(-1)).toBe("skip: skipped: thread context read failed or timed out");
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("W211 2: a wait-state read that takes over 10 seconds counts as unknown", async () => {
    const h = harness();
    await h.native();
    h.waitHook = () => new Promise(() => {});
    await h.clock.advanceTo(4 * MINUTE + 10 * SECOND);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe("skip: skipped: BB could not tell what the thread waits on");
  });

  it("ends the lease when BB cannot tell what the thread waits on", async () => {
    const h = harness();
    h.waits.set("thr_coord", null);
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe("skip: skipped: BB could not tell what the thread waits on");
  });

  it("ends the lease when a refresh finds the entry gone (early expiry) and counts the miss", async () => {
    const h = harness();
    h.replies.push({
      kind: "response",
      status: 200,
      usage: { ...hit(0), cacheWriteTokens: 100_000, cacheWrite5mTokens: 100_000 },
      outputEmpty: true,
      startedAt: 0,
    });
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(1);
    expect(h.warmer.status().totals.cacheMisses).toBe(1);
    expect(h.events().at(-1)).toBe(
      "end: the entry was already gone: the refresh wrote 100000 tokens",
    );
  });

  it("ends the lease when a refresh reads less than the native prefix", async () => {
    const h = harness();
    h.replies.push({ kind: "response", status: 200, usage: hit(50_000), outputEmpty: true, startedAt: 0 });
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(1);
    expect(h.events().at(-1)).toBe("end: the refresh read 50000 of 100000 cached tokens");
  });

  it("sends nothing when its timer runs after the entry already expired", async () => {
    const h = harness();
    await h.native();
    h.clock.jumpTo(6 * MINUTE);
    await h.clock.advanceTo(6 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: the entry expired before a refresh could start");
  });

  it("stops warming when a refresh produces output or carries no usage", async () => {
    const output = harness();
    output.replies.push({ kind: "response", status: 200, usage: { ...hit(), outputTokens: 1 }, outputEmpty: false, startedAt: 0 });
    await output.native();
    await output.clock.advanceTo(60 * MINUTE);
    expect(output.sent).toHaveLength(1);
    expect(output.events().at(-1)).toBe("end: refresh produced output; warming stopped");
    const unknown = harness();
    unknown.replies.push({ kind: "response", status: 200, usage: null, outputEmpty: true, startedAt: 0 });
    await unknown.native();
    await unknown.clock.advanceTo(60 * MINUTE);
    expect(unknown.events().at(-1)).toBe("end: refresh response carried no cache usage");
  });

  it("ends on a rejected or skipped refresh without trying anything else", async () => {
    const rejected = harness();
    rejected.replies.push({ kind: "response", status: 429, usage: null, outputEmpty: null, startedAt: 0 });
    await rejected.native();
    await rejected.clock.advanceTo(60 * MINUTE);
    expect(rejected.sent).toHaveLength(1);
    expect(rejected.events().at(-1)).toBe("end: refresh rejected with HTTP 429");
    const skipped = harness();
    skipped.replies.push({ kind: "skipped", reason: "the account's quota is unknown" });
    await skipped.native();
    await skipped.clock.advanceTo(60 * MINUTE);
    expect(skipped.sent.map((request) => request.accountId)).toEqual([ACCOUNT]);
    expect(skipped.events().at(-1)).toBe("skip: refresh not sent: the account's quota is unknown");
    expect(skipped.warmer.status().totals.refreshesSent).toBe(0);
  });
});

describe("cache warmer native priority and attribution", () => {
  it("asks BB which thread runs a session no thread is linked to, and admits it once linked", async () => {
    const h = harness();
    await h.native({ link: false });
    expect(h.resolved).toEqual(["s-thr_coord"]);
    expect(h.warmer.status().admissions).toMatchObject([{ state: "linking" }]);
    // The answer arrives as a link: the waiting request is classified and leased.
    h.sessions.set("thr_coord", "s-thr_coord");
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    await flush();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.native();
    expect(h.resolved).toEqual(["s-thr_coord"]);
  });

  it("a native request on the thread clears a pending refresh", async () => {
    const h = harness();
    await h.native();
    await h.clock.advanceTo(3 * MINUTE);
    await h.native({ body: requestBody({ turn: "second turn" }) });
    // The first lease (due at 4m) is gone; the new one is due 4m after the new request started.
    expect(h.clock.pendingAt()).toEqual([7 * MINUTE]);
    await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
    expect(h.sent).toHaveLength(0);
    await h.clock.advanceTo(7 * MINUTE);
    expect(h.sent).toHaveLength(1);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain("second turn");
  });

  it("a native request aborts an in-flight refresh", async () => {
    const h = harness();
    let aborted = false;
    h.replies.push(
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ kind: "failed", reason: "canceled", startedAt: 0 });
          });
        }),
    );
    await h.native();
    await h.clock.advanceTo(4 * MINUTE);
    expect(h.warmer.status().leases[0]?.state).toBe("refreshing");
    const observation = h.warmer.observe({
      sessionId: "s-thr_coord",
      parentSessionId: null,
      family: "opus",
    });
    await flush();
    expect(aborted).toBe(true);
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("end: a native request on the thread took over");
    observation?.abandon();
  });

  it("agent-team requests and helpers in other families end the lease but never start one", async () => {
    const h = harness();
    await h.native();
    await h.native({ parentSessionId: "s-thr_coord", body: requestBody({ turn: "teammate" }) });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain(
      "skip: the request carries a parent_session_id (an agent-team session); only sessions without a parent start leases",
    );
    await h.native();
    await h.native({ family: "haiku", body: requestBody({ model: "claude-haiku-4-5" }) });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("skip: model family haiku is not enabled for warming");
    await h.clock.advanceTo(30 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });

  it("requests without a session id are observed but never leased", async () => {
    const h = harness();
    await h.native({ threadId: null });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("skip: no Claude Code session id in the request metadata");
  });

  it("a session no BB thread reported, or two threads reported, sends nothing", async () => {
    const unlinked = harness();
    await unlinked.native({ link: false });
    expect(unlinked.warmer.status().leases).toEqual([]);
    expect(unlinked.warmer.status().admissions).toMatchObject([{ sessionId: "s-thr_coord", threadId: null }]);
    await unlinked.clock.advanceTo(60 * MINUTE);
    expect(unlinked.sent).toHaveLength(0);
    expect(unlinked.events().at(-1)).toBe("skip: skipped: no BB thread is linked to this Claude session");
    const ambiguous = harness();
    ambiguous.warmer.linkSession("thr_fork", "s-thr_coord");
    await ambiguous.native();
    await ambiguous.clock.advanceTo(60 * MINUTE);
    expect(ambiguous.sent).toHaveLength(0);
    expect(ambiguous.events().at(-1)).toBe("skip: skipped: more than one BB thread reported this Claude session");
  });

  it("a thread that moves to a new Claude session ends the old session's lease", async () => {
    const h = harness();
    await h.native();
    h.sessions.set("thr_coord", "s-new");
    h.warmer.linkSession("thr_coord", "s-new");
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: the thread moved to a newer Claude session");
  });

  it("a native request from a newer session of the same thread ends the old lease at once", async () => {
    const h = harness();
    await h.native();
    h.warmer.linkSession("thr_other", "s-thr_coord-2");
    // BB linked thr_coord's new session before the old lease's thread moved: simulate a request on
    // a session already known to belong to thr_coord.
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    const observation = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "opus" });
    expect(h.warmer.status().leases).toHaveLength(0);
    observation?.abandon();
  });

  it("an older completion does not lease while a newer native request is in flight", async () => {
    const h = harness();
    h.sessions.set("thr_coord", "s-thr_coord");
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    const start = { sessionId: "s-thr_coord", parentSessionId: null, family: "opus" as const };
    const older = h.warmer.observe(start);
    const newer = h.warmer.observe(start);
    const response = (turn: string) => ({
      accountId: ACCOUNT,
      url: URL_,
      body: requestBody({ turn }),
      headers: new Headers(),
      startedAt: h.clock.now(),
      status: 200,
      contentType: "text/event-stream",
    });
    const olderTap = older?.responded(response("older"));
    olderTap?.push(sse(NATIVE_USAGE));
    olderTap?.finish(true);
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("skip: a newer native request in the session is in flight");
    const newerTap = newer?.responded(response("newer"));
    newerTap?.push(sse(NATIVE_USAGE));
    newerTap?.finish(true);
    await flush();
    await h.clock.advanceTo(4 * MINUTE);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain("newer");
  });

  it.each([
    ["failed", { status: 500 }, "skip: native request returned HTTP 500"],
    ["cut", { completed: false }, "native: native response did not complete"],
    ["unknown usage", { usage: null }, "skip: cache usage unknown"],
    ["no breakpoint", { body: requestBody({ messageTtl: null, systemTtl: undefined, extra: { system: "plain" } }) }, "skip: no cache breakpoint"],
    ["thinking enabled", { body: requestBody({ extra: { thinking: { type: "enabled", budget_tokens: 2048 } } }) }, "skip: thinking.type enabled cannot be sent with max_tokens 0"],
    ["forced tool", { body: requestBody({ extra: { tool_choice: { type: "any" } } }) }, "skip: a forced tool_choice cannot be sent with max_tokens 0"],
    ["structured output", { body: requestBody({ extra: { output_config: { format: { type: "json_schema" } } } }) }, "skip: output_config.format cannot be sent with max_tokens 0"],
  ] as const)("does not lease a %s native request", async (_name, options, event) => {
    const h = harness();
    await h.native(options as Parameters<Harness["native"]>[0]);
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain(event);
  });
});

describe("cache warmer context and lifecycle", () => {
  it.each([
    ["retired worker", worker("accepted", { state: "retired" }), "skip: worker retired"],
    ["stopped worker", worker("active", { state: "stopped" }), "skip: worker stopped"],
    ["former (replaced) worker", worker(null, { state: "former" }), "skip: worker former"],
    ["former reviewer", worker("reported", { role: "review", state: "former" }), "skip: reviewer former"],
    ["archived Initiative", { ...COORDINATOR, archived: true }, "skip: archived Initiative"],
    ["unknown context", { kind: "unknown", reason: "Projects context read returned HTTP 503" }, "skip: skipped: Projects context read returned HTTP 503"],
  ] as const)("sends no refresh for a %s", async (_name, context, event) => {
    const h = harness();
    h.context.set("thr_coord", context as ThreadContext);
    await h.native();
    // Classified before any lease: no slot, no body, no timer.
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [], retainedBodyBytes: 0 });
    expect(h.clock.pendingAt()).toEqual([]);
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe(event);
  });

  it("refuses at send time when a fresh read shows the worker retired after a cached reported read", async () => {
    const h = harness();
    h.context.set("thr_coord", worker("reported"));
    h.freshContext.set("thr_coord", worker("reported", { state: "retired" }));
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    // Admission and the timer classify from the cache; the send-time check reads fresh.
    expect(h.contextReads).toEqual([
      { threadId: "thr_coord", fresh: false },
      { threadId: "thr_coord", fresh: false },
      { threadId: "thr_coord", fresh: true },
    ]);
    expect(h.events().at(-1)).toBe("skip: refresh not sent: worker retired");
  });

  it.each([
    ["accepted worker", worker("accepted"), "worker", "worker, A1 accepted"],
    ["worker whose brief is pending delivery", worker("pending"), "worker", "worker, A1 pending"],
    ["worker with its next assignment queued", worker("reported", { next: { ref: "A2", phase: "pending" } }), "worker", "worker, A2 pending"],
    ["reviewer", worker("active", { role: "review" }), "reviewer", "reviewer, A1 active"],
    ["adhoc thread", worker(null, { memberKind: "adhoc", role: "adhoc" }), "standalone", "adhoc Initiative thread"],
    ["thread outside any Initiative", { kind: "none" }, "standalone", "no Initiative"],
  ] as const)("warms a %s mid-turn: its next brief or turn reuses the conversation", async (_name, context, role, label) => {
    const h = harness();
    h.context.set("thr_coord", context as ThreadContext);
    await h.native();
    expect(h.warmer.status().leases[0]).toMatchObject({ role, label });
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(2);
  });

  it("a role left out of the settings is not warmed, and removing it refuses the next send", async () => {
    const h = harness({ roles: ["coordinator", "worker"] });
    h.context.set("thr_coord", { kind: "none" });
    await h.native();
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("skip: role standalone is not enabled for warming (no Initiative)");
    const later = harness();
    await later.native();
    later.config.roles = ["worker"];
    await later.clock.advanceTo(10 * MINUTE);
    expect(later.sent).toHaveLength(0);
    expect(later.events().at(-1)).toBe("end: role coordinator is not enabled for warming (coordinator)");
  });

  it.each([
    ["Stop", worker("active", { state: "stopped" }), "worker stopped"],
    ["coordinator replacement", { ...COORDINATOR, state: "former" as const }, "coordinator former"],
    ["an archived Initiative", { ...COORDINATOR, archived: true }, "archived Initiative"],
  ])("refuses at send time after %s", async (_name, fresh, reason) => {
    const h = harness();
    h.context.set("thr_coord", fresh.kind === "member" && fresh.memberKind === "coordinator" ? COORDINATOR : worker("active"));
    h.freshContext.set("thr_coord", fresh as ThreadContext);
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe(`skip: refresh not sent: ${reason}`);
  });

  it("refuses at send time when BB reports a newer session for the thread", async () => {
    const h = harness();
    await h.native();
    h.sessions.set("thr_coord", "s-newer");
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe("skip: refresh not sent: the thread moved to a newer Claude session");
  });

  it("observe mode applies the same send-time refusal", async () => {
    const h = harness({ mode: "observe" });
    h.freshContext.set("thr_coord", { ...COORDINATOR, state: "former" });
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.warmer.status().totals.refreshesPlanned).toBe(0);
    expect(h.events().at(-1)).toBe("skip: refresh not sent: coordinator former");
  });

  it("warms a worker mid-turn through a 50-minute tool call, past any fixed window", async () => {
    const h = harness();
    h.context.set("thr_coord", worker("active"));
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(50 * MINUTE);
    expect(h.sent).toHaveLength(12);
    // The tool returns: the turn's next request ends the lease.
    await h.native();
    expect(h.events()).toContain("end: a native request on the thread took over");
    expect(h.outcomes.at(-1)).toMatchObject({ role: "worker", state: "tool", refreshes: 12 });
  });

  it("re-reads context before every refresh, so a retirement mid-lease stops it", async () => {
    const h = harness();
    await h.native();
    await h.clock.advanceTo(4 * MINUTE + SECOND);
    expect(h.sent).toHaveLength(1);
    h.context.set("thr_coord", { ...COORDINATOR, state: "former" });
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(1);
    // An admission read, then one classification read and one fresh send-time read per due
    // refresh; the second refresh ends at classification.
    expect(h.contextReads.map((read) => read.fresh)).toEqual([false, false, true, false]);
    expect(h.events().at(-1)).toBe("end: coordinator former");
  });

  it("thread archival and disposal end leases, abort refreshes and drop retained bodies", async () => {
    const h = harness();
    h.context.set("thr_other", COORDINATOR);
    await h.native();
    await h.native({ threadId: "thr_other" });
    expect(h.warmer.status().retainedBodyBytes).toBeGreaterThan(0);
    h.warmer.cancelThread("thr_coord", "thread archived");
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_other"]);
    // The archived thread's session link is gone too.
    await h.native({ link: false });
    await h.clock.advanceTo(30 * MINUTE);
    expect(h.events()).toContain("skip: skipped: no BB thread is linked to this Claude session");
    h.warmer.dispose();
    expect(h.warmer.status()).toMatchObject({ mode: "off", leases: [], retainedBodyBytes: 0 });
    expect(h.clock.pendingAt()).toEqual([]);
    expect(h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "opus" })).toBeNull();
  });

  it("observe mode plans the schedule without sending or keeping request bodies", async () => {
    const h = harness({ mode: "observe" });
    await h.native();
    expect(h.warmer.status()).toMatchObject({ retainedBodyBytes: 0 });
    expect(h.warmer.status().leases[0]?.dryRun).toBe(true);
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    // Due every 4 minutes from 240 s while the wait (from 30 s) is under an hour.
    expect(h.warmer.status().totals).toMatchObject({ refreshesPlanned: 15, refreshesSent: 0 });
    expect(h.events().filter((event) => event.startsWith("refresh: dry run"))).toHaveLength(15);
  });

  it("off mode observes nothing", async () => {
    const h = harness({ mode: "off" });
    await h.native();
    expect(h.warmer.status().totals.nativeObserved).toBe(0);
    expect(h.warmer.status().events).toEqual([]);
  });

  it("a mode change ends leases at their next timer", async () => {
    const h = harness();
    await h.native();
    h.config.mode = "observe";
    await h.clock.advanceTo(5 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: warming mode changed");
  });
});

describe("cache warmer bounds", () => {
  it("enforces maxLeases and maxLeaseBodyKiB", async () => {
    const leases = harness({ maxLeases: 1 });
    leases.context.set("thr_two", COORDINATOR);
    await leases.native();
    await leases.native({ threadId: "thr_two" });
    expect(leases.warmer.status().leases).toHaveLength(1);
    expect(leases.events()).toContain("skip: lease limit reached (maxLeases 1)");
    const body = harness({ maxLeaseBodyKiB: 64 });
    await body.native({ body: requestBody({ turn: "x".repeat(70 * 1024) }) });
    expect(body.events()).toContain("skip: request body is larger than maxLeaseBodyKiB (64 KiB)");
  });

  it("enforces maxRefreshesPerHour across leases", async () => {
    const h = harness({ maxRefreshesPerHour: 1 });
    h.context.set("thr_two", COORDINATOR);
    await h.native();
    await h.native({ threadId: "thr_two" });
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(1);
    expect(h.events()).toContain("end: hourly refresh budget reached (maxRefreshesPerHour 1)");
  });

  it("waits for a refresh slot under maxConcurrentRefreshes instead of exceeding it", async () => {
    const h = harness({ maxConcurrentRefreshes: 1 });
    h.context.set("thr_two", COORDINATOR);
    h.sessions.set("thr_two", "s-2");
    h.warmer.linkSession("thr_two", "s-2");
    let release: (() => void) | null = null;
    h.replies.push(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ kind: "response", status: 200, usage: hit(), outputEmpty: true, startedAt: h.clock.now() });
        }),
    );
    const start = { sessionId: "s-2", parentSessionId: null, family: "opus" as const };
    await h.native();
    const second = h.warmer.observe(start);
    const tap = second?.responded({
      accountId: ACCOUNT, url: URL_, body: requestBody({ turn: "two" }), headers: new Headers(),
      startedAt: T0, status: 200, contentType: "text/event-stream",
    });
    tap?.push(sse(NATIVE_USAGE));
    tap?.finish(true);
    await flush();
    await h.clock.advanceTo(4 * MINUTE + 2 * SECOND);
    expect(h.sent).toHaveLength(1);
    (release as (() => void) | null)?.();
    await h.clock.advanceTo(4 * MINUTE + 4 * SECOND);
    expect(h.sent).toHaveLength(2);
  });

  it("prunes history by count and age", async () => {
    const h = harness({ historyLimit: 10, historyMinutes: 5 });
    for (let index = 0; index < 8; index += 1) await h.native({ threadId: null });
    expect(h.warmer.status().events).toHaveLength(10);
    await h.clock.advanceTo(30 * MINUTE);
    expect(h.warmer.status().events).toHaveLength(0);
  });
});

// A231: the seven A227 findings and the D357 pause default. Each test failed on the A224 tree.
const reviewer = (
  phase: "active" | "reported" | "accepted",
  overrides: Partial<Member> = {},
): Member => worker(phase, { role: "review", ...overrides });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("A227 1: any same-session native request ends the lease", () => {
  it("an Opus lease ends when the thread switches to Sonnet, though Sonnet is not warmed", async () => {
    const h = harness();
    await h.native();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(2 * MINUTE);
    await h.native({ family: "sonnet", body: requestBody({ model: "claude-sonnet-5-5", turn: "sonnet turn" }) });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("end: a native request on the thread took over");
    expect(h.events().at(-1)).toBe("skip: model family sonnet is not enabled for warming");
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });

  it("a Sonnet request aborts an in-flight Opus refresh, not only a waiting timer", async () => {
    const h = harness();
    let aborted = false;
    h.replies.push(
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ kind: "failed", reason: "canceled", startedAt: 0 });
          });
        }),
    );
    await h.native();
    await h.clock.advanceTo(4 * MINUTE);
    expect(h.warmer.status().leases[0]?.state).toBe("refreshing");
    const observation = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "sonnet" });
    await flush();
    expect(aborted).toBe(true);
    expect(h.warmer.status().leases).toHaveLength(0);
    observation?.abandon();
  });

  it("an Opus completion does not lease while a same-session Sonnet request is in flight", async () => {
    const h = harness();
    h.sessions.set("thr_coord", "s-thr_coord");
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    const opus = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "opus" });
    const sonnet = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "sonnet" });
    const tap = opus?.responded({
      accountId: ACCOUNT, url: URL_, body: requestBody(), headers: new Headers(),
      startedAt: h.clock.now(), status: 200, contentType: "text/event-stream",
    });
    tap?.push(sse(NATIVE_USAGE));
    tap?.finish(true);
    await flush();
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("skip: a newer native request in the session is in flight");
    sonnet?.abandon();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });

  it("a newer completion does not lease while an older same-session request is still in flight", async () => {
    const h = harness();
    h.sessions.set("thr_coord", "s-thr_coord");
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    const older = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "sonnet" });
    const newer = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "opus" });
    const tap = newer?.responded({
      accountId: ACCOUNT, url: URL_, body: requestBody(), headers: new Headers(),
      startedAt: h.clock.now(), status: 200, contentType: "text/event-stream",
    });
    tap?.push(sse(NATIVE_USAGE));
    tap?.finish(true);
    await flush();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
    expect(h.events().at(-1)).toBe("skip: an older native request in the session is still in flight");
    older?.abandon();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });

  it("a request whose parent_session_id is the leased session ends that lease", async () => {
    const h = harness();
    await h.native();
    await h.native({ threadId: "thr_mate", link: false, parentSessionId: "s-thr_coord" });
    expect(h.warmer.status().leases).toHaveLength(0);
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });
});

describe("A227 2: reviewers are a role of their own", () => {
  it("a reviewer mid-turn is warmed like any thread waiting on a tool", async () => {
    const h = harness();
    h.context.set("thr_coord", reviewer("active"));
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
    expect(h.warmer.status().leases[0]).toMatchObject({ role: "reviewer", waitingOn: "tool" });
  });

  it("an idle reviewer is judged by reviewer waits, not worker ones", async () => {
    const h = harness();
    h.history = new ResumeHistory([
      ...Array.from({ length: 30 }, () => ({ state: "idle" as const, role: "worker" as const, waitMs: 6 * MINUTE })),
      ...Array.from({ length: 30 }, () => ({ state: "idle" as const, role: "reviewer" as const, waitMs: null })),
    ]);
    h.context.set("thr_coord", reviewer("reported"));
    h.waits.set("thr_coord", "idle");
    await h.native();
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(0);
    h.context.set("thr_other", worker("reported"));
    h.waits.set("thr_other", "idle");
    await h.native({ threadId: "thr_other" });
    await h.clock.advanceTo(20 * MINUTE);
    expect(h.sent).toHaveLength(1);
  });
});

describe("A227 3: shared-session subagents (documented limitation)", () => {
  it("a same-session request without a parent replaces the lease body; nothing tells a Task subagent apart", async () => {
    const h = harness();
    await h.native();
    await h.native({ body: requestBody({ turn: "subagent prompt" }) });
    await h.clock.advanceTo(5 * MINUTE);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain("subagent prompt");
  });

  it("names parent_session_id as agent-team lineage, not as a subagent marker", async () => {
    const h = harness();
    await h.native({ threadId: "thr_mate", link: false, parentSessionId: "s-thr_coord" });
    expect(h.events()).toContain(
      "skip: the request carries a parent_session_id (an agent-team session); only sessions without a parent start leases",
    );
  });
});

describe("A227 4: classification before a lease slot", () => {
  it("threads that can never warm hold no slot and no body, so the coordinator still gets one", async () => {
    const h = harness({ maxLeases: 2, roles: ["coordinator", "worker"] });
    h.context.set("thr_a", { kind: "none" });
    h.context.set("thr_b", worker(null, { memberKind: "adhoc", role: "adhoc" }));
    h.context.set("thr_c", { ...COORDINATOR, archived: true });
    h.context.set("thr_d", reviewer("active"));
    for (const threadId of ["thr_a", "thr_b", "thr_c", "thr_d"]) await h.native({ threadId });
    expect(h.warmer.status()).toMatchObject({ leases: [], retainedBodyBytes: 0 });
    await h.native();
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    expect(h.events()).not.toContain("skip: lease limit reached (maxLeases 2)");
    await h.clock.advanceTo(7 * MINUTE);
    expect(h.sent).toHaveLength(1);
  });

  it("an unlinked session waits for its link without a slot, then gets classified", async () => {
    const h = harness();
    await h.native({ link: false });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.warmer.status().admissions).toMatchObject([{ sessionId: "s-thr_coord", state: "linking" }]);
    h.sessions.set("thr_coord", "s-thr_coord");
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    await flush();
    expect(h.warmer.status()).toMatchObject({ admissions: [], leases: [{ threadId: "thr_coord" }] });
  });

  it("a session never linked is dropped after a bounded wait", async () => {
    const h = harness();
    await h.native({ link: false });
    await h.clock.advanceTo(2 * MINUTE);
    expect(h.warmer.status()).toMatchObject({ admissions: [], leases: [], retainedBodyBytes: 0 });
    expect(h.events().at(-1)).toBe("skip: skipped: no BB thread is linked to this Claude session");
  });

  it("admissions are bounded: a flood of unlinked sessions cannot keep out the coordinator", async () => {
    const h = harness({ maxLeases: 2 });
    for (const threadId of ["thr_x", "thr_y", "thr_z"])
      await h.native({ threadId, link: false, durationMs: SECOND });
    expect(h.warmer.status().admissions.length).toBeLessThanOrEqual(2);
    expect(h.events()).toContain("skip: too many requests awaiting classification (maxLeases 2)");
    await h.native();
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
  });

  it("a native request during classification cancels the admission", async () => {
    const h = harness();
    const read = deferred<ThreadContext>();
    h.readHook = () => read.promise;
    await h.native();
    expect(h.warmer.status().admissions).toMatchObject([{ state: "classifying" }]);
    const next = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family: "opus" });
    read.resolve(COORDINATOR);
    await flush();
    expect(h.warmer.status()).toMatchObject({ admissions: [], leases: [], retainedBodyBytes: 0 });
    next?.abandon();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });

  it("a thread start or a family removal during classification cancels the admission", async () => {
    const started = harness();
    const read = deferred<ThreadContext>();
    started.readHook = () => read.promise;
    await started.native();
    started.warmer.threadStarted("thr_coord");
    read.resolve(COORDINATOR);
    await flush();
    expect(started.warmer.status().leases).toHaveLength(0);
    expect(started.events().at(-1)).toBe("skip: the thread started a new turn");
    const narrowed = harness();
    const second = deferred<ThreadContext>();
    narrowed.readHook = () => second.promise;
    await narrowed.native();
    narrowed.config.families = [];
    second.resolve(COORDINATOR);
    await flush();
    expect(narrowed.warmer.status().leases).toHaveLength(0);
    expect(narrowed.events().at(-1)).toBe("skip: model family opus is no longer enabled for warming");
  });
});

describe("A227 5: narrowing model families", () => {
  it("reconcile ends a family's leases at once and aborts an in-flight refresh", async () => {
    const h = harness();
    let aborted = false;
    h.replies.push(
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ kind: "failed", reason: "canceled", startedAt: 0 });
          });
        }),
    );
    await h.native();
    await h.clock.advanceTo(4 * MINUTE);
    expect(h.warmer.status().leases[0]?.state).toBe("refreshing");
    h.config.families = ["sonnet"];
    h.warmer.reconcile();
    await flush();
    expect(aborted).toBe(true);
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: model family opus is no longer enabled for warming");
  });

  it("a hot settings change without reconcile still gates the timer and the final send check", async () => {
    const timer = harness();
    await timer.native();
    timer.config.families = [];
    await timer.clock.advanceTo(60 * MINUTE);
    expect(timer.sent).toHaveLength(0);
    expect(timer.events().at(-1)).toBe("end: model family opus is no longer enabled for warming");
    const confirm = harness();
    await confirm.native();
    // The change lands after classification, while the send-time check runs.
    confirm.sessionHook = () => {
      confirm.config.families = ["haiku"];
    };
    await confirm.clock.advanceTo(60 * MINUTE);
    expect(confirm.sent).toHaveLength(0);
    expect(confirm.events().at(-1)).toBe(
      "skip: refresh not sent: model family opus is no longer enabled for warming",
    );
  });
});

describe("A227 6: maxWaitMinutes bounds a 1h entry", () => {
  it("a 1h entry is leased only when maxWaitMinutes outlasts it", async () => {
    const h = harness({ maxWaitMinutes: 90 });
    await h.native({ body: requestBody({ messageTtl: "1h" }) });
    expect(h.warmer.status().leases).toHaveLength(1);
    // Due 59 minutes after the request started, 58.5 minutes into the wait.
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent.map((request) => request.at / MINUTE)).toEqual([59]);
  });
});

describe("A227 7: a turn start ends the thread's leases before any re-link", () => {
  it("ends every lease linked to the thread, even when BB's snapshot still names the old session", async () => {
    const h = harness();
    await h.native();
    h.warmer.threadStarted("thr_coord");
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: the thread started a new turn");
    // The stale snapshot re-links the old session; the new turn runs on an unlinked session.
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    const busy = h.warmer.observe({ sessionId: "s-new", parentSessionId: null, family: "opus" });
    await h.clock.advanceTo(30 * MINUTE);
    expect(h.sent).toHaveLength(0);
    busy?.abandon();
  });
});

describe("A227 7: ambiguous sessions", () => {
  it("a turn start ends the lease of the thread's last session even after another thread claimed it", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    // Hold the timer's classification so the lease is live when the claim and the turn start land.
    await h.native();
    h.readHook = () =>
      new Promise((resolve) => {
        release = () => resolve(COORDINATOR);
      });
    await h.clock.advanceTo(4 * MINUTE);
    expect(h.warmer.status().leases[0]?.state).toBe("checking");
    h.warmer.linkSession("thr_fork", "s-thr_coord");
    h.warmer.threadStarted("thr_coord");
    expect(h.warmer.status().leases).toHaveLength(0);
    (release as (() => void) | null)?.();
    await h.clock.advanceTo(30 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });
});

describe("D357: pauseStopsWarming", () => {
  it("defaults on: a paused Initiative gets no lease, and a pause seen fresh refuses the send", async () => {
    const h = harness();
    h.context.set("thr_coord", { ...COORDINATOR, paused: true });
    await h.native();
    expect(h.events().at(-1)).toBe("skip: paused Initiative");
    const fresh = harness();
    fresh.freshContext.set("thr_coord", { ...COORDINATOR, paused: true });
    await fresh.native();
    await fresh.clock.advanceTo(60 * MINUTE);
    expect(fresh.sent).toHaveLength(0);
    expect(fresh.events().at(-1)).toBe("skip: refresh not sent: paused Initiative");
  });

  it("off keeps warming through a pause", async () => {
    const h = harness({ pauseStopsWarming: false });
    h.context.set("thr_coord", { ...COORDINATOR, paused: true });
    await h.native();
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(2);
  });
});

// Starts a same-session native request now and finishes it later, so tests can interleave starts
// and completions the way concurrent Claude Code requests do.
function overlapping(
  h: Harness,
  options: { family?: ModelFamily; turn?: string; model?: string; session?: string } = {},
) {
  const family = options.family ?? "opus";
  const observation = h.warmer.observe({ sessionId: options.session ?? "s-thr_coord", parentSessionId: null, family });
  const startedAt = h.clock.now();
  return {
    async finish(end: { status?: number; completed?: boolean } = {}) {
      const tap = observation?.responded({
        accountId: ACCOUNT,
        url: URL_,
        body: requestBody({ model: options.model, turn: options.turn }),
        headers: new Headers(),
        startedAt,
        status: end.status ?? 200,
        contentType: "text/event-stream",
      });
      tap?.push(sse(NATIVE_USAGE));
      tap?.finish(end.completed ?? true);
      await flush();
    },
    async abandon() {
      observation?.abandon();
      await flush();
    },
  };
}

function linked(overrides: Partial<WarmingConfig> = {}): Harness {
  const h = harness(overrides);
  h.sessions.set("thr_coord", "s-thr_coord");
  h.warmer.linkSession("thr_coord", "s-thr_coord");
  return h;
}

const HAIKU = { family: "haiku" as const, model: "claude-haiku-4-5", turn: "tool summary" };

describe("A234 1: a finished helper does not suppress the final eligible completion", () => {
  it("Q1: a Haiku helper that starts after the final Opus request and finishes first", async () => {
    const h = linked();
    const opus = overlapping(h, { turn: "final" });
    const haiku = overlapping(h, HAIKU);
    await haiku.finish();
    await opus.finish();
    expect(h.warmer.status().leases).toHaveLength(1);
    expect(h.events().join("\n")).not.toContain("newer native request");
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(2);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain("final");
  });

  it("Q2: the same pair with the helper started first gives the same lease", async () => {
    const h = linked();
    const haiku = overlapping(h, HAIKU);
    const opus = overlapping(h, { turn: "final" });
    await haiku.finish();
    await opus.finish();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(2);
  });

  it("no lease while any same-session request still runs, whatever its family", async () => {
    const h = linked();
    const opus = overlapping(h, { turn: "final" });
    const haiku = overlapping(h, HAIKU);
    await opus.finish();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
    expect(h.events().at(-1)).toBe("skip: a newer native request in the session is in flight");
    await haiku.finish();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
    const older = linked();
    const helper = overlapping(older, HAIKU);
    const main = overlapping(older, { turn: "final" });
    await main.finish();
    expect(older.events().at(-1)).toBe("skip: an older native request in the session is still in flight");
    await helper.finish();
    await older.clock.advanceTo(60 * MINUTE);
    expect([h.sent.length, older.sent.length]).toEqual([0, 0]);
  });

  it("a newer request that could itself lease still keeps an older completion from leasing", async () => {
    const h = linked();
    const older = overlapping(h, { turn: "older" });
    const newer = overlapping(h, { turn: "newer" });
    await newer.finish();
    expect(h.events().at(-1)).toBe("skip: an older native request in the session is still in flight");
    await older.finish();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
    expect(h.events().at(-1)).toBe(
      "skip: a newer request in the session that could start a lease finished first",
    );
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });

  it("an enabled family counts as eligible: with Haiku warmed, a newer Haiku request blocks the older Opus one", async () => {
    const h = linked({ families: ["opus", "haiku"] });
    const opus = overlapping(h, { turn: "final" });
    const haiku = overlapping(h, HAIKU);
    await haiku.finish();
    await opus.finish();
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe(
      "skip: a newer request in the session that could start a lease finished first",
    );
  });

  it("an agent-team request that finished first does not block the main session's completion", async () => {
    const h = linked();
    const opus = overlapping(h, { turn: "final" });
    const mate = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: "s-lead", family: "opus" });
    mate?.abandon();
    await opus.finish();
    expect(h.warmer.status().leases).toHaveLength(1);
  });

  it("the next request after a drained session starts clean", async () => {
    const h = linked();
    const opus = overlapping(h, { turn: "first" });
    const haiku = overlapping(h, HAIKU);
    await haiku.finish();
    await opus.finish();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(2 * MINUTE);
    const next = overlapping(h, { turn: "second" });
    expect(h.warmer.status().leases).toHaveLength(0);
    await next.finish();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(60 * MINUTE);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain("second");
  });

  it("a helper start still drops a pending admission and aborts an in-flight refresh", async () => {
    const h = harness();
    await h.native({ link: false });
    expect(h.warmer.status().admissions).toHaveLength(1);
    const helper = overlapping(h, HAIKU);
    expect(h.warmer.status().admissions).toHaveLength(0);
    await helper.finish();
    h.sessions.set("thr_coord", "s-thr_coord");
    h.warmer.linkSession("thr_coord", "s-thr_coord");
    await flush();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
    const sending = harness();
    let aborted = false;
    sending.replies.push(
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ kind: "failed", reason: "canceled", startedAt: 0 });
          });
        }),
    );
    await sending.native();
    await sending.clock.advanceTo(4 * MINUTE);
    expect(sending.warmer.status().leases[0]?.state).toBe("refreshing");
    const late = overlapping(sending, HAIKU);
    await flush();
    expect(aborted).toBe(true);
    await late.finish();
    expect(sending.warmer.status().leases).toHaveLength(0);
  });
});

describe("A234 3: post-turn helpers (documented limitation)", () => {
  it("a same-session helper after the final main request ends the lease; nothing is refreshed", async () => {
    const h = harness();
    await h.native();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(1 * MINUTE);
    await h.native({ family: "haiku", body: requestBody({ model: "claude-haiku-4-5" }), durationMs: 2 * SECOND });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("end: a native request on the thread took over");
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
  });
});

describe("T141: settings of the fixed-window model", () => {
  it("a stored record that still has them loads without them, so warming stays on", () => {
    const state = loadWarmingConfig({
      mode: "warm",
      coordinatorMinutes: 20,
      workerActiveMinutes: 15,
      reviewerAcceptedMinutes: 0,
      standaloneMinutes: 0,
      maxRefreshesPerLease: 4,
      maxRefreshesPerHour: 60,
      safetyMarginSeconds: 15,
    });
    // The hourly budget at the old default of 60 moves to the new one; the server saves the result.
    expect(state).toEqual({
      ok: true,
      config: warmingConfigSchema.parse({ mode: "warm", safetyMarginSeconds: 15, maxRefreshesPerHour: 100 }),
      migrated: true,
    });
    // A budget set to anything else is kept; a record without legacy keys is not migrated, so an
    // explicit 60 saved after the migration stays.
    expect(loadWarmingConfig({ mode: "warm", coordinatorMinutes: 20, maxRefreshesPerHour: 40 })).toMatchObject({
      config: { maxRefreshesPerHour: 40 },
      migrated: true,
    });
    expect(loadWarmingConfig({ mode: "warm", maxRefreshesPerHour: 60 })).toEqual({
      ok: true,
      config: warmingConfigSchema.parse({ mode: "warm", maxRefreshesPerHour: 60 }),
    });
  });
});

describe("T104: a newer request that ends without a usable response stops blocking the last good one", () => {
  type Overlap = ReturnType<typeof overlapping>;
  const failures: [string, (r: Overlap) => Promise<void>, string][] = [
    ["aborted", (r) => r.abandon(), "ended without a response"],
    ["failed with HTTP 500", (r) => r.finish({ status: 500 }), "HTTP 500"],
    ["cut off mid-response", (r) => r.finish({ completed: false }), "response did not complete"],
  ];
  const leasedBody = (h: Harness) => new TextDecoder().decode(h.sent[0]?.body);

  for (const [label, fail, why] of failures) {
    it(`newer ${label} first, then the older completes: the older leases`, async () => {
      const h = linked();
      const older = overlapping(h, { turn: "older" });
      const newer = overlapping(h, { turn: "newer" });
      await fail(newer);
      expect(h.warmer.status().leases).toHaveLength(0); // the older one still runs
      await older.finish();
      expect(h.warmer.status().leases).toHaveLength(1);
      expect(h.events().join("\n")).not.toContain("finished first");
      await h.clock.advanceTo(60 * MINUTE);
      expect(leasedBody(h)).toContain("older");
    });

    it(`older completes first, then the newer ${label}: the held older one leases`, async () => {
      const h = linked();
      const older = overlapping(h, { turn: "older" });
      const newer = overlapping(h, { turn: "newer" });
      await older.finish();
      // A running same-session request still prevents leasing.
      expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
      expect(h.events().at(-1)).toBe("skip: a newer native request in the session is in flight");
      await fail(newer);
      expect(h.warmer.status().leases).toHaveLength(1);
      expect(h.events().join("\n")).toContain(`native: a newer request in the session failed (${why}) and none newer succeeded, so the last successful request can lease again`);
      await h.clock.advanceTo(60 * MINUTE);
      expect(leasedBody(h)).toContain("older");
    });
  }

  it("a successful newer request still wins, in both finish orders", async () => {
    const first = linked();
    const a = overlapping(first, { turn: "older" });
    const b = overlapping(first, { turn: "newer" });
    await a.finish();
    await b.finish();
    await first.clock.advanceTo(60 * MINUTE);
    expect(new TextDecoder().decode(first.sent[0]?.body)).toContain("newer");
    const second = linked();
    const c = overlapping(second, { turn: "older" });
    const d = overlapping(second, { turn: "newer" });
    await d.finish();
    await c.finish();
    expect(second.events().at(-1)).toBe("skip: a newer request in the session that could start a lease finished first");
    expect(second.warmer.status().leases).toHaveLength(0);
  });

  it("the newest successful one leases when several newer requests end differently", async () => {
    const h = linked();
    const one = overlapping(h, { turn: "one" });
    const two = overlapping(h, { turn: "two" });
    const three = overlapping(h, { turn: "three" });
    await two.finish(); // held: one and three still run
    await three.abandon();
    await one.finish();
    expect(h.events()).toContain("skip: a newer request in the session that could start a lease finished first");
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(60 * MINUTE);
    expect(leasedBody(h)).toContain("two");
  });

  it("any new start still cancels the resumed lease, and a turn start drops a held completion", async () => {
    const h = linked();
    const older = overlapping(h, { turn: "older" });
    const newer = overlapping(h, { turn: "newer" });
    await older.finish();
    await newer.abandon();
    expect(h.warmer.status().leases).toHaveLength(1);
    overlapping(h, { turn: "next" });
    expect(h.warmer.status().leases).toHaveLength(0);

    const t = linked();
    const a = overlapping(t, { turn: "older" });
    const b = overlapping(t, { turn: "newer" });
    await a.finish();
    t.warmer.threadStarted("thr_coord");
    await b.abandon();
    expect(t.warmer.status()).toMatchObject({ leases: [], admissions: [] });
  });

  it("A250 #2: the newest success leases whatever order the failures and the success arrive in", async () => {
    const h = linked();
    const a = overlapping(h, { turn: "turn-a" });
    const b = overlapping(h, { turn: "turn-b" });
    const c = overlapping(h, { turn: "turn-c" });
    await c.abandon();
    await b.finish(); // only the older A still runs
    expect(h.warmer.status().leases).toHaveLength(0);
    await a.abandon();
    expect(h.warmer.status().leases).toHaveLength(1);
    expect(h.events().join("\n")).toContain("native: an older request in the session failed (ended without a response) and none newer succeeded");
    await h.clock.advanceTo(60 * MINUTE);
    expect(leasedBody(h)).toContain("turn-b");
  });

  it("two successes with no failure keep the earlier rule: nothing leases", async () => {
    const h = linked();
    const a = overlapping(h, { turn: "a" });
    const b = overlapping(h, { turn: "b" });
    await b.finish();
    await a.finish();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
  });

  it("A250 #1: held completions pass the lease gates first, stay within maxLeases, count their bytes and expire", async () => {
    const h = linked({ maxLeases: 1, maxLeaseBodyKiB: 64 });
    // Too large to ever lease: never held.
    const big = overlapping(h, { session: "s-big", turn: "x".repeat(70_000) });
    overlapping(h, { session: "s-big", turn: "newer" });
    await big.finish();
    expect(h.warmer.status().retainedBodyBytes).toBe(0);
    // Two sessions each hold one completion; maxLeases 1 keeps only the latest.
    for (const session of ["s-1", "s-2"]) {
      const older = overlapping(h, { session, turn: `older ${session}` });
      overlapping(h, { session, turn: "newer" });
      await older.finish();
    }
    const retained = h.warmer.status().retainedBodyBytes;
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(64 * 1024);
    // A held completion is gone once its refresh would be due, timer or not.
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.warmer.status().retainedBodyBytes).toBe(0);
  });

  it("observe mode holds no request body", async () => {
    const h = linked({ mode: "observe" });
    const older = overlapping(h, { turn: "older" });
    const newer = overlapping(h, { turn: "newer" });
    await older.finish();
    expect(h.warmer.status().retainedBodyBytes).toBe(0);
    await newer.abandon();
    expect(h.warmer.status().admissions.length + h.warmer.status().leases.length).toBe(1);
  });

  it("an older request that waited only on a helper that could never lease stays skipped, as before", async () => {
    const h = linked();
    const opus = overlapping(h, { turn: "final" });
    const haiku = overlapping(h, HAIKU);
    await opus.finish();
    await haiku.abandon();
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [] });
  });
});

describe("D440: review holds", () => {
  const WHY = "review of W1 by W2 running (A2)";
  const review = (ref = "A2", since = T0) => ({ ref, worker: "W2", since });
  // Idle workers never resume, so without a hold a reported worker's lease stops at once.
  const never = () =>
    new ResumeHistory(Array.from({ length: 30 }, () => ({ state: "idle" as const, role: "worker" as const, waitMs: null })));
  function reported(overrides: Partial<Harness["config"]> = {}) {
    const h = harness(overrides);
    h.history = never();
    h.context.set("thr_coord", worker("reported", { worker: "W1", review: review() }));
    h.waits.set("thr_coord", "idle");
    return h;
  }

  it("keeps a reported worker warm while its review runs, and lets the odds decide once it reports", async () => {
    const h = reported();
    await h.native();
    await h.clock.advanceTo(17 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720, 960]);
    expect(h.warmer.status().leases[0]).toMatchObject({ reviewHold: WHY, waitingOn: "idle", resumeChance: 1 });
    h.context.set("thr_coord", worker("reported", { worker: "W1" }));
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(4);
    expect(h.events().at(-1)).toMatch(/^end: stopped \(idle\): expected savings no longer cover refreshes/);
    // The ledger names the hold, so calibration leaves this wait out.
    expect(h.outcomes.at(-1)).toMatchObject({ role: "worker", state: "idle", refreshes: 4, reviewHold: WHY });
  });

  it("expires reviewHoldMinutes after the review started, and a re-review renews it", async () => {
    const expired = reported({ reviewHoldMinutes: 10 });
    await expired.native();
    await expired.clock.advanceTo(60 * MINUTE);
    expect(expired.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
    expect(expired.events().at(-1)).toMatch(/^end: stopped \(idle\): expected savings/);

    const renewed = reported({ reviewHoldMinutes: 10 });
    await renewed.native();
    await renewed.clock.advanceTo(500 * SECOND);
    renewed.context.set("thr_coord", worker("reported", { worker: "W1", review: review("A4", T0 + 500 * SECOND) }));
    await renewed.clock.advanceTo(60 * MINUTE);
    // Held until 1100 s: the entry refreshed at 960 already lasts past it.
    expect(renewed.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720, 960]);
    expect(renewed.outcomes.at(-1)?.reviewHold).toBe("review of W1 by W2 running (A4)");
  });

  it("ends when the worker resumes or retires; reviewHoldMinutes 0 turns holds off", async () => {
    const resumed = reported();
    await resumed.native();
    await resumed.clock.advanceTo(5 * MINUTE);
    resumed.context.set("thr_coord", worker("active", { worker: "W1" }));
    await resumed.native();
    expect(resumed.outcomes.at(-1)).toMatchObject({ reason: "a native request on the thread took over", refreshes: 1, reviewHold: WHY });

    const retired = reported();
    await retired.native();
    await retired.clock.advanceTo(5 * MINUTE);
    retired.context.set("thr_coord", worker("reported", { worker: "W1", review: review(), state: "retired" }));
    await retired.clock.advanceTo(60 * MINUTE);
    expect(retired.sent).toHaveLength(1);
    expect(retired.events().at(-1)).toBe("end: worker retired");

    const off = reported({ reviewHoldMinutes: 0 });
    await off.native();
    await off.clock.advanceTo(60 * MINUTE);
    expect(off.sent).toHaveLength(0);
    expect(off.outcomes.at(-1)?.reviewHold).toBeNull();
  });

  it("keeps warming when a background task ends during the hold", async () => {
    const h = reported();
    h.waits.set("thr_coord", "background");
    await h.native();
    await h.clock.advanceTo(5 * MINUTE);
    h.waits.set("thr_coord", "idle");
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
  });

  it("at the lease limit, a worker under review takes an unheld lease's slot, read fresh", async () => {
    const h = harness({ maxLeases: 1 });
    h.history = never();
    await h.native();
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    // The cached read predates the review; the fresh read at the limit sees it.
    h.context.set("thr_w1", worker("reported", { worker: "W1" }));
    h.freshContext.set("thr_w1", worker("reported", { worker: "W1", review: review() }));
    await h.native({ threadId: "thr_w1" });
    expect(h.contextReads).toContainEqual({ threadId: "thr_w1", fresh: true });
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_w1"]);
    expect(h.events()).toContain(`end: lease slot taken by a thread under review (${WHY})`);
    // Neither an unheld thread nor another held one takes a held lease's slot.
    h.context.set("thr_w3", worker("reported", { worker: "W3" }));
    await h.native({ threadId: "thr_w3" });
    h.context.set("thr_w5", worker("reported", { worker: "W5", review: review("A6") }));
    await h.native({ threadId: "thr_w5" });
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_w1"]);
    expect(h.events().filter((event) => event === "skip: lease limit reached (maxLeases 1)")).toHaveLength(2);
  });

  it("W233: a lease whose review started after its admission keeps its slot", async () => {
    const h = harness({ maxLeases: 1 });
    h.history = never();
    h.context.set("thr_coord", worker("reported", { worker: "W1" }));
    await h.native();
    expect(h.warmer.status().leases[0]).toMatchObject({ threadId: "thr_coord", reviewHold: null });
    // The review of W1 starts now: only a fresh read sees it.
    h.freshContext.set("thr_coord", worker("reported", { worker: "W1", review: review() }));
    h.context.set("thr_w3", worker("reported", { worker: "W3", review: review("A4") }));
    await h.native({ threadId: "thr_w3" });
    expect(h.contextReads).toContainEqual({ threadId: "thr_coord", fresh: true });
    expect(h.warmer.status().leases).toMatchObject([{ threadId: "thr_coord", reviewHold: WHY }]);
    expect(h.events().at(-1)).toBe("skip: lease limit reached (maxLeases 1)");
  });

  // Admission at the limit; once armed, thr_coord's next fresh (victim) read stays open until
  // released.
  async function racing() {
    const h = harness({ maxLeases: 1 });
    h.history = never();
    await h.native();
    let armed = false;
    let release: (() => void) | null = null;
    h.readHook = (threadId, fresh) => {
      if (!(armed && threadId === "thr_coord" && fresh)) return Promise.resolve(h.context.get(threadId)!);
      armed = false;
      return new Promise((resolve) => (release = () => resolve(h.context.get(threadId)!)));
    };
    h.context.set("thr_w1", worker("reported", { worker: "W1", review: review() }));
    return { h, arm: () => (armed = true), release: () => (release as (() => void) | null)?.() };
  }

  it("W233: an entry that expires while the leases it could evict are read takes no slot", async () => {
    const { h, arm } = await racing();
    // W1's request started at 90 s and completes at 388 s; its 5-minute entry expires at 390 s.
    await h.clock.advanceTo(90 * SECOND);
    h.sessions.set("thr_w1", "s-thr_w1");
    h.warmer.linkSession("thr_w1", "s-thr_w1");
    const observation = h.warmer.observe({ sessionId: "s-thr_w1", parentSessionId: null, family: "opus" });
    const tap = observation!.responded({
      accountId: ACCOUNT, url: URL_, body: requestBody({ turn: "w1" }), headers: new Headers(),
      startedAt: h.clock.now(), status: 200, contentType: "text/event-stream",
    });
    tap.push(sse(NATIVE_USAGE));
    await h.clock.advanceTo(388 * SECOND);
    arm();
    tap.finish(true);
    await flush();
    expect(h.contextReads.at(-1)).toEqual({ threadId: "thr_coord", fresh: true });
    // The victim read gives up after 3 seconds, past the entry's expiry.
    await h.clock.advanceTo(391 * SECOND);
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    expect(h.events().at(-1)).toBe("skip: the entry expired during classification");
  });

  it("W233: holds or the role turned off while the leases it could evict are read take no slot", async () => {
    const off = await racing();
    off.arm();
    await off.h.native({ threadId: "thr_w1" });
    expect(off.h.contextReads.at(-1)).toEqual({ threadId: "thr_coord", fresh: true });
    off.h.config.reviewHoldMinutes = 0;
    off.h.warmer.reconcile();
    off.release();
    await flush();
    expect(off.h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    expect(off.h.events().at(-1)).toBe("skip: lease limit reached (maxLeases 1)");

    const role = await racing();
    role.arm();
    await role.h.native({ threadId: "thr_w1" });
    role.h.config.roles = role.h.config.roles.filter((name) => name !== "worker");
    role.h.warmer.reconcile();
    role.release();
    await flush();
    expect(role.h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    expect(role.h.events().at(-1)).toMatch(/^skip: role worker is not enabled for warming/);
  });

  it("W233: a hold that would not pay for itself takes no slot", async () => {
    // A hold to minute 60 needs 14 refreshes from the first due time (1.4 > 1.15 × prefix).
    const h = harness({ maxLeases: 1, reviewHoldMinutes: 60, maxWaitMinutes: 120 });
    h.history = never();
    await h.native();
    h.context.set("thr_w1", worker("reported", { worker: "W1", review: review() }));
    await h.native({ threadId: "thr_w1" });
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    expect(h.events().at(-1)).toBe("skip: lease limit reached (maxLeases 1)");
    // Nothing was re-read for an eviction that could not happen.
    expect(h.contextReads.filter((read) => read.threadId === "thr_coord" && read.fresh)).toEqual([]);
  });

  it("W233: the fresh read before a send decides again: a review that just reported stops the refresh", async () => {
    const h = reported();
    await h.native();
    // The cached read still shows the review; the fresh one just before the send does not.
    h.freshContext.set("thr_coord", worker("reported", { worker: "W1" }));
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toMatch(
      /^skip: refresh not sent: stopped \(idle\): expected savings no longer cover refreshes/,
    );
    // And the other way round: a fresh read still showing the review sends it.
    const held = reported();
    held.freshContext.set("thr_coord", worker("reported", { worker: "W1", review: review() }));
    await held.native();
    await held.clock.advanceTo(5 * MINUTE);
    expect(held.sent).toHaveLength(1);
  });

  it("W233: an admission whose context read never answers is dropped after 3 seconds", async () => {
    const h = harness();
    const signals: AbortSignal[] = [];
    h.readHook = (_threadId, _fresh, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    };
    await h.native();
    expect(h.warmer.status().admissions).toHaveLength(1);
    await h.clock.advanceTo(33 * SECOND);
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [], retainedBodyBytes: 0 });
    expect(h.events().at(-1)).toBe("skip: skipped: thread context read failed or timed out");
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });
});

describe("reported grace: an idle work worker that reported stops being warmed", () => {
  const review = { ref: "A2", worker: "W2", since: T0 };
  const never = () =>
    new ResumeHistory(Array.from({ length: 30 }, () => ({ state: "idle" as const, role: "worker" as const, waitMs: null })));
  // W1 reported A1 at T0, as Initiatives' assignment.reportedAt says, and W2 is reviewing it.
  function reported(overrides: Partial<Harness["config"]> = {}, member: Partial<Member> = {}) {
    const h = harness(overrides);
    h.history = never();
    h.context.set("thr_coord", worker("reported", { worker: "W1", review, reportedAt: T0, ...member }));
    h.waits.set("thr_coord", "idle");
    return h;
  }

  it("caps the review hold at reportedGraceMinutes from the report", async () => {
    const h = reported({ reportedGraceMinutes: 10 });
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    // Held until 600 s: the refresh at 480 s lasts to 780 s; none after the grace.
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
    expect(h.events().at(-1)).toBe("end: stopped (idle): W1 reported A1: its report reached reportedGraceMinutes");
  });

  it("by default (5 minutes) the 5-minute entry already covers the grace: no refresh; 0 is the same", async () => {
    for (const config of [{}, { reportedGraceMinutes: 0 }]) {
      const h = reported(config);
      await h.native();
      await h.clock.advanceTo(60 * MINUTE);
      expect(h.sent).toHaveLength(0);
    }
  });

  it("an Initiatives without reportedAt keeps the full review hold (backward compatible)", async () => {
    const h = reported({}, { reportedAt: null });
    await h.native();
    await h.clock.advanceTo(17 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720, 960]);
  });

  it("a worker with a queued next assignment is not capped", async () => {
    const h = reported({}, { next: { ref: "A3", phase: "pending" } });
    await h.native();
    await h.clock.advanceTo(17 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720, 960]);
  });

  it("a background or mid-turn wait is not capped", async () => {
    for (const wait of ["background", "tool"] as const) {
      const h = reported();
      h.waits.set("thr_coord", wait);
      await h.native();
      await h.clock.advanceTo(10 * MINUTE);
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
    }
  });

  it("a report seen only by the fresh read before the send refuses the refresh", async () => {
    // The cached classification still shows W1 working under a review hold of an earlier report.
    const h = reported({}, { reportedAt: null });
    h.freshContext.set("thr_coord", worker("reported", { worker: "W1", review, reportedAt: T0 - 10 * MINUTE }));
    await h.native();
    await h.clock.advanceTo(10 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toMatch(/W1 reported A1: its report reached reportedGraceMinutes/);
  });
});

describe("send-time checks never outlive the entry", () => {
  // A refresh is due at second 295; its send-time wait-state read (the second read) takes 6 seconds.
  function slowConfirm(margin: number) {
    const h = harness({ safetyMarginSeconds: margin });
    let reads = 0;
    h.waitHook = async () => {
      if (++reads === 2) await new Promise<void>((resolve) => h.clock.timers.setTimeout(resolve, 6 * SECOND));
      return "tool";
    };
    return h;
  }

  it("refuses the send when the confirmation read consumed the safety margin, and ends the lease", async () => {
    const h = slowConfirm(5);
    await h.native();
    await h.clock.advanceTo(5 * MINUTE + 2 * SECOND);
    expect(h.sent).toEqual([]);
    expect(h.warmer.status().leases).toEqual([]);
    expect(h.events().at(-1)).toBe("end: the entry expired while its refresh was being checked");
  });

  it("sends on time when the margin covers the same slow read", async () => {
    const h = slowConfirm(15);
    await h.native();
    await h.clock.advanceTo(5 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([291]);
  });

  it("still processes a refresh sent in time whose response arrives after the entry's expiry", async () => {
    const h = harness({ safetyMarginSeconds: 5 });
    h.replies.push(async () => {
      await new Promise<void>((resolve) => h.clock.timers.setTimeout(resolve, 10 * SECOND));
      return { kind: "response", status: 200, usage: hit(), outputEmpty: true, startedAt: h.clock.now() - 10 * SECOND };
    });
    await h.native();
    await h.clock.advanceTo(5 * MINUTE + 12 * SECOND);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([295]);
    expect(h.warmer.status().leases[0]).toMatchObject({ refreshes: 1 });
  });
});

describe("reported grace: fixes from review", () => {
  const WHY_A4 = "review of W3 by W4 running (A4)";
  const hold = (ref = "A2", worker = "W2") => ({ ref, worker, since: T0 });
  const never = () =>
    new ResumeHistory(Array.from({ length: 30 }, () => ({ state: "idle" as const, role: "worker" as const, waitMs: null })));
  // W1 reported A1 at T0 under a review hold (45 minutes by default).
  function reportedW1(overrides: Partial<Harness["config"]> = {}, member: Partial<Member> = {}) {
    const h = harness(overrides);
    h.history = never();
    h.context.set("thr_coord", worker("reported", { worker: "W1", review: hold(), reportedAt: T0, ...member }));
    return h;
  }

  describe("R1: lease competition applies the grace only to a genuinely idle wait", () => {
    // W3 has queued work and a review hold, and arrives at the single lease slot.
    const W3 = worker("reported", {
      worker: "W3",
      next: { ref: "A5", phase: "pending" },
      review: hold("A4", "W4"),
    });

    it.each(["tool", "background", "question"] as const)("keeps a %s wait's slot after the grace, as before the grace existed", async (wait) => {
      const h = reportedW1({ maxLeases: 1 });
      h.waits.set("thr_coord", wait);
      await h.native();
      await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([240]);
      expect(h.warmer.status().leases[0]).toMatchObject({ waitingOn: wait });
      await h.clock.advanceTo(5 * MINUTE + 30 * SECOND);
      h.context.set("thr_w3", W3);
      await h.native({ threadId: "thr_w3" });
      expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
      expect(h.events().at(-1)).toBe("skip: lease limit reached (maxLeases 1)");
    });

    it("protects a lease that has not had a first wait-state read", async () => {
      const h = reportedW1({ maxLeases: 1 });
      h.waits.set("thr_coord", "tool");
      await h.native();
      expect(h.warmer.status().leases[0]).toMatchObject({ waitingOn: null });
      h.context.set("thr_w3", W3);
      await h.native({ threadId: "thr_w3" });
      expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
    });

    it("reads the wait fresh: a lease last seen mid-turn that is now idle past its grace gives up the slot", async () => {
      const h = reportedW1({ maxLeases: 1 });
      h.waits.set("thr_coord", "tool");
      await h.native();
      await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
      expect(h.warmer.status().leases[0]).toMatchObject({ waitingOn: "tool" });
      h.waits.set("thr_coord", "idle");
      await h.clock.advanceTo(5 * MINUTE + 30 * SECOND);
      h.context.set("thr_w3", W3);
      await h.native({ threadId: "thr_w3" });
      expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_w3"]);
      expect(h.events()).toContain(`end: lease slot taken by a thread under review (${WHY_A4})`);
    });

    it("applies to the arriving thread too: an idle reported worker past its grace takes no slot, a mid-turn one does", async () => {
      for (const [wait, taken] of [["idle", false], ["tool", true]] as const) {
        const h = harness({ maxLeases: 1 });
        h.history = never();
        await h.native();
        await h.clock.advanceTo(10 * MINUTE);
        h.context.set("thr_w3", worker("reported", { worker: "W3", review: { ref: "A4", worker: "W4", since: h.clock.now() }, reportedAt: T0 }));
        h.waits.set("thr_w3", wait);
        await h.native({ threadId: "thr_w3" });
        const remaining = h.warmer.status().leases.map((lease) => lease.threadId);
        expect(remaining).toEqual([taken ? "thr_w3" : "thr_coord"]);
      }
    });
  });

  describe("R5: the arriving thread is read again after the victims' context", () => {
    // W3's report is past its grace and its review hold is live; only an idle wait loses the grace.
    const arriving = () => worker("reported", {
      worker: "W3", reportedAt: T0, review: { ref: "A4", worker: "W4", since: T0 },
    });
    async function contested(after: WaitState) {
      const h = harness({ maxLeases: 1 });
      await h.native();
      await h.clock.advanceTo(5 * MINUTE + 30 * SECOND);
      h.context.set("thr_w3", arriving());
      h.waits.set("thr_w3", "tool");
      // Reading the coordinator's current context is when W3's turn ends.
      h.readHook = async (id, fresh) => {
        if (id === "thr_coord" && fresh) h.waits.set("thr_w3", after);
        return h.context.get(id)!;
      };
      await h.native({ threadId: "thr_w3" });
      return h;
    }

    it("a worker that went idle past its grace while the victims were read takes no slot", async () => {
      const h = await contested("idle");
      expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_coord"]);
      expect(h.events().at(-1)).toBe("skip: lease limit reached (maxLeases 1)");
    });

    it("a worker still mid-turn after the victims were read keeps its protected hold and takes the slot", async () => {
      const h = await contested("tool");
      expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_w3"]);
    });
  });

  describe("R2: a later turn BB started is not capped by the earlier report", () => {
    it("a user continuation after the report gets the idle warming of an unreported wait", async () => {
      const h = reportedW1();
      h.waits.set("thr_coord", "idle");
      await h.native();
      await h.clock.advanceTo(10 * MINUTE);
      expect(h.sent).toHaveLength(0);
      h.warmer.threadStarted("thr_coord");
      await h.native();
      await h.clock.advanceTo(20 * MINUTE);
      // The continuation's own wait, from minute 10: refreshes one 5-minute entry apart.
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([840, 1080]);
    });

    it("a helper request after the report does not: no turn started, so the report still caps the wait", async () => {
      const h = reportedW1();
      h.waits.set("thr_coord", "idle");
      await h.native();
      await h.clock.advanceTo(10 * MINUTE);
      await h.native();
      await h.clock.advanceTo(30 * MINUTE);
      expect(h.sent).toHaveLength(0);
      expect(h.events().at(-1)).toMatch(/its report reached reportedGraceMinutes/);
    });

    it("after a reload, a continuation that began while the plugin was unloaded is found in BB's events", async () => {
      const h = reportedW1();
      h.waits.set("thr_coord", "idle");
      // No threadStarted: the plugin was not running. BB's latest turn/started is minute 10.
      await h.clock.advanceTo(10 * MINUTE);
      h.turnStarts.set("thr_coord", h.clock.now());
      await h.native();
      await h.clock.advanceTo(20 * MINUTE);
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([840, 1080]);
    });

    it("reads BB's events once per thread: the reporting turn's start keeps the cap, and a later start is noted", async () => {
      const h = reportedW1();
      h.waits.set("thr_coord", "idle");
      h.turnStarts.set("thr_coord", T0 - MINUTE);
      await h.native();
      await h.clock.advanceTo(10 * MINUTE);
      expect(h.sent).toHaveLength(0);
      expect(h.turnReads).toEqual(["thr_coord"]);
      h.warmer.threadStarted("thr_coord");
      await h.native();
      await h.clock.advanceTo(20 * MINUTE);
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([840, 1080]);
      expect(h.turnReads).toEqual(["thr_coord"]);
    });

    it("a turn start BB cannot tell lifts the cap this time and is read again at the next refresh", async () => {
      const h = reportedW1();
      h.waits.set("thr_coord", "idle");
      h.turnStarts.set("thr_coord", null);
      await h.native();
      await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
      // Read once for the refresh, not again for its send.
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([240]);
      expect(h.turnReads).toEqual(["thr_coord"]);
      await h.clock.advanceTo(8 * MINUTE + 30 * SECOND);
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
      expect(h.turnReads).toEqual(["thr_coord", "thr_coord"]);
    });

    describe("a turn-start read that does not answer", () => {
      // Each lookup hangs until its signal aborts, unless it is answered through `answer`.
      function stalled(h: Harness) {
        const lookups: { signal: AbortSignal; answer: (at: number) => void }[] = [];
        (h.warmer as any).deps.turnStartedAt = (_: string, signal: AbortSignal) =>
          new Promise<number>((resolve, reject) => {
            lookups.push({ signal, answer: resolve });
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        return lookups;
      }

      it("is aborted at its deadline, retried at the next refresh, and aborted again at disposal", async () => {
        const h = reportedW1();
        h.waits.set("thr_coord", "idle");
        const lookups = stalled(h);
        await h.native();
        // Read at the idle wait's first refresh decision, not at admission.
        expect(lookups).toHaveLength(0);
        await h.clock.advanceTo(240 * SECOND);
        expect(lookups.map((lookup) => lookup.signal.aborted)).toEqual([false]);
        await h.clock.advanceTo(250 * SECOND);
        // Unknown turn start: no cap, so the refresh is sent 3 seconds late.
        expect(h.sent.map((request) => request.at / SECOND)).toEqual([243]);
        expect(lookups.map((lookup) => lookup.signal.aborted)).toEqual([true]);
        await h.clock.advanceTo(485 * SECOND);
        expect(lookups.map((lookup) => lookup.signal.aborted)).toEqual([true, false]);
        h.warmer.dispose();
        expect(lookups.every((lookup) => lookup.signal.aborted)).toBe(true);
      });

      it("is aborted with its caller: disposal while pending, and a caller that is already aborted never starts one", async () => {
        const h = reportedW1();
        h.waits.set("thr_coord", "idle");
        const lookups = stalled(h);
        await h.native();
        await h.clock.advanceTo(241 * SECOND);
        expect(lookups).toHaveLength(1);
        h.warmer.dispose();
        expect(lookups[0]!.signal.aborted).toBe(true);
        const controller = new AbortController();
        controller.abort();
        await (h.warmer as any).recoverTurnStart("thr_other", controller.signal);
        expect(lookups).toHaveLength(1);
      });

      it("never lets an answer after the deadline reach the cache", async () => {
        const h = reportedW1();
        h.waits.set("thr_coord", "idle");
        const lookups = stalled(h);
        await h.native();
        // The thread is read at the refresh 240 seconds in, and the lookup's deadline is 3 seconds later.
        await h.clock.advanceTo(244 * SECOND);
        expect(lookups[0]!.signal.aborted).toBe(true);
        lookups[0]!.answer(h.clock.now() + MINUTE);
        await flush();
        // Had the late answer been noted, the next read would find a turn after the report.
        expect((h.warmer as any).turnStarts.has("thr_coord")).toBe(false);
      });
    });

    it("the reporting turn's own start is not a later turn", async () => {
      const h = reportedW1();
      h.waits.set("thr_coord", "idle");
      h.warmer.threadStarted("thr_coord");
      await h.native();
      await h.clock.advanceTo(30 * MINUTE);
      expect(h.sent).toHaveLength(0);
    });
  });

  describe("R3: the send uses what the thread waits on at the send", () => {
    // The cached classification has not seen the report; the fresh read just before the send does,
    // and the thread changes state while it is read.
    function racing(from: WaitState, to: WaitState, config: Partial<Harness["config"]> = { reportedGraceMinutes: 0 }) {
      const h = reportedW1(config, { reportedAt: null });
      h.waits.set("thr_coord", from);
      h.readHook = async (threadId, fresh) => {
        if (fresh) h.waits.set(threadId, to);
        return fresh
          ? worker("reported", { worker: "W1", review: hold(), reportedAt: T0 })
          : h.context.get(threadId)!;
      };
      return h;
    }

    it("a tool wait that went idle during the read honours a zero grace", async () => {
      const h = racing("tool", "idle");
      await h.native();
      await h.clock.advanceTo(10 * MINUTE);
      expect(h.sent).toHaveLength(0);
      expect(h.events().at(-1)).toMatch(/^skip: refresh not sent: stopped \(idle\): W1 reported A1: its report reached reportedGraceMinutes/);
    });

    it("an idle wait that went back to work during the read is still refreshed", async () => {
      const h = racing("idle", "tool");
      await h.native();
      await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
      expect(h.sent.map((request) => request.at / SECOND)).toEqual([240]);
      expect(h.warmer.status().leases[0]).toMatchObject({ waitingOn: "tool" });
    });

    it("a wait BB cannot read at the send refuses it", async () => {
      const h = racing("tool", "tool");
      h.waitHook = (() => {
        let reads = 0;
        return async () => (++reads === 1 ? "tool" : null);
      })();
      await h.native();
      await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
      expect(h.sent).toHaveLength(0);
      expect(h.events().at(-1)).toBe("skip: refresh not sent: BB could not tell what the thread waits on");
    });

    it("a background task that ended during the read still ends the lease", async () => {
      const h = racing("background", "idle", { reportedGraceMinutes: 5 });
      // No review holds the thread, in either read.
      h.readHook = async (threadId, fresh) => {
        if (fresh) h.waits.set(threadId, "idle");
        return worker("reported", { worker: "W1" });
      };
      h.waits.set("thr_coord", "background");
      await h.native();
      await h.clock.advanceTo(4 * MINUTE + 30 * SECOND);
      expect(h.sent).toHaveLength(0);
      expect(h.events().at(-1)).toBe("skip: refresh not sent: stopped: the background task ended without the thread resuming");
    });
  });
});

describe("reported grace: BB reads only where the grace applies, and none outlives its wait", () => {
  const never = () =>
    new ResumeHistory(Array.from({ length: 30 }, () => ({ state: "idle" as const, role: "worker" as const, waitMs: null })));
  // Each call hangs until its signal aborts, unless answered through `answer`.
  function hanging<T>() {
    const calls: { signal: AbortSignal; answer: (value: T) => void }[] = [];
    const call = (_: string, signal: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        calls.push({ signal, answer: resolve });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    return { calls, call };
  }

  it.each([
    ["a reviewer waiting on a tool", { role: "review" as const }, "tool"],
    ["a worker with a next assignment", { next: { ref: "A3", phase: "pending" as const } }, "idle"],
    ["a worker waiting on a tool", {}, "tool"],
    ["a worker waiting on a question", {}, "question"],
    ["a worker waiting on a background task", {}, "background"],
  ] as const)("%s never waits on the turn history: a 5-second margin still sends on time", async (_name, member, wait) => {
    const h = harness({ safetyMarginSeconds: 5 });
    h.history = never();
    h.context.set(
      "thr_coord",
      worker("reported", { worker: "W1", review: { ref: "A2", worker: "W2", since: T0 }, reportedAt: T0, ...member }),
    );
    h.waits.set("thr_coord", wait);
    const history = hanging<number>();
    (h.warmer as any).deps.turnStartedAt = history.call;
    await h.native();
    await h.clock.advanceTo(5 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([295]);
    expect(history.calls).toHaveLength(0);
  });

  it("at the lease limit, aborts each wait-state read at its own deadline, before admission and disposal", async () => {
    const h = harness({ maxLeases: 1 });
    // The incumbent W1 reported and no review holds it; the arriving W3 is held by its review.
    h.context.set("thr_coord", worker("reported", { worker: "W1", reportedAt: T0 }));
    await h.native();
    const states = hanging<WaitState>();
    (h.warmer as any).deps.waitState = states.call;
    h.context.set(
      "thr_w3",
      worker("reported", { worker: "W3", reportedAt: T0, review: { ref: "A4", worker: "W4", since: T0 } }),
    );
    await h.native({ threadId: "thr_w3" });
    expect(states.calls.length).toBeGreaterThan(0);
    // Every read BB cannot answer is unknown, so no lease is capped: W3's hold takes W1's slot.
    await h.clock.advanceTo(2 * MINUTE);
    expect(h.warmer.status().leases.map((lease) => lease.threadId)).toEqual(["thr_w3"]);
    expect(states.calls.map((call) => call.signal.aborted).every(Boolean)).toBe(true);
    h.warmer.dispose();
    expect(states.calls.map((call) => call.signal.aborted).every(Boolean)).toBe(true);
  });

  it("never caches a turn start that answered just before its caller gave up", async () => {
    const h = harness();
    const history = hanging<number>();
    (h.warmer as any).deps.turnStartedAt = history.call;
    const caller = new AbortController();
    const recovering = (h.warmer as any).recoverTurnStart("thr_coord", caller.signal);
    // The answer arrives, and the caller is cancelled before the lookup's continuation runs.
    history.calls[0]!.answer(T0 - MINUTE);
    caller.abort();
    await recovering;
    expect((h.warmer as any).turnStarts.has("thr_coord")).toBe(false);
    // So the next caller reads again, and keeps that answer.
    const retry = (h.warmer as any).recoverTurnStart("thr_coord", new AbortController().signal);
    history.calls[1]!.answer(T0 - MINUTE);
    await retry;
    expect(history.calls).toHaveLength(2);
    expect((h.warmer as any).turnStarts.get("thr_coord")).toBe(T0 - MINUTE);
  });
});
