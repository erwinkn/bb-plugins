import { z } from "zod";
import { abortable, linkSignals } from "./signals.js";
import type { WarmingConfig } from "./warming-config.js";
import type { WarmingRole } from "./warming-economics.js";

// What the warmer knows about a thread's Initiative role. It comes only from the Initiatives
// plugin's public token-auth read: context contract v1.1, thread route (plugins/initiatives/README.md,
// "Read-only context for other plugins"); anything else is "unknown" and warms nothing. "none"
// means Initiatives has no record of the thread: a standalone thread, a foreign or unknown id, or a
// worker whose spawn is not linked yet. The warmer reads it only for a thread BB already linked to
// a Claude session, so it treats it as standalone, and re-reads it at every refresh.
export type ThreadContext =
  | { kind: "none" }
  | {
      kind: "member";
      memberKind: "coordinator" | "worker" | "adhoc";
      role: "coordinator" | "work" | "review" | "adhoc";
      state: "active" | "stopped" | "retired" | "former";
      archived: boolean;
      paused: boolean;
      // The member's W#, null for a coordinator or adhoc thread.
      worker: string | null;
      // The last assignment whose brief reached this thread, and a later one still undelivered.
      assignment: { ref: string; phase: AssignmentPhase } | null;
      next: { ref: string; phase: AssignmentPhase } | null;
      // The review pending or running of the thread's latest report (D440).
      review: { ref: string; worker: string; since: number } | null;
    }
  | { kind: "unknown"; reason: string };

const assignmentPhaseSchema = z.enum([
  "pending",
  "active",
  "reported",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
]);
type AssignmentPhase = z.infer<typeof assignmentPhaseSchema>;

const assignmentSchema = z
  .object({ ref: z.string().min(1), phase: assignmentPhaseSchema })
  .passthrough();

// Read leniently: an Initiatives that predates it, or a malformed one, means no review hold, not an
// unknown context.
const reviewSchema = z
  .object({ ref: z.string().min(1), worker: z.string().min(1), since: z.number().int() })
  .passthrough();

const membershipSchema = z
  .object({
    kind: z.enum(["coordinator", "worker", "adhoc"]),
    role: z.enum(["coordinator", "work", "review", "adhoc"]),
    state: z.enum(["active", "stopped", "retired", "former"]),
    archived: z.boolean(),
    paused: z.boolean(),
    worker: z.string().nullable().catch(null),
    assignment: assignmentSchema.nullable(),
    next: assignmentSchema.nullable(),
    review: reviewSchema.nullable().catch(null),
  })
  .passthrough();

export const threadContextResponseSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string().min(1),
    membership: membershipSchema.nullable(),
  })
  .passthrough();

const errorResponseSchema = z
  .object({
    version: z.literal(1),
    error: z.object({ code: z.string().min(1) }).passthrough(),
  })
  .passthrough();

// The usage ledger's role label for a thread: its Initiative role, "coordinator" for a coordinator
// in any role, "standalone" with no Initiative record, null when unknown.
export function threadRoleLabel(context: ThreadContext | null): string | null {
  if (context === null || context.kind === "unknown") return null;
  if (context.kind === "none") return "standalone";
  return context.memberKind === "coordinator" ? "coordinator" : context.role;
}

export const INITIATIVES_PLUGIN_ID = "initiatives";
const CONTEXT_PATH = "/api/v1/plugins/initiatives/http/context/v1/thread";
const CONTEXT_TIMEOUT_MS = 2_000;
const CONTEXT_CACHE_MS = 30_000;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_CACHED_CONTEXTS = 256;

export interface ThreadContextReader {
  // fresh bypasses the cache; the warmer reads fresh immediately before every keep-alive.
  read(
    threadId: string,
    signal: AbortSignal,
    options?: { fresh?: boolean },
  ): Promise<ThreadContext>;
  // The last membership or no-record read for the thread, however old, without a request. Labels only.
  peek(threadId: string): ThreadContext | null;
}

export function createInitiativesContextReader(deps: {
  fetch: typeof fetch;
  baseUrl: () => string;
  token: () => Promise<string>;
  now: () => number;
  timeoutMs?: number;
}): ThreadContextReader {
  const cache = new Map<string, { at: number; context: ThreadContext }>();
  // The last answer that said something about the thread (a membership or no record), for labels.
  const labels = new Map<string, ThreadContext>();
  return {
    async read(threadId, signal, options = {}) {
      const cached = cache.get(threadId);
      if (
        !options.fresh &&
        cached !== undefined &&
        deps.now() - cached.at < CONTEXT_CACHE_MS
      )
        return cached.context;
      const context = await readOnce(deps, threadId, signal);
      cache.delete(threadId);
      if (context.kind !== "unknown" && !signal.aborted) {
        labels.delete(threadId);
        labels.set(threadId, context);
        while (labels.size > MAX_CACHED_CONTEXTS) {
          const oldest = labels.keys().next();
          if (!oldest.done) labels.delete(oldest.value);
        }
      }
      // Only a membership is cached. "none" may be a worker whose spawn is not linked yet, and an
      // unknown or canceled read says nothing about the thread.
      if (context.kind !== "member" || signal.aborted) return context;
      cache.set(threadId, { at: deps.now(), context });
      while (cache.size > MAX_CACHED_CONTEXTS) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return context;
    },
    peek: (threadId) => labels.get(threadId) ?? null,
  };
}

