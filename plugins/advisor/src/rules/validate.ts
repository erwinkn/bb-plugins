// Positional, per-side, scope-bound citation check (A140 §5.3, A144 §1, A152 §2,
// A160 F2/F3). Validation proves that citations are real and bound to their
// subject. It never proves the judgment right.

import { norm, normPath, type Hunk } from "./diff.js";
import { deriveSubject, pairRelation, type Subject } from "./scope.js";
import { HISTORIC, type RequirementClass } from "./requests.js";

export interface Citation {
  hunk?: number | null;
  lines: [number, number];
  quote: string;
}

export interface HunkFinding {
  category?: string;
  evidence?: string;
  hunk?: number;
  subject?: string | null;
  relation?: string | null;
  before?: Citation | null;
  after?: Citation | null;
  requirement?: { ref: string; quote: string } | null;
}

export type SubjectStatus = "verified" | "rename-or-replacement" | "ambiguous";

export interface CitedSide {
  path: string;
  hunk: number;
  side: "old" | "new";
  lines: [number, number];
  text: string;
}

export interface Shown {
  before?: CitedSide;
  after?: CitedSide;
  subject: string;
  locator: string;
  subjectStatus: SubjectStatus;
  subjectVerified: boolean;
  claimedSubject?: string;
  pairing?: "positional" | "claimed-same-name" | "claimed-moved";
  requirement?: { ref: string; quote: string };
  requirementStatus?: string;
  requirementSource?: string;
}

export type ValidateResult = { ok: true; reason: "ok"; shown: Shown } | { ok: false; reason: string; shown: null };

type Proven = Extract<Subject, { status: "proven" }>;

interface SideState {
  hunk: number;
  h: Hunk;
  sub: Proven | null;
  firstChanged: number;
}

const fail = (reason: string): ValidateResult => ({ ok: false, reason, shown: null });

export function validate(
  finding: HunkFinding,
  evidence: Record<string, Hunk[]>,
  requirements: Record<string, string>,
  root?: string | null,
  classes?: Record<string, RequirementClass | null | undefined>,
): ValidateResult {
  const ev = finding.evidence === undefined ? undefined : evidence[finding.evidence];
  if (ev === undefined) return fail("unknown-evidence");
  const hi = finding.hunk;
  if (typeof hi !== "number" || !Number.isInteger(hi) || hi < 0 || hi >= ev.length) return fail("unknown-hunk");
  const moved = finding.relation === "moved";
  const shown: Partial<Shown> = {};
  const sides: { before?: SideState; after?: SideState } = {};
  let changed = false;
  for (const [side, attr, mark] of [
    ["before", "old", "-"],
    ["after", "new", "+"],
  ] as const) {
    const cite = finding[side];
    if (cite === undefined || cite === null) continue;
    const hIdx: number = cite.hunk ?? hi;
    if (!Number.isInteger(hIdx) || hIdx < 0 || hIdx >= ev.length) return fail(`${side}-unknown-hunk`);
    if (hIdx !== hi && !moved) return fail(`${side}-cross-hunk-without-moved`);
    const h = ev[hIdx]!;
    const [lo, up] = cite.lines;
    const rows = h.lines.filter((l) => l[attr] !== null && lo <= l[attr]! && l[attr]! <= up);
    if (lo > up || rows.length !== up - lo + 1) return fail(`${side}-lines-outside-hunk`);
    const text = rows.map((l) => l.text).join("\n");
    if (norm(text) !== norm(cite.quote)) return fail(`${side}-quote-mismatch`);
    changed ||= rows.some((l) => l.kind === mark);
    const subs = rows.map((l) => deriveSubject(h, attr, l[attr]!));
    const proven = new Set(subs.flatMap((s) => (s.status === "proven" ? [s.decl] : [])));
    if (proven.size > 1) return fail(`${side}-range-spans-subjects`);
    const allProven = subs.length > 0 && subs.every((s) => s.status === "proven");
    sides[side] = {
      hunk: hIdx,
      h,
      sub: allProven ? (subs[0] as Proven) : null,
      firstChanged: rows.find((l) => l.kind === mark)?.[attr] ?? lo,
    };
    shown[side] = { path: normPath(h.path, root), hunk: hIdx, side: attr, lines: [lo, up], text };
  }
  const b = sides.before;
  const a = sides.after;
  if (!b && !a) return fail("no-citation");
  if (!changed) return fail("no-changed-line-cited");
  if (moved && (!b || !a)) return fail("moved-needs-both-sides");
  let status: SubjectStatus = "ambiguous";
  let subj: Proven | null = null;
  let pairing: Shown["pairing"] | null = null;
  if (b && a) {
    const bs = b.sub;
    const as = a.sub;
    if (b.hunk !== a.hunk) {
      // An explicit moved pair across hunks is never verified. Names sit on the
      // cited declaration lines, so different names are a fact; suite chains are
      // hunk-local and may be incomplete, so equal names stay a claim.
      if (bs && as && bs.name !== as.name) return fail("subject-incompatible");
      pairing = "claimed-moved";
    } else if (bs && as) {
      const rel = pairRelation(b.h, bs, as);
      if (rel === "different") return fail("subject-incompatible");
      if (rel === "same" || rel === "same-edited") {
        status = "verified";
        subj = as;
      } else if (rel === "rename-or-replacement") {
        status = "rename-or-replacement";
        pairing = "positional";
      } else if (rel === "same-name") {
        pairing = "claimed-same-name";
      }
      // "unpairable" stays ambiguous
    }
    // One side proven and the other not: the pair may span two tests. Ambiguous.
  } else {
    const only = (b ?? a)!;
    if (only.sub) {
      status = "verified";
      subj = only.sub;
    }
  }
  const claimed = finding.subject ?? null;
  const cited = [b, a].filter((s): s is SideState => s !== undefined);
  if (claimed !== null && cited.every((s) => s.sub !== null)) {
    if (!cited.some((s) => s.sub!.name === claimed)) return fail("subject-mismatch");
  }
  const anchor = (a ?? b)!;
  const path = normPath(anchor.h.path, root);
  if (subj !== null) {
    shown.subject = [...subj.chain, subj.name].join(" › ");
    shown.locator = `${path}::${shown.subject}@${subj.side}:L${subj.declLine}`;
  } else {
    const side = a ? "new" : "old";
    shown.subject = `${path}:L${anchor.firstChanged}`;
    shown.locator = `${path}@${side}:L${anchor.firstChanged}`;
    if (claimed !== null) shown.claimedSubject = claimed; // a model claim, never shown as verified
  }
  shown.subjectStatus = status;
  shown.subjectVerified = status === "verified";
  if (moved && pairing === null) pairing = "claimed-moved";
  if (pairing) shown.pairing = pairing;
  const req = finding.requirement;
  if (req !== undefined && req !== null) {
    const blob = requirements[req.ref];
    if (blob === undefined || !norm(blob).includes(norm(req.quote))) return fail("requirement-quote-not-in-packet");
    // The cited requirement's class comes from the packet, never from the model.
    const k = classes?.[req.ref];
    if (k && HISTORIC.has(k)) {
      if (finding.category === "missed-requirement") return fail("historic-requirement-not-missable");
      shown.requirementStatus = "historic: replaced authority, context only";
    } else if (k === "unattributed") {
      shown.requirementSource = "UNATTRIBUTED: user or plugin";
    }
    shown.requirement = req;
  }
  return { ok: true, reason: "ok", shown: shown as Shown };
}
