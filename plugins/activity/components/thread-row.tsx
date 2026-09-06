import * as Menu from "@radix-ui/react-context-menu";
import { useRef, useState, type ReactNode } from "react";
import {
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
  nested = false,
  showStatus = false,
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
  nested?: boolean;
  showStatus?: boolean;
  children?: ReactNode;
  active: boolean;
  now: number;
  sortBy: SortBy;
  onNavigate: () => void;
  onError: (error: unknown) => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const scope = usePortalScopeProps();
  const [menuOpen, setMenuOpen] = useState(false);
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
    actions.open(thread.id, { split });
    onNavigate();
  };
  return (
    <li data-thread-node={thread.id} className="min-w-0">
      <div
        className={`group relative flex min-w-0 items-center rounded-md ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
      >
        <Menu.Root
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
                {...splitProps}
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
                  if (event.pointerType !== "touch" && event.button === 0) {
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
                className={`flex min-w-0 flex-1 select-none items-start rounded-md py-2 pr-10 text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring ${nested ? (status === "done" ? "pl-7" : "pl-12") : "pl-8"}`}
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
                    className="absolute left-2 top-3 size-3 text-[var(--subtle-foreground)]"
                  >
                    <path d="M3 3v5a2 2 0 0 0 2 2h8m-3-3 3 3-3 3" />
                  </svg>
                )}
                {status !== "done" && (
                  <span
                    role="img"
                    aria-label={STATUS_LABEL[status]}
                    className={`absolute top-2.5 flex size-4 items-center justify-center ${nested ? "left-7" : "left-2"}`}
                  >
                    {status === "unread" || (nested && status === "working") ? (
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
                  {showStatus && !nested && (
                    <span
                      className={`block text-[10px] leading-4 ${status === "attention" ? "text-[var(--warning-text)]" : "text-muted-foreground"}`}
                    >
                      {STATUS_LABEL[status]}
                    </span>
                  )}
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
              aria-label={`Actions for ${title}`}
              className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              {isAvailable && (
                <Menu.Item
                  className={menuItemClass}
                  onSelect={() => open(true)}
                >
                  Open in split
                </Menu.Item>
              )}
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
              <Menu.Item
                className={menuItemClass}
                onSelect={() => actions.archive(thread.id)}
              >
                Archive
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {children}
    </li>
  );
}
