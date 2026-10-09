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
 * Every line is a summary (gist §6: a turn waits until every earlier message is summarized), so
 * the caller renders a view only once messages 0..cut-1 have their line.
 *
 * Example, 300 messages logged, the last one the new message: frozen holds 0+128 … 256+16 and the
 * tail 272+8 … 298+1.
 */
export const TAIL_BYTES = 32_000;

export interface TurnViewInput {
  /** The saved chat view and the messages fed into it. */
  chat: readonly NodeRef[];
  fed: number;
  nodes: Nodes;
  /** The view covers messages 0..cut-1; the new message and anything after it are left out. */
  cut: number;
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

export function turnView({ chat, fed, nodes, cut, frozen }: TurnViewInput): TurnView {
  // The view's lines before the new message, then the messages logged since the view was fed.
  const refs = before(chat, cut);
  for (let i = fed; i < cut; i++) refs.push([0, i]);
  const unbuilt = refs.find((n) => !nodes.has(key(...n)));
  if (unbuilt) throw new Error(`line ${label(unbuilt)} has no summary yet`);
  const lines = refs.map((n) => renderLine(n, nodes));
  const keep = frozen !== null && frozen.length <= refs.length && sameRefs(frozen, refs) && size(lines.slice(frozen.length)) <= TAIL_BYTES;
  const cutAt = keep ? frozen.length : refs.length;
  return { frozen: refs.slice(0, cutAt), frozenLines: lines.slice(0, cutAt), tailLines: lines.slice(cutAt) };
}
