import { z } from "zod";
import type { ModelFamily } from "./contracts.js";
import {
  CACHE_TTL_MS,
  createUsageTap,
  describeClaudeRequest,
  keepAliveBody,
  type CacheTtl,
  type CacheUsage,
} from "./cache-usage.js";
import type { ThreadContext } from "./thread-context.js";
import { warmingRole } from "./thread-context.js";
import {
  effectiveWarmingQuotaReserve,
  warmingModeSchema,
  warmingRoleSchema,
  type WarmingConfig,
  type WarmingFamily,
} from "./warming-config.js";
import {
  decideRefresh,
  waitStates,
  type ResumeHistory,
  type WaitState,
  type WarmingRole,
} from "./warming-economics.js";

// Cache warming keeps an idle thread's prompt cache entry alive by re-sending the thread's last
// native request with max_tokens 0, on the same account, shortly before the entry expires.
//
// Timing, all from observed requests (never from BB turn ends):
//   wait start   = completion of the session's last native request
//   coveredUntil = start of the last request that wrote or read the entry + its TTL
// A refresh is due at coveredUntil - safetyMargin. A refresh that reads the whole prefix moves
// coveredUntil to its own start + TTL; only a native request ends the wait. At every due time the
// warmer reads what the thread waits on (a tool mid-turn, a background task, a question, nothing)
// and refreshes only while that is expected to pay (warming-economics.ts), and never once the wait
// is maxWaitMinutes old. The lease ends on the first refresh that would not pay, or on the first
// condition it cannot verify. Every lease end and every skip that leaves a wait unwarmed is also
// written to the usage ledger with its reason (recordOutcome).
//
// Attribution adds nothing to a thread's environment. Leases are keyed by the Claude Code session
// id in each request's metadata.user_id, which is the providerThreadId of the thread's latest
// thread/identity event in BB. The server links a thread to its session from that event on thread
// lifecycle events, as soon as a request arrives on a session no thread is linked to
// (resolveSession), and again immediately before every keep-alive.
//
// Admission: a completed request takes a lease slot, and keeps its body, only once its session is
// linked to a thread and that thread's Initiative context gives it a role that may be warmed.
// Until then it waits as an admission, bounded in count (maxLeases) and time (LINK_WAIT_MS), and
// any newer request in the session, a turn start or a settings change drops it.
//
// Subagents and helpers: Claude Code 2.1.287 sets metadata.user_id.parent_session_id from its
// agent-team context (getParentSessionId), so it marks a teammate session, not an ordinary Task
// subagent or helper. Those appear to share the main session id with no parent, and nothing in the
// request tells them apart. A same-session subagent or helper request therefore ends the lease like
// any native request, including a helper sent after the turn's final main request
// (tool_use_summary_generation, generate_session_title, prompt_suggestion, extract_memories), and
// if one in an enabled family is the session's last completed request its body becomes the
// lease's body. A refresh of that body is still a max_tokens 0 cache read with no output. Which of
// these real sessions send is a live check for root.

const HOUR_MS = 60 * 60_000;
const CONCURRENCY_RETRY_MS = 1_000;
const MAX_SESSION_LINKS = 1_024;
// How long a completed request waits for BB to link its session to a thread. thread.idle reads the
// link as soon as the turn ends.
const LINK_WAIT_MS = 60_000;
// How long the warmer waits for BB to say what a thread waits on before it gives up on the refresh.
const WAIT_STATE_TIMEOUT_MS = 10_000;
const AMBIGUOUS = Symbol("ambiguous");

