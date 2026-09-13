import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "../lib/portal-scope";
import type { LinkedPullRequest } from "../lib/pull-requests-schema";

const STATE_LABEL: Record<PluginSidebarPullRequest["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const ATTENTION_LABEL: Partial<
  Record<PluginSidebarPullRequest["attention"], string>
> = {
  blocked: "blocked",
  changes_requested: "changes requested",
  checks_failed: "checks failed",
  checks_pending: "checks pending",
  conflicts: "conflicts",
  ready_to_merge: "ready to merge",
  review_requested: "review requested",
};

const NEEDS_YOU = new Set<PluginSidebarPullRequest["attention"]>([
  "blocked",
  "changes_requested",
  "checks_failed",
  "conflicts",
]);

const GITHUB_PULL_URL =
  /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;

/** Canonical dedupe key for a pull request URL: `owner/repo#n`, else the URL. */
export function pullRequestKey(url: string): string {
  const match = GITHUB_PULL_URL.exec(url);
  return match ? `${match[1]}#${match[2]}`.toLowerCase() : url;
}

/** `owner/repo` of a GitHub pull request URL, null for anything else. */
export function pullRequestRepo(url: string): string | null {
  return GITHUB_PULL_URL.exec(url)?.[1] ?? null;
}

function normalizeLinkedState(
  state: string | null,
): PluginSidebarPullRequest["state"] {
  switch (state?.toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "draft":
      return "draft";
    default:
      // A missing or unrecognised state reads as open rather than wrong.
      return "open";
  }
}

/**
 * The row's pull requests: the branch's live PR first, then the github-prs
 * links, deduplicated by URL. A linked entry keeps its last-seen state and
 * carries no attention signal; the live entry wins the duplicate.
 */
export function mergePullRequests(
  branch: PluginSidebarPullRequest | null,
  linked: readonly LinkedPullRequest[] | undefined,
): PluginSidebarPullRequest[] {
  const merged: PluginSidebarPullRequest[] = [];
  const seen = new Set<string>();
  const push = (pullRequest: PluginSidebarPullRequest) => {
    const key = pullRequestKey(pullRequest.url);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(pullRequest);
  };
  if (branch !== null) push(branch);
  for (const link of linked ?? []) {
    push({
      number: link.number,
      title: link.title ?? `${link.repo}#${link.number}`,
      url: link.url,
      state: normalizeLinkedState(link.state),
      attention: "none",
    });
  }
  return merged;
}

// Chip colour order: an open pull request that needs you is the most
// attention-worthy, then open, draft, merged, and finally closed.
function attentionRank(pullRequest: PluginSidebarPullRequest): number {
  switch (pullRequest.state) {
    case "open":
      return NEEDS_YOU.has(pullRequest.attention) ? 0 : 1;
    case "draft":
      return 2;
    case "merged":
      return 3;
    default:
      return 4;
  }
}

/** The pull request whose state should colour a collapsed multi-PR chip. */
export function attentionWorthyPullRequest(
  pullRequests: readonly PluginSidebarPullRequest[],
): PluginSidebarPullRequest | null {
  let best: PluginSidebarPullRequest | null = null;
  for (const pullRequest of pullRequests) {
    if (best === null || attentionRank(pullRequest) < attentionRank(best))
      best = pullRequest;
  }
  return best;
}

/** "Open pull request #12, checks failed" — for labels and the info card. */
export function pullRequestSummary(pullRequest: PluginSidebarPullRequest) {
  const attention = ATTENTION_LABEL[pullRequest.attention];
  return `${STATE_LABEL[pullRequest.state]} pull request #${pullRequest.number}${attention ? `, ${attention}` : ""}`;
}

/**
 * Chip colors on the theme plugin's roles with BB fallbacks: merged purple
 * (agent), open green (done), closed red (error), draft amber (edit), and an
 * open pull request that needs you in the attention amber. The glyph shape
 * differs per state as well.
 */
export function pullRequestColorClass(pullRequest: PluginSidebarPullRequest) {
  switch (pullRequest.state) {
    case "merged":
      return "text-[var(--bbp-agent,var(--pr-merged))]";
    case "closed":
      return "text-[var(--bbp-error,var(--destructive-text))]";
    case "draft":
      return "text-[var(--bbp-edit,var(--warning-text))]";
    default:
      return NEEDS_YOU.has(pullRequest.attention)
        ? "text-[var(--bbp-attention,var(--warning-text))]"
        : "text-[var(--bbp-done,var(--success))]";
  }
}

export function PullRequestIcon({
  pullRequest,
  className = "",
}: {
  pullRequest: PluginSidebarPullRequest;
  className?: string;
}) {
  return (
    <svg
      role="img"
      aria-label={pullRequestSummary(pullRequest)}
      data-pull-request-state={pullRequest.state}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-3.5 shrink-0 ${pullRequestColorClass(pullRequest)} ${className}`}
    >
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <path d="M4 5.25v5.5" />
      {pullRequest.state === "merged" ? (
        <>
          <circle cx="12" cy="8" r="1.75" />
          <path d="M4 5.5a4.5 4.5 0 0 0 4.5 2.5h1.75" />
        </>
      ) : pullRequest.state === "closed" ? (
        <path d="M10 2.5 14 6.5M14 2.5 10 6.5M12 8.5v2.25" />
      ) : (
        <>
          <circle cx="12" cy="12.5" r="1.75" />
          <path
            d="M12 10.75V6a2.5 2.5 0 0 0-2.5-2.5H8m2-2-2 2 2 2"
            strokeDasharray={pullRequest.state === "draft" ? "2 2" : undefined}
          />
        </>
      )}
    </svg>
  );
}

const chipClass =
  "flex shrink-0 cursor-pointer items-center gap-1 rounded underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

const entryClass =
  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs leading-4 outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

/**
 * The row's pull request indicator. One PR keeps the plain icon-and-number
 * link; several collapse into an icon with a plain count, coloured by the
 * most attention-worthy state, that opens a picker. Both keep the press
 * away from the row (selection, drag, and the long-press menu) and call
 * `onOpen` with the chosen URL.
 */
export function PullRequestsChip({
  pullRequests,
  threadRepo,
  onOpen,
}: {
  pullRequests: readonly PluginSidebarPullRequest[];
  /**
   * `owner/repo` of the thread's branch PR, when it has one. Entries in
   * other repos are labelled; with no branch PR the label appears only
   * when the list mixes repos.
   */
  threadRepo: string | null;
  onOpen: (url: string) => void;
}) {
  const scope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  if (pullRequests.length === 0) return null;
  const primary = attentionWorthyPullRequest(pullRequests)!;
  if (pullRequests.length === 1) {
    const pullRequest = pullRequests[0]!;
    return (
      // The row itself is a link, so the chip is a link by role rather
      // than a nested anchor.
      <span
        role="link"
        tabIndex={0}
        data-thread-pull-request=""
        aria-label={`${pullRequestSummary(pullRequest)}: ${pullRequest.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen(pullRequest.url);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onOpen(pullRequest.url);
        }}
        className={chipClass}
      >
        <PullRequestIcon pullRequest={pullRequest} />
        <span className={`tabular-nums ${pullRequestColorClass(pullRequest)}`}>
          #{pullRequest.number}
        </span>
      </span>
    );
  }
  const repos = new Set(
    pullRequests.map((pullRequest) => pullRequestRepo(pullRequest.url)),
  );
  const pick = (url: string) => {
    setOpen(false);
    onOpen(url);
  };
  const moveFocus = (current: HTMLElement, direction: 1 | -1) => {
    const entries = Array.from(
      current
        .closest("ul")
        ?.querySelectorAll<HTMLElement>("[data-pull-request-entry]") ?? [],
    );
    const index = entries.indexOf(current);
    entries[
      (index + direction + entries.length) % entries.length
    ]?.focus();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <span
          role="button"
          tabIndex={0}
          data-thread-pull-requests=""
          aria-label={`${pullRequests.length} linked pull requests`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          className={chipClass}
        >
          <PullRequestIcon pullRequest={primary} />
          <span
            aria-hidden="true"
            data-pull-request-count=""
            className={`tabular-nums ${pullRequestColorClass(primary)}`}
          >
            {pullRequests.length}
          </span>
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          {...scope}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label="Linked pull requests"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)
              ?.querySelector<HTMLElement>("[data-pull-request-entry]")
              ?.focus();
          }}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <ul className="m-0 list-none p-0">
            {pullRequests.map((pullRequest) => {
              const repo = pullRequestRepo(pullRequest.url);
              const showRepo =
                repo !== null &&
                (threadRepo === null
                  ? repos.size > 1
                  : repo !== threadRepo);
              return (
                <li key={pullRequest.url}>
                  <span
                    role="link"
                    tabIndex={-1}
                    data-pull-request-entry=""
                    aria-label={`${pullRequestSummary(pullRequest)}: ${pullRequest.title}${showRepo ? `, ${repo}` : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      pick(pullRequest.url);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        pick(pullRequest.url);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveFocus(event.currentTarget, 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveFocus(event.currentTarget, -1);
                      }
                    }}
                    className={entryClass}
                  >
                    <PullRequestIcon pullRequest={pullRequest} />
                    <span
                      className={`shrink-0 tabular-nums ${pullRequestColorClass(pullRequest)}`}
                    >
                      #{pullRequest.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {pullRequest.title}
                    </span>
                    {showRepo && (
                      <span className="shrink-0 text-[var(--subtle-foreground)]">
                        {repo}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
