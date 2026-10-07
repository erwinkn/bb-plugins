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

/** The chip's face: the state glyph and the number. */
function ChipFace({ pullRequest }: { pullRequest: PluginSidebarPullRequest }) {
  return (
    <>
      <PullRequestIcon pullRequest={pullRequest} />
      <span
        className={`font-normal tabular-nums ${pullRequestColorClass(pullRequest)}`}
      >
        #{pullRequest.number}
      </span>
    </>
  );
}

/**
 * The chip's footprint inside the row link: invisible and hidden from
 * assistive tech, it keeps the metadata line laid out as if the chip were
 * there. The real chip is a sibling of the row link, placed over it.
 */
export function PullRequestChipSpace({
  pullRequest,
}: {
  pullRequest: PluginSidebarPullRequest;
}) {
  return (
    <span
      aria-hidden="true"
      data-thread-pull-request-space=""
      className="invisible flex shrink-0 items-center gap-1"
    >
      <ChipFace pullRequest={pullRequest} />
    </span>
  );
}

/**
 * The row's pull request indicator: a state-colored icon and the number. It is
 * a real link, so modifier clicks, middle clicks and Copy Link behave natively;
 * only a plain left click is taken, to call `onOpen` with the URL. It is not
 * inside the row link (a link can't nest a link): the row renders it beside
 * that link, over `PullRequestChipSpace`. Presses stay away from the row's
 * drag, long press and selection.
 */
export function PullRequestChip({
  pullRequest,
  onOpen,
}: {
  pullRequest: PluginSidebarPullRequest;
  onOpen: (url: string) => void;
}) {
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      data-thread-pull-request=""
      aria-label={`${pullRequestSummary(pullRequest)}: ${pullRequest.title}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(pullRequest.url);
      }}
      className={`pointer-events-auto ${chipClass}`}
    >
      <ChipFace pullRequest={pullRequest} />
    </a>
  );
}
