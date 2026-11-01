import { bytes, children, end, key, label, renderLine, start, type NodeRef, type Nodes } from "./tree";

/** Frozen historical prefix and growing summary tail. Admission builds every needed leaf first. */
export const TAIL_BYTES = 32_000;

export interface TurnViewInput {
  /** The saved chat view and the messages fed into it. */
  chat: readonly NodeRef[];
  fed: number;
  nodes: Nodes;
  /** The view covers messages 0..cut-1: the log as the turn found it. */
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
  // The view's lines before the cut, then the messages logged since the view was fed.
  const refs = before(chat, cut);
  for (let i = fed; i < cut; i++) refs.push([0, i]);
  const built = (n: NodeRef) => nodes.has(key(...n));
  const lines = refs.map((n) => {
    if (!built(n)) throw new Error(`line ${label(n)} has no summary yet`);
    return renderLine(n, nodes);
  });
  const fixed = refs.length;
  const keep = frozen !== null && frozen.length <= fixed && sameRefs(frozen, refs) && size(lines.slice(frozen.length)) <= TAIL_BYTES;
  const cutAt = keep ? frozen.length : fixed;
  return { frozen: refs.slice(0, cutAt), frozenLines: lines.slice(0, cutAt), tailLines: lines.slice(cutAt) };
}
