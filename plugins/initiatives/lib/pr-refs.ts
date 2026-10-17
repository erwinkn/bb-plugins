// The PRs an assignment's texts name (W224, W492, W506). Pure, and free of server-only imports:
// Store indexes them on every write, and the app bundles Store.
import { ownBriefText } from "./brief";
import { canonicalPrUrl } from "./pr-stages";
import { prsReferenced, reportPrs } from "./task-status";

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi;

/** The canonical URLs of the GitHub PRs a text names, in order, once each. */
export function prsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(PR_URL)].flatMap((match) => canonicalPrUrl(match[0]) ?? []))];
}

/** The PRs a stored report's text names; an unreadable one names none. */
function storedReportPrs(report: string | null): string[] {
  if (!report) return [];
  try {
    return reportPrs(JSON.parse(report));
  } catch {
    return [];
  }
}

/**
 * W506: the PRs one assignment names, as Store keeps them (assignment_pr_refs) whenever its
 * brief or report is written: `brief` as stored, `report` as its stored JSON. Each list in
 * order of first appearance.
 */
export function assignmentPrRefs(brief: string, report: string | null): { named: string[]; referenced: string[] } {
  // Without the appendix every worker shares: a PR a rule names is no one's work.
  const own = ownBriefText(brief);
  return {
    // Who works on a PR, by URL. Both: a review's report rarely repeats the PR its brief gave it.
    named: prsNamed(`${own}\n${report ?? ""}`),
    // W492: whose a PR is (a worker's initiative_pr) counts owner/repo#12 too; the report read
    // from its values, since its JSON would glue an escaped "\n" onto a name.
    referenced: [...new Set([...prsReferenced(own), ...storedReportPrs(report)])],
  };
}
