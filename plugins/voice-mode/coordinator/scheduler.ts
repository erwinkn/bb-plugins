// Pure scheduling rules for background updates. No I/O: the server and the
// voice bridge feed these functions their observed state, and tests can pin
// every branch without a realtime session.

/** Conversation-side facts the server knows when a batch is requested. */
export interface ServerIdleFacts {
  /** The requesting call owns the conversation right now. */
  callMatches: boolean;
  /** Requests dispatched in this call that have no settled answer yet. */
  openRequests: number;
  /** The coordinator thread is idle (no active turn, no queued request). */
  coordinatorIdle: boolean;
  /** A coordinator question or native approval is waiting for the user. */
  blockingInteraction: boolean;
  /** A digest batch is already reserved or being answered. */
  batchInFlight: boolean;
  /** After a resume: has any request in this call been answered yet? */
  openingAnswered: boolean;
  /** Milliseconds since the call went live; used for the no-request grace. */
  msSinceCallLive: number;
  /** Requests submitted in this call, answered or not. */
  requestsThisCall: number;
}

export const RESUME_NO_REQUEST_GRACE_MS = 15_000;

export type BatchRefusal =
  | "call-mismatch"
  | "open-request"
  | "coordinator-busy"
  | "blocking-interaction"
  | "batch-in-flight"
  | "awaiting-opening-answer";

/** Why a background batch may not be reserved right now, or null when it may. */
export function refuseBatch(facts: ServerIdleFacts): BatchRefusal | null {
  if (!facts.callMatches) return "call-mismatch";
  if (facts.batchInFlight) return "batch-in-flight";
  if (facts.blockingInteraction) return "blocking-interaction";
  if (facts.openRequests > 0) return "open-request";
  if (!facts.coordinatorIdle) return "coordinator-busy";
  if (!facts.openingAnswered && (facts.requestsThisCall > 0 || facts.msSinceCallLive < RESUME_NO_REQUEST_GRACE_MS)) return "awaiting-opening-answer";
  return null;
}

/** Voice-side facts the bridge knows from the realtime data channel. */
export interface VoiceIdleFacts {
  userSpeaking: boolean;
  /** A committed user turn has no settled response yet, or transcription is pending. */
  inputUnresolved: boolean;
  responseActive: boolean;
  assistantSpeaking: boolean;
  responsePending: boolean;
  pendingToolCalls: number;
  /** A handoff waits for its transcript or is being dispatched. */
  handoffPending: boolean;
  /** A coordinator question is waiting for the user's answer. */
  questionOpen: boolean;
  /** Milliseconds since the last of the above changed. */
  quietForMs: number;
}

export const QUIET_INTERVAL_MS = 2000;

export type VoiceRefusal = "speaking" | "input-unresolved" | "generating" | "playing" | "tool-pending" | "handoff-pending" | "question-open" | "not-quiet";

/**
 * Whether unrelated background speech may start. This is the full idle gate:
 * every condition must hold. Clarifications and direct replies use the
 * narrower {@link refuseDirectSpeech}.
 */
export function refuseBackgroundSpeech(facts: VoiceIdleFacts): VoiceRefusal | null {
  const direct = refuseDirectSpeech(facts);
  if (direct) return direct;
  if (facts.handoffPending) return "handoff-pending";
  if (facts.questionOpen) return "question-open";
  if (facts.quietForMs < QUIET_INTERVAL_MS) return "not-quiet";
  return null;
}

/**
 * Whether a reply addressed to the user (answer, question, failure) may be
 * spoken now. It waits for the user and the current audio, not for the
 * coordinator or for open questions, so a clarification cannot deadlock.
 */
export function refuseDirectSpeech(facts: VoiceIdleFacts): VoiceRefusal | null {
  if (facts.userSpeaking) return "speaking";
  if (facts.inputUnresolved) return "input-unresolved";
  if (facts.responseActive || facts.responsePending) return "generating";
  if (facts.assistantSpeaking) return "playing";
  if (facts.pendingToolCalls > 0) return "tool-pending";
  return null;
}

export interface QueuedUpdate {
  id: string;
  threadId: string;
  title: string;
  kind: string;
  detail: string | null;
  createdAt: number;
}

export const BATCH_SPOKEN_LIMIT = 2;

/**
 * Coalesce repeated status changes per thread (latest wins) while keeping
 * failures and unresolved blockers, then pick the first few for one spoken
 * batch. Returns the selected updates plus the ids superseded by coalescing.
 */
export function selectBatch(queued: QueuedUpdate[], limit = BATCH_SPOKEN_LIMIT): { selected: QueuedUpdate[]; superseded: string[] } {
  const latestByThread = new Map<string, QueuedUpdate>();
  const superseded: string[] = [];
  const blocking = new Set(["failed", "interaction", "turn_failed"]);
  for (const update of [...queued].sort((a, b) => a.createdAt - b.createdAt)) {
    const previous = latestByThread.get(update.threadId);
    if (!previous) { latestByThread.set(update.threadId, update); continue; }
    // A later plain status change never hides an earlier failure or blocker.
    if (blocking.has(previous.kind) && !blocking.has(update.kind)) { superseded.push(update.id); continue; }
    superseded.push(previous.id);
    latestByThread.set(update.threadId, update);
  }
  const ordered = [...latestByThread.values()].sort((a, b) => {
    const aBlocking = blocking.has(a.kind) ? 0 : 1;
    const bBlocking = blocking.has(b.kind) ? 0 : 1;
    return aBlocking - bBlocking || a.createdAt - b.createdAt;
  });
  return { selected: ordered.slice(0, limit), superseded };
}