export interface WarmingTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realWarmingTimers: WarmingTimers = {
  setTimeout(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Known when the native request arrives: the Claude Code session ids from metadata.user_id.
// parentSessionId is Claude Code's agent-team lineage, not a subagent marker.
export interface NativeRequestStart {
  sessionId: string | null;
  parentSessionId: string | null;
  family: ModelFamily;
}

// The upstream attempt whose response reached the client.
export interface NativeResponse {
  accountId: string;
  url: string;
  // The exact upstream body bytes, after the account rewrite.
  body: Uint8Array;
  // Replayable caller headers only: never credentials.
  headers: Headers;
  startedAt: number;
  status: number;
  contentType: string | null;
}

export interface ResponseTap {
  push(chunk: Uint8Array): void;
  finish(completed: boolean): void;
}

export interface NativeObservation {
  responded(response: NativeResponse): ResponseTap;
  abandon(): void;
}

export interface KeepAliveRequest {
  // The Claude Code session the lease keeps warm; the usage ledger attributes the refresh to it.
  sessionId: string;
  accountId: string;
  family: ModelFamily;
  url: string;
  body: Uint8Array;
  headers: Headers;
  reserve: number;
  timeoutMs: number;
  // Fresh checks run after credential preparation and immediately before the vendor request.
  // A non-null reason refuses the send.
  confirm(signal: AbortSignal): Promise<string | null>;
}

export type KeepAliveResult =
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; startedAt: number }
  | {
      kind: "response";
      status: number;
      usage: CacheUsage | null;
      outputEmpty: boolean | null;
      startedAt: number;
    };

export interface WarmerDeps {
  now(): number;
  timers: WarmingTimers;
  config(): WarmingConfig;
  switchThreshold(): number;
  readContext(
    threadId: string,
    signal: AbortSignal,
    options?: { fresh?: boolean },
  ): Promise<ThreadContext>;
  // BB's current record of the thread's provider session, read fresh.
  threadSession(threadId: string, signal: AbortSignal): Promise<string | null>;
  // Asks BB, in the background, which thread runs a session no thread is linked to yet; the answer
  // arrives as linkSession. Called once per request on such a session; the server rate-limits it.
  resolveSession(sessionId: string): void;
  // What the thread waits on now, read fresh; null when BB cannot tell.
  waitState(threadId: string, signal: AbortSignal): Promise<WaitState | null>;
  // How long waits of each state and role have lasted.
  resumeHistory(): ResumeHistory;
  // A lease that ended, or a wait left unwarmed, with the reason.
  recordOutcome(outcome: WarmingOutcome): void;
  keepAlive(
    request: KeepAliveRequest,
    signal: AbortSignal,
  ): Promise<KeepAliveResult>;
}

// The newest usable eligible completion of a session that was skipped only because another
// request of the session was still in flight. It already passed every lease gate, holds a body only
// in warm mode, and lives at most until its refresh would be due.
interface HeldCompletion {
  sequence: number;
  lease: Lease;
  timer: unknown;
}

// Why a wait ended up warmed for as long as it was, for the usage ledger.
export interface WarmingOutcome {
  at: number;
  sessionId: string;
  threadId: string | null;
  model: string | null;
  role: WarmingRole | null;
  // What the thread waited on at the first refresh decision, null when none was reached.
  state: WaitState | null;
  waitStartedAt: number;
  firstDecisionAt: number | null;
  prefixTokens: number;
  ttl: CacheTtl | null;
  refreshes: number;
  kind: "end" | "skip";
  reason: string;
}

interface Lease {
  sessionId: string;
  accountId: string;
  model: string | null;
  family: ModelFamily;
  ttl: CacheTtl;
  url: string;
  // Held only in warm mode, only while the lease lives.
  body: Uint8Array | null;
  headers: Headers;
  bodyHash: string;
  bodyBytes: number;
  prefixTokens: number;
  nativeStartedAt: number;
  // When the wait started.
  nativeCompletedAt: number;
  coveredUntil: number;
  role: WarmingRole | null;
  // How Initiatives describes the thread, for status.
  label: string | null;
  // What the thread waited on at the latest and at the first refresh decision.
  waitingOn: WaitState | null;
  firstWaitingOn: WaitState | null;
  firstDecisionAt: number | null;
  resumeChance: number | null;
  // The latest decision's expected saving, in input-equivalent tokens.
  expectedSaving: number | null;
  refreshes: number;
  nextRefreshAt: number | null;
  state: "waiting" | "checking" | "refreshing";
  dryRun: boolean;
  timer: unknown;
  controller: AbortController | null;
  ended: boolean;
}

// A completed request waiting for its session's link and its thread's classification. It holds
// no lease slot.
interface Admission {
  lease: Lease;
  state: "linking" | "classifying";
  since: number;
  timer: unknown;
  controller: AbortController;
}

const eventKindSchema = z.enum(["native", "skip", "lease", "refresh", "end"]);

const warmingEventSchema = z
  .object({
    at: z.number().int(),
    kind: eventKindSchema,
    threadId: z.string().nullable(),
    accountId: z.string().nullable(),
    model: z.string().nullable(),
    ttl: z.enum(["5m", "1h"]).nullable(),
    message: z.string(),
  })
  .strict();

export type WarmingEvent = z.infer<typeof warmingEventSchema>;

export const warmingStatusSchema = z
  .object({
    mode: warmingModeSchema,
    leases: z.array(
      z
        .object({
          sessionId: z.string(),
          threadId: z.string().nullable(),
          accountId: z.string(),
          model: z.string().nullable(),
          ttl: z.enum(["5m", "1h"]),
          bodyHash: z.string(),
          prefixTokens: z.number(),
          nativeStartedAt: z.number().int(),
          nativeCompletedAt: z.number().int(),
          coveredUntil: z.number().int(),
          role: warmingRoleSchema.nullable(),
          label: z.string().nullable(),
          waitingOn: z.enum(waitStates).nullable(),
          resumeChance: z.number().nullable(),
          expectedSaving: z.number().nullable(),
          refreshes: z.number().int(),
          nextRefreshAt: z.number().int().nullable(),
          state: z.enum(["waiting", "checking", "refreshing"]),
          dryRun: z.boolean(),
        })
        .strict(),
    ),
    admissions: z.array(
      z
        .object({
          sessionId: z.string(),
          threadId: z.string().nullable(),
          state: z.enum(["linking", "classifying"]),
          since: z.number().int(),
        })
        .strict(),
    ),
    totals: z
      .object({
        nativeObserved: z.number().int(),
        leasesStarted: z.number().int(),
        refreshesPlanned: z.number().int(),
        refreshesSent: z.number().int(),
        refreshesConfirmed: z.number().int(),
        cacheMisses: z.number().int(),
        refreshCacheReadTokens: z.number(),
        refreshCacheWriteTokens: z.number(),
        refreshInputTokens: z.number(),
        refreshOutputTokens: z.number(),
      })
      .strict(),
    retainedBodyBytes: z.number().int(),
    since: z.number().int(),
    events: z.array(warmingEventSchema),
  })
  .strict();

export type WarmingStatus = z.infer<typeof warmingStatusSchema>;

export class CacheWarmer {
  // Keyed by Claude Code session id.
  private readonly leases = new Map<string, Lease>();
  private readonly admissions = new Map<string, Admission>();
  private readonly sessionThreads = new Map<string, string | typeof AMBIGUOUS>();
  private readonly threadSessions = new Map<string, string>();
  // Per session: the start sequence of every native request in flight, of every model family; the
  // starts that could themselves lease (no parent session, enabled family) and have not ended
  // without a usable response; how the latest eligible one that did end that way failed; and the
  // newest usable eligible completion skipped while another request still ran. All reset once
  // nothing is in flight. Held completions are bounded by maxLeases and expire.
  private readonly inFlight = new Map<string, Set<number>>();
  private readonly eligibleStarts = new Map<string, Set<number>>();
  private readonly failures = new Map<string, { sequence: number; why: string }>();
  private readonly held = new Map<string, HeldCompletion>();
  private sequence = 0;
  private refreshing = 0;
  private refreshTimes: number[] = [];
  private events: WarmingEvent[] = [];
  private disposed = false;
  private readonly since: number;
  private totals: WarmingStatus["totals"] = {
    nativeObserved: 0,
    leasesStarted: 0,
    refreshesPlanned: 0,
    refreshesSent: 0,
    refreshesConfirmed: 0,
    cacheMisses: 0,
    refreshCacheReadTokens: 0,
    refreshCacheWriteTokens: 0,
    refreshInputTokens: 0,
    refreshOutputTokens: 0,
  };

