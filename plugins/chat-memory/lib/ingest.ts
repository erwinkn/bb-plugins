import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LOG_EVENT_TYPES, type EventRow } from "./log";

type Sdk = BbPluginApi["sdk"];
const PAGE = 100;

export type ListEvents = (args: {
  threadId: string;
  types: readonly [string, ...string[]];
  order: "asc" | "desc";
  limit: string;
  afterSeq?: string;
}) => Promise<EventRow[]>;
export const sdkEvents = (sdk: Sdk): ListEvents => (args) => sdk.threads.events.list(args as never) as Promise<EventRow[]>;

/**
 * D487: a thread's events after `afterSeq` through its last turn/completed, oldest first. BB writes
 * one for every turn that ends (completed, failed or interrupted); what comes after it (a turn in
 * progress, a request whose turn has not started) waits for the next one, and is never read: the
 * newest turn/completed is found first and pages stop there. Reads carry no signal (W193: BB's SDK
 * records a composite on each); callers check theirs between reads.
 *
 * Pages of PAGE rows are read up to that end, or `pages` of them once a turn has ended in what was
 * read (`more`: read again). Only a page's first PAGE rows are taken: BB merges its per-type reads
 * into one prefix of `limit` rows, and from a BB that counts `limit` per type, the first PAGE rows
 * are a complete prefix too.
 */
export async function readTurns(list: ListEvents, threadId: string, afterSeq: number, pages: number, stopped: () => boolean) {
  const none = { rows: [], through: afterSeq, more: false };
  const [last] = await list({ threadId, types: ["turn/completed"], order: "desc", limit: "1" });
  if (!last || last.seq <= afterSeq) return none;
  const rows: EventRow[] = [];
  let after = afterSeq;
  let through = afterSeq;
  let ended = 0;
  for (let page = 1; ; page++) {
    if (stopped()) return none;
    const read = (await list({ threadId, types: LOG_EVENT_TYPES, order: "asc", limit: String(PAGE), afterSeq: String(after) }))
      .filter((r) => r.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, PAGE);
    for (const row of read) {
      if (row.seq > last.seq) break;
      rows.push(row);
      if (row.type === "turn/completed") (through = row.seq), (ended = rows.length);
    }
    if (through === last.seq || read.length < PAGE) return { rows: rows.slice(0, ended), through, more: false };
    after = read.at(-1)!.seq;
    if (ended && page >= pages) return { rows: rows.slice(0, ended), through, more: true };
  }
}
