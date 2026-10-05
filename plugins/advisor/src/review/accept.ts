// From parsed model findings to validated occurrences. Every citation is
// checked mechanically against this packet; anything that fails is dropped and
// counted, never repaired. Validation proves citations, not judgment.

import { createHash } from "node:crypto";
import { norm, normPath, type Hunk } from "../rules/diff.js";
import { occurrenceId } from "../rules/findings.js";
import { HISTORIC, type RequirementClass } from "../rules/requests.js";
import { citedChange, type CitedChange } from "../rules/reversal.js";
import { retain, type Retained } from "../rules/retain.js";
import { validate, type HunkFinding } from "../rules/validate.js";
import { SUMMARY_MAX, type ModelFinding } from "../transport/output.js";
import { hasIntentWords } from "./charter.js";

export interface PacketContext {
  watchId: string;
  root: string | null;
  /** Packet cards by id: edit/state cards carry hunks. */
  cards: Map<string, { kind: string; text: string; hunks?: Hunk[]; path?: string | null; seq?: number; side?: "added" | "removed" }>;
  requirements: Record<string, string>;
  classes: Record<string, RequirementClass>;
  /** Categories this review may report (route scope, settings and coverage). */
  categories: string[];
}

export interface Accepted {
  id: string;
  category: string;
  severity: string;
  locator: string;
  evidence: string;
  subjectVerified: boolean;
  summary: string;
  shown: Record<string, unknown>;
  retained: Retained;
  /** Test integrity only: the cited changed lines, to recognize a later observed reversal. */
  change?: CitedChange;
}

export interface AcceptResult {
  accepted: Accepted[];
  dropped: Array<{ index: number; reason: string }>;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

export function acceptFindings(findings: ModelFinding[], ctx: PacketContext): AcceptResult {
  const accepted: Accepted[] = [];
  const dropped: AcceptResult["dropped"] = [];
  findings.forEach((f, index) => {
    const r = acceptOne(f, ctx);
    if ("reason" in r) dropped.push({ index, reason: r.reason });
    else accepted.push(r);
  });
  return { accepted, dropped };
}

function requirementCheck(req: ModelFinding["requirement"], ctx: PacketContext, category: string): string | null {
  if (req === null) return null;
  const blob = ctx.requirements[req.ref];
  if (blob === undefined || !norm(blob).includes(norm(req.quote))) return "requirement-quote-not-in-packet";
  if (category === "missed-requirement" && HISTORIC.has(ctx.classes[req.ref] ?? "")) return "historic-requirement-not-missable";
  return null;
}

function requirementShown(req: ModelFinding["requirement"], ctx: PacketContext) {
  if (req === null) return {};
  const k = ctx.classes[req.ref];
  return {
    requirement: req,
    ...(k && HISTORIC.has(k) ? { requirementStatus: "historic: replaced authority, context only" } : {}),
    ...(k === "unattributed" ? { requirementSource: "UNATTRIBUTED: user or plugin" } : {}),
  };
}

function acceptOne(f: ModelFinding, ctx: PacketContext): Accepted | { reason: string } {
  if (!ctx.categories.includes(f.category)) return { reason: `category-not-allowed:${f.category}` };
  if (f.summary.length > SUMMARY_MAX) return { reason: "summary-over-600-characters" };
  if (hasIntentWords(f.summary)) return { reason: "intent-words" };
  if (f.category === "test-integrity") {
    const card = ctx.cards.get(f.evidence);
    if (!card || !card.hunks) return { reason: "unknown-evidence" };
    const hf: HunkFinding = {
      category: f.category,
      evidence: f.evidence,
      hunk: f.hunk ?? -1,
      subject: f.subject,
      relation: f.relation,
      before: f.before,
      after: f.after,
      requirement: f.requirement,
    };
    const v = validate(hf, { [f.evidence]: card.hunks }, ctx.requirements, ctx.root, ctx.classes);
    if (!v.ok) return { reason: v.reason };
    const seq = card.seq ?? 0;
    const after = f.after ? citedChange(card.hunks[f.after.hunk ?? hf.hunk!]!, ctx.root, { after: f.after.lines }, seq) : null;
    const before = f.before ? citedChange(card.hunks[f.before.hunk ?? hf.hunk!]!, ctx.root, { before: f.before.lines }, seq) : null;
    const change: CitedChange = { path: (after ?? before)!.path, added: after?.added ?? [], removed: before?.removed ?? [], evidenceSeq: seq };
    return {
      change,
      id: occurrenceId(ctx.watchId, f.category, v.shown.locator, hf),
      category: f.category,
      severity: f.severity,
      locator: v.shown.locator,
      evidence: f.evidence,
      subjectVerified: v.shown.subjectVerified,
      summary: f.summary,
      shown: { ...v.shown, path: card.path ? normPath(card.path, ctx.root) : null },
      retained: retain({ ...v.shown, ...(v.shown.requirement ? { requirement: v.shown.requirement } : {}) }),
    };
  }
  if (f.category === "unsupported-claim") {
    if (!f.claim) return { reason: "claim-citation-missing" };
    const claim = ctx.cards.get(f.claim.evidence);
    if (!claim || claim.kind !== "claim") return { reason: "unknown-claim-evidence" };
    if (!f.claim.quote.trim() || !norm(claim.text).includes(norm(f.claim.quote))) return { reason: "claim-quote-mismatch" };
    if (!f.command) return { reason: "command-citation-missing" };
    const cmd = ctx.cards.get(f.command.evidence);
    if (!cmd || cmd.kind !== "command") return { reason: "unknown-command-evidence" };
    const rq = requirementCheck(f.requirement, ctx, f.category);
    if (rq) return { reason: rq };
    const locator = `claim@${f.claim.evidence}`;
    const shown = {
      subject: `completion claim ${f.claim.evidence}`,
      locator,
      subjectStatus: "verified",
      subjectVerified: true,
      claim: { evidence: f.claim.evidence, text: f.claim.quote },
      command: { evidence: f.command.evidence, text: cmd.text.slice(0, 2000) },
      ...requirementShown(f.requirement, ctx),
    };
    return {
      id: hash([ctx.watchId, f.category, locator, f.claim.evidence, f.command.evidence]),
      category: f.category,
      severity: f.severity,
      locator,
      evidence: f.claim.evidence,
      subjectVerified: true,
      summary: f.summary,
      shown,
      retained: retain({ before: { text: cmd.text.slice(0, 4096) }, after: { text: f.claim.quote }, ...(f.requirement ? { requirement: f.requirement } : {}) }),
    };
  }
  // missed-requirement
  if (!f.requirement) return { reason: "requirement-citation-missing" };
  const rq = requirementCheck(f.requirement, ctx, f.category);
  if (rq) return { reason: rq };
  const locator = `requirement@${f.requirement.ref}`;
  return {
    id: hash([ctx.watchId, f.category, locator, f.evidence]),
    category: f.category,
    severity: f.severity,
    locator,
    evidence: f.evidence,
    subjectVerified: true,
    summary: f.summary,
    shown: { subject: `requirement ${f.requirement.ref}`, locator, subjectStatus: "verified", subjectVerified: true, ...requirementShown(f.requirement, ctx) },
    retained: retain({ requirement: f.requirement }),
  };
}