async function readOnce(
  deps: Parameters<typeof createInitiativesContextReader>[0],
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadContext> {
  // One deadline for the whole read: the plugin token, the request and its body.
  const deadline = linkSignals([signal], deps.timeoutMs ?? CONTEXT_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    let token: string;
    try {
      token = await abortable(deps.token(), deadline.signal);
    } catch {
      return {
        kind: "unknown",
        reason: deadline.signal.aborted
          ? "Initiatives plugin token timed out"
          : "Initiatives plugin token unavailable",
      };
    }
    const url = new URL(CONTEXT_PATH, deps.baseUrl());
    url.searchParams.set("threadId", threadId);
    response = await deps.fetch(url, {
      headers: { "x-bb-plugin-token": token, accept: "application/json" },
      signal: deadline.signal,
    });
    text = await readText(response, MAX_CONTEXT_BYTES);
  } catch (error) {
    return {
      kind: "unknown",
      reason:
        error instanceof ContextTooLarge
          ? "Initiatives context response too large"
          : "Initiatives context read failed or timed out",
    };
  } finally {
    deadline.dispose();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      kind: "unknown",
      reason: `Initiatives context read returned HTTP ${response.status} without a v1 body`,
    };
  }
  if (!response.ok) {
    const failure = errorResponseSchema.safeParse(body);
    return {
      kind: "unknown",
      reason: failure.success
        ? `Initiatives context error ${failure.data.error.code} (HTTP ${response.status})`
        : `Initiatives context read returned HTTP ${response.status} without a v1 body`,
    };
  }
  const result = threadContextResponseSchema.safeParse(body);
  if (!result.success || result.data.threadId !== threadId)
    return {
      kind: "unknown",
      reason: "Initiatives context response does not match contract v1",
    };
  const membership = result.data.membership;
  if (membership === null) return { kind: "none" };
  return {
    kind: "member",
    memberKind: membership.kind,
    role: membership.role,
    state: membership.state,
    archived: membership.archived,
    paused: membership.paused,
    worker: membership.worker,
    assignment:
      membership.assignment === null
        ? null
        : { ref: membership.assignment.ref, phase: membership.assignment.phase },
    next:
      membership.next === null
        ? null
        : { ref: membership.next.ref, phase: membership.next.phase },
    review:
      membership.review === null
        ? null
        : { ref: membership.review.ref, worker: membership.review.worker, since: membership.review.since },
  };
}

class ContextTooLarge extends Error {}

async function readText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ContextTooLarge();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// D440: warm the thread as if it will resume until `until`, while a review of its work runs.
export interface ReviewHold {
  until: number;
  why: string;
}

type Refusal = { ok: false; reason: string; kind: "skip" | "end" };

export type WarmingClass =
  | { ok: true; role: WarmingRole; label: string; reviewHold: ReviewHold | null }
  | Refusal;

// The thread's warming role, from Initiatives context. The assignment's phase does not matter: a
// worker's next brief arrives as a message in the same conversation, so a pending or undelivered
// assignment keeps the prefix in use, and whether a wait is worth warming is decided from what the
// thread waits on (warming-economics). The thread is linked to BB already, so a thread Initiatives
// has no record of is a standalone BB thread. Ends warming:
// - unknown context (a failed or unexpected read): it cannot be verified;
// - an archived Initiative, or a paused one while pauseStopsWarming is on;
// - a stopped, retired or former member: its conversation is done;
// - a role that is not enabled in the settings.
// A review of the thread's latest report running holds it warm for reviewHoldMinutes from the
// review's start (warming-economics decides whether that pays).
export function warmingRole(
  context: ThreadContext,
  config: WarmingConfig,
): WarmingClass {
  if (context.kind === "unknown")
    return { ok: false, reason: `skipped: ${context.reason}`, kind: "skip" };
  const classified = classify(context, config);
  if (!classified.ok) return classified;
  if (!config.roles.includes(classified.role))
    return {
      ok: false,
      reason: `role ${classified.role} is not enabled for warming (${classified.label})`,
      kind: "end",
    };
  const reviewHold =
    context.kind === "member" && context.review !== null && config.reviewHoldMinutes > 0
      ? {
          until: context.review.since + config.reviewHoldMinutes * 60_000,
          why: `review of ${context.worker ?? "the thread"} by ${context.review.worker} running (${context.review.ref})`,
        }
      : null;
  return { ...classified, reviewHold };
}

function classify(
  context: Exclude<ThreadContext, { kind: "unknown" }>,
  config: WarmingConfig,
): { ok: true; role: WarmingRole; label: string } | Refusal {
  if (context.kind === "none")
    return { ok: true, role: "standalone", label: "no Initiative" };
  if (context.archived)
    return { ok: false, reason: "archived Initiative", kind: "end" };
  if (context.paused && config.pauseStopsWarming)
    return { ok: false, reason: "paused Initiative", kind: "end" };
  if (context.memberKind === "adhoc" || context.role === "adhoc")
    return { ok: true, role: "standalone", label: "adhoc Initiative thread" };
  const role: WarmingRole =
    context.memberKind === "coordinator"
      ? "coordinator"
      : context.role === "review"
        ? "reviewer"
        : "worker";
  if (context.state !== "active")
    return { ok: false, reason: `${role} ${context.state}`, kind: "end" };
  if (role === "coordinator") return { ok: true, role, label: "coordinator" };
  const assignment = context.next ?? context.assignment;
  return {
    ok: true,
    role,
    label: assignment === null ? `${role} between assignments` : `${role}, ${assignment.ref} ${assignment.phase}`,
  };
}
