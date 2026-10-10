import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Profile } from "./schema";

/**
 * T136: a replacement coordinator's first message is a handover written by GPT-6 Luna High
 * from recent activity. The plugin captures a dated snapshot (lib/handover-snapshot.ts),
 * builds a bounded packet from it and its own records (lib/handover-packet.ts), and a
 * short-lived Codex thread turns that into the handover; the text is kept only as the new
 * coordinator's first message. When Luna is unavailable, fails or takes too long, a plain
 * listing of the same packet is used instead.
 */
type Sdk = BbPluginApi["sdk"];

export const HANDOVER_PROFILE: Profile = { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" };
/** A writer still running after this long is abandoned for the plain listing. */
export const HANDOVER_TIMEOUT_MS = 10 * 60_000;
/** A preview captured longer ago than this is written again before a replacement uses it (F1). */
export const HANDOVER_MAX_AGE_MS = 30 * 60_000;

export { emptySnapshot, fallbackBody, handoverPacket, handoverPrompt, withReason, type HandoverSnapshot } from "./handover-packet";
export { captureHandoverSnapshot, fingerprintHolds, handoverFingerprint, readConversation, readHandoverState, readUserMark, type Destination, type HandoverState } from "./handover-snapshot";

type EventRow = { seq: number; type: string; createdAt?: number | string; data?: Record<string, any> };
const list = (sdk: Sdk, args: Record<string, unknown>) => sdk.threads.events.list(args as never) as Promise<EventRow[]>;
const inputText = (input: unknown) =>
  Array.isArray(input) ? (input as { type?: string; text?: string }[]).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";

export interface EndedTurn {
  status: "ended";
  /** The turn's own outcome: "completed" normally, otherwise interrupted, failed, ... */
  outcome: string;
  /** The turn's last agent message, or null when it has none or did not complete normally. */
  final: { text: string; seq: number } | null;
  /** The texts the turn received as input (briefs carry their op marker). */
  inputs: string[];
  startSeq: number;
  endSeq: number;
  startedAt: number | null;
  endedAt: number | null;
}
export type CompletedTurn = EndedTurn;

const timeOf = (row: EventRow | undefined) => {
  const value = row?.createdAt;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The thread's latest turn: running, or ended with its outcome. Null when no turn is recorded.
 * A failed event read throws, so callers can tell "unknown" from a turn that ended.
 */
export async function latestTurn(sdk: Sdk, threadId: string): Promise<{ status: "running" } | EndedTurn | null> {
  const bounds = (await list(sdk, { threadId, types: ["turn/started", "turn/completed"], order: "desc", limit: "2" })).sort((a, b) => b.seq - a.seq);
  const end = bounds[0];
  if (!end) return null;
  if (end.type === "turn/started") return { status: "running" };
  const start = bounds.find(row => row.type === "turn/started" && row.seq < end.seq);
  if (!start) return null;
  const outcome = typeof end.data?.status === "string" ? end.data.status : "unknown";
  const inside = (row: EventRow) => row.seq > start.seq && row.seq < end.seq;
  const accepted = (await list(sdk, { threadId, types: ["turn/input/accepted"], afterSeq: String(start.seq), order: "asc", limit: "20" })).filter(inside);
  const ids = new Set(accepted.map(row => row.data?.clientRequestId).filter((id): id is string => typeof id === "string"));
  const requests = ids.size ? await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: "50" }) : [];
  const inputs = requests.filter(row => ids.has(row.data?.requestId)).map(row => inputText(row.data?.input));
  let final: EndedTurn["final"] = null;
  if (outcome === "completed") {
    const items = (await list(sdk, { threadId, types: ["item/completed"], afterSeq: String(start.seq), order: "desc", limit: "50" })).filter(inside).sort((a, b) => b.seq - a.seq);
    const message = items.find(row => row.data?.item?.type === "agentMessage" && !row.data.item.parentToolCallId && typeof row.data.item.text === "string" && row.data.item.text.trim());
    if (message) final = { text: String(message.data!.item.text).trim(), seq: message.seq };
  }
  return { status: "ended", outcome, final, inputs, startSeq: start.seq, endSeq: end.seq, startedAt: timeOf(start), endedAt: timeOf(end) };
}