  constructor(private readonly deps: WarmerDeps) {
    this.since = deps.now();
  }

  active(): boolean {
    return !this.disposed && this.deps.config().mode !== "off";
  }

  // Called when a native Claude Messages request arrives. Any request with a session id, in any
  // model family and with or without a parent session, ends at once the lease and admission of its
  // session, of its parent session, and of every session linked to the same thread: native traffic
  // always wins. Only a request with no parent session in an enabled family can start the next
  // lease, from its own completion, and only once nothing else in its session is in flight.
  //
  // A newer request that already finished blocks an older completion only if it could have leased
  // itself: its prefix is the fresher one, and it was skipped while the older request still ran.
  // A finished request that could never lease (a helper in another family, an agent-team request)
  // does not, so the turn's last eligible request leases whatever order the two started in.
  // Neither does an eligible request that ended without a usable response (aborted, failed,
  // non-2xx): the newest usable eligible completion skipped while other requests ran is held, and
  // once nothing in the session is in flight, it leases if one of those requests failed and no
  // newer eligible request succeeded.
  observe(start: NativeRequestStart): NativeObservation | null {
    if (!this.active()) return null;
    this.totals.nativeObserved += 1;
    const session = start.sessionId;
    let sequence = 0;
    if (session !== null) {
      if (!this.sessionThreads.has(session)) this.deps.resolveSession(session);
      this.preempt(
        [session, start.parentSessionId],
        "a native request on the thread took over",
      );
      sequence = ++this.sequence;
      const running = this.inFlight.get(session) ?? new Set<number>();
      running.add(sequence);
      this.inFlight.set(session, running);
      if (this.couldLease(start)) {
        const eligible = this.eligibleStarts.get(session) ?? new Set<number>();
        eligible.add(sequence);
        this.eligibleStarts.set(session, eligible);
      }
    }
    let finished = false;
    const finish = (
      response: NativeResponse | null,
      usage: CacheUsage | null,
      completed: boolean,
    ) => {
      if (finished) return;
      finished = true;
      let busy: string | null = null;
      let hold = false;
      let resume: { held: HeldCompletion; failure: { sequence: number; why: string } } | null = null;
      if (session !== null) {
        this.pruneHeld();
        const usable =
          response !== null &&
          completed &&
          response.status >= 200 &&
          response.status < 300;
        const eligible = this.eligibleStarts.get(session);
        const wasEligible = eligible?.has(sequence) ?? false;
        // A request without a usable response can never be the fresher prefix.
        if (!usable && wasEligible) {
          eligible!.delete(sequence);
          this.failures.set(session, {
            sequence,
            why: response === null ? "ended without a response" : !completed ? "response did not complete" : `HTTP ${response.status}`,
          });
        }
        const newest = eligible?.size ? Math.max(...eligible) : 0;
        const running = this.inFlight.get(session);
        running?.delete(sequence);
        if (running !== undefined && running.size > 0) {
          busy =
            Math.max(...running) > sequence
              ? "a newer native request in the session is in flight"
              : "an older native request in the session is still in flight";
          // Kept until the session settles, in case the requests still running fail.
          hold = usable && wasEligible && (this.held.get(session)?.sequence ?? 0) < sequence;
        } else {
          if (newest > sequence)
            busy =
              "a newer request in the session that could start a lease finished first";
          // An eligible request failed and no newer eligible one succeeded. (A completion that
          // waited only on requests that could never lease, or on ones that succeeded, stays
          // skipped, as before.)
          const held = this.held.get(session);
          const failure = this.failures.get(session);
          if (held !== undefined && failure !== undefined && held.sequence === newest)
            resume = { held, failure };
          this.inFlight.delete(session);
          this.eligibleStarts.delete(session);
          this.failures.delete(session);
          this.dropHeld(session);
        }
      }
      this.afterNative(start, busy, response, usage, completed, hold ? sequence : null);
      if (resume !== null) this.resumeHeld(resume.held, resume.failure);
    };
    return {
      responded: (response) => {
        const tap = createUsageTap(response.contentType);
        return {
          push: (chunk) => {
            if (!finished) tap.push(chunk);
          },
          finish: (completed) =>
            finish(response, completed ? tap.usage() : null, completed),
        };
      },
      abandon: () => finish(null, null, false),
    };
  }

  // Records BB's link between a thread and its current Claude Code session. A thread that moved to a
  // new session ends the old session's lease; a session claimed by two threads is ambiguous. A
  // request waiting for this link is classified now.
  linkSession(threadId: string, sessionId: string): void {
    const previous = this.threadSessions.get(threadId);
    if (previous !== undefined && previous !== sessionId) {
      if (this.sessionThreads.get(previous) === threadId)
        this.sessionThreads.delete(previous);
      const stale = this.leases.get(previous);
      if (stale !== undefined)
        this.endLease(stale, "the thread moved to a newer Claude session");
      const waiting = this.admissions.get(previous);
      if (waiting !== undefined)
        this.dropAdmission(waiting, "the thread moved to a newer Claude session");
    }
    const owner = this.sessionThreads.get(sessionId);
    this.sessionThreads.delete(sessionId);
    this.sessionThreads.set(
      sessionId,
      owner === undefined || owner === threadId ? threadId : AMBIGUOUS,
    );
    this.threadSessions.delete(threadId);
    this.threadSessions.set(threadId, sessionId);
    while (this.sessionThreads.size > MAX_SESSION_LINKS) {
      const oldest = this.sessionThreads.keys().next();
      if (!oldest.done) this.sessionThreads.delete(oldest.value);
    }
    while (this.threadSessions.size > MAX_SESSION_LINKS) {
      const oldest = this.threadSessions.keys().next();
      if (!oldest.done) this.threadSessions.delete(oldest.value);
    }
    const admission = this.admissions.get(sessionId);
    if (admission !== undefined && admission.state === "linking")
      void this.classify(admission);
  }

