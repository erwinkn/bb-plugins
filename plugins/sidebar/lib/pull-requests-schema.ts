import { z } from "zod/mini";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.

/** The plugin whose thread metadata mirrors linked pull requests. */
export const GITHUB_PRS_PLUGIN_ID = "github-prs";
/** The metadata key the GitHub plugin mirrors its link list under. */
export const PULL_REQUESTS_METADATA_KEY = "pullRequests";
/**
 * The sidebar's own realtime channel for link changes. Plugin apps only
 * receive their own plugin's signals, so the GitHub plugin's
 * `pull-requests-changed` cannot be heard here; it calls the
 * `pullRequestsChanged` RPC instead and the server republishes.
 */
export const LINKED_PULL_REQUESTS_CHANNEL = "linked-pull-requests-changed";

/** One pull request linked to a thread, narrowed to what the chip needs. */
export const linkedPullRequestSchema = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.nullable(z.string()),
  /**
   * Last state the GitHub plugin saw ("open", "draft", "merged", "closed");
   * null on links mirrored before it recorded states.
   */
  state: z.nullable(z.string()),
});
export type LinkedPullRequest = z.infer<typeof linkedPullRequestSchema>;

/**
 * Read the `pullRequests` metadata value tolerantly: another plugin writes
 * it, so entries may predate fields or be malformed. Bad entries drop out
 * one by one rather than failing the thread's whole list.
 */
export function readLinkedPullRequests(value: unknown): LinkedPullRequest[] {
  if (!Array.isArray(value)) return [];
  const links: LinkedPullRequest[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { repo, number, url, title, state } = entry as Record<
      string,
      unknown
    >;
    if (typeof repo !== "string" || repo === "") continue;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0
    )
      continue;
    if (typeof url !== "string" || url === "") continue;
    links.push({
      repo,
      number,
      url,
      title: typeof title === "string" ? title : null,
      state: typeof state === "string" ? state : null,
    });
  }
  return links;
}
