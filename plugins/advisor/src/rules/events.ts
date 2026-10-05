// The installed event-read contract (A160 F1): every read is one page of at most
// 100 rows, cursors are strict, and every early stop is a named gap.

export const EVENT_PAGE_MAX = 100; // THREAD_EVENT_LIST_PAGE_SIZE; limit > 100 is a 400
export const SEED_PAGES = 5; // newest pre-watch request/receipt rows: at most 500
export const SWEEP_PAGES = 10; // the first request's receipt sweep
export const OWNER_PAGES = 5; // pre-watch ownership history
export const SEED_BYTES = 2 * 1024 * 1024; // per bounded read sequence, measured on the page JSON
export const DRAIN_PAGE_ROWS = 25;
export const DRAIN_PASS_PAGES = 8;
export const DRAIN_PASS_BYTES = 8 * 1024 * 1024;

export const REQUEST_TYPES = ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"] as const;
export const RECEIPT_TYPES = ["turn/input/accepted", "client/turn/rejected"] as const;

/** A thread event row as the SDK returns it; only the fields the rules read are typed. */
export interface EventRow {
  seq: number;
  type: string;
  data: Record<string, any>;
  createdAt?: number;
  id?: string;
}

export interface EventQuery {
  order?: "asc" | "desc";
  limit?: string;
  afterSeq?: string;
  beforeSeq?: string;
  types?: readonly string[];
}

/** One page of events: the SDK's `threads.events.list` bound to a thread. */
export interface EventSource {
  list(args: EventQuery): Promise<EventRow[]>;
}

/** HTTP status of a failed read when the error carries one; null otherwise. */
export function errorStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    for (const v of [e.status, e.statusCode, e.response?.status]) {
      if (typeof v === "number" && Number.isInteger(v)) return v;
    }
  }
  return null;
}

export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

export type PageStatus = string; // "complete" | "stopped" | a named gap such as "page-cap@1101"

/**
 * Strict-cursor paging over the bare-array API: afterSeq for asc, beforeSeq for
 * desc, each next cursor the last row's seq. Bounded by reads, rows (reads x 100)
 * and encoded bytes. Any status but "complete"/"stopped" is a named partial gap.
 */
export async function readPages(
  src: EventSource,
  base: EventQuery,
  order: "asc" | "desc",
  start: number | null,
  maxPages: number,
  maxBytes: number,
  stop?: (rows: EventRow[]) => boolean,
): Promise<{ rows: EventRow[]; status: PageStatus }> {
  const rows: EventRow[] = [];
  let reads = 0;
  let used = 0;
  let limit = EVENT_PAGE_MAX;
  let cursor = start;
  const key = order === "asc" ? "afterSeq" : "beforeSeq";
  const at = () => (cursor === null ? "None" : String(cursor));
  for (;;) {
    if (reads >= maxPages) return { rows, status: `page-cap@${at()}` };
    const args: EventQuery = { ...base, order, limit: String(limit), ...(cursor !== null ? { [key]: String(cursor) } : {}) };
    reads++;
    let page: EventRow[];
    try {
      page = await src.list(args);
    } catch (err) {
      const status = errorStatus(err);
      if (status === 413 && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2)); // a smaller page may fit; still bounded by maxPages
        continue;
      }
      return { rows, status: `read-failed-${status ?? "unknown"}@${at()}` };
    }
    if (page.length === 0) return { rows, status: "complete" };
    if (page.length > limit) return { rows, status: `contract-violation-oversize@${at()}` };
    const seqs = page.map((r) => r.seq);
    const fwd = order === "asc";
    const behind = cursor !== null && seqs.some((s) => (fwd ? s <= cursor! : s >= cursor!));
    const unordered = seqs.some((s, i) => i > 0 && (fwd ? s <= seqs[i - 1]! : s >= seqs[i - 1]!));
    if (behind || unordered) return { rows, status: `contract-violation-non-progress@${at()}` };
    rows.push(...page);
    used += jsonBytes(page);
    cursor = seqs[seqs.length - 1]!;
    if (stop?.(rows)) return { rows, status: "stopped" };
    if (used > maxBytes) return { rows, status: `byte-cap@${at()}` };
    if (page.length < limit) return { rows, status: "complete" }; // the server returns min(limit, remaining)
  }
}

/** Is this row a stop of the watched work (Stop, interrupt)? */
export function isInterrupt(row: EventRow): boolean {
  return row.type === "system/thread/interrupted" || (row.type === "turn/completed" && row.data?.status === "interrupted");
}
