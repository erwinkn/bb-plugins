import { describe, expect, it } from "vitest";
import type { CacheUsage } from "./cache-usage.js";
import type { ModelFamily } from "./contracts.js";
import type { ThreadContext } from "./thread-context.js";
import {
  CacheWarmer,
  type KeepAliveRequest,
  type KeepAliveResult,
  type NativeRequestStart,
} from "./warming.js";
import {
  longestWindowMinutes,
  warmingConfigSchema,
  type WarmingConfig,
} from "./warming-config.js";
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
  assignment: null,
  next: null,
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
  readHook: ((threadId: string, fresh: boolean) => Promise<ThreadContext>) | null;
  sessionHook: ((threadId: string) => void) | null;
  // BB's current provider session per thread, as threads.context reports it.
  sessions: Map<string, string>;
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
  const sent: Harness["sent"] = [];
  const replies: Harness["replies"] = [];
  const warmer = new CacheWarmer({
    now: clock.now,
    timers: clock.timers,
    config: () => config,
    switchThreshold: () => 0.98,
    readContext: async (threadId, _signal, options) => {
      contextReads.push({ threadId, fresh: options?.fresh === true });
      if (h.readHook !== null) return h.readHook(threadId, options?.fresh === true);
      return (
        (options?.fresh ? freshContext.get(threadId) : undefined) ??
        context.get(threadId) ?? { kind: "unknown", reason: "no stub" }
      );
    },
    threadSession: async (threadId) => {
      h.sessionHook?.(threadId);
      return sessions.get(threadId) ?? null;
    },
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
  it("refreshes a 5m entry at start + TTL - margin until it outlasts completion + window", async () => {
    const h = harness();
    await h.native({ durationMs: 30 * SECOND });
    // Entry written at T0 lasts until T0+5m; the coordinator window ends at T0+30s+20m.
    expect(h.warmer.status().leases[0]).toMatchObject({
      ttl: "5m",
      coveredUntil: T0 + 5 * MINUTE,
      nextRefreshAt: T0 + 4 * MINUTE,
      prefixTokens: 100_000,
    });
    await h.clock.advanceTo(60 * MINUTE);
    // Each confirmed refresh starts a new 5m lifetime from its own start; the deadline never moves.
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720, 960]);
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: the cache entry now lasts until the deadline");
    expect(h.warmer.status().totals).toMatchObject({
      leasesStarted: 1,
      refreshesSent: 4,
      refreshesConfirmed: 4,
      cacheMisses: 0,
      refreshCacheReadTokens: 400_000,
      refreshOutputTokens: 0,
    });
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

  it("does not lease a 1h entry that already outlasts every window, and never reads context for it", async () => {
    const h = harness();
    await h.native({ body: requestBody({ messageTtl: "1h" }) });
    expect(h.warmer.status().leases).toHaveLength(0);
    expect(h.events()).toContain("skip: the 1h cache entry already outlasts every warming window");
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
    const hour = harness();
    await hour.native({ body: requestBody({ systemTtl: "5m", messageTtl: null, automatic: "1h" }) });
    expect(hour.warmer.status().leases).toHaveLength(0);
  });

  it("never extends the deadline: a 10-minute window gets two refreshes even with a high cap", async () => {
    const h = harness({ maxRefreshesPerLease: 30 });
    h.context.set("thr_coord", worker("reported"));
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(60 * MINUTE);
    // Deadline T0+30s+10m = 630 s; covered 540 s after the first refresh, 780 s after the second.
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
    expect(h.events()).toContain(
      "end: the cache entry now lasts until the deadline",
    );
  });

  it("stops at maxRefreshesPerLease before the deadline and says so", async () => {
    const h = harness({ maxRefreshesPerLease: 2 });
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(2);
    expect(h.events().at(-1)).toBe("end: refresh cap reached (maxRefreshesPerLease 2)");
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
    ["retired worker", worker("accepted", { state: "retired" }), "skip: no warming window for work retired"],
    ["stopped worker", worker("active", { state: "stopped" }), "skip: no warming window for work stopped"],
    ["former (replaced) worker", worker(null, { state: "former" }), "skip: no warming window for work former"],
    ["finished (accepted) worker", worker("accepted"), "skip: no warming window for worker accepted"],
    ["adhoc thread", worker(null, { memberKind: "adhoc", role: "adhoc" }), "skip: no warming window for adhoc Initiative thread"],
    ["archived Initiative", { ...COORDINATOR, archived: true }, "skip: no warming window for archived Initiative"],
    ["pending delivery", worker("pending"), "skip: no warming window for assignment A1 pending delivery"],
    ["undelivered next assignment", worker("reported", { next: { ref: "A2", phase: "pending" } }), "skip: no warming window for next assignment A2 not delivered yet"],
    ["thread without a Projects record", { kind: "none" }, "skip: skipped: Projects has no record of this thread; a standalone thread cannot be told from an unknown or unlinked one"],
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
    expect(h.events().at(-1)).toBe("skip: refresh not sent: no warming window for work retired");
  });

  it.each([
    ["Stop", worker("active", { state: "stopped" }), "no warming window for work stopped"],
    ["coordinator replacement", { ...COORDINATOR, state: "former" as const }, "no warming window for coordinator former"],
    ["acceptance", worker("accepted"), "no warming window for worker accepted"],
    ["a new undelivered assignment", worker("active", { next: { ref: "A2", phase: "pending" } }), "no warming window for next assignment A2 not delivered yet"],
    ["the record disappearing", { kind: "none" as const }, "skipped: Projects has no record of this thread; a standalone thread cannot be told from an unknown or unlinked one"],
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
    expect(h.events().at(-1)).toBe("skip: refresh not sent: no warming window for coordinator former");
  });

  it("uses the 15-minute window for an Opus worker mid-assignment", async () => {
    const h = harness();
    h.context.set("thr_coord", worker("active"));
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(60 * MINUTE);
    // Deadline 930 s: covered 540, 780, then 1020 s.
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720]);
    expect(h.warmer.status().totals.refreshesConfirmed).toBe(3);
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
    expect(h.events().at(-1)).toBe("end: no warming window for coordinator former");
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
    expect(h.warmer.status().totals).toMatchObject({ refreshesPlanned: 4, refreshesSent: 0 });
    expect(h.events().filter((event) => event.startsWith("refresh: dry run"))).toHaveLength(4);
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

describe("A227 2: reviewers have their own window", () => {
  it("defaults to 0 for a reviewer mid-assignment or reported, never the worker 15/10", async () => {
    for (const phase of ["active", "reported"] as const) {
      const h = harness();
      h.context.set("thr_coord", reviewer(phase));
      await h.native();
      await h.clock.advanceTo(60 * MINUTE);
      expect(h.sent).toHaveLength(0);
      expect(h.events().at(-1)).toBe(
        `skip: no warming window for reviewer ${phase === "active" ? "mid-assignment" : "reported"}`,
      );
    }
  });

  it("reviewerMinutes sets the reviewer window, and the worker windows stay as they are", async () => {
    const h = harness({ reviewerMinutes: 10 });
    h.context.set("thr_coord", reviewer("active"));
    await h.native({ durationMs: 30 * SECOND });
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
    const w = harness({ reviewerMinutes: 0 });
    w.context.set("thr_coord", worker("active"));
    await w.native({ durationMs: 30 * SECOND });
    await w.clock.advanceTo(60 * MINUTE);
    expect(w.sent.map((request) => request.at / SECOND)).toEqual([240, 480, 720]);
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
    const h = harness({ maxLeases: 2 });
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

describe("A227 6: inactive standaloneMinutes", () => {
  it("does not raise the 1h threshold: a 1h entry still skips without a slot or a context read", async () => {
    const h = harness({ standaloneMinutes: 60 });
    await h.native({ body: requestBody({ messageTtl: "1h" }) });
    expect(h.warmer.status()).toMatchObject({ leases: [], admissions: [], retainedBodyBytes: 0 });
    expect(h.events()).toContain("skip: the 1h cache entry already outlasts every warming window");
    expect(h.contextReads).toHaveLength(0);
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
    expect(h.events().at(-1)).toBe("skip: no warming window for paused Initiative");
    const fresh = harness();
    fresh.freshContext.set("thr_coord", { ...COORDINATOR, paused: true });
    await fresh.native();
    await fresh.clock.advanceTo(60 * MINUTE);
    expect(fresh.sent).toHaveLength(0);
    expect(fresh.events().at(-1)).toBe("skip: refresh not sent: no warming window for paused Initiative");
  });

  it("off keeps the role windows through a pause", async () => {
    const h = harness({ pauseStopsWarming: false });
    h.context.set("thr_coord", { ...COORDINATOR, paused: true });
    await h.native();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(4);
  });
});

// Starts a same-session native request now and finishes it later, so tests can interleave starts
// and completions the way concurrent Claude Code requests do.
function overlapping(
  h: Harness,
  options: { family?: ModelFamily; turn?: string; model?: string } = {},
) {
  const family = options.family ?? "opus";
  const observation = h.warmer.observe({ sessionId: "s-thr_coord", parentSessionId: null, family });
  const startedAt = h.clock.now();
  return {
    async finish() {
      const tap = observation?.responded({
        accountId: ACCOUNT,
        url: URL_,
        body: requestBody({ model: options.model, turn: options.turn }),
        headers: new Headers(),
        startedAt,
        status: 200,
        contentType: "text/event-stream",
      });
      tap?.push(sse(NATIVE_USAGE));
      tap?.finish(true);
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
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(4);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain("final");
  });

  it("Q2: the same pair with the helper started first gives the same lease", async () => {
    const h = linked();
    const haiku = overlapping(h, HAIKU);
    const opus = overlapping(h, { turn: "final" });
    await haiku.finish();
    await opus.finish();
    expect(h.warmer.status().leases).toHaveLength(1);
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(4);
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
      "skip: a newer request in the session that could start a lease ended first",
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
      "skip: a newer request in the session that could start a lease ended first",
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

describe("D362: reviewerAcceptedMinutes", () => {
  it("an old record defaults it to 0 and the longest window counts it", () => {
    const old = warmingConfigSchema.parse({ mode: "warm", workerAcceptedMinutes: 10 });
    expect(old.reviewerAcceptedMinutes).toBe(0);
    expect(longestWindowMinutes(warmingConfigSchema.parse({ reviewerAcceptedMinutes: 45 }))).toBe(45);
  });

  it("worker grace does not warm accepted reviewers; their own window does", async () => {
    const grace = harness({ workerAcceptedMinutes: 10 });
    grace.context.set("thr_coord", reviewer("accepted"));
    await grace.native();
    await grace.clock.advanceTo(60 * MINUTE);
    expect(grace.sent).toHaveLength(0);
    expect(grace.events().at(-1)).toBe("skip: no warming window for reviewer accepted");
    const own = harness({ reviewerAcceptedMinutes: 10 });
    own.context.set("thr_coord", reviewer("accepted"));
    await own.native({ durationMs: 30 * SECOND });
    await own.clock.advanceTo(60 * MINUTE);
    expect(own.sent.map((request) => request.at / SECOND)).toEqual([240, 480]);
  });

  it("a 1h entry is not pre-skipped when only the accepted reviewer window reaches an hour", async () => {
    const h = harness({ reviewerAcceptedMinutes: 60 });
    h.context.set("thr_coord", reviewer("accepted"));
    await h.native({ body: requestBody({ messageTtl: "1h" }) });
    expect(h.events().join("\n")).not.toContain("already outlasts every warming window");
    expect(h.warmer.status().leases).toHaveLength(1);
  });

  it("lowering it to 0 while a lease waits refuses the next refresh", async () => {
    const h = harness({ reviewerAcceptedMinutes: 10 });
    h.context.set("thr_coord", reviewer("accepted"));
    await h.native();
    expect(h.warmer.status().leases).toHaveLength(1);
    h.config.reviewerAcceptedMinutes = 0;
    h.warmer.reconcile();
    await h.clock.advanceTo(60 * MINUTE);
    expect(h.sent).toHaveLength(0);
    expect(h.events().at(-1)).toBe("end: no warming window for reviewer accepted");
  });
});
