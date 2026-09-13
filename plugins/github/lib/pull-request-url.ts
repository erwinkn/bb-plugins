/**
 * GitHub pull request identity helpers shared by the server, the app, and the
 * content script. A PR is identified by `owner/repo` plus its number; the
 * canonical URL is `https://github.com/<owner>/<repo>/pull/<n>`.
 */

export interface PullRequestRef {
  repo: string;
  number: number;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** `https://github.com/<owner>/<repo>/pull/<n>` with any trailing path, query, or hash. */
const PULL_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

export function isRepoName(value: unknown): value is string {
  return typeof value === "string" && REPO_PATTERN.test(value);
}

/** The PR a github.com URL names, or null for any other URL (issues, files, other hosts). */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = PULL_URL_PATTERN.exec(url.trim());
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: `${match[1]}/${match[2]}`, number };
}

export function pullRequestUrl(ref: PullRequestRef): string {
  return `https://github.com/${ref.repo}/pull/${ref.number}`;
}

export function pullRequestKey(ref: PullRequestRef): string {
  return `${ref.repo}#${ref.number}`;
}

/**
 * Parse a PR reference an agent or user might type: a full URL,
 * `owner/repo#123`, `#123`, or `123`. Bare numbers need `defaultRepo`.
 * Returns an error message instead of a ref when nothing fits.
 */
export function parsePullRequestReference(
  reference: string,
  defaultRepo: string | null,
): { ref: PullRequestRef } | { error: string } {
  const text = reference.trim();
  if (text === "") return { error: "Pass a pull request URL or number." };
  const fromUrl = parsePullRequestUrl(text);
  if (fromUrl !== null) return { ref: fromUrl };
  if (/^https?:\/\//i.test(text)) {
    return { error: `"${text}" is not a github.com pull request URL (expected https://github.com/<owner>/<repo>/pull/<n>).` };
  }
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  if (qualified !== null) {
    return { ref: { repo: qualified[1]!, number: Number(qualified[2]) } };
  }
  const bare = /^#?(\d+)$/.exec(text);
  if (bare !== null) {
    if (defaultRepo === null) {
      return { error: `"${text}" needs a repository: pass the full PR URL or owner/repo#${bare[1]}.` };
    }
    return { ref: { repo: defaultRepo, number: Number(bare[1]) } };
  }
  return { error: `"${text}" is not a pull request URL, owner/repo#number, or #number.` };
}

/** `owner/repo` from a GitHub remote URL (https, ssh, or git protocol), else null. */
export function parseGithubRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (match === null) return null;
  return `${match[1]}/${match[2]}`;
}