  // BB reports that the thread started a turn. Every lease and admission linked to it ends before
  // anything re-reads the session link: BB's snapshot may still name the previous session while
  // the new turn runs on another one.
  threadStarted(threadId: string): void {
    const reason = "the thread started a new turn";
    // The thread's last known session counts even if another thread has since claimed it.
    const known = this.threadSessions.get(threadId);
    const hit = (session: string) =>
      session === known || this.linkedThread(session) === threadId;
    for (const lease of [...this.leases.values()])
      if (hit(lease.sessionId)) this.endLease(lease, reason);
    for (const admission of [...this.admissions.values()])
      if (hit(admission.lease.sessionId)) this.dropAdmission(admission, reason);
    for (const session of [...this.held.keys()]) if (hit(session)) this.dropHeld(session);
  }

  // Applies a settings change at once: leases and admissions the current mode or model families
  // no longer allow end, and an in-flight refresh of theirs is aborted.
  reconcile(): void {
    const config = this.deps.config();
    for (const lease of [...this.leases.values()]) {
      const blocked = this.gate(lease, config);
      if (blocked !== null) this.endLease(lease, blocked);
    }
    for (const admission of [...this.admissions.values()]) {
      const blocked = this.gate(admission.lease, config);
      if (blocked !== null) this.dropAdmission(admission, blocked);
    }
  }

  cancelThread(threadId: string, reason: string): void {
    for (const lease of [...this.leases.values()]) {
      if (this.sessionThreads.get(lease.sessionId) === threadId)
        this.endLease(lease, reason);
    }
    for (const admission of [...this.admissions.values()]) {
      if (this.sessionThreads.get(admission.lease.sessionId) === threadId)
        this.dropAdmission(admission, reason);
    }
    const session = this.threadSessions.get(threadId);
    if (session !== undefined) this.dropHeld(session);
    if (session !== undefined && this.sessionThreads.get(session) === threadId)
      this.sessionThreads.delete(session);
    this.threadSessions.delete(threadId);
  }

  cancelAll(reason: string): void {
    for (const session of [...this.held.keys()]) this.dropHeld(session);
    for (const lease of [...this.leases.values()]) this.endLease(lease, reason);
    for (const admission of [...this.admissions.values()])
      this.dropAdmission(admission, reason);
  }

  dispose(): void {
    this.cancelAll("Account Pooler stopped");
    this.disposed = true;
  }

  status(): WarmingStatus {
    this.pruneEvents();
    let retainedBodyBytes = 0;
    for (const lease of this.leases.values())
      retainedBodyBytes += lease.body?.byteLength ?? 0;
    for (const admission of this.admissions.values())
      retainedBodyBytes += admission.lease.body?.byteLength ?? 0;
    this.pruneHeld();
    for (const held of this.held.values())
      retainedBodyBytes += held.lease.body?.byteLength ?? 0;
    return {
      mode: this.disposed ? "off" : this.deps.config().mode,
      leases: [...this.leases.values()].map((lease) => ({
        sessionId: lease.sessionId,
        threadId: this.linkedThread(lease.sessionId),
        accountId: lease.accountId,
        model: lease.model,
        ttl: lease.ttl,
        bodyHash: lease.bodyHash,
        prefixTokens: lease.prefixTokens,
        nativeStartedAt: lease.nativeStartedAt,
        nativeCompletedAt: lease.nativeCompletedAt,
        coveredUntil: lease.coveredUntil,
        role: lease.role,
        label: lease.label,
        waitingOn: lease.waitingOn,
        resumeChance: lease.resumeChance,
        expectedSaving: lease.expectedSaving,
        refreshes: lease.refreshes,
        nextRefreshAt: lease.nextRefreshAt,
        state: lease.state,
        dryRun: lease.dryRun,
      })),
      admissions: [...this.admissions.values()].map((admission) => ({
        sessionId: admission.lease.sessionId,
        threadId: this.linkedThread(admission.lease.sessionId),
        state: admission.state,
        since: admission.since,
      })),
      totals: { ...this.totals },
      retainedBodyBytes,
      since: this.since,
      events: [...this.events],
    };
  }

  private preempt(sessions: Array<string | null>, reason: string): void {
    const named = new Set(
      sessions.filter((session): session is string => session !== null),
    );
    const threads = new Set<string>();
    for (const session of named) {
      const thread = this.linkedThread(session);
      if (thread !== null) threads.add(thread);
    }
    const hit = (session: string) => {
      if (named.has(session)) return true;
      const thread = this.linkedThread(session);
      return thread !== null && threads.has(thread);
    };
    for (const lease of [...this.leases.values()])
      if (hit(lease.sessionId)) this.endLease(lease, reason);
    // A dropped admission needs no event: the request that dropped it reports its own outcome.
    for (const admission of [...this.admissions.values()])
      if (hit(admission.lease.sessionId)) this.dropAdmission(admission, null);
  }

  // Whether a request could start a lease from its completion, as far as its start tells.
  private couldLease(start: NativeRequestStart): boolean {
    return (
      start.parentSessionId === null &&
      this.deps.config().families.includes(start.family as WarmingFamily)
    );
  }

  // Settings can change at any time. The mode and model family a lease started under must still
  // hold at admission, at every timer and in the final send-time check.
  private gate(lease: Lease, config: WarmingConfig): string | null {
    if (config.mode === "off") return "warming is off";
    if (lease.dryRun !== (config.mode === "observe"))
      return "warming mode changed";
    if (!config.families.includes(lease.family as WarmingFamily))
      return `model family ${lease.family} is no longer enabled for warming`;
    return null;
  }

