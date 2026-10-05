// Observed removal of an issue's cited lines (A228 #6, #7). A test-integrity
// citation names the lines a change added and removed. A later edit, or a
// checkpoint hunk that vanished, which takes those added lines away again (or
// puts removed lines back, for a pure deletion) is an observed reversal. It is
// a fact about the files, never a verdict that the issue is fixed: a passing
// test run, a claim or the citing card itself never counts.

import { norm, normPath, type Hunk } from "./diff.js";

export interface CitedChange {
  path: string; // root-relative
  added: string[];
  removed: string[];
  evidenceSeq: number;
}

/** The changed lines inside a citation's line ranges, per side. */
export function citedChange(
  h: Hunk,
  root: string | null,
  cites: { before?: [number, number] | null; after?: [number, number] | null },
  evidenceSeq: number,
): CitedChange {
  const within = (attr: "old" | "new", kind: "-" | "+", r: [number, number] | null | undefined) =>
    r ? h.lines.filter((l) => l.kind === kind && l[attr] !== null && r[0] <= l[attr]! && l[attr]! <= r[1]).map((l) => l.text) : [];
  return { path: normPath(h.path, root), added: within("new", "+", cites.after), removed: within("old", "-", cites.before), evidenceSeq };
}

export interface LaterCard {
  kind: string;
  seq: number;
  path: string | null;
  hunks?: Hunk[];
  side?: "added" | "removed";
}

function covers(lines: string[], want: string[]): boolean {
  const have = new Set(lines.map(norm));
  return want.length > 0 && want.every((t) => have.has(norm(t)));
}

/**
 * Does this later card remove the cited added lines (or, when the citation
 * only removed lines, put them back)? Edit cards are provider diffs; a
 * checkpoint "removed" card is a HEAD-relative hunk that is gone now, so its
 * "+" lines are what disappeared. Checkpoint "added" cards, commands and
 * claims never count.
 */
export function reverses(card: LaterCard, c: CitedChange, root: string | null): boolean {
  if (card.seq <= c.evidenceSeq || !card.hunks || card.path === null) return false;
  if (normPath(card.path, root) !== c.path) return false;
  const lines = (kind: "+" | "-") => card.hunks!.flatMap((h) => h.lines.filter((l) => l.kind === kind).map((l) => l.text));
  if (card.kind === "edit") return c.added.length > 0 ? covers(lines("-"), c.added) : covers(lines("+"), c.removed);
  if (card.kind === "state" && card.side === "removed") return c.added.length > 0 ? covers(lines("+"), c.added) : covers(lines("-"), c.removed);
  return false;
}
