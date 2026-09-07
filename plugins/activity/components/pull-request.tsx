import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";

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

/** "Open pull request #12, checks failed" — for labels and the info card. */
export function pullRequestSummary(pullRequest: PluginSidebarPullRequest) {
  const attention = ATTENTION_LABEL[pullRequest.attention];
  return `${STATE_LABEL[pullRequest.state]} pull request #${pullRequest.number}${attention ? `, ${attention}` : ""}`;
}

function colorOf(pullRequest: PluginSidebarPullRequest) {
  switch (pullRequest.state) {
    case "merged":
      return "text-violet-600 dark:text-violet-400";
    case "closed":
      return "text-red-600 dark:text-red-400";
    case "draft":
      return "text-[var(--subtle-foreground)]";
    default:
      return NEEDS_YOU.has(pullRequest.attention)
        ? "text-[var(--warning-text)]"
        : "text-[var(--success)]";
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
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-3.5 shrink-0 ${colorOf(pullRequest)} ${className}`}
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
