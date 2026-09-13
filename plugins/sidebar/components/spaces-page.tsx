import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreads,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toggleValue } from "../lib/client-state";
import { SPACE_NAME_MAX, type Space } from "../lib/space-schema";
import { moveItem, newSpaceId } from "../lib/spaces";
import { usePortalScopeProps } from "../lib/portal-scope";
import { projectLabel } from "../lib/project-schema";
import { useCompact } from "../lib/use-compact";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { useProjects } from "../lib/use-projects";
import { useSpaces } from "../lib/use-spaces";
import { HostIcon } from "../lib/host-icon";
import { InlineForm, NameField } from "./inline-form";
import { menuItemClass } from "./menus";
import {
  AddButton,
  FILTER_THRESHOLD,
  FilterField,
  matchesFilter,
  ProjectList,
  RowMenu,
  useDragOrder,
} from "./project-list";

/** URL segment of the page: `/plugins/<pluginId>/spaces`. */
export const SPACES_PANEL_PATH = "spaces";
/** Sub-paths inside the page. */
const NEW_SPACE_SUBPATH = "new";
export const ALL_PROJECTS_SUBPATH = "projects";

type Route =
  | { kind: "index" }
  | { kind: "new" }
  | { kind: "projects" }
  | { kind: "space"; id: string };

function parseRoute(subPath: string): Route {
  const path = subPath.replace(/^\/+|\/+$/g, "");
  if (path === "") return { kind: "index" };
  if (path === NEW_SPACE_SUBPATH) return { kind: "new" };
  if (path === ALL_PROJECTS_SUBPATH) return { kind: "projects" };
  return { kind: "space", id: path };
}

const headingClass = "text-sm font-semibold";
const subtleClass = "text-xs text-muted-foreground";
// Every row in the spaces list shares this box so names and counts line up.
const navRowClass =
  "relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
const chevron = (
  <HostIcon
    name="ChevronRight"
    fallback="ArrowRight"
    className="size-4 shrink-0 text-muted-foreground"
  />
);

type SpaceEdit = "rename" | "delete";

