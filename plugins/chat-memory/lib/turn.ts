import type { MemoryMessage } from "./log";
import { messageText } from "./prompt";
import { bytes, children, end, key, label, renderLine, start, type NodeRef, type Nodes } from "./tree";

/**
 * D431 phase 2: the view an OptChat turn sees, split in two for prompt caching.
 *
 * - frozen: the view's older lines, at the end of the system prompt. They stay the same turn after
 *   turn, so the system prompt is a cached prefix (and Claude Code's fresh-session seed is reused),
 *   until a merge batch rewrites them or the rest grows past TAIL_BYTES; then every line is frozen
 *   again.
 * - tail: the rest, in the session's first message.
 *
 * D487: a message with no summary yet is shown whole, "id+1|kind: text" as memory_zoom gives it,
 * up to WHOLE_BYTES in all: the caller waits for the summaries of every message before those. A
 * message shown whole is never frozen, since its line changes once it is summarized.
 *
 * Example, 300 messages logged, 296 to 299 not summarized yet: frozen holds 0+128 … 256+32, the
 * tail 288+8, then 296+1 … 299+1 whole.
 */
export const TAIL_BYTES = 32_000;
export const WHOLE_BYTES = 32_000;

export interface TurnViewInput {
  /** The saved chat view and the messages fed into it. */
  chat: readonly NodeRef[];
  fed: number;
  nodes: Nodes;
  /** The view covers messages 0..cut-1: the log as the turn found it. */
  cut: number;
  /** A logged message, for one shown whole. */
  message: (i: number) => MemoryMessage | null;
  /** This thread's frozen lines from its previous turn, if any. */
  frozen: readonly NodeRef[] | null;
}

export interface TurnView {
  frozen: NodeRef[];
  frozenLines: string[];
  tailLines: string[];
}

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
const size = (lines: readonly string[]) => lines.reduce((sum, l) => sum + bytes(l) + 1, 0);

export function turnView({ chat, fed, nodes, cut, frozen, message }: TurnViewInput): TurnView {
  // The view's lines before the cut, then the messages logged since the view was fed.
  const refs = before(chat, cut);
  for (let i = fed; i < cut; i++) refs.push([0, i]);
  const built = (n: NodeRef) => nodes.has(key(...n));
  const lines = refs.map((n) => {
    if (built(n)) return renderLine(n, nodes);
    const m = n[0] === 0 ? message(n[1]) : null;
    if (!m) throw new Error(`line ${label(n)} has no summary yet`);
    return `${n[1]}+1|${messageText(m)}`;
  });
  const whole = refs.findIndex((n) => !built(n));
  const fixed = whole < 0 ? refs.length : whole;
  const keep = frozen !== null && frozen.length <= fixed && sameRefs(frozen, refs) && size(lines.slice(frozen.length)) <= TAIL_BYTES;
  const cutAt = keep ? frozen.length : fixed;
  return { frozen: refs.slice(0, cutAt), frozenLines: lines.slice(0, cutAt), tailLines: lines.slice(cutAt) };
}
