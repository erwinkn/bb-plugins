/**
 * D431: a chat's memory as Victor Taelin's OptChat tree
 * (https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), as W216 replayed it.
 *
 * node(0, i) is message i, requested at 448 bytes and stored at most 576 bytes; node(l, i) merges
 * its two children under the same target and hard maximum and covers the 2^l messages from i·2^l on, labelled "id+n" (node(3, 5) is 40+8, opened
 * with zoom(40, 8)). A view is a list of nodes covering messages 0..T-1, oldest first, sent as one
 * "id+n|text" line per node. Sizes are UTF-8 bytes. Each node is built once and never rebuilt.
 */
/**
 * Requested model target and hard stored-node cap are intentionally distinct. W574: Luna overshoots
 * its ask (merges most), so it is asked for 448 bytes, first and on its one retry. A first reply
 * fits 61% of the time against 43% asked for 512, so a line costs 1.39 calls instead of 1.57.
 */
export const TARGET_BYTES = 448;
export const LIMIT = 576;
export const PLACEHOLDER = "(not summarized yet: zoom it)";

/** [level, index]. */
export type NodeRef = [number, number];
/** Built nodes' text by key(l, i). */
export type Nodes = Pick<ReadonlyMap<string, string>, "has" | "get">;

export const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** What ends a line cut to fit, so no reader takes it for the whole. */
export const CUT = " [cut]";
/** A cut backs up to the word's start only this far: a longer word (a hash, a path) is cut inside instead. */
const WORD_BYTES = 64;
/**
 * A line of at most LIMIT bytes: the text if it fits, else its start up to the last word boundary
 * that leaves room for CUT, then CUT. The only cut any line gets. Example: a 600-byte line ending
 * "…; agent: ran migration 0042 on staging" becomes "…; agent: ran migration [cut]", never
 * "…; agent: ran migr". A word longer than WORD_BYTES is cut at a character boundary instead.
 */
export function capLine(text: string) {
  return bytes(text) <= LIMIT ? text : `${head(text, LIMIT - bytes(CUT))}${CUT}`;
}
/** The start of a text longer than `room` bytes that fits in it, cut as capLine cuts. */
function head(text: string, room: number) {
  const buf = Buffer.from(text, "utf8");
  let at = room;
  while ((buf[at]! & 0xc0) === 0x80) at--; // not inside a multi-byte character
  const start = buf.subarray(0, at).toString("utf8");
  const atSpace = /^\s/.test(buf.subarray(at, at + 4).toString("utf8"));
  const words = atSpace ? start : start.replace(/\S+$/, "");
  return (at - bytes(words) <= WORD_BYTES ? words : start).trimEnd();
}
/**
 * A line holds no newline: a run of whitespace with one in it becomes one space. Linear: `\s+`
 * takes each run once, where `\s*\n\s*` backtracks over a long run without a newline in
 * quadratic time (30,000 spaces took 0.7 s).
 */
const oneLine = (text: string) => text.replace(/\s+/g, (run) => (run.includes("\n") ? " " : run));
/**
 * The start of oneLine(text) without its leading whitespace: at least `room` + 1 UTF-16 units of
 * it (so more than `room` bytes) when the text goes on, and whether it does. It reads the text a
 * run at a time and stops there, so a megabyte message costs what its start does.
 */
function lineStart(text: string, room: number) {
  const piece = /\s+|\S{1,1024}/y;
  piece.lastIndex = text.search(/\S/);
  if (piece.lastIndex < 0) return { start: "", more: false };
  let start = "";
  while (start.length <= room) {
    const run = piece.exec(text)?.[0];
    if (run === undefined) return { start: start.trimEnd(), more: false };
    start += !/^\s/.test(run) ? run : run.includes("\n") ? " " : run.slice(0, room + 1 - start.length);
  }
  // Only whitespace left: oneLine(text).trim() ends here.
  const rest = /\s*/y;
  rest.lastIndex = piece.lastIndex;
  rest.exec(text);
  return rest.lastIndex < text.length ? { start, more: true } : { start: start.trimEnd(), more: false };
}
const ELLIPSIS = "…";
/** What follows the start of a message a turn shows before its summary exists (R12). */
export const PENDING = ` ${PLACEHOLDER}`;
/**
 * R12: the line of a message whose summary a turn did not get within its short wait: the start of
 * the message on one line, cut as capLine cuts, then PENDING, in at most TARGET_BYTES, the size of a
 * summary, so the view's size math holds. Example: "user: Can you check why the deploy… (not
 * summarized yet: zoom it)". memory_zoom {id, n:1} gives the whole message.
 */
