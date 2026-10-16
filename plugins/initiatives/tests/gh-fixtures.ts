// `gh api graphql` answers shaped like GitHub's, for the merge queue's fake `gh`s.
import { GH_LIST_QUERY } from "../lib/merge-queue";

/** A list query node's `statusCheckRollup`: the last commit's check runs and status contexts, counted by state. */
export const rollup = (checkRuns: Record<string, number> = {}, statusContexts: Record<string, number> = {}) => ({
  nodes: [{ commit: { statusCheckRollup: { contexts: {
    checkRunCountsByState: Object.entries(checkRuns).map(([state, count]) => ({ state, count })),
    statusContextCountsByState: Object.entries(statusContexts).map(([state, count]) => ({ state, count })),
  } } } }],
});

/** One page of a search query's answer: `total` is GitHub's issueCount, `next` the next page's cursor. */
export const searchPage = (nodes: unknown[], next: string | null = null, total = nodes.length) =>
  JSON.stringify({ data: { search: { issueCount: total, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } });

/** Which `gh` call these arguments make: the account, the list query, the details query, or another. */
export const ghCall = (args: readonly string[]): "user" | "list" | "details" | "other" =>
  args[1] === "user" ? "user"
    : args[1] === "graphql" ? (args.includes(`query=${GH_LIST_QUERY}`) ? "list" : "details")
      : "other";

/** The page cursor a search call asks for; null for the first page. */
export const cursorOf = (args: readonly string[]) => args.find((a) => a.startsWith("endCursor="))?.slice("endCursor=".length) ?? null;
