import { createHash } from "node:crypto";
import type { Sdk } from "./bb";
import { senderParts } from "./sender-parts";

/**
 * W468: BB can refuse the turn a report notice starts (competing_turn) after `threads.send` has
 * answered. The send response names no request; only the lead's event log tells what became of
 * it. The server may also queue a retry of the refused turn itself ("retry" payload, sent later
 * as a request with retryOfRequestId); that retry is BB's to deliver, never resent from here.
 */
export const REPORT_NOTICE_ATTEMPTS = 3;
/** A send that left no turn request in the log is given this long to appear before it counts as lost. */
export const REPORT_NOTICE_SETTLE_MS = 15_000;
/** A request with no verdict (taken or refused) this long after it was made is taken as taken. */
const ASSUME_MS = 5 * 60_000;
const SLACK_MS = 5_000;
const PAGE = 100;
const MAX_PAGES = 10;
const MAX_RETRY_HOPS = 8;

/** Identity of a report's content: an identical refile keeps its notice, a different report starts a new one. */
export const reportHash = (report: unknown) => createHash("sha256").update(JSON.stringify(report) ?? "").digest("hex").slice(0, 16);

export type NoticeVerdict =
  /** BB took the turn, or a request has gone unanswered for so long that it is taken as taken. */
  | "accepted"
  /** BB refused every send and holds no retry. */
  | "rejected"
  /** A request has no verdict yet. */
  | "pending"
  /** BB holds the message, or a retry of it, in its queue. */
  | "queued"
  /** The log shows no such request. */
  | "missing"
  /** The log could not be read far enough back to tell. */
  | "unknown"
  /** The lead thread no longer exists. */
  | "gone";

type EventRow = { seq: number; type: string; createdAt?: number | string; data?: Record<string, any> };
const timeOf = (row: EventRow) => {
  const v = row.createdAt;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const textOf = (input: unknown) =>
  (Array.isArray(input) ? (input as { type?: string; text?: unknown }[]).filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text as string).join("\n") : "");

/** BB's own envelope line, if any, then the header line the notice carries. */
const ENVELOPE = /^(?:\[bb (?:message from thread:[^\]]*|system)\]\s*)?(?:Initiative · [^\n]*? · W[1-9]\d*\s+)?/;
const read = async (sdk: Sdk, lead: string, since: number) => {
  const rows: EventRow[] = [];
  let before: number | null = null;
  let complete = false;
  for (let page = 0; page < MAX_PAGES && !complete; page++) {
    const got = (await sdk.threads.events.list({ threadId: lead, types: ["client/turn/requested", "client/turn/rejected", "turn/input/accepted"], order: "desc", limit: String(PAGE), ...(before !== null ? { beforeSeq: String(before) } : {}) } as never)) as EventRow[];
    const older = got.filter(row => before === null || row.seq < before);
    rows.push(...older);
    const at = older.map(timeOf).filter((t): t is number => t !== null);
    complete = got.length < PAGE || !older.length || (at.length === older.length && Math.max(...at) < since - SLACK_MS);
    before = older.length ? Math.min(...older.map(row => row.seq)) : null;
  }
  return { rows, complete };
};

export interface NoticeQuery {
  lead: string;
  /** The worker thread the notice was sent as. */
  sender: string;
  /** The message after its header line. */
  text: string;
  /** When the notice's first send began. */
  since: number;
  /** The BB queue row holding the latest send, when BB queued it. */
  queuedId: string | null;
  now: number;
}

/**
 * What became of a notice. Every send of it that the lead's log shows is looked at; BB's retries
 * of a refused turn all name the original request and count with it. The notice is taken if any
 * of them was, and is BB's to deliver while a queue row holds it or a retry of it.
 */
export async function noticeVerdict(sdk: Sdk, q: NoticeQuery): Promise<NoticeVerdict> {
  const wanted = q.text.replace(/\s+/g, " ").trim();
  const analyze = async (): Promise<NoticeVerdict> => {
    const queued = await sdk.threads.queuedMessages.list({ threadId: q.lead });
    if (q.queuedId && queued.some(row => row.id === q.queuedId)) return "queued";
    const { rows, complete } = await read(sdk, q.lead, q.since);
    const isNotice = (input: unknown) => textOf(input).replace(ENVELOPE, "").replace(/\s+/g, " ").trim() === wanted;
    // BB runs several queued messages as one turn: each is its own input group, and merging them would hide the notice.
    const mine = rows.filter(row => row.type === "client/turn/requested" && (timeOf(row) ?? Infinity) >= q.since - SLACK_MS &&
      senderParts(row.data).some(part => part.sender === q.sender) &&
      [...senderParts(row.data).map(part => part.input), ...(Array.isArray(row.data?.inputGroups) ? row.data.inputGroups : [])].some(isNotice));
    if (!mine.length) return complete ? "missing" : "unknown";
    const originals = new Set(mine.map(row => (row.data?.retryOfRequestId ?? row.data?.requestId) as string));
    const requests = rows.filter(row => row.type === "client/turn/requested" && (originals.has(row.data?.requestId) || originals.has(row.data?.retryOfRequestId)));
    const ids = new Set(requests.map(row => row.data!.requestId as string));
    if (rows.some(row => row.type === "turn/input/accepted" && ids.has(row.data?.clientRequestId))) return "accepted";
    const rejected = new Set(rows.filter(row => row.type === "client/turn/rejected").map(row => row.data?.requestId));
    const unanswered = requests.filter(row => !rejected.has(row.data!.requestId));
    if (unanswered.length) return unanswered.every(row => (timeOf(row) ?? Infinity) < q.now - ASSUME_MS) ? "accepted" : "pending";
    return queued.some(row => row.payload?.kind === "retry" && originals.has(row.payload.retryOfTurnRequestId)) ? "queued" : "rejected";
  };
  try {
    // A queued retry may have been sent between the queue and history reads; read both again before calling it refused.
    const verdict = await analyze();
    return verdict === "rejected" ? await analyze() : verdict;
  } catch (error) {
    // Only a thread BB says does not exist is gone; any other failed read says nothing about the notice.
    if ((error as { status?: unknown } | null)?.status === 404) return "gone";
    throw error;
  }
}