export function pendingLine(text: string) {
  const room = TARGET_BYTES - bytes(PENDING);
  const { start, more } = lineStart(text, room);
  return `${!more && bytes(start) <= room ? start : `${head(start, room - bytes(ELLIPSIS))}${ELLIPSIS}`}${PENDING}`;
}
export const key = (l: number, i: number) => `${l}:${i}`;
export const start = ([l, i]: NodeRef) => i * 2 ** l;
export const span = ([l]: NodeRef) => 2 ** l;
/** The last message a node covers. */
export const end = ([l, i]: NodeRef) => (i + 1) * 2 ** l - 1;
export const label = (n: NodeRef) => `${start(n)}+${span(n)}`;
/** The node `zoom(id, n)` names, or null when id+n is no node. */
export function nodeAt(id: number, n: number): NodeRef | null {
  const l = Math.log2(n);
  if (!Number.isInteger(id) || id < 0 || !Number.isInteger(l) || l < 0 || id % n !== 0) return null;
  return [l, id / n];
}

export function renderLine(n: NodeRef, nodes: Nodes) {
  return `${label(n)}|${oneLine(nodes.get(key(...n)) ?? PLACEHOLDER)}`;
}
export const viewBytes = (view: readonly NodeRef[], nodes: Nodes) =>
  view.reduce((sum, n) => sum + bytes(renderLine(n, nodes)) + 1, 0);

/**
 * Merge the most due sibling pair whose parent is built, oldest first on ties. due = (T + 1)/2^l − i,
 * the code form of (T − last)/2^l with `last` the pair's final message: measured from the pair's
 * first message instead, it would churn old lines.
 */
export function mergeOnce(view: NodeRef[], T: number, nodes: Nodes) {
  let best = -1;
  let bestDue = -Infinity;
  for (let p = 0; p + 1 < view.length; p++) {
    const [l, i] = view[p]!;
    const [l2, i2] = view[p + 1]!;
    if (l !== l2 || i % 2 !== 0 || i2 !== i + 1 || !nodes.has(key(l + 1, i / 2))) continue;
    const due = (T + 1) / 2 ** l - i;
    if (due > bestDue) {
      bestDue = due;
      best = p;
    }
  }
  if (best < 0) return false;
  const [l, i] = view[best]!;
  view.splice(best, 2, [l + 1, i / 2]);
  return true;
}

/** Merge until the view is at most `target` bytes or nothing more can merge; returns the merges. */
export function mergeDown(view: NodeRef[], T: number, nodes: Nodes, target: number) {
  let merges = 0;
  while (viewBytes(view, nodes) > target && mergeOnce(view, T, nodes)) merges++;
  return merges;
}

/**
 * The two saved views (view.json in the gist: saved, never rebuilt from the log).
 * - chat: what a turn sees. Each message appends a line; past its bound (128 KB, a worker's 64 KB)
 *   one batch merges it down to half, so between batches it only grows at its end and stays a
 *   cached prefix.
 * - compaction: the chat view merged further, on a 32→16 KB sawtooth: the context of every
 *   compaction call, and what memory_read gives.
 */
export interface Views {
  /** Messages fed into both views (T). */
  fed: number;
  chat: NodeRef[];
  /** A chat batch is under way: past its bound, not yet back under half of it. */
  merging: boolean;
  compaction: NodeRef[];
}
/** A view's [bound, target]: past the bound, one batch merges it down to the target. */
export type ViewBounds = readonly [number, number];
/**
 * W604: an Initiative worker's chat view (workerChat) is half a coordinator's (chat), whose memory
 * holds Erwin's decisions: a worker's turns are many and short-lived, and pay for every line of it
 * on each one. Which scope gets which is chatBounds (store.ts).
 */