  // `holdAs`: a busy completion that passes every other gate is held under this sequence.
  private afterNative(
    start: NativeRequestStart,
    busy: string | null,
    response: NativeResponse | null,
    usage: CacheUsage | null,
    completed: boolean,
    holdAs: number | null = null,
  ): void {
    if (this.disposed) return;
    const config = this.deps.config();
    const base = {
      threadId:
        start.sessionId === null ? null : this.linkedThread(start.sessionId),
      accountId: response?.accountId ?? null,
    };
    if (response === null || !completed) {
      this.record({
        ...base,
        kind: "native",
        model: null,
        ttl: null,
        message:
          response === null
            ? "native request ended without a response"
            : "native response did not complete",
      });
      return;
    }
    const shape = describeClaudeRequest(response.body);
    const usageText =
      usage === null
        ? "usage unknown"
        : `cache read ${usage.cacheReadTokens}, write ${usage.cacheWriteTokens}` +
          (usage.cacheWrite1hTokens !== null || usage.cacheWrite5mTokens !== null
            ? ` (5m ${usage.cacheWrite5mTokens ?? 0}, 1h ${usage.cacheWrite1hTokens ?? 0})`
            : "");
    const event = {
      ...base,
      model: shape.model,
      ttl: shape.tailTtl,
    };
    this.record({
      ...event,
      kind: "native",
      message: `HTTP ${response.status} in ${Math.max(0, this.deps.now() - response.startedAt)} ms; ${usageText}; body ${shape.bodyHash}`,
    });
    const skip = (message: string) =>
      this.record({ ...event, kind: "skip", message });
    if (config.mode === "off") return;
    if (start.sessionId === null)
      return skip("no Claude Code session id in the request metadata");
    // The wait after this request goes unwarmed (a busy skip does not: a later completion leases).
    const sessionId = start.sessionId;
    const unwarmed = (message: string) => {
      skip(message);
      this.deps.recordOutcome({
        at: this.deps.now(),
        sessionId,
        threadId: base.threadId,
        model: shape.model,
        role: null,
        state: null,
        waitStartedAt: this.deps.now(),
        firstDecisionAt: null,
        prefixTokens: usage === null ? 0 : usage.cacheReadTokens + usage.cacheWriteTokens,
        ttl: shape.tailTtl,
        refreshes: 0,
        kind: "skip",
        reason: message,
      });
    };
    if (start.parentSessionId !== null)
      return unwarmed(
        "the request carries a parent_session_id (an agent-team session); only sessions without a parent start leases",
      );
    if (!config.families.includes(start.family as WarmingFamily))
      return unwarmed(`model family ${start.family} is not enabled for warming`);
    if (busy !== null) {
      if (holdAs !== null) {
        const lease = this.leaseFrom(start.sessionId, start.family, response, usage, shape, config);
        if (typeof lease !== "string") this.hold(holdAs, lease, config);
      }
      return skip(busy);
    }
    const lease = this.leaseFrom(start.sessionId, start.family, response, usage, shape, config);
    if (typeof lease === "string") return unwarmed(lease);
    this.admit(lease, config);
  }

  // Every lease gate that does not depend on the session's other requests: a lease, or why not.
  private leaseFrom(
    sessionId: string,
    family: ModelFamily,
    response: NativeResponse,
    usage: CacheUsage | null,
    shape: ReturnType<typeof describeClaudeRequest>,
    config: WarmingConfig,
  ): Lease | string {
    if (response.status < 200 || response.status >= 300)
      return `native request returned HTTP ${response.status}`;
    if (usage === null) return "cache usage unknown";
    if (shape.tailTtl === null) return "no cache breakpoint";
    if (shape.keepAliveBlocker !== null) return shape.keepAliveBlocker;
    const prefixTokens = usage.cacheReadTokens + usage.cacheWriteTokens;
    if (prefixTokens === 0) return "nothing was cached";
    const ttlMs = CACHE_TTL_MS[shape.tailTtl];
    const coveredUntil = response.startedAt + ttlMs;
    const completedAt = this.deps.now();
    if (coveredUntil >= completedAt + config.maxWaitMinutes * 60_000)
      return `the ${shape.tailTtl} cache entry already outlasts maxWaitMinutes (${config.maxWaitMinutes})`;
    const dryRun = config.mode === "observe";
    if (!dryRun && response.body.byteLength > config.maxLeaseBodyKiB * 1024)
      return `request body is larger than maxLeaseBodyKiB (${config.maxLeaseBodyKiB} KiB)`;
    return {
        sessionId,
        accountId: response.accountId,
        model: shape.model,
        family,
        ttl: shape.tailTtl,
        url: response.url,
        body: dryRun ? null : response.body,
        headers: response.headers,
        bodyHash: shape.bodyHash,
        bodyBytes: response.body.byteLength,
        prefixTokens,
        nativeStartedAt: response.startedAt,
        nativeCompletedAt: completedAt,
        coveredUntil,
        role: null,
        label: null,
        waitingOn: null,
        firstWaitingOn: null,
        firstDecisionAt: null,
        resumeChance: null,
        expectedSaving: null,
        refreshes: 0,
        nextRefreshAt: null,
        state: "waiting",
        dryRun,
        timer: null,
        controller: null,
        ended: false,
    };
  }

  // At most maxLeases completions are held at once (the oldest goes first), each only until its
  // refresh would be due: after that a lease from it could only end at once.
  private hold(sequence: number, lease: Lease, config: WarmingConfig): void {
    this.dropHeld(lease.sessionId);
    while (this.held.size >= config.maxLeases) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.dropHeld(oldest.value);
    }
    const ms = Math.max(0, this.heldExpiry(lease, config) - this.deps.now());
    const timer = this.deps.timers.setTimeout(() => this.pruneHeld(), ms);
    this.held.set(lease.sessionId, { sequence, lease, timer });
  }

  private heldExpiry(lease: Lease, config: WarmingConfig): number {
    return lease.coveredUntil - config.safetyMarginSeconds * 1_000;
  }

  private dropHeld(sessionId: string): void {
    const held = this.held.get(sessionId);
    if (held === undefined) return;
    this.deps.timers.clearTimeout(held.timer);
    this.held.delete(sessionId);
  }

  private pruneHeld(): void {
    const config = this.deps.config();
    const now = this.deps.now();
    for (const [session, held] of [...this.held])
      if (now >= this.heldExpiry(held.lease, config)) this.dropHeld(session);
  }

