import { useDraggable, useDroppable } from "@dnd-kit/core";
import * as Menu from "@radix-ui/react-context-menu";
import * as Popover from "@radix-ui/react-popover";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  useRpc,
  useBbNavigate,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  type ExperimentalProviderIconProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  STATUS_LABEL,
  threadTitle,
  type Status,
  type SortBy,
} from "../lib/status";
import type { archiveContract } from "../lib/archive-contract";
import type { libraryContract } from "../lib/library-contract";
import type { snoozeContract } from "../lib/snooze-contract";
import { formatWakeTime, type SnoozePreset } from "../lib/snooze-presets";
import {
  SnoozePopoverContent,
  snoozeChoices,
  type SnoozePickerMode,
} from "./snooze-picker";
import { menuItemClass } from "./menus";
import { usePortalScopeProps } from "../lib/portal-scope";
import { relativeAge } from "../lib/time";
import { PullRequestIcon, pullRequestSummary } from "./pull-request";
import { StatusIcon } from "./status-icon";
import { ArchiveIcon } from "./archive-icon";
import { ThreadInfo } from "./thread-info";
import { HostIcon } from "../lib/host-icon";
import { getThreadRowDroppableId } from "../lib/thread-dnd";
import type { ThreadNestTargetState } from "../lib/thread-dnd";
import { useThreadDndState } from "../lib/thread-dnd-context";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { useFinePointer } from "../lib/use-fine-pointer";
import { projectHueStep } from "../lib/project-hue";

/** The provider record `experimental_ProviderIcon` reads artwork from. */
export type ProviderIconRecord = ExperimentalProviderIconProps["provider"];

// Palette roles with BB fallbacks (see plugins/theme/README.md).
// Child arrows stay in the subtle text color: a colored arrow on every nested
// row competes with the status markers.
const ARROW_COLOR_CLASS = "text-[var(--subtle-foreground)]";

// Overflowing text fades out at the right edge instead of showing an ellipsis.
export const fadeClass =
  "overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%_-_1.25rem),transparent)]";

// Ring language mirrors bb's sidebar nest states (ThreadRow.tsx, MIT).
const NEST_TARGET_STATE_CLASS: Record<ThreadNestTargetState, string> = {
  valid: "bg-accent text-accent-foreground ring-1 ring-inset ring-ring",
  blocked: "ring-1 ring-inset ring-destructive/60",
  unchanged: "ring-1 ring-inset ring-border",
};

export interface ThreadRowNesting {
  candidates: readonly { id: string; title: string }[];
  onSetParent: (parentThreadId: string | null) => void;
}

export interface ThreadRowSnooze {
  /** Wake time while the thread sleeps; null when it is not snoozed. */
  until: number | null;
  /** The snooze ended and the thread has not been opened since. */
  woke: boolean;
  presets: readonly SnoozePreset[];
}

