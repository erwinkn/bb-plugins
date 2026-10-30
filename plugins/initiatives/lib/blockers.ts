/**
 * D386: a blocked worker report waits until the coordinator acts on it. W555: it never reaches
 * the user directly; the coordinator asks them (initiative_question) when the worker needs an
 * answer only they can give.
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
 * or closes every task it is about. W482: a retired worker's blocker is closed
 * too: nobody is left to answer it, and retiring is final.
 */
export function openBlockers<T extends BlockerFacts>(assignments: T[], closedTask: (num: number) => boolean, retiredWorker: (workerNum: number) => boolean): T[] {
  return assignments.filter((a) => {
    if (a.state !== "reported" || a.outcome !== "blocked" || retiredWorker(a.workerNum)) return false;
    const subject = subjectOf(a);
    if (subject.length && subject.every(closedTask)) return false;
    return !assignments.some(
      (b) => b.num > a.num && b.state !== "failed" &&
        (b.workerNum === a.workerNum || (b.role === a.role && subjectOf(b).some((num) => subject.includes(num)))),
    );
  });
}