export const VIEW_BYTES = { chat: [128_000, 64_000], workerChat: [64_000, 32_000], compaction: [32_000, 16_000] } as const;
export const emptyViews = (): Views => ({ fed: 0, chat: [], merging: false, compaction: [] });

/** Append message `fed` to both views; returns the merges it caused in each. */
export function feed(v: Views, nodes: Nodes, chat: ViewBounds = VIEW_BYTES.chat) {
  v.chat.push([0, v.fed]);
  v.compaction.push([0, v.fed]);
  v.fed++;
  return settleViews(v, nodes, chat);
}

/**
 * Start a batch past the chat view's bound, or continue one a missing parent stopped. Merges need
 * built parents, so a batch can stall until the builder catches up; the gist resumes it at the
 * next message, this also resumes it when a node lands, so a quiet chat still reaches its target.
 * A landing node can also start one: its line replaces a shorter placeholder. A chat merge resets
 * the compaction view to the chat view, merged further. A view saved over a bound that has since
 * shrunk (W604) starts merging down at its first settle, over nodes the tree builds anyway: no call
 * the scope did not already owe. A scope whose tree lags finishes the batch as those nodes land.
 */
export function settleViews(v: Views, nodes: Nodes, [bound, target]: ViewBounds = VIEW_BYTES.chat) {
  if (!v.merging && viewBytes(v.chat, nodes) > bound) v.merging = true;
  let chat = 0;
  if (v.merging) {
    chat = mergeDown(v.chat, v.fed, nodes, target);
    if (viewBytes(v.chat, nodes) <= target) v.merging = false;
  }
  let compaction = 0;
  if (chat > 0) {
    v.compaction = v.chat.map(([l, i]) => [l, i]);
    compaction = mergeDown(v.compaction, v.fed, nodes, VIEW_BYTES.compaction[1]);
  } else if (viewBytes(v.compaction, nodes) > VIEW_BYTES.compaction[0])
    compaction = mergeDown(v.compaction, v.fed, nodes, VIEW_BYTES.compaction[1]);
  return { chat, compaction };
}

/** A compaction's context: the compaction view's lines up to the node, stopping at the first unbuilt line. */
export function contextLines(node: NodeRef, compaction: readonly NodeRef[], nodes: Nodes) {
  const cut = node[0] === 0 ? node[1] - 1 : end(node);
  const lines: string[] = [];
  for (const n of compaction) {
    if (end(n) > cut || !nodes.has(key(...n))) break;
    lines.push(renderLine(n, nodes));
  }
  return lines;
}

/** The two lines a node was made from, or its message when n = 1 (served by the caller). */
export function children([l, i]: NodeRef): [NodeRef, NodeRef] {
  return [[l - 1, 2 * i], [l - 1, 2 * i + 1]];
}

/**
 * Built nodes read from the store by key, the most recently used kept in memory up to `budget`
 * characters: a tree's history stays on disk, and what views and ready work touch stays at hand.
 */
export class NodeCache implements Nodes {
  private texts = new Map<string, string>();
  private chars = 0;
  constructor(
    private readonly read: (l: number, i: number) => string | null,
    private readonly budget = 2_000_000,
  ) {}
  get(k: string) {
    const cached = this.texts.get(k);
    if (cached !== undefined) {
      this.texts.delete(k);
      this.texts.set(k, cached);
      return cached;
    }
    const [l, i] = k.split(":").map(Number) as NodeRef;
    const text = this.read(l, i);
    if (text === null) return undefined;
    this.set(k, text);
    return text;
  }
  has(k: string) {
    return this.get(k) !== undefined;
  }
  set(k: string, text: string) {
    this.chars -= this.texts.get(k)?.length ?? 0;
    this.texts.delete(k);
    this.texts.set(k, text);
    this.chars += text.length;
    for (const [old, t] of this.texts) {
      if (this.chars <= this.budget) break;
      this.texts.delete(old);
      this.chars -= t.length;
    }
  }
}
