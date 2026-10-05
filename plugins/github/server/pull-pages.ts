import { PULL_PAGE_SIZE, pullPageSchema, type PullPage, type PullSection } from "../contract";

// Count bound shared with the output schema. One HTTP page, never --paginate.
export { PULL_PAGE_SIZE } from "../contract";
const commentFields = 'id:(.id|tostring),author:(.user.login // ""),body:(.body // ""),bodyHtml:(.body_html // null),createdAt:(.created_at // "")';
const sections: Record<PullSection, { endpoint: string; query?: string; projection: string; cap?: number }> = {
  comments: { endpoint: "issues", projection: `[.[] | {${commentFields}}]` },
  reviews: { endpoint: "pulls", projection: '[.[] | {id:(.id|tostring),author:(.user.login // ""),state:.state,body:(.body // ""),bodyHtml:(.body_html // null),createdAt:(.submitted_at // "")}]' },
  reviewComments: { endpoint: "pulls", query: "&sort=created&direction=asc", projection: `[.[] | {${commentFields},inReplyToId:(if .in_reply_to_id then (.in_reply_to_id|tostring) else null end),path:.path,line:(.line // .original_line // null),diffHunk:(.diff_hunk // "")}]` },
  files: { endpoint: "pulls", cap: 3000, projection: '[.[] | {path:.filename,previousPath:(.previous_filename // null),status:.status,additions:.additions,deletions:.deletions,patch:null}]' },
  commits: { endpoint: "pulls", cap: 250, projection: '[.[] | {sha:.sha,message:(.commit.message | split("\\n")[0]),author:(.author.login // .commit.author.name // ""),committedAt:(.commit.committer.date // ""),url:(.html_url // "")}]' },
};

export async function fetchPullPage(
  gh: (args: string[], timeoutMs?: number) => Promise<string>,
  { repo, number, section, page }: { repo: string; number: number; section: PullSection; page: number },
): Promise<PullPage> {
  const spec = sections[section];
  const offset = (page - 1) * PULL_PAGE_SIZE;
  if (spec.cap !== undefined && offset >= spec.cap) throw new Error(`GitHub exposes at most ${spec.cap} ${section} for a pull request. View the rest on GitHub.`);
  const suffix = section === "reviewComments" ? "comments" : section;
  const endpoint = `repos/${repo}/${spec.endpoint}/${number}/${suffix}?per_page=${PULL_PAGE_SIZE}&page=${page}${spec.query ?? ""}`;
  // jq drops file patches and unrelated payload before it reaches execFile's
  // unchanged 16 MiB stdout guard. Preserve rendered bodies for conversation UI.
  const raw = await gh(["api", endpoint, "--include", "-H", "Accept: application/vnd.github.full+json", "--jq", spec.projection], 30_000);
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator || !/^HTTP\/\S+ 2\d\d\b/.test(raw)) throw new Error("GitHub page response is missing successful HTTP headers.");
  const headers = raw.slice(0, separator.index);
  let items: unknown = JSON.parse(raw.slice(separator.index + separator[0].length));
  const nextLink = /^link:\s*(.*)$/im.exec(headers)?.[1]?.split(",").find((link) => /;\s*rel="next"/.test(link));
  let nextPage: number | null = null;
  if (nextLink !== undefined) {
    const href = /<([^>]+)>/.exec(nextLink)?.[1];
    const next = href ? Number(new URL(href).searchParams.get("page")) : NaN;
    if (next !== page + 1) throw new Error("GitHub returned an invalid continuation page.");
    nextPage = next;
  }
  if (section === "files" && Array.isArray(items)) items = items.map((item) => ({ ...item, page }));
  const count = Array.isArray(items) ? items.length : 0;
  const capped = spec.cap !== undefined && offset + count >= spec.cap;
  const limitation = capped ? `GitHub exposes at most ${spec.cap} ${section} for a pull request. View the rest on GitHub.` : null;
  return pullPageSchema.parse({ section, items, nextPage: capped ? null : nextPage, limitation });
}
