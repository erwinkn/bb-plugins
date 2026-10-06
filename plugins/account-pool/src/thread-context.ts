import { z } from "zod";
import type { WarmingConfig } from "./warming-config.js";

// What the warmer knows about a thread's Initiative role. It comes only from the Initiatives
// plugin's public token-auth read: context contract v1.1, thread route (plugins/initiatives/README.md,
// "Read-only context for other plugins"); anything else is "unknown" and warms nothing. "none"
// means Initiatives has no record of the thread: a standalone thread, a foreign or unknown id, or a
// worker whose spawn is not linked yet. It is the absence of evidence, never proof that a thread
// is standalone.
export type ThreadContext =
  | { kind: "none" }
  | {
      kind: "member";
      memberKind: "coordinator" | "worker" | "adhoc";
      role: "coordinator" | "work" | "review" | "adhoc";
      state: "active" | "stopped" | "retired" | "former";
      archived: boolean;
      paused: boolean;
      // The last assignment whose brief reached this thread, and a later one still undelivered.
      assignment: { ref: string; phase: AssignmentPhase } | null;
      next: { ref: string; phase: AssignmentPhase } | null;
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

const membershipSchema = z
  .object({
    kind: z.enum(["coordinator", "worker", "adhoc"]),
    role: z.enum(["coordinator", "work", "review", "adhoc"]),
    state: z.enum(["active", "stopped", "retired", "former"]),
    archived: z.boolean(),
    paused: z.boolean(),
    assignment: assignmentSchema.nullable(),
    next: assignmentSchema.nullable(),
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

/** The Initiatives plugin's ID, then the one it had until its one-time move. Drop `projects` once retired. */
export const INITIATIVE_PLUGIN_IDS = ["initiatives", "projects"] as const;
const contextPath = (pluginId: string) => `/api/v1/plugins/${pluginId}/http/context/v1/thread`;
const PLUGIN_ID_CACHE_MS = 5_000;
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
  // The last membership read for the thread, however old, without a request. Labels only.
  peek(threadId: string): ThreadContext | null;
}

/**
 * Which plugin answers context reads: the running one of INITIATIVE_PLUGIN_IDS, else an installed
 * one (its 503 is an unknown read, never "no record"), else none. Cached briefly: every warming
 * check reads context.
 */
export function initiativesPluginId(
  list: () => Promise<{ plugins: { id: string; enabled?: boolean; status?: string }[] }>,
  now: () => number,
): () => Promise<string | null> {
  let cached: { id: string | null; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < PLUGIN_ID_CACHE_MS) return cached.id;
    const { plugins } = await list();
    const installed = INITIATIVE_PLUGIN_IDS.filter((id) => plugins.some((p) => p.id === id));
    const running = installed.find((id) =>
      plugins.some((p) => p.id === id && p.enabled === true && p.status === "running"),
    );
    cached = { id: running ?? installed[0] ?? null, at: now() };
    return cached.id;
  };
}

export function createInitiativesContextReader(deps: {
  fetch: typeof fetch;
  baseUrl: () => string;
  /** The plugin to read (see initiativesPluginId); null when none is installed. */
  pluginId: () => Promise<string | null>;
  token: (pluginId: string) => Promise<string>;
  now: () => number;
  timeoutMs?: number;
}): ThreadContextReader {
  const cache = new Map<string, { at: number; context: ThreadContext }>();
  let source: string | null = null;
  return {
    async read(threadId, signal, options = {}) {
      let pluginId: string | null;
      try {
        pluginId = await deps.pluginId();
      } catch {
        return { kind: "unknown", reason: "the installed plugins could not be listed" };
      }
      // A membership read from one plugin says nothing once another one answers, or none does.
      if (pluginId !== source) {
        cache.clear();
        source = pluginId;
      }
      if (pluginId === null) return { kind: "unknown", reason: "no Initiatives plugin is installed" };
      const cached = cache.get(threadId);
      if (
        !options.fresh &&
        cached !== undefined &&
        deps.now() - cached.at < CONTEXT_CACHE_MS
      )
        return cached.context;
      const context = await readOnce(deps, pluginId, threadId, signal);
      cache.delete(threadId);
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
    peek: (threadId) => cache.get(threadId)?.context ?? null,
  };
}

async function readOnce(
  deps: Parameters<typeof createInitiativesContextReader>[0],
  pluginId: string,
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadContext> {
  let token: string;
  try {
    token = await deps.token(pluginId);
  } catch {
    return { kind: "unknown", reason: "Initiatives plugin token unavailable" };
  }
  const url = new URL(contextPath(pluginId), deps.baseUrl());
  url.searchParams.set("threadId", threadId);
  let response: Response;
  let text: string;
  try {
    response = await deps.fetch(url, {
      headers: { "x-bb-plugin-token": token, accept: "application/json" },
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(deps.timeoutMs ?? CONTEXT_TIMEOUT_MS),
      ]),
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
    assignment:
      membership.assignment === null
        ? null
        : { ref: membership.assignment.ref, phase: membership.assignment.phase },
    next:
      membership.next === null
        ? null
        : { ref: membership.next.ref, phase: membership.next.phase },
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

export type WarmingWindow =
  | { ok: true; minutes: number; label: string }
  | { ok: false; reason: string };

// The idle window for a thread, from Initiatives context only. Supported windows: an active
// coordinator, a worker whose last delivered assignment is active, reported or accepted, a
// reviewer whose assignment is active or reported (reviewerMinutes), and a member that ended.
// Everything else is a visible zero or skip:
// - no Initiatives record: not evidence of a standalone thread, so no warming at all;
// - an archived Initiative, or an adhoc Initiative thread: no warming;
// - a paused Initiative, unless pauseStopsWarming is off;
// - an undelivered next assignment, or a delivered one still pending: its turn will start from a
//   different prompt, so the current prefix is not known to stay in use.
export function warmingWindow(
  context: ThreadContext,
  config: WarmingConfig,
): WarmingWindow {
  if (context.kind === "unknown") return { ok: false, reason: context.reason };
  if (context.kind === "none")
    return {
      ok: false,
      reason:
        "Initiatives has no record of this thread; a standalone thread cannot be told from an unknown or unlinked one",
    };
  if (context.archived)
    return { ok: true, minutes: 0, label: "archived Initiative" };
  if (context.memberKind === "adhoc" || context.role === "adhoc")
    return { ok: true, minutes: 0, label: "adhoc Initiative thread" };
  if (context.paused && config.pauseStopsWarming)
    return { ok: true, minutes: 0, label: "paused Initiative" };
  const who = context.memberKind === "coordinator" ? "coordinator" : context.role;
  if (context.state !== "active")
    return {
      ok: true,
      minutes: config.workerEndedMinutes,
      label: `${who} ${context.state}`,
    };
  if (context.memberKind === "coordinator")
    return { ok: true, minutes: config.coordinatorMinutes, label: "coordinator" };
  if (context.next !== null)
    return {
      ok: true,
      minutes: 0,
      label: `next assignment ${context.next.ref} not delivered yet`,
    };
  const assignment = context.assignment;
  if (assignment === null)
    return {
      ok: true,
      minutes: config.workerEndedMinutes,
      label: "worker without assignment",
    };
  const review = context.role === "review";
  switch (assignment.phase) {
    case "pending":
      return {
        ok: true,
        minutes: 0,
        label: `assignment ${assignment.ref} pending delivery`,
      };
    case "active":
      return review
        ? { ok: true, minutes: config.reviewerMinutes, label: "reviewer mid-assignment" }
        : { ok: true, minutes: config.workerActiveMinutes, label: "worker mid-assignment" };
    case "reported":
      return review
        ? { ok: true, minutes: config.reviewerMinutes, label: "reviewer reported" }
        : { ok: true, minutes: config.workerReportedMinutes, label: "worker reported" };
    case "accepted":
      return review
        ? { ok: true, minutes: config.reviewerAcceptedMinutes, label: "reviewer accepted" }
        : { ok: true, minutes: config.workerAcceptedMinutes, label: "worker accepted" };
    default:
      return {
        ok: true,
        minutes: config.workerEndedMinutes,
        label: `assignment ${assignment.phase}`,
      };
  }
}
