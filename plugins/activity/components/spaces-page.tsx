import { useEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreads,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toggleValue } from "../lib/client-state";
import { SPACE_NAME_MAX, type Space } from "../lib/space-schema";
import { moveItem, newSpaceId } from "../lib/spaces";
import { useCompact } from "../lib/use-compact";
import { useProjects } from "../lib/use-projects";
import { useSpaces } from "../lib/use-spaces";
import { InlineForm, NameField } from "./inline-form";
import { menuItemClass } from "./menus";
import {
  addButtonClass,
  Grip,
  ProjectList,
  rowClass,
  RowMenu,
  useDragOrder,
} from "./project-list";

/** URL segment of the page: `/plugins/<pluginId>/spaces`. */
export const SPACES_PANEL_PATH = "spaces";
/** Sub-paths inside the page. */
export const NEW_SPACE_SUBPATH = "new";
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
  // A deleted or unknown space goes back to the list.
  useEffect(() => {
    if (
      spaces.status === "ready" &&
      route.kind === "space" &&
      !catalog.some((space) => space.id === route.id)
    )
      go("", true);
  });

  const save = (next: Space[]) => spaces.save(next);
  const update = (id: string, change: (space: Space) => Space) =>
    save(catalog.map((space) => (space.id === id ? change(space) : space)));
  const toggleMember = (spaceId: string, projectId: string) =>
    update(spaceId, (space) => ({
      ...space,
      projectIds: toggleValue(space.projectIds, projectId),
    })).catch(report);
  const moveSpace = (from: number, to: number) => {
    if (to < 0 || to >= catalog.length) return;
    save(moveItem(catalog, from, to)).catch(report);
  };
  const dropFromSpaces = async (projectId: string) => {
    if (!catalog.some((space) => space.projectIds.includes(projectId))) return;
    await save(
      catalog.map((space) => ({
        ...space,
        projectIds: space.projectIds.filter((id) => id !== projectId),
      })),
    );
  };
  const drag = useDragOrder(!compact, (fromId, toId) =>
    moveSpace(
      catalog.findIndex((space) => space.id === fromId),
      catalog.findIndex((space) => space.id === toId),
    ),
  );

  const list = (
    <nav
      aria-label="Spaces"
      className={compact ? "p-3" : "w-64 shrink-0 border-r border-border p-3"}
    >
      <h2 className={`${headingClass} mb-2 px-1`}>Spaces</h2>
      {spaces.status === "loading" && catalog.length === 0 && (
        <p className={`${subtleClass} px-1`}>Loading…</p>
      )}
      {spaces.status !== "loading" && catalog.length === 0 && (
        <p className={`${subtleClass} px-1 py-1`}>
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
              className={`${rowClass} ${drag.dropClass(space.id)} ${current ? "bg-accent" : ""}`}
              {...drag.props(space.id)}
            >
              {drag.grip && (
                <Grip id={space.id} onStart={drag.start} onEnd={drag.end} />
              )}
              <button
                type="button"
                aria-current={current ? "page" : undefined}
                onClick={() => go(space.id)}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${current ? "font-medium" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                <span className={subtleClass}>{space.projectIds.length}</span>
                {compact && (
                  <span aria-hidden="true" className="text-muted-foreground">
                    ›
                  </span>
                )}
              </button>
              {!compact && (
                <RowMenu label={`Move space: ${space.name}`}>
                  <Menu.Item
                    className={menuItemClass}
                    disabled={index === 0}
                    onSelect={() => moveSpace(index, index - 1)}
                  >
                    Move up
                  </Menu.Item>
                  <Menu.Item
                    className={menuItemClass}
                    disabled={index === catalog.length - 1}
                    onSelect={() => moveSpace(index, index + 1)}
                  >
                    Move down
                  </Menu.Item>
                </RowMenu>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => go(NEW_SPACE_SUBPATH)}
        className={addButtonClass}
      >
        + New space…
      </button>
      <div className="mt-3 border-t border-border pt-2">
        <button
          type="button"
          aria-current={detail.kind === "projects" ? "page" : undefined}
          onClick={() => go(ALL_PROJECTS_SUBPATH)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${detail.kind === "projects" ? "bg-accent font-medium" : ""}`}
        >
          <span className="flex-1">All projects</span>
          <span className={subtleClass}>
            {projects.inventory?.projects.length ?? sidebar.projects.length}
          </span>
          {compact && (
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
          )}
        </button>
      </div>
    </nav>
  );

  const back = compact && (
    <button
      type="button"
      onClick={() => go("")}
      className="mb-2 -ml-1 rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      ‹ Spaces
    </button>
  );

  let content: React.ReactNode = null;
  if (detail.kind === "new")
    content = (
      <section aria-labelledby="new-space-heading">
        {back}
        <h2 id="new-space-heading" className={headingClass}>
          New space
        </h2>
        <NewSpaceForm
          projects={
            projects.inventory?.projects.map(({ id, name }) => ({
              id,
              name,
            })) ?? sidebar.projects.map(({ id, name }) => ({ id, name }))
          }
          onSubmit={async (name, projectIds) => {
            const id = newSpaceId();
            await save([...catalog, { id, name, projectIds }]);
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
        onRename={(name) =>
          update(selected.id, (space) => ({ ...space, name }))
        }
        onMove={(delta) => {
          const index = catalog.findIndex((space) => space.id === selected.id);
          moveSpace(index, index + delta);
        }}
        onDelete={async () => {
          await save(catalog.filter((space) => space.id !== selected.id));
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
  onRename,
  onMove,
  onDelete,
  children,
}: {
  space: Space;
  index: number;
  count: number;
  compact: boolean;
  back: React.ReactNode;
  onRename: (name: string) => Promise<unknown>;
  onMove: (delta: number) => void;
  onDelete: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [edit, setEdit] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(space.name);
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
  projects: readonly { id: string; name: string }[];
  onSubmit: (name: string, projectIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
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
        {projects.length === 0 ? (
          <p className={subtleClass}>
            No projects yet. Add them under All projects.
          </p>
        ) : (
          <ul className="m-0 max-h-72 list-none overflow-y-auto rounded-md border border-border p-1">
            {projects.map((project) => (
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