  // A held completion is reconsidered once its session settled after an eligible request failed.
  private resumeHeld(held: HeldCompletion, failure: { sequence: number; why: string }): void {
    if (this.disposed) return;
    const config = this.deps.config();
    const lease = held.lease;
    const event = { threadId: this.linkedThread(lease.sessionId), accountId: lease.accountId, model: lease.model, ttl: lease.ttl };
    this.record({
      ...event,
      kind: "native",
      message: `${failure.sequence > held.sequence ? "a newer" : "an older"} request in the session failed (${failure.why}) and none newer succeeded, so the last successful request can lease again; body ${lease.bodyHash}`,
    });
    const blocked = this.gate(lease, config);
    if (blocked !== null) return this.record({ ...event, kind: "skip", message: blocked });
    if (this.deps.now() >= this.heldExpiry(lease, config))
      return this.record({ ...event, kind: "skip", message: "the entry expired before the session settled" });
    this.admit(lease, config);
  }

  // At most maxLeases requests wait for admission at once; a newer one replaces the oldest, so
  // sessions that never link cannot keep an eligible thread out.
  private admit(lease: Lease, config: WarmingConfig): void {
    const existing = this.admissions.get(lease.sessionId);
    if (existing !== undefined) this.dropAdmission(existing, null);
    while (this.admissions.size >= config.maxLeases) {
      const oldest = this.admissions.values().next();
      if (oldest.done) break;
      this.dropAdmission(
        oldest.value,
        `too many requests awaiting classification (maxLeases ${config.maxLeases})`,
      );
    }
    const admission: Admission = {
      lease,
      state: "linking",
      since: this.deps.now(),
      timer: null,
      controller: new AbortController(),
    };
    this.admissions.set(lease.sessionId, admission);
    void this.classify(admission);
  }

  // Waits for the session's link, then classifies the thread (a cached context read is fine here;
  // every send is confirmed fresh). Only a thread whose role may be warmed takes a lease slot.
  private async classify(admission: Admission): Promise<void> {
    const lease = admission.lease;
    const thread = this.sessionThreads.get(lease.sessionId);
    if (thread === undefined) {
      if (admission.timer === null) {
        const wait = Math.min(
          LINK_WAIT_MS,
          lease.coveredUntil -
            this.deps.config().safetyMarginSeconds * 1_000 -
            this.deps.now(),
        );
        admission.timer = this.deps.timers.setTimeout(
          () =>
            this.dropAdmission(
              admission,
              "skipped: no BB thread is linked to this Claude session",
            ),
          Math.max(0, wait),
        );
      }
      return;
    }
    if (thread === AMBIGUOUS)
      return this.dropAdmission(
        admission,
        "skipped: more than one BB thread reported this Claude session",
      );
    if (admission.state === "classifying") return;
    admission.state = "classifying";
    if (admission.timer !== null) this.deps.timers.clearTimeout(admission.timer);
    admission.timer = null;
    let context: ThreadContext;
    try {
      context = await this.deps.readContext(thread, admission.controller.signal);
    } catch {
      context = { kind: "unknown", reason: "thread context read failed" };
    }
    if (
      this.admissions.get(lease.sessionId) !== admission ||
      admission.controller.signal.aborted
    )
      return;
    const config = this.deps.config();
    const blocked = this.gate(lease, config);
    if (blocked !== null) return this.dropAdmission(admission, blocked);
    if (this.sessionThreads.get(lease.sessionId) !== thread)
      return this.dropAdmission(
        admission,
        "the session's thread link changed during classification",
      );
    const refused = this.applyRole(lease, context, config);
    if (refused !== null) return this.dropAdmission(admission, refused.message);
    if (this.leases.size >= config.maxLeases)
      return this.dropAdmission(
        admission,
        `lease limit reached (maxLeases ${config.maxLeases})`,
      );
    this.admissions.delete(lease.sessionId);
    this.leases.set(lease.sessionId, lease);
    this.totals.leasesStarted += 1;
    this.recordLease(
      lease,
      "lease",
      `${lease.dryRun ? "dry-run " : ""}lease on ${lease.prefixTokens} cached tokens; entry covered until ${new Date(lease.coveredUntil).toISOString()}`,
    );
    this.schedule(lease, config);
  }

  private dropAdmission(admission: Admission, message: string | null): void {
    const lease = admission.lease;
    if (this.admissions.get(lease.sessionId) !== admission) return;
    this.admissions.delete(lease.sessionId);
    if (admission.timer !== null) this.deps.timers.clearTimeout(admission.timer);
    admission.timer = null;
    admission.controller.abort(new Error(message ?? "admission dropped"));
    lease.ended = true;
    lease.body = null;
    if (message === null) return;
    this.recordLease(lease, "skip", message);
    this.recordOutcome(lease, "skip", message);
  }

  private schedule(lease: Lease, config: WarmingConfig): void {
    const due = lease.coveredUntil - config.safetyMarginSeconds * 1_000;
    if (due - lease.nativeCompletedAt >= config.maxWaitMinutes * 60_000)
      return this.endLease(
        lease,
        `the wait reached maxWaitMinutes (${config.maxWaitMinutes})`,
      );
    this.arm(lease, due);
  }

  private arm(lease: Lease, at: number): void {
    if (lease.timer !== null) this.deps.timers.clearTimeout(lease.timer);
    lease.state = "waiting";
    lease.nextRefreshAt = at;
    lease.timer = this.deps.timers.setTimeout(
      () => void this.fire(lease),
      Math.max(0, at - this.deps.now()),
    );
  }

