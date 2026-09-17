// The "PRs" thread panel tab: the thread's linked pull requests, and the
// Cursor-style view of one of them.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, type PluginRpcResult, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { PULL_REQUESTS_CHANGED } from "../contract";
import { parsePullRequestUrl, pullRequestUrl, type PullRequestRef } from "../lib/pull-request-url";
import { EmptyState } from "./empty-state";
import { PullStateBadge } from "./pull-detail";
import { ThreadPullView } from "./pull-thread-view";
import { DetailSkeleton, errorText, relativeTime, type Contract } from "./shared";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export const PULL_PANEL_ACTION_ID = "pull";
/** Tab title for the linked-PR list; a PR tab is titled `PR #<n>` at open time. */
export const PULL_LIST_PANEL_TITLE = "PRs";
export const pullTabTitle = (number: number) => `PR #${number}`;

export type ThreadPullRequestList = PluginRpcResult<Contract["listPullRequests"]>;
type Linked = ThreadPullRequestList["links"][number];

/** The `params` a viewer tab was opened with: `{ url }` names one PR. */
export function pullRequestFromParams(params: PluginThreadPanelProps["params"]): PullRequestRef | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.url === "string") return parsePullRequestUrl(record.url);
  if (typeof record.repo === "string" && typeof record.number === "number") {
    return parsePullRequestUrl(pullRequestUrl({ repo: record.repo, number: record.number }));
  }
  return null;
}

function changedPayloadThread(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId = (payload as Record<string, unknown>).threadId;
  return typeof threadId === "string" ? threadId : null;
}

/**
 * Linked PRs for a thread, refreshed on `pull-requests-changed` and after a
 * realtime reconnection (signals are ephemeral, so a gap may have hidden one).
 */
export function useThreadPullRequests(threadId: string): { list: ThreadPullRequestList | null; error: string | null; refetch: () => void } {
  const rpc = useRpc<Contract>();
  const [list, setList] = useState<ThreadPullRequestList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refetch = useCallback(() => {
    const id = (request.current += 1);
    rpc.call("listPullRequests", { threadId }).then(
      (result) => {
        if (id !== request.current) return;
        setList(result);
        setError(null);
      },
      (cause: unknown) => {
        if (id !== request.current) return;
        setError(errorText(cause));
      },
    );
  }, [rpc, threadId]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(PULL_REQUESTS_CHANGED, (payload) => {
    const changed = changedPayloadThread(payload);
    if (changed === null || changed === threadId) refetch();
  });
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected" && !wasConnected.current) refetch();
    wasConnected.current = connection === "connected";
  }, [connection, refetch]);
  return { list, error, refetch };
}

const SOURCE_LABEL: Record<Linked["source"], string> = {
  branch: "thread branch",
  agent: "linked by agent",
  user: "linked by you",
  spawn: "review thread",
};

/** Humanized `trigger` values; NULL on links written before attribution. */
const TRIGGER_LABEL: Record<NonNullable<Linked["trigger"]>, string> = {
  "thread-idle": "after a turn",
  "panel-action": "via Link branch PR",
  "agent-tool": "via agent tool",
  cli: "via CLI",
  spawn: "on spawn",
  user: "via panel",
};

function LinkedRow({ link, onOpen, onUnlink }: { link: Linked; onOpen: () => void; onUnlink: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50">
      <button type="button" className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left" onClick={onOpen} aria-label={`Open ${link.repo}#${link.number}`}>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{link.number}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{link.title ?? link.url}</span>
          {link.state !== null ? <PullStateBadge state={link.state} /> : null}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="truncate">{link.repo}</span>
          <span>·</span>
          <span className="shrink-0">{SOURCE_LABEL[link.source]}</span>
          {link.trigger !== null ? (
            <>
              <span>·</span>
              <span className="shrink-0">{TRIGGER_LABEL[link.trigger] ?? link.trigger}</span>
            </>
          ) : null}
          <span>·</span>
          <span className="shrink-0">{relativeTime(link.linkedAt)}</span>
        </span>
      </button>
      <Button size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" aria-label={`Unlink ${link.repo}#${link.number}`} onClick={onUnlink}>
        ✕
      </Button>
    </div>
  );
}

