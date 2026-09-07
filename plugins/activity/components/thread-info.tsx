import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect, useState, type ReactNode } from "react";
import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { STATUS_LABEL, threadTitle, type Status } from "../lib/status";
import { usePortalScopeProps } from "../lib/portal-scope";
import { PullRequestIcon, pullRequestSummary } from "./pull-request";
import { StatusIcon } from "./status-icon";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[var(--subtle-foreground)]">{label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

export function ThreadInfo({
  thread,
  status,
  project,
  provider,
  parent,
  pullRequest,
  disabled,
  children,
}: {
  thread: PluginSidebarThread;
  status: Status;
  project: string;
  provider: string;
  parent?: string;
  pullRequest: PluginSidebarPullRequest | null;
  disabled: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const scope = usePortalScopeProps();
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const title = threadTitle(thread);
  const branch = thread.environment?.branchName;
  const workspace = thread.environment
    ? thread.environment.workspaceDisplayKind === "other"
      ? "Workspace"
      : "Worktree"
    : null;
  const environment = thread.environment?.name;
  const dates = (["Created", "Updated"] as const).map((label) => {
    const date = new Date(
      label === "Created" ? thread.createdAt : thread.updatedAt,
    );
    return {
      label,
      iso: date.toISOString(),
      text: date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    };
  });
  const description = [
    title,
    thread.isArchived ? "Archived" : STATUS_LABEL[status],
    provider,
    project,
    branch,
    thread.host?.name,
    workspace,
    environment,
    thread.isPinned ? "Pinned" : null,
    parent ? `Child of ${parent}` : null,
    pullRequest
      ? `${pullRequestSummary(pullRequest)}: ${pullRequest.title}`
      : null,
    ...dates.map((date) => `${date.label}: ${date.text}`),
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
      <Tooltip.Root
        open={open && !disabled}
        onOpenChange={(value) => setOpen(value && !disabled)}
      >
        <Tooltip.Trigger asChild onClickCapture={() => setOpen(false)}>
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            {...scope}
            data-thread-info={thread.id}
            side="right"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            aria-label={description}
            className="z-50 w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
          >
            <p className="m-0 break-words text-[14px] font-semibold leading-5 [overflow-wrap:anywhere]">
              {title}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--subtle-foreground)]">
              <span className="flex items-center gap-1.5 text-popover-foreground">
                <StatusIcon status={status} size="small" />
                {thread.isArchived ? "Archived" : STATUS_LABEL[status]}
              </span>
              <span aria-hidden="true">·</span>
              <span>{provider}</span>
              {thread.isPinned && (
                <span className="ml-auto rounded bg-accent px-1.5 leading-4 text-accent-foreground">
                  Pinned
                </span>
              )}
            </div>
            <dl className="mb-0 mt-4 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-[18px]">
              <Detail label="Project">{project}</Detail>
              {branch && <Detail label="Branch">{branch}</Detail>}
              {thread.host && (
                <Detail label="Machine">{thread.host.name}</Detail>
              )}
              {workspace && (
                <Detail label="Workspace">
                  {workspace}
                  {environment && environment !== workspace
                    ? ` · ${environment}`
                    : ""}
                </Detail>
              )}
              {parent && <Detail label="Parent">{parent}</Detail>}
              {pullRequest && (
                <Detail label="PR">
                  <span className="flex items-start gap-1.5">
                    <PullRequestIcon
                      pullRequest={pullRequest}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="tabular-nums">#{pullRequest.number}</span>{" "}
                      {pullRequest.title}
                    </span>
                  </span>
                </Detail>
              )}
            </dl>
            <dl className="mb-0 mt-3 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-2 text-xs leading-4 text-[var(--subtle-foreground)]">
              {dates.map((date) => (
                <Detail key={date.label} label={date.label}>
                  <time className="tabular-nums" dateTime={date.iso}>
                    {date.text}
                  </time>
                </Detail>
              ))}
            </dl>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
