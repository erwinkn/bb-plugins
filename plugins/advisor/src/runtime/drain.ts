// One bounded drain pass over persisted events (A140 §3.2, A160 F1): afterSeq
// cursor, ascending, 25-row pages, at most 8 pages or 8 MiB per pass. Each
// page's derived cards and the cursor commit together. A page that does not
// move strictly past the cursor stops the pass with a named gap.

import { DRAIN_PAGE_ROWS, DRAIN_PASS_BYTES, DRAIN_PASS_PAGES, errorStatus, jsonBytes, type EventRow, type EventSource } from "../rules/events.js";

export interface DrainInfo {
  cursor: number;
  pages: number;
  atTip: boolean;
  gap?: string;
}

export async function drainPass(
  src: EventSource,
  cursor: number,
  commit: (page: EventRow[], nextCursor: number) => Promise<void> | void,
  limits = { pages: DRAIN_PASS_PAGES, bytes: DRAIN_PASS_BYTES, rows: DRAIN_PAGE_ROWS },
): Promise<DrainInfo> {
  let pages = 0;
  let used = 0;
  let short = false;
  while (pages < limits.pages && used < limits.bytes) {
    let page: EventRow[];
    try {
      page = await src.list({ order: "asc", afterSeq: String(cursor), limit: String(limits.rows) });
    } catch (err) {
      return { cursor, pages, atTip: false, gap: `read-failed-${errorStatus(err) ?? "unknown"}@${cursor}` };
    }
    if (page.length === 0) return { cursor, pages, atTip: true };
    const seqs = page.map((e) => e.seq);
    if (page.length > limits.rows || seqs[0]! <= cursor || seqs.some((s, i) => i > 0 && s <= seqs[i - 1]!)) {
      return { cursor, pages, atTip: false, gap: `contract-violation-non-progress@${cursor}` };
    }
    const next = seqs[seqs.length - 1]!;
    await commit(page, next);
    used += jsonBytes(page);
    cursor = next;
    pages++;
    short = page.length < limits.rows;
    if (short) break;
  }
  return { cursor, pages, atTip: short };
}
