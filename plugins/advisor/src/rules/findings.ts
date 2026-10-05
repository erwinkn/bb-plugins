// Issue and occurrence identity (A140 §6.1, A144 §6, A152 §5).
//
// Issue = (watch, category, locator). A proven locator carries test identity
// (path::suite › name@side:L<declaration>); an unverified one
// (path@side:L<line>) is grouping only. Occurrence = issue + evidence id + cited
// hunk and lines, so byte-identical content at a later sequence is a new
// occurrence. Nothing auto-closes: a passing run changes nothing. A later
// observed change that removes an issue's cited lines leaves it open but makes
// its next occurrence notify (restore, then the same weakening again).

import { createHash } from "node:crypto";
import type { HunkFinding, Shown } from "./validate.js";

export type IssueState = "open" | "muted" | "dismissed-unverified" | "model-reported-resolved";

export type NotificationReason =
  | "new"
  | "recurred-after-dismissed-unverified"
  | "recurred-after-model-reported-resolved"
  | "recurred-after-cited-lines-removed"
  | "new-occurrence-at-muted-unverified-locator";

export function issueKey(watch: string, category: string, locator: string): string {
  return JSON.stringify([watch, category, locator]);
}

export function occurrenceId(watch: string, category: string, locator: string, finding: HunkFinding): string {
  const cites = (["before", "after"] as const)
    .filter((s) => finding[s])
    .map((s) => [s, finding[s]!.hunk ?? finding.hunk, finding[s]!.lines]);
  return createHash("sha256")
    .update(JSON.stringify([watch, category, locator, finding.evidence, cites]))
    .digest("hex")
    .slice(0, 12);
}

/**
 * What a new occurrence does to its issue. Pure, so the in-memory reference
 * (tests) and the durable store share one rule.
 *  - already recorded: deduplicated, silent;
 *  - verified issue muted: stored, silent;
 *  - unverified issue muted: the mute covers only the occurrences it was set
 *    on, so a new one notifies and the issue stays muted;
 *  - new, dismissed or model-reported-resolved: notify and (re)open;
 *  - open, but a later observed change removed its cited lines: notify.
 */
export function admitOccurrence(
  prior: IssueState | null,
  alreadyRecorded: boolean,
  subjectVerified: boolean,
  reversed = false,
): { notify: NotificationReason | null; nextState: IssueState | null; store: boolean } {
  if (alreadyRecorded) return { notify: null, nextState: null, store: false };
  if (prior === "muted") {
    return subjectVerified
      ? { notify: null, nextState: null, store: true }
      : { notify: "new-occurrence-at-muted-unverified-locator", nextState: null, store: true };
  }
  if (prior === null) return { notify: "new", nextState: "open", store: true };
  if (prior === "dismissed-unverified" || prior === "model-reported-resolved") {
    return { notify: `recurred-after-${prior}`, nextState: "open", store: true };
  }
  if (reversed) return { notify: "recurred-after-cited-lines-removed", nextState: "open", store: true };
  return { notify: null, nextState: "open", store: true };
}

/** In-memory findings, the reference shape of the durable store's rule. */
export class Findings {
  issues = new Map<string, IssueState>();
  occurrences = new Map<string, { issue: string; evidence?: string; review: string; reconfirmedBy: string[]; subjectVerified: boolean }>();
  notifications: Array<{ occ: string; reason: NotificationReason }> = [];

  add(watch: string, category: string, shown: Shown, finding: HunkFinding, review: string): string {
    const issue = issueKey(watch, category, shown.locator);
    const occ = occurrenceId(watch, category, shown.locator, finding);
    const existing = this.occurrences.get(occ);
    const r = admitOccurrence(this.issues.get(issue) ?? null, existing !== undefined, shown.subjectVerified);
    if (existing) {
      existing.reconfirmedBy.push(review);
      return occ;
    }
    this.occurrences.set(occ, { issue, evidence: finding.evidence, review, reconfirmedBy: [], subjectVerified: shown.subjectVerified });
    if (r.notify) this.notifications.push({ occ, reason: r.notify });
    if (r.nextState) this.issues.set(issue, r.nextState);
    return occ;
  }

  setState(watch: string, category: string, locator: string, state: IssueState): void {
    this.issues.set(issueKey(watch, category, locator), state);
  }

  state(watch: string, category: string, locator: string): IssueState | undefined {
    return this.issues.get(issueKey(watch, category, locator));
  }
}