// The Spaces page: a list of spaces beside the selected space's projects.
// Phones show one column at a time and use the route for back navigation.
export function SpacesPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const compact = useCompact();
  const spaces = useSpaces();
  const sidebar = experimental_useSidebarThreads();
  const projects = useProjects(
    sidebar.projects
      .map((project) => `${project.id}:${project.name}`)
      .join("|"),
  );
  const catalog = spaces.catalog.spaces;
  const route = parseRoute(subPath);
  const go = (path: string, replace = false) =>
    navigate.toPluginPanel(SPACES_PANEL_PATH, { subPath: path, replace });
  const [notice, setNotice] = useState<string | null>(null);
  // Rename/Delete chosen from the list open that space with its form shown.
  const [pendingEdit, setPendingEdit] = useState<{
    id: string;
    kind: SpaceEdit;
  } | null>(null);
  const report = (cause: unknown) =>
    setNotice(cause instanceof Error ? cause.message : String(cause));

  const threadCounts = new Map<string, number>();
  for (const thread of sidebar.threads)
    threadCounts.set(
      thread.projectId,
      (threadCounts.get(thread.projectId) ?? 0) + 1,
    );

  // Desktop shows a detail beside the list; the index falls back to the
  // first space, or to All projects when there are none.
  const detail: Route =
    route.kind === "index" && !compact
      ? catalog[0]
        ? { kind: "space", id: catalog[0].id }
        : { kind: "projects" }
      : route;
  const selected =
    detail.kind === "space"
      ? catalog.find((space) => space.id === detail.id)
      : undefined;
  // A deleted or unknown space goes back to the list once the server has
  // answered or failed: the cached catalog may predate a space made
  // elsewhere, and a page that never settles must not sit blank.
  const settled = spaces.synced || spaces.error !== null;
  const routeSpaceId = route.kind === "space" ? route.id : null;
  const routeSpaceKnown =
    routeSpaceId !== null && catalog.some((space) => space.id === routeSpaceId);
  useEffect(() => {
    if (settled && routeSpaceId !== null && !routeSpaceKnown) go("", true);
    // `go` is recreated each render; the inputs that matter are listed.
  }, [settled, routeSpaceId, routeSpaceKnown]);

  const { save } = spaces;
  const update = (id: string, change: (space: Space) => Space) =>
    save((list) =>
      list.map((space) => (space.id === id ? change(space) : space)),
    );
  const toggleMember = (spaceId: string, projectId: string) =>
    update(spaceId, (space) => ({
      ...space,
      projectIds: toggleValue(space.projectIds, projectId),
    })).catch(report);
  // Positions are resolved inside the updater: an earlier queued move may
  // have changed them by the time this save runs.
  const moveSpace = (
    id: string,
    target: { delta: number } | { toId: string },
  ) =>
    save((list) => {
      const from = list.findIndex((space) => space.id === id);
      const to =
        "toId" in target
          ? list.findIndex((space) => space.id === target.toId)
          : from + target.delta;
      if (from < 0 || to < 0 || to >= list.length || from === to) return list;
      return moveItem(list, from, to);
    }).catch(report);
  const dropFromSpaces = async (projectId: string) => {
    if (!catalog.some((space) => space.projectIds.includes(projectId))) return;
    await save((list) =>
      list.map((space) => ({
        ...space,
        projectIds: space.projectIds.filter((id) => id !== projectId),
      })),
    );
  };
  const drag = useDragOrder(!compact, (fromId, toId) =>
    moveSpace(fromId, { toId }),
  );

  const list = (
    <nav
      aria-label="Spaces"
      className={compact ? "p-3" : "w-64 shrink-0 border-r border-border p-3"}
    >
      <h2 className={`${headingClass} mb-2 px-2`}>Spaces</h2>
      {spaces.error !== null && (
        <div role="alert" className="mb-2 px-2 text-xs text-destructive">
          {spaces.error}
          <button className="ml-2 underline" onClick={spaces.refresh}>
            Retry
          </button>
        </div>
      )}
      {spaces.status === "loading" && catalog.length === 0 && (
        <p className={`${subtleClass} px-2`}>Loading…</p>
      )}
      {spaces.status === "ready" && catalog.length === 0 && (
        <p className={`${subtleClass} px-2 py-1`}>
          No spaces yet. A space is a named set of projects that scopes the
          Threads sidebar.
        </p>
      )}
      <ul className="m-0 list-none p-0">
        {catalog.map((space, index) => {
          const current = detail.kind === "space" && detail.id === space.id;
          return (
            <li
              key={space.id}
              className={`rounded ${drag.dropClass(space.id)} ${current ? "bg-accent" : ""}`}
              {...drag.props(space.id)}
            >
              <SpaceRowMenu
                spaceName={space.name}
                canMoveUp={index > 0}
                canMoveDown={index < catalog.length - 1}
                onAction={(action) => {
                  if (action === "up") moveSpace(space.id, { delta: -1 });
                  else if (action === "down") moveSpace(space.id, { delta: 1 });
                  else {
                    setPendingEdit({ id: space.id, kind: action });
                    go(space.id);
                  }
                }}
              >
                <button
                  type="button"
                  aria-current={current ? "page" : undefined}
                  onClick={() => go(space.id)}
                  className={`${navRowClass} ${current ? "font-medium" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{space.name}</span>
                  <span className={subtleClass}>{space.projectIds.length}</span>
                  {compact && chevron}
                </button>
              </SpaceRowMenu>
            </li>
          );
        })}
      </ul>
      <AddButton label="New space…" onClick={() => go(NEW_SPACE_SUBPATH)} />
      <div className="mt-3 border-t border-border pt-2">
        <button
          type="button"
          aria-current={detail.kind === "projects" ? "page" : undefined}
          onClick={() => go(ALL_PROJECTS_SUBPATH)}
          className={`${navRowClass} ${detail.kind === "projects" ? "bg-accent font-medium" : ""}`}
        >
          <span className="flex-1">All projects</span>
          <span className={subtleClass}>
            {projects.inventory?.projects.length ?? sidebar.projects.length}
          </span>
          {compact && chevron}
        </button>
      </div>
    </nav>
  );

  const back = compact && (
    <button
      type="button"
      onClick={() => go("")}
      className="mb-2 -ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <HostIcon
        name="ChevronLeft"
        fallback="ArrowTurnBackward"
        className="size-4 shrink-0"
      />
      Spaces
    </button>
  );

  let content: ReactNode = null;
  if (detail.kind === "new")
    content = (
      <section aria-labelledby="new-space-heading">
        {back}
        <h2 id="new-space-heading" className={headingClass}>
          New space
        </h2>
        <NewSpaceForm
          projects={
            projects.inventory?.projects.map((project) => ({
              id: project.id,
              name: projectLabel(project),
              path: project.source?.path ?? null,
            })) ??
            sidebar.projects.map((project) => ({
              id: project.id,
              name: projectLabel(project),
              path: null,
            }))
          }
          onSubmit={async (name, projectIds) => {
            const id = newSpaceId();
            await save((list) => [...list, { id, name, projectIds }]);
            go(id, true);
          }}
          onCancel={() => go("", true)}
        />
      </section>
    );
  else if (detail.kind === "projects")
    content = (
      <section aria-labelledby="projects-heading">
        {back}
        <h2 id="projects-heading" className={headingClass}>
          All projects
        </h2>
        <p className={`${subtleClass} mb-2`}>
          Every project in BB. Rename, move, change the folder, or remove them
          here; pick a space to choose which ones it shows.
        </p>
        <ProjectList
          projects={projects}
          space={null}
          spaces={catalog}
          threadCounts={threadCounts}
          compact={compact}
          onToggleMember={toggleMember}
          onProjectRemoved={dropFromSpaces}
          report={report}
        />
      </section>
    );
  else if (selected)
    content = (
      <SpaceDetail
        key={selected.id}
        space={selected}
        index={catalog.findIndex((space) => space.id === selected.id)}
        count={catalog.length}
        compact={compact}
        back={back}
        initialEdit={pendingEdit?.id === selected.id ? pendingEdit.kind : null}
        onEditShown={() => setPendingEdit(null)}
        onRename={(name) =>
          update(selected.id, (space) => ({ ...space, name }))
        }
        onMove={(delta) => moveSpace(selected.id, { delta })}
        onDelete={async () => {
          await save((list) =>
            list.filter((space) => space.id !== selected.id),
          );
          go("", true);
        }}
      >
        <ProjectList
          projects={projects}
          space={selected}
          spaces={catalog}
          threadCounts={threadCounts}
          compact={compact}
          onToggleMember={toggleMember}
          onProjectRemoved={dropFromSpaces}
          report={report}
        />
      </SpaceDetail>
    );
  else if (detail.kind === "space")
    // Not in the cache yet; the redirect above takes over once settled.
    content = (
      <section aria-label="Space">
        {back}
        <p className={subtleClass}>Loading space…</p>
      </section>
    );

  return (
    <div
      data-activity-spaces-page=""
      className={
        compact ? "text-foreground" : "flex min-h-full text-foreground"
      }
    >
      {(!compact || route.kind === "index") && list}
      {(!compact || route.kind !== "index") && (
        <div className={compact ? "p-3" : "min-w-0 flex-1 p-4"}>
          {notice && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-destructive"
            >
              <span className="flex-1">{notice}</span>
              <button className="underline" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          )}
          {content}
        </div>
      )}
    </div>
  );
}

function SpaceDetail({
  space,
  index,
  count,
  compact,
  back,
  initialEdit,
  onEditShown,
  onRename,
  onMove,
  onDelete,
  children,
}: {
  space: Space;
  index: number;
  count: number;
  compact: boolean;
  back: ReactNode;
  initialEdit: SpaceEdit | null;
  onEditShown: () => void;
  onRename: (name: string) => Promise<unknown>;
  onMove: (delta: number) => void;
  onDelete: () => Promise<void>;
  children: ReactNode;
}) {
  const [edit, setEdit] = useState<SpaceEdit | null>(initialEdit);
  const [name, setName] = useState(space.name);
  useEffect(() => {
    if (!initialEdit) return;
    setName(space.name);
    setEdit(initialEdit);
    onEditShown();
  }, [initialEdit, onEditShown, space.name]);
  const trimmed = name.trim();
  return (
    <section aria-labelledby={`space-${space.id}-heading`}>
      {back}
      <div className="flex items-center gap-2">
        <h2
          id={`space-${space.id}-heading`}
          className={`${headingClass} min-w-0 flex-1 truncate`}
        >
          {space.name}
        </h2>
        <RowMenu label={`Space actions: ${space.name}`}>
          <Menu.Item
            className={menuItemClass}
            onSelect={() => {
              setName(space.name);
              setEdit("rename");
            }}
          >
            Rename…
          </Menu.Item>
          {compact && (
            <>
              <Menu.Item
                className={menuItemClass}
                disabled={index === 0}
                onSelect={() => onMove(-1)}
              >
                Move up
              </Menu.Item>
              <Menu.Item
                className={menuItemClass}
                disabled={index === count - 1}
                onSelect={() => onMove(1)}
              >
                Move down
              </Menu.Item>
            </>
          )}
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item
            className={`${menuItemClass} text-destructive`}
            onSelect={() => setEdit("delete")}
          >
            Delete…
          </Menu.Item>
        </RowMenu>
      </div>
      {edit === "rename" && (
        <InlineForm
          label="Rename space"
          submitLabel="Save"
          canSubmit={trimmed.length > 0 && trimmed !== space.name}
          onSubmit={() => onRename(trimmed).then(() => undefined)}
          onClose={() => setEdit(null)}
        >
          <NameField
            label="Space name"
            value={name}
            max={SPACE_NAME_MAX}
            onChange={setName}
          />
        </InlineForm>
      )}
      {edit === "delete" && (
        <InlineForm
          label="Delete space"
          submitLabel="Delete"
          destructive
          onSubmit={onDelete}
          onClose={() => setEdit(null)}
        >
          <p className="w-full text-sm">
            Delete space “{space.name}”? Projects and threads are not affected.
          </p>
        </InlineForm>
      )}
      <p className={`${subtleClass} mb-2 mt-1`}>
        Check the projects that belong to this space.
      </p>
      {children}
    </section>
  );
}

function NewSpaceForm({
  projects,
  onSubmit,
  onCancel,
}: {
  projects: readonly { id: string; name: string; path: string | null }[];
  onSubmit: (name: string, projectIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const shown = projects.filter((project) =>
    matchesFilter(filter, project.name, project.path),
  );
  // The caller navigates to the new space; only a cancel goes back.
  const created = useRef(false);
  const trimmed = name.trim();
  return (
    <InlineForm
      label="New space"
      submitLabel="Create"
      canSubmit={trimmed.length > 0}
      hint={
        projectIds.length === 0
          ? "An empty space shows no threads until projects are added."
          : `${projectIds.length} of ${projects.length} selected.`
      }
      onSubmit={async () => {
        await onSubmit(trimmed, projectIds);
        created.current = true;
      }}
      onClose={() => {
        if (!created.current) onCancel();
      }}
    >
      <NameField
        label="Space name"
        value={name}
        max={SPACE_NAME_MAX}
        onChange={setName}
      />
      <fieldset className="w-full">
        <legend className={`${subtleClass} mb-1`}>Projects</legend>
        {projects.length >= FILTER_THRESHOLD && (
          <FilterField
            label="Filter projects"
            value={filter}
            onChange={setFilter}
          />
        )}
        {projects.length === 0 ? (
          <p className={subtleClass}>
            No projects yet. Add them under All projects.
          </p>
        ) : shown.length === 0 ? (
          <p className={subtleClass}>No projects match “{filter.trim()}”.</p>
        ) : (
          <ul className="m-0 max-h-72 list-none overflow-y-auto rounded-md border border-border p-1">
            {shown.map((project) => (
              <li key={project.id}>
                <label className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                  <input
                    type="checkbox"
                    checked={projectIds.includes(project.id)}
                    onChange={() =>
                      setProjectIds((ids) => toggleValue(ids, project.id))
                    }
                    className="size-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </InlineForm>
  );
}

// Right-click or long-press a space in the list for its actions.
function SpaceRowMenu({
  spaceName,
  canMoveUp,
  canMoveDown,
  onAction,
  children,
}: {
  spaceName: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onAction: (action: SpaceEdit | "up" | "down") => void;
  children: ReactNode;
}) {
  const scope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const longPress = useLongPressMenu(open);
  // Rename and Delete open a form that takes focus; keep it there instead of
  // letting Radix return focus to the row.
  const editing = useRef(false);
  const act = (action: SpaceEdit | "up" | "down") => {
    editing.current = action === "rename" || action === "delete";
    onAction(action);
  };
  return (
    <ContextMenu.Root onOpenChange={setOpen}>
      <ContextMenu.Trigger asChild>
        <div {...longPress} data-space-row={spaceName}>
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...scope}
          aria-label={`Actions for space ${spaceName}`}
          onCloseAutoFocus={(event) => {
            if (!editing.current) return;
            editing.current = false;
            event.preventDefault();
          }}
          className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => act("rename")}
          >
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            disabled={!canMoveUp}
            onSelect={() => act("up")}
          >
            Move up
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            disabled={!canMoveDown}
            onSelect={() => act("down")}
          >
            Move down
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item
            className={`${menuItemClass} text-destructive`}
            onSelect={() => act("delete")}
          >
            Delete…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
