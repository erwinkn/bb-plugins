import * as Menu from "@radix-ui/react-context-menu";
import { useRef, useState, type ReactNode } from "react";
import {
  useRpc,
  useBbNavigate,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  STATUS_LABEL,
  threadTitle,
  type Status,
  type SortBy,
} from "../lib/status";
import type { archiveContract } from "../lib/archive-contract";
import { menuItemClass } from "./menus";
import { usePortalScopeProps } from "../lib/portal-scope";
import { relativeAge } from "../lib/time";
import { StatusIcon } from "./status-icon";
import { ThreadInfo } from "./thread-info";
import { useLongPressMenu } from "../lib/use-long-press-menu";

export function ThreadRow({
  thread,
  status,
  project,
  provider,
  parent,
  depth = 0,
  children,
  active,
  now,
  sortBy,
  onNavigate,
  onError,
}: {
  thread: PluginSidebarThread;
  status: Status;
  project: string;
  provider: string;
  parent?: string;
  depth?: number;
  children?: ReactNode;
  active: boolean;
  now: number;
  sortBy: SortBy;
  onNavigate: () => void;
  onError: (error: unknown) => void;
}) {
  const rpc = useRpc<typeof archiveContract>();
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
  const longPress = useLongPressMenu(menuOpen);
  // A long press can produce a click on release. Keep keyboard and BB shortcut
  // clicks (detail === 0) available, but require a fresh pointer press otherwise.
  const suppressClick = useRef(false);
  const { splitProps, isAvailable } = experimental_useSidebarThreadSplit(
    thread.id,
  );
  const title = threadTitle(thread);
  const branch = thread.environment?.branchName;
  const timestamp = sortBy === "created" ? thread.createdAt : thread.updatedAt;
  const open = (split = false) => {
    if (thread.isArchived) navigate.toThread(thread.id);
    else actions.open(thread.id, { split });
    onNavigate();
  };
  return (
    <li data-thread-node={thread.id} className="min-w-0">
      <div
        className={`group relative flex min-w-0 items-center rounded-md ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
      >
        {editing ? (
          <form
            aria-label="Rename thread"
            className="flex min-w-0 flex-1 flex-wrap gap-2 p-2"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!savingRef.current) setEditing(false);
              }
            }}
            onSubmit={async (event) => {
              event.preventDefault();
              const nextTitle = draftTitle.trim();
              if (!nextTitle || savingRef.current) return;
              if (nextTitle === title) {
                setEditing(false);
                return;
              }
              savingRef.current = true;
              setSaving(true);
              setRenameError(null);
              try {
                await actions.rename(thread.id, nextTitle);
                setEditing(false);
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
              disabled={saving}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button type="submit" disabled={saving || !draftTitle.trim()} className="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={saving} onClick={() => setEditing(false)} className="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
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
            disabled={menuOpen}
          >
            <Menu.Trigger asChild>
              <a
                {...(!thread.isArchived ? splitProps : {})}
                {...longPress}
                href={`/projects/${encodeURIComponent(thread.projectId)}/threads/${encodeURIComponent(thread.id)}`}
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
                  open(event.metaKey || event.ctrlKey);
                }}
                className="flex min-w-0 flex-1 select-none items-start rounded-md py-2 pr-10 text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ paddingLeft: `${nested ? 1.75 + depth * 1.5 : 2}rem` }}
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
                    className="absolute top-3 size-3 text-[var(--subtle-foreground)]"
                    style={{ left: `${0.5 + depth * 1.5}rem` }}
                  >
                    <path d="M3 3v5a2 2 0 0 0 2 2h8m-3-3 3 3-3 3" />
                  </svg>
                )}
                {status !== "done" && (
                  <span
                    role="img"
                    aria-label={STATUS_LABEL[status]}
                    className="absolute left-2 top-2.5 flex size-4 items-center justify-center"
                  >
                    {status === "unread" ? (
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-sky-600 dark:bg-sky-400"
                      />
                    ) : (
                      <StatusIcon status={status} />
                    )}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm leading-5 ${thread.isUnread || active ? "font-semibold" : "font-medium"}`}
                  >
                    {title}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-4 text-[var(--subtle-foreground)]">
                    {parent && !nested ? "↳ " : ""}
                    <span
                      className={
                        branch ? "max-w-[55%] shrink-0 truncate" : "truncate"
                      }
                    >
                      {project}
                    </span>
                    {branch && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="min-w-0 truncate">{branch}</span>
                      </>
                    )}
                  </span>
                </span>
                <time
                  dateTime={new Date(timestamp).toISOString()}
                  aria-label={`${sortBy === "created" ? "Created" : "Updated"} ${new Date(timestamp).toLocaleString()}`}
                  className="absolute right-2 top-2.5 text-xs tabular-nums text-[var(--subtle-foreground)] max-md:hidden"
                >
                  {relativeAge(timestamp, now)}
                </time>
              </a>
            </Menu.Trigger>
          </ThreadInfo>
          <Menu.Portal>
            <Menu.Content
              {...scope}
              onCloseAutoFocus={(event) => {
                if (renameInputRef.current) {
                  event.preventDefault();
                  renameInputRef.current.focus();
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
                  <Menu.Separator className="my-1 h-px bg-border" />
                </>
              )}
              <Menu.Item
                className={menuItemClass}
                onSelect={() => {
                  if (thread.isArchived) {
                    void rpc
                      .call("restoreThread", { threadId: thread.id })
                      .catch(onError);
                  } else actions.archive(thread.id);
                }}
              >
                {thread.isArchived ? "Restore" : "Archive"}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>}
      </div>
      {children}
    </li>
  );
}
