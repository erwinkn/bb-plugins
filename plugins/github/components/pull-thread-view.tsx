// The Cursor-style pull request view inside the "PR #<n>" thread panel tab:
// state pill + branches + actions + merge button, the title row, and
// Changes / Description / Commits / Checks / Reviews tabs over BB's diff
// viewer. Files collapse per-section and can be marked viewed; diffs lazily
// load both full sides so the viewer can expand unmodified regions.
import { useCallback, useEffect, useState } from "react";
import {
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  UrlLink,
  useBbNavigate,
  useRpc,
  type ExperimentalDiffFullFileContents,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { EXTERNAL_ATTRIBUTE } from "../lib/link-interception";
import { cn } from "../lib/utils";
import { EmptyState } from "./empty-state";
import { GithubBody } from "./github-html";
import { PullTimeline, REVIEW_STATE_LABELS, ReviewThreadCard, reviewStateClass } from "./pull-detail";
import { Avatar, DetailSkeleton, errorText, relativeTime, type Contract, type MergeMethod, type PullCheck, type PullDetail, type PullFile } from "./shared";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

const externalLink = { [EXTERNAL_ATTRIBUTE]: "" } as const;

const PILL_CLASS: Record<string, string> = {
  OPEN: "bg-green-600 text-white",
  MERGED: "bg-purple-600 text-white",
  CLOSED: "bg-red-600 text-white",
  DRAFT: "bg-muted-foreground/25 text-foreground",
};

function StatePill({ state }: { state: string }) {
  const label = state.charAt(0) + state.slice(1).toLowerCase();
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", PILL_CLASS[state] ?? PILL_CLASS.DRAFT)}>
      <Icon name={state === "MERGED" ? "GitMerge" : state === "DRAFT" ? "GitPullRequestDraft" : state === "CLOSED" ? "GitPullRequestClosed" : "GitPullRequest"} className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash & Merge",
  rebase: "Rebase & Merge",
};

function MergeButton({ pull, onMerged }: { pull: PullDetail; onMerged: () => void }) {
  const rpc = useRpc<Contract>();
  const [busy, setBusy] = useState(false);
  const methods = pull.mergeMethods;
  const mergeable = pull.state === "OPEN" && pull.mergeable === "MERGEABLE" && methods.length > 0;
  const primary = methods[0] ?? "merge";

  const merge = (method: MergeMethod) => {
    if (busy) return;
    setBusy(true);
    rpc
      .call("mergePull", { repo: pull.repo, number: pull.number, method })
      .then(() => {
        toast.success(`${pull.repo}#${pull.number} merged`);
        onMerged();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setBusy(false));
  };

  if (methods.length === 0) {
    return (
      <span title="This repository allows no merge method the plugin knows">
        <Button size="sm" className="h-7" disabled>
          Merge
        </Button>
      </span>
    );
  }
  return (
    <div
      className="flex items-stretch"
      role="group"
      aria-label="Merge pull request"
      title={mergeable ? undefined : pull.state !== "OPEN" ? "Only open pull requests can be merged" : "GitHub reports this pull request as not mergeable"}
    >
      <Button
        size="sm"
        className="h-7 gap-1.5 rounded-r-none bg-green-600 text-white hover:bg-green-600/90"
        disabled={!mergeable || busy}
        onClick={() => merge(primary)}
      >
        <Icon name="GitMerge" className="size-3.5" aria-hidden />
        {busy ? "Merging…" : MERGE_METHOD_LABEL[primary]}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!mergeable || busy}>
          <Button size="sm" className="h-7 rounded-l-none border-l border-white/25 bg-green-600 px-1.5 text-white hover:bg-green-600/90" aria-label="Choose merge method">
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {methods.map((method) => (
            <DropdownMenuItem key={method} onSelect={() => merge(method)}>
              {MERGE_METHOD_LABEL[method]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PullMenu({ pull, threadId, onRefresh, onOpenList }: { pull: PullDetail; threadId: string; onRefresh: () => void; onOpenList: () => void }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label="Pull request actions">
          <Icon name="MoreHorizontal" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => navigate.openUrl(pull.url)}>Open on GitHub</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(pull.url).then(
              () => toast.success("Link copied"),
              () => toast.error("Could not copy the link"),
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRefresh}>Refresh</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            rpc
              .call("unlinkPullRequest", { threadId, repo: pull.repo, number: pull.number })
              .then(() => {
                toast.success(`Unlinked ${pull.repo}#${pull.number}`);
                onOpenList();
              })
              .catch((error: unknown) => toast.error(errorText(error)));
          }}
        >
          Unlink from this thread
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TitleRow({ pull, onRenamed }: { pull: PullDetail; onRenamed: () => void }) {
  const rpc = useRpc<Contract>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pull.title);
  const [saving, setSaving] = useState(false);

  const save = () => {
    const title = draft.trim();
    if (title === "" || title === pull.title) {
      setEditing(false);
      setDraft(pull.title);
      return;
    }
    setSaving(true);
    rpc
      .call("setPullTitle", { repo: pull.repo, number: pull.number, title })
      .then(() => {
        toast.success("Title updated");
        setEditing(false);
        onRenamed();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex items-center gap-1.5">
      {editing ? (
        <Input
          value={draft}
          autoFocus
          disabled={saving}
          aria-label="Pull request title"
          className="h-8 text-sm font-semibold"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") {
              setEditing(false);
              setDraft(pull.title);
            }
          }}
          onBlur={() => {
            if (!saving) {
              setEditing(false);
              setDraft(pull.title);
            }
          }}
        />
      ) : (
        <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug text-foreground">
          {pull.title} <span className="font-normal text-muted-foreground">#{pull.number}</span>
        </h2>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 text-muted-foreground"
        aria-label="Copy pull request link"
        onClick={() => {
          navigator.clipboard.writeText(pull.url).then(
            () => toast.success("Link copied"),
            () => toast.error("Could not copy the link"),
          );
        }}
      >
        <Icon name="Copy" aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 text-muted-foreground"
        aria-label="Edit pull request title"
        onClick={() => {
          setDraft(pull.title);
          setEditing(true);
        }}
      >
        <Icon name="Edit" aria-hidden />
      </Button>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function CheckIcon({ status }: { status: PullCheck["status"] }) {
  if (status === "success") return <Icon name="CircleCheck" className="size-3.5 text-green-600 dark:text-green-400" aria-hidden />;
  if (status === "failure") return <Icon name="CircleX" className="size-3.5 text-red-600 dark:text-red-400" aria-hidden />;
  if (status === "pending") return <Icon name="Spinner" className="size-3.5 animate-pulse text-yellow-600 dark:text-yellow-400" aria-hidden />;
  return <Icon name="Circle" className="size-3.5 text-muted-foreground" aria-hidden />;
}

function checksLabel(checks: PullCheck[]): { text: string; failing: boolean; pending: boolean } {
  const failing = checks.filter((check) => check.status === "failure").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passing = checks.filter((check) => check.status === "success" || check.status === "neutral").length;
  if (failing > 0) return { text: `${failing}/${checks.length} checks failing`, failing: true, pending: pending > 0 };
  if (pending > 0) return { text: `${passing}/${checks.length} checks passed, ${pending} running`, failing: false, pending: true };
  return { text: `All Checks Passed ${passing}/${checks.length}`, failing: false, pending: false };
}

function ChecksTab({ checks }: { checks: PullCheck[] }) {
  if (checks.length === 0) return <EmptyState message="No checks reported for this pull request." />;
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {checks.map((check, index) => (
        <div key={`${check.name}-${index}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <CheckIcon status={check.status} />
          <span className="min-w-0 flex-1 truncate text-foreground">{check.name}</span>
          {check.durationSeconds !== null ? <span className="shrink-0 text-muted-foreground">{formatDuration(check.durationSeconds)}</span> : null}
          {check.url.length > 0 ? (
            <UrlLink href={check.url} className="shrink-0 text-muted-foreground underline hover:text-foreground" {...externalLink}>
              details ↗
            </UrlLink>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CommitsTab({ pull }: { pull: PullDetail }) {
  if (pull.commits.length === 0) return <EmptyState message="No commits listed for this pull request." />;
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {pull.commits.map((commit) => (
        <div key={commit.sha} className="flex items-center gap-2 px-3 py-2 text-xs">
          {commit.url.length > 0 ? (
            <UrlLink href={commit.url} className="shrink-0 font-mono text-primary underline underline-offset-2" {...externalLink}>
              {commit.sha.slice(0, 7)}
            </UrlLink>
          ) : (
            <span className="shrink-0 font-mono text-muted-foreground">{commit.sha.slice(0, 7)}</span>
          )}
          <span className="min-w-0 flex-1 truncate text-foreground" title={commit.message}>
            {commit.message}
          </span>
          {commit.author.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <Avatar login={commit.author} size="size-4" />
              <span className="max-w-28 truncate">{commit.author}</span>
            </span>
          ) : null}
          <span className="shrink-0 text-muted-foreground">{relativeTime(commit.committedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function viewedStorageKey(repo: string, number: number): string {
  return `github-prs:viewed:${repo}#${number}`;
}

function readViewed(repo: string, number: number): Set<string> {
  try {
    const raw = window.localStorage.getItem(viewedStorageKey(repo, number));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function FileSection({
  pull,
  file,
  environmentId,
  open,
  viewed,
  onToggleOpen,
  onToggleViewed,
}: {
  pull: PullDetail;
  file: PullFile;
  environmentId: string | null;
  open: boolean;
  viewed: boolean;
  onToggleOpen: () => void;
  onToggleViewed: (viewed: boolean) => void;
}) {
  const rpc = useRpc<Contract>();
  const [contents, setContents] = useState<ExperimentalDiffFullFileContents | null>(null);
  const [contentsLoaded, setContentsLoaded] = useState(false);

  useEffect(() => {
    if (!open || file.patch === null || contentsLoaded) return;
    let live = true;
    const oldPath = file.status === "added" ? null : (file.previousPath ?? file.path);
    const newPath = file.status === "removed" ? null : file.path;
    rpc
      .call("getPullFile", { repo: pull.repo, oldPath, oldRef: pull.baseRefOid, newPath, newRef: pull.headRefOid })
      .then((result) => {
        if (!live) return;
        setContentsLoaded(true);
        if (result.old === null && result.new === null) return;
        setContents({
          old: result.old ?? { path: file.previousPath ?? file.path, content: "" },
          new: result.new ?? { path: file.path, content: "" },
        });
      })
      .catch(() => {
        if (live) setContentsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [rpc, open, file, pull.repo, pull.baseRefOid, pull.headRefOid, contentsLoaded]);

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", viewed && "opacity-60")}>
      <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent/50">
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground"
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path} diff`}
          onClick={onToggleOpen}
        >
          {open ? "▾" : "▸"}
        </button>
        <Icon name="FileDiff" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {environmentId === null || file.status === "removed" ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={file.previousPath !== null ? `${file.previousPath} → ${file.path}` : file.path}>
            {file.path}
          </span>
        ) : (
          <FileLink
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:underline"
            target={{ kind: "workspace", environmentId, path: file.path }}
          >
            {file.path}
          </FileLink>
        )}
        {file.status !== "modified" ? (
          <Badge variant="secondary" className="shrink-0 font-normal text-muted-foreground">
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">+{file.additions}</span>
        <span className="shrink-0 text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>
        <label className="flex shrink-0 items-center gap-1.5 pl-1 text-xs text-muted-foreground" title="Mark file as viewed">
          <input
            type="checkbox"
            checked={viewed}
            aria-label={`Mark ${file.path} as viewed`}
            onChange={(event) => onToggleViewed(event.target.checked)}
            className="size-3.5 accent-current"
          />
        </label>
      </div>
      {open ? (
        file.patch !== null ? (
          <div className="border-t border-border">
            <Diff patch={file.patch} path={file.path} experimental_fullFileContents={contents ?? undefined} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Diff too large to inline —{" "}
            <UrlLink href={`${pull.url}/files`} className="underline" {...externalLink}>
              view on GitHub ↗
            </UrlLink>
          </p>
        )
      ) : null}
    </div>
  );
}

function ChangesTab({ pull, environmentId }: { pull: PullDetail; environmentId: string | null }) {
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [viewed, setViewed] = useState<Set<string>>(() => readViewed(pull.repo, pull.number));

  const isOpen = (path: string) => openMap[path] ?? !viewed.has(path);
  const allOpen = pull.files.length > 0 && pull.files.every((file) => isOpen(file.path));

  const toggleViewed = (file: PullFile, next: boolean) => {
    setViewed((current) => {
      const updated = new Set(current);
      if (next) updated.add(file.path);
      else updated.delete(file.path);
      try {
        window.localStorage.setItem(viewedStorageKey(pull.repo, pull.number), JSON.stringify([...updated]));
      } catch {}
      return updated;
    });
    setOpenMap((current) => ({ ...current, [file.path]: !next }));
  };

  if (pull.files.length === 0) return <EmptyState message="No changed files listed for this pull request." />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {pull.changedFiles} File{pull.changedFiles === 1 ? "" : "s"} Changed
        </span>
        <span className="text-green-600 dark:text-green-400">+{pull.additions}</span>
        <span className="text-red-600 dark:text-red-400">−{pull.deletions}</span>
        <button
          type="button"
          className="ml-auto rounded p-1 hover:bg-accent hover:text-foreground"
          aria-label={allOpen ? "Collapse all file diffs" : "Expand all file diffs"}
          onClick={() => setOpenMap(Object.fromEntries(pull.files.map((file) => [file.path, !allOpen])))}
        >
          <Icon name={allOpen ? "ChevronsUp" : "ChevronsDown"} className="size-3.5" aria-hidden />
        </button>
      </div>
      {pull.files.map((file) => (
        <FileSection
          key={file.path}
          pull={pull}
          file={file}
          environmentId={environmentId}
          open={isOpen(file.path)}
          viewed={viewed.has(file.path)}
          onToggleOpen={() => setOpenMap((current) => ({ ...current, [file.path]: !isOpen(file.path) }))}
          onToggleViewed={(next) => toggleViewed(file, next)}
        />
      ))}
    </div>
  );
}

function DescriptionTab({ pull }: { pull: PullDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Avatar login={pull.author} />
          <span className="font-medium text-foreground">{pull.author}</span>
          opened this pull request · updated {relativeTime(pull.updatedAt)}
        </div>
        <div className="p-4">
          {pull.body.length > 0 || pull.bodyHtml !== null ? (
            <GithubBody body={pull.body} bodyHtml={pull.bodyHtml} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">(no description)</p>
          )}
        </div>
      </div>
      <PullTimeline pull={pull} />
    </div>
  );
}

function ReviewsTab({ pull }: { pull: PullDetail }) {
  if (pull.reviews.length === 0 && pull.reviewThreads.length === 0 && pull.reviewRequests.length === 0) {
    return <EmptyState message="No reviews yet." />;
  }
  return (
    <div className="flex flex-col gap-2">
      {pull.reviewRequests.length > 0 ? (
        <p className="text-xs text-muted-foreground">Review requested from {pull.reviewRequests.join(", ")}</p>
      ) : null}
      {pull.reviews.map((review, index) => (
        <div key={index} className="rounded-lg border border-border bg-card p-3">
          <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar login={review.author} />
            <span className="font-medium text-foreground">{review.author}</span>
            <span className={cn("font-medium", reviewStateClass(review.state))}>{REVIEW_STATE_LABELS[review.state] ?? review.state.toLowerCase()}</span>·{" "}
            {relativeTime(review.createdAt)}
          </p>
          {review.body.length > 0 || review.bodyHtml !== null ? <GithubBody body={review.body} bodyHtml={review.bodyHtml} className="text-sm" /> : null}
        </div>
      ))}
      {pull.reviewThreads.map((thread, index) => (
        <ReviewThreadCard key={index} thread={thread} />
      ))}
    </div>
  );
}

type TabId = "changes" | "description" | "commits" | "checks" | "reviews";

export function ThreadPullView({
  repo,
  number,
  threadId,
  environmentId,
  onOpenList,
}: {
  repo: string;
  number: number;
  threadId: string;
  environmentId: string | null;
  onOpenList: () => void;
}) {
  const rpc = useRpc<Contract>();
  const [pull, setPull] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("changes");

  const load = useCallback(() => {
    rpc.call("getPull", { repo, number }).then(
      (result) => {
        setPull(result.pull);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setPull(null);
    load();
  }, [load]);

  if (error !== null) return <EmptyState message={error} />;
  if (pull === null) return <DetailSkeleton />;

  const checkSummary = checksLabel(pull.checks);
  const tabs: Array<{ id: TabId; label: React.ReactNode }> = [
    { id: "changes", label: `Changes ${pull.changedFiles}` },
    { id: "description", label: "Description" },
    { id: "commits", label: `Commits ${pull.commits.length}` },
    {
      id: "checks",
      label:
        pull.checks.length === 0 ? (
          "Checks"
        ) : (
          <span className={cn("inline-flex items-center gap-1", checkSummary.failing && "text-red-600 dark:text-red-400")}>
            <CheckIcon status={checkSummary.failing ? "failure" : checkSummary.pending ? "pending" : "success"} />
            {checkSummary.text}
          </span>
        ),
    },
    { id: "reviews", label: "Reviews" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <StatePill state={pull.state} />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={`${pull.headRefName} → ${pull.baseRefName}`}>
          {pull.headRefName} → {pull.baseRefName}
        </span>
        <span className="flex-1" />
        <PullMenu pull={pull} threadId={threadId} onRefresh={load} onOpenList={onOpenList} />
        <UrlLink
          href={pull.url}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Open on GitHub"
          {...externalLink}
        >
          <Icon name="Github" aria-hidden />
        </UrlLink>
        <MergeButton pull={pull} onMerged={load} />
      </div>

      <TitleRow pull={pull} onRenamed={load} />

      <div role="tablist" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              "-mb-px border-b-2 pb-1.5 text-xs font-medium",
              tab === entry.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "changes" ? <ChangesTab pull={pull} environmentId={environmentId} /> : null}
      {tab === "description" ? <DescriptionTab pull={pull} /> : null}
      {tab === "commits" ? <CommitsTab pull={pull} /> : null}
      {tab === "checks" ? <ChecksTab checks={pull.checks} /> : null}
      {tab === "reviews" ? <ReviewsTab pull={pull} /> : null}
    </div>
  );
}
