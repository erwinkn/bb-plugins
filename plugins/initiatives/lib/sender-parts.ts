/** The header BB writes on each message of a batched turn, with the message's send time. */
const BATCH_HEADER = /^\[bb message from thread:([^;\]\s]+); sent \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\]\s*/;

type Block = { type?: string; text?: unknown; visibility?: unknown };
type Header = { at: number; match: RegExpExecArray } | null;

function headerOf(block: Block | undefined) {
  return block?.type === "text" && typeof block.text === "string" ? BATCH_HEADER.exec(block.text) : null;
}

/** BB's header on a later group: on its first text block, naming that group's sender. */
function laterHeader(blocks: Block[]): Header {
  const at = blocks.findIndex(c => c?.type === "text");
  const match = headerOf(blocks[at]);
  return match && { at, match };
}

/**
 * BB's header on the first group: on its message's first text block, which is one of the text
 * blocks up to the first visible one. Agent-only blocks ahead of it may be a fork's context or
 * the message's own, and either may quote an earlier header. BB's names the event's sender, so it
 * is found only when exactly one of those blocks starts with a header naming that sender.
 * Otherwise a quote can't be told from it, and the group keeps every header it has.
 */
function firstHeader(blocks: Block[], sender: string | null): Header {
  const visible = blocks.findIndex(c => c?.type === "text" && c.visibility !== "agent-only");
  const named = blocks.flatMap((c, at) => {
    const match = visible === -1 || at <= visible ? headerOf(c) : null;
    return match?.[1] === sender ? [{ at, match }] : [];
  });
  return named.length === 1 ? named[0]! : null;
}

/**
 * A turn request's input, one entry per sender. BB runs several queued agent messages as one
 * turn: each is its own input group, and senderThreadId names the first group's sender. Every
 * later group starts with BB's own "[bb message from thread:<id>; sent <time>]" header, ahead of
 * any agent text. The first group is never read for a sender: BB may put a fork's agent-only
 * context before it. A request with one sender, including every older event, is one entry.
 *
 * `batched` says BB wrote that header on every later group. The input then comes without the
 * headers BB wrote, each taken off the block BB wrote it on, so quoted text stays as written.
 * When the first group's header can't be told from a quote, that group keeps it. Older BB never
 * writes that header: there the request is one entry, as recorded, and its reader keeps its old
 * envelope handling.
 */
export function senderParts(data: Record<string, any> | undefined): { sender: string | null; input: unknown[]; batched: boolean }[] {
  const sender: string | null = typeof data?.senderThreadId === "string" ? data.senderThreadId : null;
  const input: unknown[] = Array.isArray(data?.input) ? data.input : [];
  const groups = (data?.initiator === "agent" && Array.isArray(data.inputGroups) ? data.inputGroups.filter(Array.isArray) : []) as Block[][];
  const later = groups.slice(1).map(laterHeader);
  if (groups.length < 2 || !later.every(Boolean)) return [{ sender, input, batched: false }];
  const headers = [firstHeader(groups[0]!, sender), ...later];
  const split = groups.map((group, i) => {
    const header = headers[i];
    const bare = header ? group.map((c, j) => (j === header.at ? { ...c, text: (c.text as string).slice(header.match[0].length) } : c)) : group;
    return { sender: i === 0 ? sender : header!.match[1]!, input: bare as unknown[], batched: true };
  });
  if (split.some(part => part.sender !== sender)) return split;
  // One sender: the groups as BB flattens them, with its separator between them.
  return [{ sender, input: split.flatMap((part, i) => (i === 0 ? part.input : [{ type: "text", text: "\n\n", mentions: [] }, ...part.input])), batched: true }];
}
