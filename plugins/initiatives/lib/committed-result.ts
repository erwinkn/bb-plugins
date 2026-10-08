import type { Overview } from "./overview";
import { dismissalItem } from "./blockers";
import type { Command } from "./commands";
import type { DecisionRecord } from "./store";

/** Project only durable RPC results; never claim success before the save. */
export function applyCommitted(o: Overview, command: Command, result: unknown): Overview {
  const next = { ...o, counts: { ...o.counts } };
  if (command.action === "decision-accept-all") {
    const refs = new Set((result as { refs: string[] }).refs);
    next.decisions = next.decisions.map(d => refs.has(d.ref) ? { ...d, review: "okay", reviewMessage: null, notification: null, acceptEligible: false } : d);
    next.revisit = next.revisit.filter(d => !refs.has(d.ref));
  } else if (["decision-review", "answer", "question-close", "acknowledge"].includes(command.action) && "decision" in command) {
    const d = result as DecisionRecord;
    if (!d?.ref || !d.body) return o;
    if (command.action === "decision-review" || command.action === "acknowledge") {
      next.decisions = next.decisions.map(row => row.ref === d.ref ? { ...row, review: d.review, reviewMessage: d.reviewMessage, notification: d.notification, updatedAt: d.updatedAt } : row);
      next.revisit = next.revisit.filter(row => row.ref !== d.ref);
    } else {
      const q = next.opinionNeeded.find(row => row.ref === command.decision);
      next.opinionNeeded = next.opinionNeeded.filter(row => row.ref !== command.decision);
      if (command.action === "answer" && q && d.body.answer) {
        const answer = d.body.answer;
        next.answered = [...next.answered.filter(row => row.ref !== d.ref), { ...q, choice: answer.choice, note: answer.note, answeredAt: answer.at, recordedBy: null }];
        next.decisions = [...next.decisions.filter(row => row.ref !== d.ref), { ref: d.ref, description: d.description, madeBy: "user", acceptEligible: false, review: null, reviewMessage: null, notification: d.notification, recordedBy: d.provenance, updatedAt: d.updatedAt }];
      } else if (command.action === "question-close" && q) {
        next.closedQuestions = [{ ref: d.ref, question: q.question, note: d.body.resolution?.note ?? "", closedAt: d.body.resolution?.at ?? d.updatedAt }, ...next.closedQuestions.filter(row => row.ref !== d.ref)];
      }
    }
  }
  if (command.action === "blocker-answer") {
    const d = result as DecisionRecord;
    if (!d?.ref || !d.body?.answer) return o;
    const answer = { ref: d.ref, note: d.body.answer.note, at: d.body.answer.at, to: d.body.answer.to ?? "coordinator" as const, delivery: d.body.answer.delivery ?? null, notification: d.notification };
    next.blockers = next.blockers.map(b => b.assignment === command.assignment ? { ...b, answer } : b);
  }
  if (command.action === "blocker-dismiss" || command.action === "blocker-dismiss-undo") {
    const d = result as DecisionRecord;
    if (!d?.ref || !d.body?.dismissal || !d.body.blocker) return o;
    const row = { ref: d.ref, description: d.description, madeBy: "user" as const, acceptEligible: false, review: null, reviewMessage: null, notification: d.notification, recordedBy: d.provenance, updatedAt: d.updatedAt, dismissal: dismissalItem(d.body.blocker, d.body.dismissal) };
    next.decisions = [...next.decisions.filter(r => r.ref !== d.ref), row];
    // An undone dismissal brings its blocker back on the next read, if it is still open.
    if (command.action === "blocker-dismiss") next.blockers = next.blockers.filter(b => b.assignment !== command.assignment);
  }
  // The memory command answers with the Initiative's new memory status.
  if (command.action === "memory" && (result as { mode?: unknown } | null)?.mode) next.memory = result as Overview["memory"];
  next.counts.opinionNeeded = next.opinionNeeded.length;
  next.counts.revisit = next.revisit.length;
  next.counts.answered = next.answered.length;
  return next;
}
