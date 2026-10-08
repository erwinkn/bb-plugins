/**
 * W239: a dashboard write that has not answered by WRITE_SLOW_MS says so, and by
 * WRITE_UNCONFIRMED_MS stops holding the dashboard: the remote app reaches bb through a relay
 * that can lose a request without an answer. The write itself is never cancelled; a late
 * answer still lands, and the next read shows what was saved.
 *
 * W244, W248: so a write sent again after that cannot run twice (two tasks from one Add task),
 * a write that adds something carries a key (keyedWrite). sendWrite keeps the key of a send
 * without a settled answer and reuses it when the same write is sent again; the server's
 * WriteReceipts (write-receipts.ts) runs each key once and answers a repeat from its receipt.
 * A write that sets a value (memory mode, pause) carries none: sending it again sets the same
 * value, and a later different choice simply wins.
 */
export const WRITE_SLOW_MS = 5_000;
export const WRITE_UNCONFIRMED_MS = 30_000;
export const WRITE_SLOW_MESSAGE = "Still saving: the connection is slow.";
export const WRITE_UNCONFIRMED_MESSAGE =
  "No answer after 30 s: this may still be saved, and shows here once it is. Sending the same again never saves it twice.";
/** How long a key stays good for sending again: the client's window; the server keeps receipts a day longer. */
export const WRITE_RECEIPT_MS = 7 * 24 * 60 * 60_000;
export const WRITE_EXPIRED_MESSAGE =
  "This was first sent over 7 days ago without an answer, so sending it again can no longer be matched to that send. Check whether it was saved; if not, send it again.";

/** A write with no answer by WRITE_UNCONFIRMED_MS; the write itself goes on. */
export class WriteUnconfirmedError extends Error {
  constructor() {
    super(WRITE_UNCONFIRMED_MESSAGE);
    this.name = "WriteUnconfirmedError";
  }
}

/** Rejects with WriteUnconfirmedError once the write has gone WRITE_UNCONFIRMED_MS unanswered. */
export function withWriteTimeout<T>(write: Promise<T>, ms = WRITE_UNCONFIRMED_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WriteUnconfirmedError()), ms);
  });
  // A late failure is nobody's to handle any more.
  write.catch(() => {});
  return Promise.race([write, late]).finally(() => clearTimeout(timer));
}

/**
 * The commands a repeat would do again: each creates, appends or sends something. Every other
 * command sets a state (a mode, paused, a task closed), so running it twice is running it once.
 */
const KEYED = new Set([
  "create", "message", "thread-create", "delegate", "task-create", "adopt", "decision", "question",
  "update", "answer", "blocker-answer", "decision-review", "queued-message", "handover-draft",
  "replace-coordinator", "coordinator-handover",
]);
export const keyedWrite = (command: { action: string; cancel?: boolean; verdict?: string }) =>
  KEYED.has(command.action) &&
  !(command.action === "coordinator-handover" && command.cancel) &&
  // Okay only marks a decision reviewed; Not okay also messages the coordinator.
  !(command.action === "decision-review" && command.verdict === "okay");

/**
 * The command RPC's answer to a keyed write. rejected: the server refused it with nothing
 * saved. unknown: an earlier send of the key failed or was cut off midway, so what it saved is
 * unknown. Either way the key is settled, and the next send is a new write.
 */
export type WriteAnswer =
  | { write: "done"; answer: unknown }
  | { write: "rejected" | "unknown"; message: string };

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/** cyrb53: a short name for a write's content in storage. The server checks the content itself. */
function hash(text: string) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

/**
 * Unconfirmed writes' keys, by content, in localStorage so a reload keeps them (in memory
 * where there is none). An entry stays until a send of it gets a settled answer, or until it
 * is older than WRITE_RECEIPT_MS and that send is refused with WRITE_EXPIRED_MESSAGE.
 */
type Held = { key: string; at: number };
const memory = new Map<string, string>();
const storage = (): Pick<Storage, "getItem" | "setItem" | "removeItem"> => {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    /* storage blocked */
  }
  return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: (k) => void memory.delete(k) };
};
const held = (id: string): Held | null => {
  let raw: string | null = null;
  try {
    raw = storage().getItem(id);
  } catch {
    /* storage blocked */
  }
  // A key storage refused to keep is in this page's memory.
  raw ??= memory.get(id) ?? null;
  try {
    return JSON.parse(raw ?? "null") as Held | null;
  } catch {
    return null;
  }
};
const hold = (id: string, value: Held | null) => {
  memory.delete(id);
  try {
    if (value) storage().setItem(id, JSON.stringify(value));
    else storage().removeItem(id);
  } catch {
    // Full or blocked storage: this page's memory keeps it.
    if (value) memory.set(id, JSON.stringify(value));
  }
};
/** Tests: forget the in-memory entries (localStorage is cleared separately). */
export const forgetUnconfirmedWrites = () => memory.clear();

/**
 * Send a write under withWriteTimeout; send spreads keyed into the RPC input. A keyed write
 * (keyedWrite) gets a new key, so the same command twice on purpose runs twice; its key is
 * kept from the first send until an answer settles it, so sending the same content again after
 * a timeout, a dropped connection or any other error is the same write, which the server runs
 * at most once. A key older than WRITE_RECEIPT_MS is dropped with a refusal asking the user to
 * check first.
 */
export async function sendWrite<T = unknown>(
  request: { projectId?: string; command: { action: string; [field: string]: unknown } },
  send: (keyed: { key?: string }) => Promise<unknown>,
): Promise<T> {
  if (!keyedWrite(request.command)) return (await withWriteTimeout(send({}))) as T;
  const id = `initiatives:write:${hash(JSON.stringify(request))}`;
  const kept = held(id);
  if (kept && Date.now() - kept.at >= WRITE_RECEIPT_MS) {
    hold(id, null);
    throw new Error(WRITE_EXPIRED_MESSAGE);
  }
  const key = kept?.key ?? newKey();
  if (!kept) hold(id, { key, at: Date.now() });
  // Any failure here may have saved it: the key stays for the next send.
  const reply = (await withWriteTimeout(send({ key }))) as WriteAnswer;
  hold(id, null);
  if (reply.write === "done") return reply.answer as T;
  throw new Error(reply.message);
}
