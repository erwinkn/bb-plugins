// The narrow hunk-local scope grammar (A144 §1, A152 §2, A160 F4).
//
// A subject is "proven" only when a test declaration whose name sits on its own
// declaration line is visible in the same hunk, on the same side, and is still
// open at the cited line by bracket depth (JS/TS/Go) or indentation (Python).
// Anything else is "ambiguous". There is no whole-file search and no backward
// name scan: the hunk is the only evidence, and "ambiguous" is the honest answer
// when it is not enough.

import type { Hunk, Line } from "./diff.js";

const JS_DECL =
  /^\s*(?:(describe|context|suite)|(it|test))(?:\.(?:only|skip|todo|concurrent))?\(\s*(['"`])((?:\\.|(?!\3).)*)\3\s*,/u;
const GO_DECL = /^\s*func (Test\w+)\s*\(/u;
const CALL_START =
  /(?<![.\p{L}\p{N}_$])(?:describe|context|suite|it|test)(?:\.\w+)*\s*\(|\bt\.Run\s*\(|^\s*func Test\w+\s*\(/gu;
const PY_DECL = /^(\s*)(?:async\s+)?def (test_\w+)\s*\(/u;
const PY_CLASS = /^(\s*)class (Test\w+)\b/u;
// A regex literal starts where an operand is expected: after an operator, an
// opening bracket, a comma, a colon or `return`. Its brackets are not code.
const REGEX_LIT =
  /((?:^|[(,=:\[!&|?{};+\-*%<>~^]|\breturn)\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[])+\/[a-z]*/gu;
const REGEX_START = /(?:^|[(,=:\[!&|?{};]|\breturn)\s*\/(?![/*\s])[^/]*$/u;
const STR_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gu;

/**
 * Blank string contents (same length) and drop comments, so brackets and call
 * starts are found only in code. Null when a string, template or block comment
 * does not close on this line: brackets are then untrackable.
 */
export function stripJs(text: string): string | null {
  let s = text.replace(STR_RE, (m) => m[0] + " ".repeat(m.length - 2) + m[m.length - 1]);
  s = s.replace(/\/\*.*?\*\//gu, (m) => " ".repeat(m.length));
  s = s.replace(REGEX_LIT, (m, lead: string) => lead + "/" + " ".repeat(m.length - lead.length - 2) + "/");
  const cut = s.indexOf("//");
  if (cut >= 0) s = s.slice(0, cut);
  const rest = s.replace(STR_RE, "");
  if (/['"`]/u.test(rest) || s.includes("/*") || REGEX_START.test(s)) return null;
  return s;
}

type Side = "old" | "new";

interface Frame {
  kind: "suite" | "test" | "unparsed";
  name: string | null;
  base: number;
  decl: Line;
}

export type Subject =
  | {
      status: "proven";
      name: string;
      chain: string[];
      decl: Line;
      declLine: number;
      declKind: Line["kind"];
      side: Side;
    }
  | { status: "ambiguous"; why: string };

type Picked = { status: "proven"; name: string; chain: string[]; decl: Line } | { status: "ambiguous"; why: string };

function leadLen(text: string): number {
  return text.length - text.trimStart().length;
}

function visible(hunk: Hunk, side: Side): Line[] {
  return hunk.lines.filter((l) => l[side] !== null);
}

function frame(l: Line, depth: number, pos: number): Frame {
  const m = JS_DECL.exec(l.text);
  const g = GO_DECL.exec(l.text);
  if (pos === leadLen(l.text) && (m || g)) {
    return { kind: m && m[1] ? "suite" : "test", name: m ? m[4]! : g![1]!, base: depth, decl: l };
  }
  return { kind: "unparsed", name: null, base: depth, decl: l };
}

/**
 * Char-level bracket tracking from the first visible line of the hunk. A frame
 * opens at its call start and closes when depth falls back to the depth at that
 * position, even mid-line.
 */
function scopeJs(vis: Line[], idx: number): Picked {
  const stack: Frame[] = [];
  let depth = 0;
  for (let i = 0; i <= idx; i++) {
    const l = vis[i]!;
    const s = stripJs(l.text);
    if (s === null) return { status: "ambiguous", why: "unclosed-string-or-comment" };
    const starts = new Set<number>();
    for (const m of s.matchAll(CALL_START)) starts.add(m.index!);
    if (i === idx) {
      const first = leadLen(s);
      for (const p of starts) {
        if (p !== first) return { status: "ambiguous", why: "several-scopes-on-cited-line" };
      }
      if (starts.has(first)) stack.push(frame(l, depth, first));
      break; // the cited line belongs to every frame open at its start
    }
    for (let pos = 0; pos < s.length; pos++) {
      if (starts.has(pos)) stack.push(frame(l, depth, pos));
      const ch = s[pos]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        while (stack.length > 0 && depth <= stack[stack.length - 1]!.base) stack.pop();
      }
    }
  }
  return pick(stack);
}

interface PyFrame {
  kind: "suite" | "test";
  name: string;
  indent: number;
  decl: Line;
}

function scopePy(vis: Line[], idx: number): Picked {
  const stack: PyFrame[] = [];
  for (let i = 0; i <= idx; i++) {
    const l = vis[i]!;
    if (l.text.includes('"""') || l.text.includes("'''")) return { status: "ambiguous", why: "triple-quoted-string" };
    if (!l.text.trim()) continue;
    const ind = leadLen(l.text);
    while (stack.length > 0 && ind <= stack[stack.length - 1]!.indent) stack.pop();
    const m = PY_DECL.exec(l.text);
    const c = PY_CLASS.exec(l.text);
    if (m) stack.push({ kind: "test", name: m[2]!, indent: m[1]!.length, decl: l });
    else if (c) stack.push({ kind: "suite", name: c[2]!, indent: c[1]!.length, decl: l });
  }
  return pick(stack.map((f) => ({ kind: f.kind, name: f.name, base: 0, decl: f.decl })));
}

function pick(stack: Frame[]): Picked {
  for (let j = stack.length - 1; j >= 0; j--) {
    const f = stack[j]!;
    if (f.kind === "unparsed") return { status: "ambiguous", why: "unparsed-call-start" };
    if (f.kind === "test") {
      if (stack.slice(0, j).some((s) => s.kind === "unparsed")) return { status: "ambiguous", why: "unparsed-enclosing-call" };
      const chain = stack.slice(0, j).filter((s) => s.kind === "suite").map((s) => s.name!);
      return { status: "proven", name: f.name!, chain, decl: f.decl };
    }
  }
  return { status: "ambiguous", why: "no-open-declaration-in-hunk" };
}

export function deriveSubject(hunk: Hunk, side: Side, lineNo: number): Subject {
  const vis = visible(hunk, side);
  const idx = vis.findIndex((l) => l[side] === lineNo);
  if (idx < 0) return { status: "ambiguous", why: "line-not-in-hunk" };
  const r = hunk.path.endsWith(".py") ? scopePy(vis, idx) : scopeJs(vis, idx);
  if (r.status !== "proven") return r;
  return { ...r, declLine: r.decl[side]!, declKind: r.decl.kind, side };
}

/** Bounds of the contiguous '-'/'+' change run containing a changed line. */
function runOf(hunk: Hunk, line: Line): [number, number] | null {
  const i = hunk.lines.indexOf(line);
  if (line.kind === " ") return null;
  let lo = i;
  let hi = i;
  while (lo > 0 && hunk.lines[lo - 1]!.kind !== " ") lo--;
  while (hi + 1 < hunk.lines.length && hunk.lines[hi + 1]!.kind !== " ") hi++;
  return [lo, hi];
}

function declName(l: Line): string | null {
  const m = JS_DECL.exec(l.text);
  if (m) return m[4]!;
  const g = GO_DECL.exec(l.text);
  if (g) return g[1]!;
  const p = PY_DECL.exec(l.text);
  return p ? p[2]! : null;
}

function lead(l: Line): string {
  return l.text.slice(0, leadLen(l.text));
}

/**
 * A160 F4. The declaration's own side of the run, from the run start up to the
 * declaration, must leave the enclosing scope alone: in JS no closer of a scope
 * opened above the run and no scope left open (depth stays >= 0 and ends at 0);
 * in Python no non-blank line indented less than the declaration.
 */
function prefixKeepsScope(hunk: Hunk, run: [number, number], decl: Line): boolean {
  const side = hunk.lines.slice(run[0], run[1] + 1).filter((l) => l.kind === decl.kind);
  const before = side.slice(0, side.indexOf(decl));
  if (hunk.path.endsWith(".py")) {
    return before.every((l) => !l.text.trim() || lead(l).length >= lead(decl).length);
  }
  let depth = 0;
  for (const l of before) {
    const s = stripJs(l.text);
    if (s === null) return false;
    for (const ch of s) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function sameEnclosing(hunk: Hunk, run: [number, number], b: Line, a: Line): boolean {
  return lead(b) === lead(a) && prefixKeepsScope(hunk, run, b) && prefixKeepsScope(hunk, run, a);
}

export type PairRelation = "same" | "same-edited" | "rename-or-replacement" | "same-name" | "unpairable" | "different";

type Proven = Extract<Subject, { status: "proven" }>;

/**
 * Same-hunk relation of the before and after declarations: "same" (one context
 * declaration); "same-edited" (k-th removed and k-th added declaration of one
 * change run, same name and chain, the name unique in that run, enclosing scope
 * provably unchanged); "rename-or-replacement" (k-th pair with another name);
 * "same-name" (claimed, not proven); "unpairable" or "different".
 */
export function pairRelation(hunk: Hunk, b: Proven, a: Proven): PairRelation {
  if (b.decl === a.decl) return "same";
  const sameName = b.name === a.name && JSON.stringify(b.chain) === JSON.stringify(a.chain);
  const rb = runOf(hunk, b.decl);
  const ra = runOf(hunk, a.decl);
  if (rb === null || ra === null || rb[0] !== ra[0] || rb[1] !== ra[1] || b.declKind !== "-" || a.declKind !== "+") {
    return sameName ? "same-name" : "different";
  }
  const run = hunk.lines.slice(rb[0], rb[1] + 1);
  const removed = run.filter((l) => l.kind === "-" && declName(l) !== null);
  const added = run.filter((l) => l.kind === "+" && declName(l) !== null);
  if (removed.length !== added.length) return sameName ? "same-name" : "unpairable";
  if (removed.indexOf(b.decl) !== added.indexOf(a.decl)) return sameName ? "same-name" : "different";
  if (!sameName) return "rename-or-replacement";
  const unique =
    removed.filter((l) => declName(l) === b.name).length === 1 && added.filter((l) => declName(l) === a.name).length === 1;
  return unique && sameEnclosing(hunk, rb, b.decl, a.decl) ? "same-edited" : "same-name";
}
