// Jev: a narrow, probability-based test-integrity judge (A154 §8, A161 F3).
//
// Jev returns one probability per yes/no question; it has no confidence value
// and no "can't tell" answer. The window comes from the same FIFO as every
// route: there is no second queue and no analysis of what a hunk means. Every
// changed hunk on a test path becomes one candidate. Sizes are encoded sizes.

import { hunkText, type Hunk } from "./diff.js";
import { matchesAny } from "./checkpoint.js";

export const JEV_MODEL = "jev-1.13.0";
export const MAX_QUESTIONS = 16;
export const MAX_STATE_BYTES = 24 * 1024;
export const MAX_REQUIREMENTS_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 60 * 1024;

const encoded = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

export interface JevQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export function question(id: string): JevQuestion {
  return {
    type: "noul",
    instructions: `Does the edit in \`hunks.${id}.hunk\` make the test accept results it rejected before, or stop checking something it checked before?`,
    criteria: {
      true: "After the edit, some behaviour that failed the old test passes the new one, or a check was removed or skipped.",
      false: "The test is as strict or stricter, or the edit only renames, reformats or moves code.",
    },
  };
}

function fitRequirements(text: string): { text: string; partial: boolean } {
  if (encoded(text) <= MAX_REQUIREMENTS_BYTES) return { text, partial: false };
  const mark = "\n[PARTIAL: requirements cut]";
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoded(cps.slice(0, mid).join("") + mark) <= MAX_REQUIREMENTS_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return { text: cps.slice(0, lo).join("") + mark, partial: true };
}

/** A FIFO card as Jev sees it: its hunks in order. Non-edit cards have none. */
export interface JevCard {
  id: string; // the card's evidence id; hunk i is `${id}/h${i}`
  hunks: Array<{ path: string; subject: string; truncated: boolean; hunk: Hunk | null }>;
}

export interface JevWrapper {
  evidence: string;
  path: string;
  subject: string;
  truncated: boolean;
  hunk: string;
}

export interface JevGap {
  kind: "not-judged";
  reason: "candidate-cap";
  card: string;
  refs: string[];
  limit: "16 questions" | "24 KiB encoded state" | "encoded body cap";
}

export interface JevWindow {
  window: string[];
  judged: Array<{ id: string; ref: string; card: string; hunkIndex: number }>;
  gaps: JevGap[];
  skipped: Array<{ ref: string; reason: string }>;
  requirementsPartial: boolean;
  partialCoverage: boolean;
  body: { model: string; state: { requirements: string; hunks: Record<string, JevWrapper> }; questions: Record<string, JevQuestion> };
  bytes: { state: number; body: number };
}

export function hunkRef(cardId: string, i: number): string {
  return `${cardId}/h${i}`;
}

function candidatesOf(card: JevCard, testGlobs: readonly string[]) {
  const out: Array<{ ref: string; hunkIndex: number; wrapper: JevWrapper }> = [];
  const skipped: Array<{ ref: string; reason: string }> = [];
  card.hunks.forEach((h, i) => {
    const ref = hunkRef(card.id, i);
    if (!matchesAny(h.path, testGlobs)) skipped.push({ ref, reason: "non-test path" });
    else if (!h.hunk || h.hunk.lines.length === 0) skipped.push({ ref, reason: "no hunk text (binary or rename-only)" });
    else {
      out.push({
        ref,
        hunkIndex: i,
        wrapper: { evidence: ref, path: h.path, subject: h.subject, truncated: h.truncated, hunk: hunkText(h.hunk) },
      });
    }
  });
  return { candidates: out, skipped };
}

/** The encoded request body for this state and the first n question ids. */
function bodyBytes(state: { requirements: string; hunks: Record<string, JevWrapper> }, n: number): number {
  const questions = Object.fromEntries(Array.from({ length: n }, (_, i) => [`h${i}`, question(`h${i}`)]));
  return encoded({ model: JEV_MODEL, state, questions });
}

/**
 * Cards are never split across reviews. Later cards join only if all their
 * candidates fit. The first card is always taken; if its candidates exceed the
 * per-request caps, the first ones in hunk order that fit are judged and the
 * rest get one named candidate-cap gap, and that card ends the review. The
 * whole encoded body (state, questions, wrappers) stays within `bodyCap`, the
 * smaller of 60 KiB and the configured packet cap (A230 #2).
 */
export function buildJevWindow(fifo: JevCard[], requirementsText: string, testGlobs: readonly string[], bodyCap = MAX_BODY_BYTES): JevWindow {
  const cap = Math.min(bodyCap, MAX_BODY_BYTES);
  const requirements = fitRequirements(requirementsText);
  const state = { requirements: requirements.text, hunks: {} as Record<string, JevWrapper> };
  const window: string[] = [];
  const judged: JevWindow["judged"] = [];
  const gaps: JevGap[] = [];
  const skipped: JevWindow["skipped"] = [];
  for (const card of fifo) {
    const { candidates, skipped: s } = candidatesOf(card, testGlobs);
    const first = window.length === 0;
    let hunks = { ...state.hunks };
    let n = Object.keys(hunks).length;
    let fitted = 0;
    let limit: JevGap["limit"] = "16 questions";
    for (const c of candidates) {
      const id = `h${n}`;
      const next = { ...hunks, [id]: c.wrapper };
      if (n + 1 > MAX_QUESTIONS) break;
      if (encoded({ ...state, hunks: next }) > MAX_STATE_BYTES) {
        limit = "24 KiB encoded state";
        break;
      }
      if (bodyBytes({ ...state, hunks: next }, n + 1) > cap) {
        limit = "encoded body cap";
        break;
      }
      hunks = next;
      n++;
      fitted++;
    }
    if (fitted < candidates.length && !first) break; // the whole card does not fit: it leads the next review
    state.hunks = hunks;
    window.push(card.id);
    skipped.push(...s);
    candidates.slice(0, fitted).forEach((c, i) => judged.push({ id: `h${n - fitted + i}`, ref: c.ref, card: card.id, hunkIndex: c.hunkIndex }));
    if (fitted < candidates.length) {
      gaps.push({
        kind: "not-judged",
        reason: "candidate-cap",
        card: card.id,
        refs: candidates.slice(fitted).map((c) => c.ref),
        limit,
      });
      break; // a capped card is the last card of its review
    }
  }
  const questions = Object.fromEntries(judged.map((j) => [j.id, question(j.id)]));
  const body = { model: JEV_MODEL, state, questions };
  return {
    window,
    judged,
    gaps,
    skipped,
    requirementsPartial: requirements.partial,
    partialCoverage: gaps.length > 0 || requirements.partial,
    body,
    bytes: { state: encoded(state), body: encoded(body) },
  };
}

/**
 * A161 F3: a window with nothing to judge makes no call and reserves nothing.
 * It is recorded as a no-call review, and the frontier moves past it exactly
 * as after a completed review.
 */
export type JevPlan =
  | { kind: "call"; window: JevWindow }
  | { kind: "no-call"; window: JevWindow; reason: "no-eligible-candidates" | "candidate-cap" };

export function planJevReview(fifo: JevCard[], requirementsText: string, testGlobs: readonly string[], bodyCap = MAX_BODY_BYTES): JevPlan | null {
  if (fifo.length === 0) return null; // an empty FIFO is not a review
  const w = buildJevWindow(fifo, requirementsText, testGlobs, bodyCap);
  if (w.judged.length > 0) return { kind: "call", window: w };
  return { kind: "no-call", window: w, reason: w.gaps.length > 0 ? "candidate-cap" : "no-eligible-candidates" };
}