  private async fire(lease: Lease): Promise<void> {
    if (lease.ended) return;
    lease.timer = null;
    lease.nextRefreshAt = null;
    let config = this.deps.config();
    const blocked = this.gate(lease, config);
    if (blocked !== null) return this.endLease(lease, blocked);
    if (this.deps.now() >= lease.coveredUntil)
      return this.endLease(lease, "the entry expired before a refresh could start");
    const thread = this.sessionThreads.get(lease.sessionId);
    if (thread === undefined)
      return this.endLease(
        lease,
        "skipped: no BB thread is linked to this Claude session",
        "skip",
      );
    if (thread === AMBIGUOUS)
      return this.endLease(
        lease,
        "skipped: more than one BB thread reported this Claude session",
        "skip",
      );
    lease.state = "checking";
    const controller = new AbortController();
    lease.controller = controller;
    // Whatever the checks below wait on, the lease ends when its entry expires.
    lease.timer = this.deps.timers.setTimeout(
      () => this.endLease(lease, "the entry expired while its refresh was being checked"),
      Math.max(0, lease.coveredUntil - this.deps.now()),
    );
    // Classification may use a cached context read; the send itself is confirmed fresh below.
    const classified = await this.qualify(lease, thread, controller.signal, false);
    if (lease.ended) return;
    if (classified !== null) return this.endLease(lease, classified.message, classified.kind);
    const state = await this.within(
      this.deps.waitState(thread, controller.signal),
      WAIT_STATE_TIMEOUT_MS,
    );
    if (lease.ended) return;
    if (state === null)
      return this.endLease(lease, "skipped: BB could not tell what the thread waits on", "skip");
    if (lease.waitingOn === "background" && state === "idle")
      return this.endLease(lease, "stopped: the background task ended without the thread resuming");
    config = this.deps.config();
    const changed = this.gate(lease, config);
    if (changed !== null) return this.endLease(lease, changed);
    const now = this.deps.now();
    const decision = this.decide(lease, state, now, config);
    if (!decision.refresh) return this.endLease(lease, `stopped (${state}): ${decision.why}`);
    if (now >= lease.coveredUntil)
      return this.endLease(lease, "the entry expired before a refresh could start");
    this.refreshTimes = this.refreshTimes.filter((at) => now - at < HOUR_MS);
    if (this.refreshTimes.length >= config.maxRefreshesPerHour)
      return this.endLease(
        lease,
        `hourly refresh budget reached (maxRefreshesPerHour ${config.maxRefreshesPerHour})`,
      );
    if (this.refreshing >= config.maxConcurrentRefreshes) {
      if (now + CONCURRENCY_RETRY_MS < lease.coveredUntil)
        return this.arm(lease, now + CONCURRENCY_RETRY_MS);
      return this.endLease(
        lease,
        `concurrent refresh limit reached (maxConcurrentRefreshes ${config.maxConcurrentRefreshes})`,
      );
    }
    this.refreshTimes.push(now);
    // Runs immediately before the vendor request: the settings must still allow the lease, BB must
    // still link the thread to this session, and a context read that bypasses the cache must still
    // qualify it, so a settings change, retirement, Stop, replacement, acceptance, pause or new
    // session since classification refuses the send.
    const confirm = async (signal: AbortSignal): Promise<string | null> => {
      const before = this.gate(lease, this.deps.config());
      if (before !== null) return before;
      const refused = await this.qualify(lease, thread, signal, true);
      if (refused !== null) return refused.message;
      if (lease.ended) return "the lease ended";
      return this.gate(lease, this.deps.config());
    };
    if (lease.dryRun) {
      const refused = await confirm(controller.signal);
      if (lease.ended) return;
      if (refused !== null)
        return this.endLease(lease, `refresh not sent: ${refused}`, "skip");
      lease.refreshes += 1;
      this.totals.refreshesPlanned += 1;
      lease.coveredUntil = this.deps.now() + CACHE_TTL_MS[lease.ttl];
      this.recordLease(
        lease,
        "refresh",
        `dry run: would refresh now (#${lease.refreshes}, ${state}, ${lease.label}): ${decision.why}`,
      );
      return this.schedule(lease, config);
    }
    if (lease.body === null)
      return this.endLease(lease, "no request body was kept for this lease");
    // The keep-alive, its send-time checks included, is bounded by refreshTimeoutSeconds.
    if (lease.timer !== null) this.deps.timers.clearTimeout(lease.timer);
    lease.timer = null;
    lease.state = "refreshing";
    this.refreshing += 1;
    let result: KeepAliveResult;
    try {
      result = await this.deps.keepAlive(
        {
          sessionId: lease.sessionId,
          accountId: lease.accountId,
          family: lease.family,
          url: lease.url,
          body: keepAliveBody(lease.body),
          headers: lease.headers,
          reserve: effectiveWarmingQuotaReserve(
            config,
            this.deps.switchThreshold(),
          ),
          timeoutMs: config.refreshTimeoutSeconds * 1_000,
          confirm,
        },
        controller.signal,
      );
    } catch (error) {
      result = {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
        startedAt: now,
      };
    } finally {
      this.refreshing -= 1;
    }
    if (result.kind !== "skipped") this.totals.refreshesSent += 1;
    if (result.kind === "response" && result.usage !== null) {
      this.totals.refreshCacheReadTokens += result.usage.cacheReadTokens;
      this.totals.refreshCacheWriteTokens += result.usage.cacheWriteTokens;
      this.totals.refreshInputTokens += result.usage.inputTokens ?? 0;
      this.totals.refreshOutputTokens += result.usage.outputTokens ?? 0;
    }
    if (lease.ended) return;
    lease.controller = null;
    this.applyKeepAlive(lease, result, this.deps.config());
  }

  // Whether the lease's thread still qualifies, from BB's session link and Initiatives context. Sets
  // the lease's role; returns null or why the lease must end.
  private async qualify(
    lease: Lease,
    thread: string,
    signal: AbortSignal,
    fresh: boolean,
  ): Promise<{ message: string; kind: "end" | "skip" } | null> {
    if (fresh) {
      let session: string | null;
      try {
        session = await this.deps.threadSession(thread, signal);
      } catch {
        session = null;
      }
      if (session !== lease.sessionId)
        return {
          message:
            session === null
              ? "BB has no current session for the thread"
              : "the thread moved to a newer Claude session",
          kind: "end",
        };
    }
    let context: ThreadContext;
    try {
      context = await this.deps.readContext(thread, signal, { fresh });
    } catch {
      context = { kind: "unknown", reason: "thread context read failed" };
    }
    return this.applyRole(lease, context, this.deps.config());
  }

  // Sets the lease's role from the thread's context; null, or why it is not warmed.
  private applyRole(
    lease: Lease,
    context: ThreadContext,
    config: WarmingConfig,
  ): { message: string; kind: "end" | "skip" } | null {
    const classified = warmingRole(context, config);
    if (!classified.ok) return { message: classified.reason, kind: classified.kind };
    lease.role = classified.role;
    lease.label = classified.label;
    return null;
  }

