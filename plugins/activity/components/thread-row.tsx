import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  STATUS_HELP,
  STATUS_LABEL,
  threadTitle,
  type Status,
  type SortBy,
} from "../lib/status";
import { MenuContent, menuItemClass } from "./menus";
import { relativeAge } from "../lib/time";
import { StatusIcon } from "./status-icon";

export function ThreadRow({
  thread,
  status,
  project,
  provider,
  parent,
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
  active: boolean;
  now: number;
  sortBy: SortBy;
  onNavigate: () => void;
  onError: (error: unknown) => void;
}) {
  const actions = experimental_useSidebarThreadActions();
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
    <li
      className={`group relative flex min-w-0 items-center rounded-md ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
    >
      <a
        {...splitProps}
        href={`/projects/${encodeURIComponent(thread.projectId)}/threads/${encodeURIComponent(thread.id)}`}
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          open(event.metaKey || event.ctrlKey);
        }}
        title={[
          title,
          STATUS_LABEL[status],
          STATUS_HELP[status],
          `${project}${branch ? ` · ${branch}` : ""}`,
          provider,
          thread.isPinned ? "Pinned" : null,
          parent ? `Child of ${parent}` : null,
        ]
          .filter(Boolean)
          .join("\n")}
        className="flex min-w-0 flex-1 items-start rounded-md py-2 pl-8 pr-10 text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {status === "working" && (
          <span
            role="img"
            aria-label="Working"
            className="absolute left-2 top-2.5 flex size-4 items-center justify-center"
          >
            <StatusIcon status="working" />
          </span>
        )}
        {status === "unread" && (
          <span
            role="img"
            aria-label="Unread"
            className="absolute left-2 top-2.5 flex size-4 items-center justify-center"
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-sky-600 dark:bg-sky-400"
            />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm leading-5 ${thread.isUnread || active ? "font-semibold" : "font-medium"}`}
          >
            {title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-4 text-[var(--subtle-foreground)]">
            {parent ? "↳ " : ""}
            <span
              className={branch ? "max-w-[55%] shrink-0 truncate" : "truncate"}
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
          title={`${sortBy === "created" ? "Created" : "Updated"} ${new Date(timestamp).toLocaleString()}`}
          className="absolute right-2 top-2.5 text-xs tabular-nums text-[var(--subtle-foreground)] group-hover:opacity-0 group-focus-within:opacity-0 max-md:hidden"
        >
          {relativeAge(timestamp, now)}
        </time>
      </a>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Actions for ${title}`}
          className="absolute right-1 top-1 rounded px-1.5 py-1 text-muted-foreground opacity-0 outline-none hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
        >
          ⋯
        </Menu.Trigger>
        <MenuContent>
          {isAvailable && (
            <Menu.Item className={menuItemClass} onSelect={() => open(true)}>
              Open in split
            </Menu.Item>
          )}
          <Menu.Item
            className={menuItemClass}
            onSelect={() => {
              void actions.setRead(thread.id, thread.isUnread).catch(onError);
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
        </MenuContent>
      </Menu.Root>
    </li>
  );
}
