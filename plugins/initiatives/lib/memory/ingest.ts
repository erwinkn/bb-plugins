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
  beforeSeq?: string;
}) => Promise<EventRow[]>;
export const sdkEvents = (sdk: Sdk): ListEvents => (args) => sdk.threads.events.list(args as never) as Promise<EventRow[]>;

/**
 * The log's events after `afterSeq`, oldest first, and the sequence read through. Reads carry no
 * signal (W193: BB's SDK records a composite on each); callers check theirs between reads.
 *
 * Every row up to `through` is read, never more: the newest sequence of the log's types is read
 * first, as one boundary, so an event that lands while the pages are read (of a type already read)
 * waits for the next read rather than being skipped. Each type is then paged on its own, since BB
 * counts `limit` per requested type, and a full page lowers the boundary to its last row. Once
 * `stopped`, no page is read: nothing is read through.
 */
export async function readEvents(list: ListEvents, threadId: string, afterSeq: number, stopped = () => false) {
  const latest = await list({ threadId, types: LOG_EVENT_TYPES, order: "desc", limit: "1" });
  const boundary = Math.max(afterSeq, ...latest.map((r) => r.seq));
  if (boundary === afterSeq || stopped()) return { rows: [], through: afterSeq, more: false };
  const pages = await Promise.all(
    LOG_EVENT_TYPES.map((type) => list({ threadId, types: [type], order: "asc", limit: String(PAGE), afterSeq: String(afterSeq) })),
  );
  let through = boundary;
  for (const rows of pages) if (rows.length >= PAGE) through = Math.min(through, Math.max(...rows.map((r) => r.seq)));
  const rows = pages.flat().filter((r) => r.seq > afterSeq && r.seq <= through).sort((a, b) => a.seq - b.seq);
  return { rows, through, more: through < boundary };
}

/**
 * Whether a coordinator thread holds everything before it: it began a new Initiative, or as a
 * replacement with a handover. Seeding stops there.
 */
export async function startsAfresh(list: ListEvents, threadId: string) {
  const [first] = await list({ threadId, types: ["client/turn/requested"], order: "asc", limit: "1" });
  const text = Array.isArray(first?.data?.input) ? first.data.input.map((c: { text?: string }) => c.text ?? "").join("") : "";
  return first?.data?.source === "spawn" &&
    (/^This thread is starting as coordinator of a new Initiative/.test(text) || (/^This thread is starting as the replacement coordinator/.test(text) && /Handover from the previous coordinator/.test(text)));
}
