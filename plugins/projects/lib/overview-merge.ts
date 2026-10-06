import type { Overview } from "./overview";

type Decision = Overview["decisions"][number];

/** What the Inbox acts on; the summary tier always carries these rows. */
const needsAttention = (d: Decision) =>
  (d.madeBy === "agent" && d.review === "pending") ||
  (!!d.notification && ["failed", "pending", "uncertain"].includes(d.notification.state));

/** Whether `a` was built from a later ledger state than `b`; unknown order reads as not newer. */
function newer(a: Overview, b: Overview) {
  return !!a.revision && !!b.revision && a.revision.epoch === b.revision.epoch &&
    a.revision.version > b.revision.version;
}

/**
 * The dashboard model from the latest summary plus a larger tier (history or
 * full) fetched separately. Each tier refreshes on its own, so either may be
 * the newer one. History supplies the record; a newer summary stays
 * authoritative for current attention: its rows replace the history's, new
 * rows join, and history rows it no longer needs attention for are left out
 * until history refreshes, so a resolved item never reappears and a new one
 * never hides.
 */
export function mergeOverview(summary: Overview, past: Overview | null, full: Overview | null): Overview {
  if (!past) return summary;
  const merged: Overview = {
    ...summary,
    historyLoaded: true,
    done: past.done,
    workers: { current: summary.workers.current, retired: past.workers.retired },
  };
  if (newer(summary, past)) {
    const current = new Map(summary.decisions.map((d) => [d.ref, d]));
    const known = new Set(past.decisions.map((d) => d.ref));
    merged.decisions = [
      ...past.decisions
        .filter((d) => current.has(d.ref) || !needsAttention(d))
        .map((d) => current.get(d.ref) ?? d),
      ...summary.decisions.filter((d) => !known.has(d.ref)),
    ];
  } else {
    // Decision rows, answers and closures come from one snapshot so a row and its answer agree.
    merged.decisions = past.decisions;
    merged.answered = past.answered;
    merged.closedQuestions = past.closedQuestions;
  }
  if (full)
    Object.assign(merged, { detailsLoaded: true, usage: full.usage, memberThreads: full.memberThreads, workers: full.workers });
  return merged;
}
