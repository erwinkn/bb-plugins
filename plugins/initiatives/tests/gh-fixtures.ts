// GitHub GraphQL answers (their `data`) shaped like GitHub's, for the merge queue's fake GraphQl.
import { GH_DETAILS_QUERY, GH_LIST_QUERY } from "../lib/merge-queue";

/** A list query node's `statusCheckRollup`: the last commit's check runs and status contexts, counted by state. */
export const rollup = (checkRuns: Record<string, number> = {}, statusContexts: Record<string, number> = {}) => ({
  nodes: [{ commit: { statusCheckRollup: { contexts: {
    checkRunCountsByState: Object.entries(checkRuns).map(([state, count]) => ({ state, count })),
    statusContextCountsByState: Object.entries(statusContexts).map(([state, count]) => ({ state, count })),
  } } } }],
});

/** One page of a list query's answer: `total` is GitHub's issueCount, `next` the next page's cursor. */
export const searchPage = (nodes: unknown[], next: string | null = null, total = nodes.length, login = "erwinkn") =>
  ({ viewer: { login }, search: { issueCount: total, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } });

/**
 * A details answer for the ids asked. The fixtures' node ids are PR URLs (list nodes without an
 * `id` get theirs from `withId`), so `of` answers by URL: a node, or null for a PR gone.
 */
export const detailsAnswer = (variables: Record<string, unknown>, of: (url: string) => Record<string, unknown> | null = () => null) =>
  ({ nodes: (variables.ids as string[]).map((id) => { const node = of(id); return node ? { id, ...node } : null; }) });

/** A list node with its URL as its id, as detailsAnswer expects. */
export const withId = <T extends { url?: unknown }>(node: T) => ({ id: node.url, ...node });

/** Which query this is: the list, the details, the PR-state lookup, or another. */
export const queryKind = (query: string): "list" | "details" | "lookup" | "other" =>
  query === GH_LIST_QUERY ? "list" : query === GH_DETAILS_QUERY ? "details" : query.includes("resource(url:") ? "lookup" : "other";

/** The page cursor a list query asks for; null for the first page. */
export const cursorOf = (variables: Record<string, unknown>) => (variables.endCursor as string | undefined) ?? null;

/** The repositories a list query searches, as its `repo:` qualifiers name them. */
export const reposOf = (variables: Record<string, unknown>) => [...String(variables.q).matchAll(/repo:(\S+)/g)].map((m) => m[1]!);

/** A `fetch` for GitHub's GraphQL endpoint answering each query's `data` from `answer`. */
export const graphqlFetch = (answer: (query: string, variables: Record<string, unknown>) => unknown) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: await answer(query, variables ?? {}) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
