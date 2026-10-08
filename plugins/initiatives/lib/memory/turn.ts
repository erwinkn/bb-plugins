import type { MemoryMessage } from "./log";
import { messageText } from "./prompt";
import { LIMIT, PLACEHOLDER, bytes, children, end, headBytes, key, label, renderLine, start, type NodeRef, type Nodes } from "./tree";

/**
 * D431 phase 2: the view an optchat turn sees, split in two for prompt caching.
 *
 * - frozen: the view's older lines, all built, at the end of the system prompt. They stay the
 *   same turn after turn, so the system prompt is a cached prefix, until a merge batch rewrites
 *   them or the rest grows past TAIL_BYTES; then everything built is frozen again.
 * - tail: the rest, in the turn's first message: the newest lines, and the messages the tree
 *   has no line for yet, shown whole when short or as head and tail (MESSAGE_BYTES), newest
 *   first within RAW_BYTES; older ones are placeholders, a run of them one line (runLine). Turns
 *   never wait for the summarizer.
 *
 * Example, 300 messages logged, the last one the new message: frozen holds 0+128 … 256+1 (built
 * lines), the tail 280+1 … 298+1, and 296+1 … 298+1 are clipped messages still being summarized.
 */
export const TAIL_BYTES = 32_000;
export const RAW_BYTES = 48_000;
/** Messages with no line at all past which the view is unusable and the turn runs as hybrid. */
export const MAX_MISSING = 16;
const MESSAGE_BYTES: Record<MemoryMessage["kind"], number> = { user: 2048, coord: 2048, work: 2048, note: 2048, tool: LIMIT, echo: LIMIT };

export interface TurnViewInput {
  /** The saved chat view and the messages fed into it. */
  chat: readonly NodeRef[];
  fed: number;
  nodes: Nodes;
  message: (i: number) => Pick<MemoryMessage, "kind" | "text"> | null;
  /** The view covers messages 0..cut-1; the new message and anything after it are left out. */
  cut: number;
  /** This thread's frozen lines from its previous turn, if any. */
  frozen: readonly NodeRef[] | null;
}

export interface TurnView {
  frozen: NodeRef[];
  frozenLines: string[];
  tailLines: string[];
  /** Messages shown as placeholders. */
  missing: number;
  /** Whether the frozen lines changed (a system prompt cache write). */
  refrozen: boolean;
}

/** A message the tree has no line for yet: whole when short, else its head and tail. */
export function rawLine(i: number, m: Pick<MemoryMessage, "kind" | "text">, budget = MESSAGE_BYTES[m.kind]) {
  const text = messageText(m).replace(/\s*\n\s*/g, " ");
  if (bytes(text) <= budget) return `${i}+1|${text}`;
  const head = headBytes(text, Math.floor((budget * 2) / 3));
  const tail = Buffer.from(text, "utf8").subarray(-(Math.floor(budget / 3) - 16)).toString("utf8").replace(/^\uFFFD+/, "");
  return `${i}+1|${head} … ${tail}`;
}

/** Consecutive messages with no line, as one line: a backlog stays one line, however long. */
export const runLine = (from: number, to: number) =>
  to === from ? `${from}+1|${PLACEHOLDER}` : `${from}..${to}|(${to - from + 1} messages not summarized yet: zoom each, n: 1)`;

/** The view's lines before message `cut`: a line that crosses it opens into its two lines, again until none does. */
function before(view: readonly NodeRef[], cut: number) {
  const refs: NodeRef[] = [];
  const add = (n: NodeRef) => {
    if (end(n) < cut) refs.push(n);
    else if (start(n) < cut) children(n).forEach(add);
  };
  view.forEach(add);
  return refs;
}

const sameRefs = (a: readonly NodeRef[], b: readonly NodeRef[]) => a.every((n, k) => b[k] !== undefined && label(n) === label(b[k]!));

export function turnView({ chat, fed, nodes, message, cut, frozen }: TurnViewInput): TurnView {
  // The view's lines before the new message, then the messages logged since the view was fed.
  const refs = before(chat, cut);
  for (let i = fed; i < cut; i++) refs.push([0, i]);
  const built = (n: NodeRef) => nodes.has(key(...n));

  const keep = frozen && frozen.length <= refs.length && sameRefs(frozen, refs) && frozen.every((n) => end(n) < cut);
  let cutAt = keep ? frozen.length : 0;
  const render = (from: number) => {
    // Unbuilt messages are shown raw, newest first, within RAW_BYTES.
    let raw = RAW_BYTES;
    let missing = 0;
    // Newest first; a placeholder is the [first, last] messages of its run.
    const lines: Array<string | [number, number]> = [];
    for (let k = refs.length - 1; k >= from; k--) {
      const n = refs[k]!;
      if (built(n)) lines.push(renderLine(n, nodes));
      else {
        const m = n[0] === 0 ? message(n[1]) : null;
        const line = m && rawLine(n[1], m);
        if (line && bytes(line) <= raw) {
          raw -= bytes(line) + 1;
          lines.push(line);
        } else {
          missing += end(n) - start(n) + 1;
          const run = lines.at(-1);
          if (Array.isArray(run) && run[0] === end(n) + 1) run[0] = start(n);
          else lines.push([start(n), end(n)]);
        }
      }
    }
    return { lines: lines.reverse().map((l) => (Array.isArray(l) ? runLine(...l) : l)), missing };
  };
  let tail = render(cutAt);
  let refrozen = !keep;
  if (!keep || tail.lines.reduce((sum, l) => sum + bytes(l) + 1, 0) > TAIL_BYTES) {
    // Freeze everything built, up to the first line that is not.
    cutAt = 0;
    while (cutAt < refs.length && built(refs[cutAt]!)) cutAt++;
    tail = render(cutAt);
    refrozen = !keep || cutAt !== frozen!.length;
  }
  const frozenRefs = refs.slice(0, cutAt);
  return {
    frozen: frozenRefs,
    frozenLines: frozenRefs.map((n) => renderLine(n, nodes)),
    tailLines: tail.lines,
    missing: tail.missing,
    refrozen,
  };
}
