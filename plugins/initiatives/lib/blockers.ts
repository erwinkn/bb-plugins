import type { BlockerAnswerItem, DismissalItem } from "./overview";
import type { DecisionBody } from "./store";

/**
 * D386: a blocked worker report waits on the user until the coordinator acts
 * on it. One rule, shared by the sidebar tree and the dashboard, so their
 * Needs you counts always agree.
 */

/** The assignment facts that decide whether a blocked report is still open. */
export interface BlockerFacts {
  num: number;
  workerNum: number;
  role: "work" | "review";
  taskNums: number[];
  reviewOf: number[] | null;
  state: string;
  outcome: string | null;
}

/** The tasks a report is about: a review's reviewed tasks, otherwise its own. */
const subjectOf = (a: BlockerFacts) => (a.role === "review" ? (a.reviewOf ?? []) : a.taskNums);

/**
 * Blocked reports nobody has acted on yet. One clears when the coordinator
 * accepts or rejects it, starts a newer assignment for the same worker or the
 * same tasks (continue, fork or fresh; a dispatch that failed does not count),
 * or closes every task it is about.
 */
export function openBlockers<T extends BlockerFacts>(assignments: T[], closedTask: (num: number) => boolean): T[] {
  return assignments.filter((a) => {
    if (a.state !== "reported" || a.outcome !== "blocked") return false;
    const subject = subjectOf(a);
    if (subject.length && subject.every(closedTask)) return false;
    return !assignments.some(
      (b) => b.num > a.num && b.state !== "failed" &&
        (b.workerNum === a.workerNum || (b.role === a.role && subjectOf(b).some((num) => subject.includes(num)))),
    );
  });
}

/**
 * Identifies the blocker an answer was given to: its question and context. A
 * re-filed identical report keeps its answer; a changed question or context on
 * the same assignment needs a new one.
 */
export const blockerKey = (assignment: number, blocker: { question: string; context: string }) =>
  JSON.stringify([assignment, blocker.question, blocker.context]);

/**
 * T128: the open blockers the user has not dismissed. A dismissal is keyed
 * like an answer, so an identical re-file stays dismissed and a changed
 * question or context shows again. Everything that lists or counts blockers
 * for the user (Inbox, dashboard pill, tree, catalog) goes through here.
 */
export const undismissed = <T extends { num: number }>(
  open: T[],
  blockerOf: (a: T) => { question: string; context: string } | null | undefined,
  dismissed: ReadonlySet<string>,
) => open.filter((a) => {
  const blocker = blockerOf(a);
  return !blocker || !dismissed.has(blockerKey(a.num, blocker));
});

/** T128: a dismissal record as the dashboard shows it. */
export const dismissalItem = (blocker: NonNullable<DecisionBody["blocker"]>, d: NonNullable<DecisionBody["dismissal"]>): DismissalItem => ({
  assignment: `A${blocker.assignment}`, question: blocker.question, context: blocker.context,
  note: d.note, notify: d.notify, at: d.at, undoneAt: d.undoneAt ?? null,
});

/** T132: a blocker answer as the dashboard's decision row carries it. */
export const blockerAnswerItem = (blocker: NonNullable<DecisionBody["blocker"]>, a: NonNullable<DecisionBody["answer"]>, worker: string | null): BlockerAnswerItem => ({
  assignment: `A${blocker.assignment}`, worker, question: blocker.question, context: blocker.context,
  note: a.note, to: a.to ?? "coordinator", delivery: a.delivery ?? null,
});

/** What the Needs you pill shows: open questions plus undismissed blockers the user has not answered yet. */
export const needsYouCount = (o: { opinionNeeded: readonly unknown[]; blockers: readonly { answer: unknown }[] }) =>
  o.opinionNeeded.length + o.blockers.filter((b) => !b.answer).length;