function LinkForm({ threadId, onLinked }: { threadId: string; onLinked: () => void }) {
  const rpc = useRpc<Contract>();
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = () => {
    const value = reference.trim();
    if (value === "" || busy) return;
    setBusy(true);
    rpc
      .call("linkPullRequest", { threadId, reference: value })
      .then((result) => {
        setReference("");
        toast.success(result.created ? `Linked ${result.link.repo}#${result.link.number}` : `${result.link.repo}#${result.link.number} was already linked`);
        onLinked();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        placeholder="Link a PR: URL, owner/repo#123, or #123"
        aria-label="Pull request to link"
        className="h-8 text-xs"
      />
      <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0" disabled={busy || reference.trim() === ""}>
        {busy ? "Linking…" : "Link"}
      </Button>
    </form>
  );
}

export function PullRequestsPanel(props: PluginThreadPanelProps) {
  return <PullRequestsPanelContent key={props.threadId} {...props} />;
}

function PullRequestsPanelContent({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const { list, error, refetch } = useThreadPullRequests(threadId);
  const requested = pullRequestFromParams(params);
  const [linkingBranch, setLinkingBranch] = useState(false);

  const openPullTab = useCallback(
    (ref: PullRequestRef) => navigate.openThreadPanel({ actionId: PULL_PANEL_ACTION_ID, title: pullTabTitle(ref.number), params: { url: pullRequestUrl(ref) } }),
    [navigate],
  );
  const openListTab = useCallback(() => navigate.openThreadPanel({ actionId: PULL_PANEL_ACTION_ID, title: PULL_LIST_PANEL_TITLE }), [navigate]);

  const unlink = (link: Linked) => {
    rpc
      .call("unlinkPullRequest", { threadId, repo: link.repo, number: link.number })
      .then(() => {
        toast.success(`Unlinked ${link.repo}#${link.number}`);
        refetch();
      })
      .catch((cause: unknown) => toast.error(errorText(cause)));
  };

  const linkBranchPullRequest = () => {
    if (linkingBranch) return;
    setLinkingBranch(true);
    rpc
      .call("linkBranchPullRequest", { threadId })
      .then((result) => {
        if (result.link === null) {
          toast.info("No pull request found for this thread's branch");
        } else {
          toast.success(`Linked ${result.link.repo}#${result.link.number}`);
        }
        refetch();
      })
      .catch((cause: unknown) => toast.error(errorText(cause)))
      .finally(() => setLinkingBranch(false));
  };

  if (requested !== null) {
    return <ThreadPullView repo={requested.repo} number={requested.number} threadId={threadId} environmentId={list?.environmentId ?? null} onOpenList={openListTab} />;
  }
  if (error !== null) return <EmptyState message={error} />;
  if (list === null) return <DetailSkeleton />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Linked pull requests · {list.links.length}</h2>
        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={linkingBranch}
            onClick={linkBranchPullRequest}
          >
            {linkingBranch ? "Linking…" : "Link branch PR"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={refetch}>
            Refresh
          </Button>
        </span>
      </div>
      {list.links.length === 0 ? (
        <EmptyState message="No pull request is linked to this thread yet. On its own worktree the PR of the thread's branch links itself once it exists; on a shared checkout use Link branch PR; agents link the ones they create or discuss; or paste one below." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="divide-y divide-border">
            {list.links.map((link) => (
              <LinkedRow key={`${link.repo}#${link.number}`} link={link} onOpen={() => openPullTab(link)} onUnlink={() => unlink(link)} />
            ))}
          </div>
        </div>
      )}
      <LinkForm threadId={threadId} onLinked={refetch} />
    </div>
  );
}
