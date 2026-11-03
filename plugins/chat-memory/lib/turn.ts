import { VIEW_BYTES, bytes, children, end, key, label, renderLine, start, type NodeRef, type Nodes } from "./tree";

/** Frozen historical prefix and growing summary tail. */
export const TAIL_BYTES = 32_000;
/**
 * R12: the most a turn's view may hold. A turn never waits for merges: when they lag, its view goes
 * over the chat view's 128 KB target and is sent as it is, up to this. Only past it does the turn
 * wait (for the merges that bring it back under), and fail visibly at its deadline: a stalled
 * builder cannot grow a view without bound.
 */
export const CEILING_BYTES = 2 * VIEW_BYTES.chat[0];

export interface TurnViewInput {
  /** The saved chat view and the messages fed into it. */
  chat: readonly NodeRef[];
  fed: number;
  nodes: Nodes;
  /** The view covers messages 0..cut-1: the log as the turn found it. */
  cut: number;
  /** This thread's frozen lines from its previous turn, if any. */
  frozen: readonly string[] | null;
  /** R12: what message i's line shows while it has no summary: pendingLine of its text. */
  pending: (i: number) => string;
  /**
   * R12: whether message i's summary failed and waits for its retry (FAILED_RETRY_MS). Its line
   * then stays as it is for that long, so it may enter the frozen prefix.
   */
  stalled: (i: number) => boolean;
}

export interface TurnView {
  frozenLines: string[];
  tailLines: string[];
  /** R12: its messages shown by their start, without a summary yet. */
  pending: number;
  bytes: number;
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

const sameLines = (a: readonly string[], b: readonly string[]) => a.every((l, k) => l === b[k]);
const size = (lines: readonly string[]) => lines.reduce((sum, l) => sum + bytes(l) + 1, 0);

/** The view's lines before the cut, then the messages logged since the view was fed. */
function refsOf({ chat, fed, cut }: Pick<TurnViewInput, "chat" | "fed" | "cut">) {
  const refs = before(chat, cut);
  for (let i = fed; i < cut; i++) refs.push([0, i]);
  return refs;
}
/**
 * R12: a line, or null for a message without its summary. Only message lines can lack one: a view
 * merges two lines only once their parent is built, and opens a built line into built halves.
 */
function lineOf(n: NodeRef, nodes: Nodes) {
  if (nodes.has(key(...n))) return renderLine(n, nodes);
  if (n[0] !== 0) throw new Error(`line ${label(n)} has no summary yet`);
  return null;
}
const pendingOf = (n: NodeRef, pending: TurnViewInput["pending"]) => `${label(n)}|${pending(n[1])}`;

/**
 * turnView's bytes, counted only until they pass `limit`: then some number over it. A turn waiting
 * on a backlog asks after each summary built whether its view is under the ceiling; this answers
 * without rendering, or reading, the rest of the backlog.
 */
export function turnBytes(input: Omit<TurnViewInput, "frozen" | "stalled">, limit: number) {
  let sum = 0;
  for (const n of refsOf(input)) {
    sum += bytes(lineOf(n, input.nodes) ?? pendingOf(n, input.pending)) + 1;
    if (sum > limit) break;
  }
  return sum;
}

export function turnView({ chat, fed, nodes, cut, frozen, pending: preview, stalled }: TurnViewInput): TurnView {
  const refs = refsOf({ chat, fed, cut });
  // R12: a message without its summary shows its start. Until one is coming, a failed one's line is stable.
  let firstComing = refs.length;
  let pending = 0;
  const lines = refs.map((n, k) => {
    const line = lineOf(n, nodes);
    if (line !== null) return line;
    if (!stalled(n[1])) firstComing = Math.min(firstComing, k);
    pending++;
    return pendingOf(n, preview);
  });
  // The frozen prefix is the cached part of the prompt: it never holds a line about to change, and
  // is kept only while its lines are the same text (a failed line's summary may since have landed).
  const keep = frozen !== null && frozen.length <= firstComing && sameLines(frozen, lines) && size(lines.slice(frozen.length)) <= TAIL_BYTES;
  const cutAt = keep ? frozen.length : firstComing;
  return {
    frozenLines: lines.slice(0, cutAt),
    tailLines: lines.slice(cutAt),
    pending,
    bytes: size(lines),
  };
}