/**
 * T150: what the thread's latest failure said — its failed turn's error, the provider's error
 * detail, or BB's own system error, newest first. Null when none carries text, or when a
 * normally completed turn is newer than any of them.
 */
export async function failureText(sdk: Sdk, threadId: string): Promise<string | null> {
  const rows = await list(sdk, { threadId, types: ["turn/completed", "provider/error", "system/error"], order: "desc", limit: "3" });
  for (const row of rows.sort((a, b) => b.seq - a.seq)) {
    const data = row.data ?? {};
    if (row.type === "turn/completed" && data.status === "completed") return null;
    const text = row.type === "turn/completed" ? data.error?.message : row.type === "provider/error" ? data.detail ?? data.message : data.message;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

/** The latest turn when it completed normally; null while running, after any other outcome, or with none. */
export async function latestCompletedTurn(sdk: Sdk, threadId: string): Promise<EndedTurn | null> {
  const turn = await latestTurn(sdk, threadId);
  return turn?.status === "ended" && turn.outcome === "completed" ? turn : null;
}

/**
 * Where a brief entered the thread: the sequence number of the turn input that accepted the
 * request carrying `marker`. Null when the thread has not received it (yet).
 */
export async function briefBoundary(sdk: Sdk, threadId: string, marker: string): Promise<number | null> {
  const requests = await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: "100" });
  const ids = new Set(requests.filter(row => inputText(row.data?.input).includes(marker)).map(row => row.data?.requestId).filter((id): id is string => typeof id === "string"));
  if (!ids.size) return null;
  const accepted = await list(sdk, { threadId, types: ["turn/input/accepted"], order: "desc", limit: "100" });
  const seqs = accepted.filter(row => ids.has(row.data?.clientRequestId)).map(row => row.seq);
  return seqs.length ? Math.min(...seqs) : null;
}

/** The thread's latest input (a turn request), or null when it has none. */
export async function latestInput(sdk: Sdk, threadId: string): Promise<{ seq: number; at: number } | null> {
  const [row] = await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: "1" });
  const at = timeOf(row);
  return row && at !== null ? { seq: row.seq, at } : null;
}

/**
 * When each sender last messaged `threadId`: its turn inputs, paged back until one predates
 * `since`, and messages still queued (as now). `reached` is how far back the read got; a sender
 * missing from `latest` is proven silent only since then.
 */
export async function messagesSince(sdk: Sdk, threadId: string, since: number, now: number) {
  const latest = new Map<string, number>();
  let reached = now;
  let beforeSeq: number | undefined;
  for (let page = 0; page < MESSAGE_PAGES; page++) {
    const rows = await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: String(MESSAGE_PAGE), ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }) });
    for (const row of rows) {
      const sender = row.data?.senderThreadId, at = timeOf(row) ?? 0;
      if (typeof sender === "string" && !latest.has(sender)) latest.set(sender, at);
      reached = Math.min(reached, at);
    }
    if (rows.length < MESSAGE_PAGE) reached = -Infinity;
    if (rows.length < MESSAGE_PAGE || reached < since) break;
    beforeSeq = rows.at(-1)!.seq;
  }
  const queued = await sdk.threads.queuedMessages.list({ threadId }) as { senderThreadId?: string | null }[];
  for (const row of queued) if (row.senderThreadId) latest.set(row.senderThreadId, now);
  return { latest, reached };
}
const MESSAGE_PAGE = 100;
const MESSAGE_PAGES = 10;

/**
 * The last agent message of the thread's latest turn, only when that turn completed normally.
 * The writer thread has one turn, so its final message is the handover.
 */
export async function finalAgentMessage(sdk: Sdk, threadId: string): Promise<{ text: string; seq: number } | null> {
  return (await latestCompletedTurn(sdk, threadId))?.final ?? null;
}