  // The promise's value, or null once it fails or takes longer than ms.
  private within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = this.deps.timers.setTimeout(() => resolve(null), ms);
      const settle = (value: T | null) => {
        this.deps.timers.clearTimeout(timer);
        resolve(value);
      };
      promise.then(settle, () => settle(null));
    });
  }

  // Whether the next refresh is expected to pay, from what the thread waits on now.
  private decide(
    lease: Lease,
    state: WaitState,
    now: number,
    config: WarmingConfig,
  ): ReturnType<typeof decideRefresh> {
    lease.waitingOn = state;
    if (lease.firstWaitingOn === null) {
      lease.firstWaitingOn = state;
      lease.firstDecisionAt = now;
    }
    const decision = decideRefresh(this.deps.resumeHistory(), {
      state,
      // Set by qualify, which always runs first.
      role: lease.role ?? "standalone",
      ageMs: now - lease.nativeCompletedAt,
      coveredMs: lease.coveredUntil - lease.nativeCompletedAt,
      stepMs: CACHE_TTL_MS[lease.ttl] - config.safetyMarginSeconds * 1_000,
      ttl: lease.ttl,
      maxAgeMs: config.maxWaitMinutes * 60_000,
      maxBackgroundAgeMs: config.maxBackgroundWaitMinutes * 60_000,
    });
    lease.resumeChance = decision.resumeChance;
    lease.expectedSaving = Math.round(decision.net * lease.prefixTokens);
    return decision;
  }

  private applyKeepAlive(
    lease: Lease,
    result: KeepAliveResult,
    config: WarmingConfig,
  ): void {
    if (result.kind === "skipped")
      return this.endLease(lease, `refresh not sent: ${result.reason}`, "skip");
    if (result.kind === "failed")
      return this.endLease(lease, `refresh failed: ${result.reason}`);
    if (result.status < 200 || result.status >= 300)
      return this.endLease(lease, `refresh rejected with HTTP ${result.status}`);
    const usage = result.usage;
    if (usage === null)
      return this.endLease(lease, "refresh response carried no cache usage");
    if (result.outputEmpty === false || (usage.outputTokens ?? 0) > 0)
      return this.endLease(lease, "refresh produced output; warming stopped");
    if (usage.cacheWriteTokens > 0) {
      this.totals.cacheMisses += 1;
      return this.endLease(
        lease,
        `the entry was already gone: the refresh wrote ${usage.cacheWriteTokens} tokens`,
      );
    }
    if (usage.cacheReadTokens < lease.prefixTokens)
      return this.endLease(
        lease,
        `the refresh read ${usage.cacheReadTokens} of ${lease.prefixTokens} cached tokens`,
      );
    lease.refreshes += 1;
    this.totals.refreshesConfirmed += 1;
    lease.coveredUntil = result.startedAt + CACHE_TTL_MS[lease.ttl];
    this.recordLease(
      lease,
      "refresh",
      `refresh #${lease.refreshes} (${lease.waitingOn}, ${lease.label}) read ${usage.cacheReadTokens} cached tokens; covered until ${new Date(lease.coveredUntil).toISOString()}`,
    );
    this.schedule(lease, config);
  }

  private endLease(
    lease: Lease,
    message: string,
    kind: "end" | "skip" = "end",
  ): void {
    if (lease.ended) return;
    lease.ended = true;
    if (lease.timer !== null) this.deps.timers.clearTimeout(lease.timer);
    lease.timer = null;
    lease.controller?.abort(new Error(message));
    lease.controller = null;
    lease.body = null;
    if (this.leases.get(lease.sessionId) === lease)
      this.leases.delete(lease.sessionId);
    this.recordLease(lease, kind, message);
    this.recordOutcome(lease, kind, message);
  }

  private recordOutcome(lease: Lease, kind: "end" | "skip", reason: string): void {
    this.deps.recordOutcome({
      at: this.deps.now(),
      sessionId: lease.sessionId,
      threadId: this.linkedThread(lease.sessionId),
      model: lease.model,
      role: lease.role,
      state: lease.firstWaitingOn,
      waitStartedAt: lease.nativeCompletedAt,
      firstDecisionAt: lease.firstDecisionAt,
      prefixTokens: lease.prefixTokens,
      ttl: lease.ttl,
      refreshes: lease.refreshes,
      kind,
      reason,
    });
  }

  private recordLease(
    lease: Lease,
    kind: WarmingEvent["kind"],
    message: string,
  ): void {
    this.record({
      kind,
      threadId: this.linkedThread(lease.sessionId),
      accountId: lease.accountId,
      model: lease.model,
      ttl: lease.ttl,
      message,
    });
  }

  // The BB thread linked to a Claude Code session, if exactly one is.
  threadOf(sessionId: string): string | null {
    return this.linkedThread(sessionId);
  }

  // The live lease that keeps a session's entry warm, if any. A dry-run (observe) lease sends
  // nothing, so its coveredUntil keeps no entry alive.
  leaseOf(sessionId: string): { model: string | null; coveredUntil: number } | null {
    const lease = this.leases.get(sessionId);
    return lease === undefined || lease.dryRun
      ? null
      : { model: lease.model, coveredUntil: lease.coveredUntil };
  }

  private linkedThread(sessionId: string): string | null {
    const thread = this.sessionThreads.get(sessionId);
    return typeof thread === "string" ? thread : null;
  }

  private record(event: Omit<WarmingEvent, "at">): void {
    this.events.push({ at: this.deps.now(), ...event });
    this.pruneEvents();
  }

  private pruneEvents(): void {
    const config = this.deps.config();
    const oldest = this.deps.now() - config.historyMinutes * 60_000;
    let drop = Math.max(0, this.events.length - config.historyLimit);
    while (drop < this.events.length && (this.events[drop]?.at ?? 0) < oldest)
      drop += 1;
    if (drop > 0) this.events = this.events.slice(drop);
  }
}
