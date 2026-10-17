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
 * up to WHOLE_BYTES in all. The caller waits a little for the summaries of every message before
 * those (W503); one still without its summary then is shown clipped (clipLine): its head and tail,
 * CLIP_KEEP bytes each, and a marker that says so. A message shown whole or clipped is never
 * frozen, since its line changes once it is summarized.
 *
 * Example, 300 messages logged, 296 to 299 not summarized yet: frozen holds 0+128 … 256+32, the
 * tail 288+8, then 296+1 … 299+1 whole. If 296 to 299 fill WHOLE_BYTES and 290, a long tool
 * output, still has no summary once the wait ends, the tail is 288+2, 290+1 clipped, 291+1, 292+4,
 * then 296+1 … 299+1 whole.
 */
export const TAIL_BYTES = 32_000;
export const WHOLE_BYTES = 32_000;
/** W503: the head and the tail a clipped message keeps, in bytes each. */
export const CLIP_KEEP = 1_000;
/** W503: the most a turn shows clipped, in bytes of kept text: past it, the turn waits on for summaries. */
export const CLIPPED_BYTES = 64_000;
/** The bytes of a message's text a turn shows when it clips it. */
export const clippedSize = (size: number) => Math.min(size, 2 * CLIP_KEEP);

/**
 * A message with no summary yet, before the newest WHOLE_BYTES, whose text is longer than its head
 * and tail: both, with the middle left out and marked twice, at the start (so no reader takes it
 * for a summary or for the whole) and where it was cut. Example, message 1404, a 30,066-byte tool
 * output: `1404+1|echo: [clipped, no summary yet: the middle 28,066 of 30,066 bytes is left out;
 * memory_zoom {id:1404, n:1} gives it whole] <first 1 KB>[… 28,066 bytes clipped …]<last 1 KB>`.
 */
export function clipLine(i: number, m: Pick<MemoryMessage, "kind" | "text">) {
  const buf = Buffer.from(m.text, "utf8");
  let head = CLIP_KEEP;
  while ((buf[head]! & 0xc0) === 0x80) head--; // not inside a multi-byte character
  let tail = buf.length - CLIP_KEEP;
  while ((buf[tail]! & 0xc0) === 0x80) tail++;
  const left = (tail - head).toLocaleString("en-US");
  const marker = `[clipped, no summary yet: the middle ${left} of ${buf.length.toLocaleString("en-US")} bytes is left out; memory_zoom {id:${i}, n:1} gives it whole]`;
  return `${i}+1|${m.kind}: ${marker} ${buf.subarray(0, head).toString("utf8")}[… ${left} bytes clipped …]${buf.subarray(tail).toString("utf8")}`;
}

export interface TurnViewInput {
  /** The saved chat view and the messages fed into it. */
  chat: readonly NodeRef[];
  fed: number;
  nodes: Nodes;
  /** The view covers messages 0..cut-1: the log as the turn found it. */
  cut: number;
  /** Messages from here on with no summary yet are shown whole; earlier ones clipped (W503). */
  whole: number;
  /** A logged message, for one shown whole or clipped. */
  message: (i: number) => MemoryMessage | null;
  /** This thread's frozen lines from its previous turn, if any. */
  frozen: readonly NodeRef[] | null;
}

export interface TurnView {
  frozen: NodeRef[];
  frozenLines: string[];
  tailLines: string[];
  /** Messages shown clipped. */
  clipped: number;
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

export function turnView({ chat, fed, nodes, cut, whole: wholeFrom, frozen, message }: TurnViewInput): TurnView {
  // The view's lines before the cut, then the messages logged since the view was fed.
  const refs = before(chat, cut);
  for (let i = fed; i < cut; i++) refs.push([0, i]);
  const built = (n: NodeRef) => nodes.has(key(...n));
  let clipped = 0;
  const lines = refs.map((n) => {
    if (built(n)) return renderLine(n, nodes);
    const m = n[0] === 0 ? message(n[1]) : null;
    if (!m) throw new Error(`line ${label(n)} has no summary yet`);
    if (n[1] >= wholeFrom || bytes(m.text) <= 2 * CLIP_KEEP) return `${n[1]}+1|${messageText(m)}`;
    clipped++;
    return clipLine(n[1], m);
  });
  const whole = refs.findIndex((n) => !built(n));
  const fixed = whole < 0 ? refs.length : whole;
  const keep = frozen !== null && frozen.length <= fixed && sameRefs(frozen, refs) && size(lines.slice(frozen.length)) <= TAIL_BYTES;
  const cutAt = keep ? frozen.length : fixed;
  return { frozen: refs.slice(0, cutAt), frozenLines: lines.slice(0, cutAt), tailLines: lines.slice(cutAt), clipped };
}
