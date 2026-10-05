// Unified-diff hunks as positional evidence (A140 §3, unchanged through A160).

export type LineKind = " " | "-" | "+";

export interface Line {
  kind: LineKind;
  text: string;
  old: number | null;
  new: number | null;
}

export interface Hunk {
  path: string;
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: Line[];
  truncated: boolean;
  omittedLines: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function makeHunk(
  path: string,
  oldStart: number,
  oldLen: number,
  newStart: number,
  newLen: number,
  lines: Line[],
  truncated = false,
  omittedLines = 0,
): Hunk {
  return { path, oldStart, oldLen, newStart, newLen, lines, truncated, omittedLines };
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`;
}

export function hunkBody(h: Hunk): string {
  return h.lines.map((l) => l.kind + l.text).join("\n");
}

export function hunkText(h: Hunk): string {
  return hunkHeader(h) + "\n" + hunkBody(h);
}

/** Identity used by checkpoint transitions: path, old-side start and length, full body. */
export function hunkKey(h: Hunk): string {
  return JSON.stringify([h.path, h.oldStart, h.oldLen, hunkBody(h)]);
}

export function parseUnified(path: string, diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of diff.split("\n")) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      o = Number(m[1]);
      n = Number(m[3]);
      cur = makeHunk(path, o, Number(m[2] ?? 1), n, Number(m[4] ?? 1), []);
      hunks.push(cur);
      continue;
    }
    if (cur === null || raw === "" || raw.startsWith("\\")) continue;
    const k = raw[0];
    const t = raw.slice(1);
    if (k === " ") {
      cur.lines.push({ kind: " ", text: t, old: o, new: n });
      o++;
      n++;
    } else if (k === "-") {
      cur.lines.push({ kind: "-", text: t, old: o, new: null });
      o++;
    } else if (k === "+") {
      cur.lines.push({ kind: "+", text: t, old: null, new: n });
      n++;
    }
  }
  return hunks;
}

/** Normalized, root-relative POSIX path. */
export function normPath(path: string, root?: string | null): string {
  let p = posixNormalize(path.replace(/\\/g, "/"));
  if (root) {
    const r = posixNormalize(root);
    if (p.startsWith(r + "/")) p = p.slice(r.length + 1);
  }
  return p;
}

function posixNormalize(p: string): string {
  if (p === "") return ".";
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return abs ? "/" + joined : joined || ".";
}

/** Whitespace-normalized text, for quote comparison. */
export function norm(s: string): string {
  return s.split(/\s+/u).filter(Boolean).join(" ");
}