export function ThreadRow({
  thread,
  status,
  project,
  showProject,
  provider,
  providerRecord,
  parent,
  depth = 0,
  children,
  active,
  now,
  sortBy,
  singleLine = false,
  libraryAction,
  nesting,
  snooze,
  onNavigate,
  onError,
}: {
  thread: PluginSidebarThread;
  status: Status;
  project: string;
  /** False under a project header, where the name would repeat. */
  showProject: boolean;
  /**
   * True renders only the title line with the timestamp: No project rows have
   * no project, branch, or pull request metadata worth a second line.
   */
  singleLine?: boolean;
  provider: string;
  /**
   * The host's provider record for the glyph left of the title; an id-only
   * record still resolves plugin-registered artwork and the host fallback.
   */
  providerRecord?: ProviderIconRecord;
  parent?: string;
  depth?: number;
  children?: ReactNode;
  active: boolean;
  now: number;
  sortBy: SortBy;
  /**
   * "save" offers Save to Library, "remove" offers Remove from Library, and
   * null hides the entry — e.g. a child shown in the library only through a
   * saved ancestor.
   */
  libraryAction: "save" | "remove" | null;
  nesting?: ThreadRowNesting;
  /** Snooze state and presets; omitted rows (archives) offer no snooze. */
  snooze?: ThreadRowSnooze;
  onNavigate: () => void;
  onError: (error: unknown) => void;
}) {
  const rpc = useRpc<typeof archiveContract>();
  const libraryRpc = useRpc<typeof libraryContract>();
  const snoozeRpc = useRpc<typeof snoozeContract>();
  const navigate = useBbNavigate();
  const nested = depth > 0;
  const actions = experimental_useSidebarThreadActions();
  const scope = usePortalScopeProps();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuOpenedEditor = useRef(false);
  // The presets popover, opened from the hover control or the menu's Custom…
  // entry; the menu's focus return is skipped while it opens.
  const [picker, setPicker] = useState<SnoozePickerMode | null>(null);
  const menuOpenedPicker = useRef(false);
  const rowRef = useRef<HTMLAnchorElement>(null);
  const restoreRowFocus = useRef(false);
  const closeEditor = () => {
    restoreRowFocus.current = true;
    setEditing(false);
  };
  useLayoutEffect(() => {
    if (!editing && restoreRowFocus.current) {
      restoreRowFocus.current = false;
      rowRef.current?.focus();
      // BB can restore composer focus while handling the same Escape event.
      // Restore the row after that event and its menu cleanup have completed.
      const frame = requestAnimationFrame(() => rowRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [editing]);
  const longPress = useLongPressMenu(menuOpen);
  // Desktop hover swaps the status marker for an archive control. Touch
  // viewports keep the marker and reach actions through the long press.
  const finePointer = useFinePointer();
  const [hovered, setHovered] = useState(false);
  const dnd = useThreadDndState();
  const dndEnabled = dnd !== null && !thread.isArchived;
  const draggable = useDraggable({ id: thread.id, disabled: !dndEnabled });
  const droppable = useDroppable({
    id: getThreadRowDroppableId(thread.id),
    disabled: !dndEnabled,
  });
  const nestTargetState =
    dnd?.nestTarget?.threadId === thread.id ? dnd.nestTarget.state : null;
  const setRowRef = (node: HTMLAnchorElement | null) => {
    rowRef.current = node;
    draggable.setNodeRef(node);
    draggable.setActivatorNodeRef(node);
    droppable.setNodeRef(node);
  };
  // A long press can produce a click on release. Keep keyboard and BB shortcut
  // clicks (detail === 0) available, but require a fresh pointer press otherwise.
  const suppressClick = useRef(false);
  const { splitProps, isAvailable } = experimental_useSidebarThreadSplit(
    thread.id,
  );
  const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);
  const title = threadTitle(thread);
  const branch = thread.environment?.branchName;
  // The project accent only appears where the project name does, so a row
  // under its own project header stays plain.
  const accentStep = showProject && !singleLine ? projectHueStep(project) : null;
  // The controls stay while the popover is open, since the pointer leaves
  // the row to reach it.
  const showHoverControls =
    finePointer && (hovered || picker !== null) && !menuOpen;
  const sleeping = snooze !== undefined && snooze.until !== null;
  const canSnooze = snooze !== undefined && !thread.isArchived;
  const snoozeUntil = (until: number) => {
    void snoozeRpc.call("snooze", { threadId: thread.id, until }).catch(onError);
  };
  const unsnooze = () => {
    void snoozeRpc.call("unsnooze", { threadId: thread.id }).catch(onError);
  };
  const toggleArchived = () => {
    void rpc
      .call(thread.isArchived ? "restoreThread" : "archiveTree", {
        threadId: thread.id,
      })
      .catch(onError);
  };
  const openPullRequest = () => {
    if (!pullRequest) return;
    // BB's browser preference (in-app browser or external); a host without
    // the URL opener gets a plain new tab.
    if (!navigate.openUrl(pullRequest.url))
      window.open(pullRequest.url, "_blank", "noopener,noreferrer");
  };
  const timestamp = sortBy === "created" ? thread.createdAt : thread.updatedAt;
  const age = (
    <time
      dateTime={new Date(timestamp).toISOString()}
      aria-label={`${sortBy === "created" ? "Created" : "Updated"} ${new Date(timestamp).toLocaleString()}`}
      className={`shrink-0 tabular-nums ${singleLine ? "text-xs leading-4 text-[var(--subtle-foreground)]" : ""}`}
    >
      {relativeAge(timestamp, now)}
    </time>
  );
  const open = (split = false) => {
    if (thread.isArchived) navigate.toThread(thread.id);
    else actions.open(thread.id, { split });
    // Opening a woke thread clears its attention signal.
    if (snooze?.woke)
      void snoozeRpc
        .call("acknowledge", { threadId: thread.id })
        .catch(onError);
    onNavigate();
  };
  // A sleeping row shows when it wakes instead of its age.
  const stamp =
    sleeping && snooze.until !== null ? (
      <time
        dateTime={new Date(snooze.until).toISOString()}
        data-thread-wake=""
        aria-label={`Wakes ${new Date(snooze.until).toLocaleString()}`}
        className={`flex shrink-0 items-center gap-1 tabular-nums ${singleLine ? "text-xs leading-4 text-[var(--subtle-foreground)]" : ""}`}
      >
        <HostIcon name="Clock" fallback="Circle" className="size-3 shrink-0" />
        {formatWakeTime(snooze.until, now)}
      </time>
    ) : (
      age
    );
  return (
    <li data-thread-node={thread.id} className="min-w-0">
      <Popover.Root
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
      >
      <Popover.Anchor asChild>
      <div
        data-thread-status={thread.isArchived ? "archived" : status}
        data-thread-snoozed={sleeping ? "" : undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={`group relative flex min-w-0 items-center rounded-md ${active ? "bg-accent text-accent-foreground" : `${status === "attention" && !thread.isArchived ? "bg-[var(--surface-attention)]" : ""} hover:bg-accent/60`} ${nestTargetState ? NEST_TARGET_STATE_CLASS[nestTargetState] : ""} ${draggable.isDragging ? "opacity-50" : ""}`}
      >
        {accentStep !== null && (
          <span
            aria-hidden="true"
            data-project-accent=""
            data-project-hue={accentStep}
            className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-current"
          />
        )}
        {editing ? (
          <form
            aria-label="Rename thread"
            className="flex min-w-0 flex-1 flex-wrap gap-2 p-2"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!savingRef.current) closeEditor();
              }
            }}
            onSubmit={async (event) => {
              event.preventDefault();
              const nextTitle = draftTitle.trim();
              if (!nextTitle || savingRef.current) return;
              if (nextTitle === title) {
                closeEditor();
                return;
              }
              savingRef.current = true;
              setSaving(true);
              setRenameError(null);
              renameInputRef.current?.focus();
              try {
                await actions.rename(thread.id, nextTitle);
                closeEditor();
              } catch {
                setRenameError("Could not rename the thread. Try again.");
              } finally {
                savingRef.current = false;
                setSaving(false);
              }
            }}
          >
            <input
              ref={renameInputRef}
              aria-label="Thread name"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              value={draftTitle}
              readOnly={saving}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button type="submit" disabled={saving || !draftTitle.trim()} className="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={saving} onClick={closeEditor} className="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              Cancel
            </button>
            {renameError && <p role="alert" className="w-full text-sm text-destructive">{renameError}</p>}
          </form>
        ) : <Menu.Root
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) suppressClick.current = true;
          }}
        >
          <ThreadInfo
            thread={thread}
            status={status}
            project={project}
            provider={provider}
            parent={parent}
            pullRequest={pullRequest}
            disabled={menuOpen}
          >
            <Menu.Trigger asChild>
              <a
                ref={setRowRef}
                {...(dndEnabled ? draggable.listeners : {})}
                {...(dndEnabled ? { "aria-roledescription": "draggable" } : {})}
                {...(!thread.isArchived ? splitProps : {})}
                {...longPress}
                href={`/projects/${encodeURIComponent(thread.projectId)}/threads/${encodeURIComponent(thread.id)}`}
                draggable={false}
                data-sidebar-thread-shortcut-target=""
                data-sidebar-thread-id={thread.id}
                aria-current={active ? "page" : undefined}
                aria-haspopup="menu"
                onPointerDown={(event) => {
                  suppressClick.current = false;
                  longPress.onPointerDown(event);
                  // Touch belongs to scrolling/long press, not drag-to-split.
                  if (
                    !thread.isArchived &&
                    event.pointerType !== "touch" &&
                    event.button === 0
                  ) {
                    splitProps.onPointerDown?.(event);
                  }
                }}
                onKeyDown={(event) => {
                  suppressClick.current = false;
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  ) {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    event.currentTarget.dispatchEvent(
                      new MouseEvent("contextmenu", {
                        bubbles: true,
                        cancelable: true,
                        clientX: bounds.left + 16,
                        clientY: bounds.bottom,
                      }),
                    );
                  }
                }}
                onClick={(event) => {
                  event.preventDefault();
                  if (suppressClick.current && event.detail !== 0) return;
                  if (dnd?.consumeClickSuppression()) return;
                  open(event.metaKey || event.ctrlKey);
                }}
                className={`flex min-w-0 flex-1 select-none flex-col rounded-md ${singleLine ? "py-1.5" : "py-2"} pr-2 text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                style={{
                  paddingLeft: `${nested ? 1.75 + (depth - 1) * 1.5 : 0.5}rem`,
                }}
              >
                {nested && (
                  <svg
                    data-child-arrow=""
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`absolute ${singleLine ? "top-2.5" : "top-3"} size-3 ${ARROW_COLOR_CLASS}`}
                    style={{ left: `${0.5 + (depth - 1) * 1.5}rem` }}
                  >
                    <path d="M3 3v5a2 2 0 0 0 2 2h8m-3-3 3 3-3 3" />
                  </svg>
                )}
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    data-thread-provider={thread.providerId}
                    className="flex size-3.5 shrink-0 items-center justify-center text-[var(--subtle-foreground)]"
                  >
                    <ProviderIcon
                      providerKind="agent"
                      provider={providerRecord ?? { id: thread.providerId }}
                      fallback="Code"
                      aria-hidden
                      className="size-3.5"
                    />
                  </span>
                  <span
                    className={`min-w-0 flex-1 text-sm leading-5 ${fadeClass} ${thread.isUnread || active ? "font-semibold" : "font-medium"}`}
                  >
                    {title}
                  </span>
                  {showHoverControls && canSnooze && (
                    <span
                      role="button"
                      tabIndex={-1}
                      data-thread-snooze-action={sleeping ? "unsnooze" : "snooze"}
                      aria-label={sleeping ? "Unsnooze thread" : "Snooze thread"}
                      aria-haspopup={sleeping ? undefined : "dialog"}
                      aria-expanded={sleeping ? undefined : picker !== null}
                      title={sleeping ? "Unsnooze" : "Snooze"}
                      // Keep the press away from drag, split, and long press.
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (sleeping) unsnooze();
                        else setPicker(picker ? null : "presets");
                      }}
                      className={`flex size-4 shrink-0 items-center justify-center rounded hover:bg-accent hover:text-foreground ${picker ? "bg-accent text-foreground" : "text-[var(--subtle-foreground)]"}`}
                    >
                      <HostIcon
                        name={sleeping ? "BellDot" : "Clock"}
                        fallback="Circle"
                        className="size-3.5"
                      />
                    </span>
                  )}
                  {showHoverControls ? (
                    <span
                      role="button"
                      tabIndex={-1}
                      data-thread-archive-action={thread.isArchived ? "unarchive" : "archive"}
                      aria-label={thread.isArchived ? "Unarchive thread" : "Archive thread"}
                      title={thread.isArchived ? "Unarchive" : "Archive"}
                      // Keep the press away from drag, split, and long press.
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleArchived();
                      }}
                      className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--subtle-foreground)] hover:bg-accent hover:text-foreground"
                    >
                      <HostIcon
                        name={thread.isArchived ? "ArchiveRestore" : "Archive"}
                        fallback="PackageReceive"
                        className="size-3.5"
                      />
                    </span>
                  ) : (thread.isArchived || status !== "done") && (
                    <span
                      role="img"
                      aria-label={thread.isArchived ? "Archived" : STATUS_LABEL[status]}
                      className="flex size-4 shrink-0 items-center justify-center"
                    >
                      {thread.isArchived ? <ArchiveIcon /> : status === "unread" ? (
                        <span
                          aria-hidden="true"
                          data-status-dot="unread"
                          className="size-1.5 rounded-full bg-[var(--bbp-file,var(--timeline-accent))]"
                        />
                      ) : (
                        <StatusIcon status={status} />
                      )}
                    </span>
                  )}
                  {singleLine && stamp}
                </span>
                {!singleLine && (
                  <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs leading-4 text-[var(--subtle-foreground)]">
                    <span
                      className={`flex min-w-0 flex-1 items-center gap-1 ${fadeClass}`}
                    >
                      {thread.parentThreadId && !nested && (
                        <span aria-hidden="true" className={ARROW_COLOR_CLASS}>
                          ↳
                        </span>
                      )}
                      {pullRequest && (
                        // The row itself is a link, so the chip is a link by
                        // role rather than a nested anchor.
                        <span
                          role="link"
                          tabIndex={0}
                          data-thread-pull-request=""
                          aria-label={`${pullRequestSummary(pullRequest)}: ${pullRequest.title}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            openPullRequest();
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            openPullRequest();
                          }}
                          className="flex shrink-0 cursor-pointer items-center gap-1 rounded underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <PullRequestIcon pullRequest={pullRequest} />
                          <span className="tabular-nums">
                            #{pullRequest.number}
                          </span>
                        </span>
                      )}
                      {showProject && (
                        <>
                          {pullRequest && <span aria-hidden="true">·</span>}
                          <span className="shrink-0">{project}</span>
                        </>
                      )}
                      {branch && (
                        <>
                          {(pullRequest || showProject) && (
                            <span aria-hidden="true">·</span>
                          )}
                          <span
                            data-thread-branch=""
                            className="flex shrink-0 items-center gap-1"
                          >
                            <HostIcon
                              name="GitBranch"
                              fallback="Fork"
                              // Same size as the pull request glyph; the
                              // flex row keeps it centered on the text. It
                              // carries no per-thread information, so it
                              // stays in the surrounding text color.
                              className="size-3.5 shrink-0"
                            />
                            {branch}
                          </span>
                        </>
                      )}
                    </span>
                    {stamp}
                  </span>
                )}
              </a>
            </Menu.Trigger>
          </ThreadInfo>
          <Menu.Portal>
            <Menu.Content
              {...scope}
              onCloseAutoFocus={(event) => {
                if (menuOpenedEditor.current) {
                  menuOpenedEditor.current = false;
                  event.preventDefault();
                  // The editor may already be closed when Radix restores focus.
                  (renameInputRef.current ?? rowRef.current)?.focus();
                } else if (menuOpenedPicker.current) {
                  menuOpenedPicker.current = false;
                  event.preventDefault();
                }
              }}
              aria-label={`Actions for ${title}`}
              className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              {isAvailable && !thread.isArchived && (
                <Menu.Item
                  className={menuItemClass}
                  onSelect={() => open(true)}
                >
                  Open in split
                </Menu.Item>
              )}
              {!thread.isArchived && (
                <>
                  <Menu.Item
                    className={menuItemClass}
                    onSelect={() => {
                      menuOpenedEditor.current = true;
                      setDraftTitle(title);
                      setRenameError(null);
                      setEditing(true);
                    }}
                  >
                    Rename
                  </Menu.Item>
                  <Menu.Item
                    className={menuItemClass}
                    onSelect={() => {
                      void actions
                        .setRead(thread.id, thread.isUnread)
                        .catch(onError);
                    }}
                  >
                    Mark as {thread.isUnread ? "read" : "unread"}
                  </Menu.Item>
                  {canSnooze && sleeping && (
                    <Menu.Item className={menuItemClass} onSelect={unsnooze}>
                      Unsnooze
                    </Menu.Item>
                  )}
                  {canSnooze && !sleeping && (
                    <Menu.Sub>
                      <Menu.SubTrigger className={menuItemClass}>
                        <span className="min-w-0 flex-1">Snooze…</span>
                        <HostIcon name="ChevronRight" className="size-3.5 shrink-0" />
                      </Menu.SubTrigger>
                      <Menu.Portal>
                        <Menu.SubContent
                          {...scope}
                          sideOffset={4}
                          aria-label="Snooze until"
                          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                        >
                          {snoozeChoices(snooze.presets, now).map((choice) => (
                            <Menu.Item
                              key={choice.id}
                              data-snooze-preset={choice.id}
                              className={menuItemClass}
                              onSelect={() => snoozeUntil(choice.until)}
                            >
                              <span className="min-w-0 flex-1">{choice.label}</span>
                              <span className="shrink-0 text-xs tabular-nums text-[var(--subtle-foreground)]">
                                {choice.hint}
                              </span>
                            </Menu.Item>
                          ))}
                          <Menu.Separator className="my-1 h-px bg-border" />
                          <Menu.Item
                            data-snooze-preset="custom"
                            className={menuItemClass}
                            onSelect={() => {
                              menuOpenedPicker.current = true;
                              setPicker("custom");
                            }}
                          >
                            Custom date and time…
                          </Menu.Item>
                        </Menu.SubContent>
                      </Menu.Portal>
                    </Menu.Sub>
                  )}
                  <Menu.Item
                    className={menuItemClass}
                    onSelect={() => {
                      void actions
                        .setPinned(thread.id, !thread.isPinned)
                        .catch(onError);
                    }}
                  >
                    {thread.isPinned ? "Unpin" : "Pin"}
                  </Menu.Item>
                  {nesting && nesting.candidates.length > 0 && (
                    <Menu.Sub>
                      <Menu.SubTrigger className={menuItemClass}>
                        <span className="min-w-0 flex-1">Make child of…</span>
                        <HostIcon name="ChevronRight" className="size-3.5 shrink-0" />
                      </Menu.SubTrigger>
                      <Menu.Portal>
                        <Menu.SubContent
                          {...scope}
                          sideOffset={4}
                          className="z-50 max-h-64 min-w-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                        >
                          {nesting.candidates.map((candidate) => (
                            <Menu.Item
                              key={candidate.id}
                              className={menuItemClass}
                              onSelect={() =>
                                nesting.onSetParent(candidate.id)
                              }
                            >
                              <span className={`min-w-0 flex-1 ${fadeClass}`}>
                                {candidate.title}
                              </span>
                            </Menu.Item>
                          ))}
                        </Menu.SubContent>
                      </Menu.Portal>
                    </Menu.Sub>
                  )}
                  {nesting && thread.parentThreadId && (
                    <Menu.Item
                      className={menuItemClass}
                      onSelect={() => nesting.onSetParent(null)}
                    >
                      Move to top level
                    </Menu.Item>
                  )}
                  {libraryAction && (
                    <Menu.Item
                      className={menuItemClass}
                      onSelect={() => {
                        void libraryRpc
                          .call(
                            libraryAction === "save" ? "save" : "remove",
                            { threadId: thread.id },
                          )
                          .catch(onError);
                      }}
                    >
                      {libraryAction === "save"
                        ? "Save to Library"
                        : "Remove from Library"}
                    </Menu.Item>
                  )}
                  <Menu.Separator className="my-1 h-px bg-border" />
                </>
              )}
              <Menu.Item
                className={menuItemClass}
                onSelect={() => {
                  void rpc
                    .call(thread.isArchived ? "restoreThread" : "archiveTree", { threadId: thread.id })
                    .catch(onError);
                }}
              >
                {thread.isArchived ? "Restore" : "Archive"}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>}
      </div>
      </Popover.Anchor>
      {picker !== null && snooze !== undefined && (
        <SnoozePopoverContent
          title={title}
          now={now}
          mode={picker}
          presets={snooze.presets}
          onSnooze={snoozeUntil}
          onClose={() => setPicker(null)}
        />
      )}
      </Popover.Root>
      {children}
    </li>
  );
}
