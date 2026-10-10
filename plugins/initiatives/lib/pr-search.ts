// T156: the PRs tab's search. Pure, so the list, the graph and the tests agree.
import type { QueuedPullRequest } from "./merge-queue";
import { matchesRef } from "./pr-map";

type Pr = Pick<QueuedPullRequest, "repo" | "number" | "url" | "title" | "head" | "category" | "stageNote" | "waitingOn" | "worker" | "links">;

/** One word of a query against one PR. */
function matches(pr: Pr, word: string): boolean {
  // A number is a PR number, matched as typed: 22 finds #2251 on the way to it.
  const number = /^#?(\d+)$/.exec(word);
  if (number) return String(pr.number).startsWith(number[1]!);
  // A URL or repo#2251 names PRs exactly.
  const named = matchesRef(word);
  if (named) return named(pr);
  const texts = [pr.title, pr.head, pr.repo, pr.category, pr.stageNote, pr.waitingOn];
  // A ref is whole (W35 is not W351), linked or in the text.
  const ref = /^([wa])\d+$/.exec(word);
  if (ref) {
    const refs = ref[1] === "w" ? [pr.worker?.ref, ...pr.links.workers] : [pr.worker?.assignment, ...pr.links.assignments];
    const whole = new RegExp(`\\b${word}\\b`);
    return refs.some((r) => r?.toLowerCase() === word) || texts.some((text) => text && whole.test(text.toLowerCase()));
  }
  return texts.some((text) => text?.toLowerCase().includes(word));
}

const words = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The PRs every word of `query` matches: a PR number (2251, #2251, as a
 * prefix), a PR URL, owner/repo#2251 or repo#2251, a whole worker or
 * assignment ref linked to it or in its text (W351, A301; not W35), or text
 * in its title, branch, repository, category, stage note or what it waits
 * on. An empty query matches all.
 */
export function searchPrs<T extends Pr>(pullRequests: readonly T[], query: string): T[] {
  const parts = words(query);
  return parts.length ? pullRequests.filter((pr) => parts.every((word) => matches(pr, word))) : [...pullRequests];
}

/**
 * The PR Enter opens. A query naming PRs by number (2251, #2251), URL,
 * owner/repo#2251 or repo#2251 opens the one it names, even behind the
 * filters, and none when it names several. Any other query opens the only
 * PR `shown`.
 */
export function pickPr<T extends Pr>(pullRequests: readonly T[], shown: readonly T[], query: string): T | null {
  const parts = words(query);
  const named = parts.length === 1 ? matchesRef(parts[0]!) : null;
  const found = named ? pullRequests.filter(named) : shown;
  return found.length === 1 ? found[0]! : null;
}
