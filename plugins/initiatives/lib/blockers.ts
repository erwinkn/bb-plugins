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

/** What the Needs you pill shows: open questions plus blockers the user has not answered yet. */
export const needsYouCount = (o: { opinionNeeded: readonly unknown[]; blockers: readonly { answer: unknown }[] }) =>
  o.opinionNeeded.length + o.blockers.filter((b) => !b.answer).length;
