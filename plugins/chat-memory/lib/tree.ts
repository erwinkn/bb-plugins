/**
 * D431: a chat's memory as Victor Taelin's OptChat tree
 * (https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), as W216 replayed it.
 *
 * node(0, i) is message i in at most 512 bytes; node(l, i) merges its two children into at most
 * 512 bytes and covers the 2^l messages from i·2^l on, labelled "id+n" (node(3, 5) is 40+8, opened
 * with zoom(40, 8)). A view is a list of nodes covering messages 0..T-1, oldest first, sent as one
 * "id+n|text" line per node. Sizes are UTF-8 bytes. Each node is built once and never rebuilt.
 */
export const LIMIT = 512;
export const PLACEHOLDER = "(not summarized yet: zoom it)";

/** [level, index]. */
export type NodeRef = [number, number];
/** Built nodes' text by key(l, i). */
export type Nodes = Pick<ReadonlyMap<string, string>, "has" | "get">;

export const bytes = (s: string) => Buffer.byteLength(s, "utf8");
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
  return `${label(n)}|${(nodes.get(key(...n)) ?? PLACEHOLDER).replace(/\s*\n\s*/g, " ")}`;
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
 * - chat: what a turn sees. Each message appends a line; past 128 KB one batch merges it down to
 *   64 KB, so between batches it only grows at its end and stays a cached prefix.
 * - compaction: the chat view merged further, on a 32→16 KB sawtooth: the context of every
 *   compaction call, and what memory_read gives.
 */
export interface Views {
  /** Messages fed into both views (T). */
  fed: number;
  chat: NodeRef[];
  /** A chat batch is under way: past 128 KB, not yet back under 64 KB. */
  merging: boolean;
  compaction: NodeRef[];
}
export const VIEW_BYTES = { chat: [128_000, 64_000], compaction: [32_000, 16_000] } as const;
export const emptyViews = (): Views => ({ fed: 0, chat: [], merging: false, compaction: [] });

/** Append message `fed` to both views; returns the merges it caused in each. */
export function feed(v: Views, nodes: Nodes) {
  v.chat.push([0, v.fed]);
  v.compaction.push([0, v.fed]);
  v.fed++;
  return settleViews(v, nodes);
}

/**
 * Start a batch past 128 KB, or continue one a missing parent stopped. Merges need built parents,
 * so a batch can stall until the builder catches up; the gist resumes it at the next message, this
 * also resumes it when a node lands, so a quiet chat still reaches 64 KB. A landing node can also
 * start one: its line replaces a shorter placeholder. A chat merge resets the compaction view to
 * the chat view, merged further.
 */
export function settleViews(v: Views, nodes: Nodes) {
  if (!v.merging && viewBytes(v.chat, nodes) > VIEW_BYTES.chat[0]) v.merging = true;
  let chat = 0;
  if (v.merging) {
    chat = mergeDown(v.chat, v.fed, nodes, VIEW_BYTES.chat[1]);
    if (viewBytes(v.chat, nodes) <= VIEW_BYTES.chat[1]) v.merging = false;
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
