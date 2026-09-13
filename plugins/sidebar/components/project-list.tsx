import { useState, type DragEvent, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { projectLabel } from "../lib/project-schema";
import type { Space } from "../lib/space-schema";
import { moveItem } from "../lib/spaces";
import type { ProjectsState } from "../lib/use-projects";
import { formInputClass } from "./inline-form";
import { MenuContent, menuItemClass } from "./menus";
import {
  AddProjectForm,
  ProjectFolderForm,
  ProjectRemoveForm,
  ProjectRenameForm,
} from "./project-forms";
import { ProjectGlyph } from "./project-glyph";
import { ProjectHueStyle } from "../lib/project-hue";

type RowEdit = { kind: "rename" | "folder" | "remove"; id: string };

const rowClass =
  "group flex items-center gap-1 rounded px-1 py-1 text-sm hover:bg-accent/60";
const addButtonClass =
  "mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Lists at least this long get a filter field. */
export const FILTER_THRESHOLD = 6;

export function AddButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={addButtonClass}>
      <span aria-hidden="true" className="w-3 text-center">
        +
      </span>
      <span>{label}</span>
    </button>
  );
}

export function matchesFilter(
  filter: string,
  ...fields: (string | null | undefined)[]
): boolean {
  const needle = filter.trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

export function FilterField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      // Enter narrows the list; it must not submit an enclosing form.
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
      className={`${formInputClass} mb-2`}
    />
  );
}

export function RowMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={label}
        className="rounded px-1.5 py-0.5 text-muted-foreground opacity-60 outline-none hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100"
      >
        …
      </Menu.Trigger>
      <MenuContent>{children}</MenuContent>
    </Menu.Root>
  );
}

/**
 * Drag-to-reorder bookkeeping for one list; desktop only. The whole row is
 * the handle: press and move to drag, drop on another row to take its place.
 */
export function useDragOrder(
  enabled: boolean,
  onDrop: (fromId: string, toId: string) => void,
) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const end = () => {
    setDrag(null);
    setOver(null);
  };
  const props = (id: string) =>
    !enabled
      ? {}
      : {
          draggable: true,
          title: "Drag to reorder",
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", id);
            setDrag(id);
          },
          onDragEnd: end,
          onDragOver: (event: DragEvent) => {
            if (!drag) return;
            event.preventDefault();
            setOver(id);
          },
          onDragLeave: () =>
            setOver((current) => (current === id ? null : current)),
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            if (drag && drag !== id) onDrop(drag, id);
            end();
          },
        };
  const dropClass = (id: string) =>
    `${over === id && drag !== id ? "ring-1 ring-ring" : ""} ${drag === id ? "opacity-50" : ""}`;
  return { props, dropClass };
}

// Every BB project, with a membership checkbox when a space is being edited.
// Project edits go through BB; membership goes to the plugin catalog.
export function ProjectList({
  projects,
  space,
  spaces,
  threadCounts,
  compact,
  onToggleMember,
  onProjectRemoved,
  report,
}: {
  projects: ProjectsState;
  /** The space whose membership the checkboxes edit; null lists projects only. */
  space: Space | null;
  spaces: readonly Space[];
  threadCounts: ReadonlyMap<string, number>;
  compact: boolean;
  onToggleMember: (spaceId: string, projectId: string) => void;
  /** Called after BB deleted the project so spaces can drop it. */
  onProjectRemoved: (projectId: string) => Promise<void>;
  report: (cause: unknown) => void;
}) {
  const [rowEdit, setRowEdit] = useState<RowEdit | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const filtering = filter.trim().length > 0;
  const rows = projects.inventory?.projects ?? [];
  const shown = rows.filter((project) =>
    matchesFilter(filter, projectLabel(project), project.source?.path),
  );
  const hosts = projects.inventory?.hosts ?? [];
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
  const orderable = rows.filter((project) => !project.isPersonal);
  const listed = new Set(rows.map((project) => project.id));
  const unavailable = space
    ? space.projectIds.filter((id) => !listed.has(id))
    : [];
  const moveProject = async (from: number, to: number) => {
    if (to < 0 || to >= orderable.length || from === to || from < 0) return;
    const next = moveItem(orderable, from, to);
    const moved = next[to]!;
    try {
      projects.apply(
        await projects.rpc.call("reorderProject", {
          projectId: moved.id,
          previousProjectId: next[to - 1]?.id ?? null,
          nextProjectId: next[to + 1]?.id ?? null,
        }),
      );
    } catch (cause) {
      report(cause);
    }
  };
  // Reordering only makes sense against the full list.
  const drag = useDragOrder(
    !compact && !filtering,
    (fromId, toId) =>
      void moveProject(
        orderable.findIndex((project) => project.id === fromId),
        orderable.findIndex((project) => project.id === toId),
      ),
  );
  return (
    <div>
      <ProjectHueStyle />
      {projects.error && (
        <div role="alert" className="mb-1 px-1 text-xs text-destructive">
          Cannot load projects.
          <button className="ml-2 underline" onClick={projects.refresh}>
            Retry
          </button>
        </div>
      )}
      {!projects.inventory && !projects.error && (
        <p className="px-1 py-1 text-xs text-muted-foreground">Loading…</p>
      )}
      {rows.length >= FILTER_THRESHOLD && (
        <FilterField
          label="Filter projects"
          value={filter}
          onChange={setFilter}
        />
      )}
      {filtering && shown.length === 0 && (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          No projects match “{filter.trim()}”.
        </p>
      )}
      <ul aria-label="Projects" className="m-0 list-none p-0">
        {shown.map((project) => {
          const index = orderable.findIndex((entry) => entry.id === project.id);
          const member = space?.projectIds.includes(project.id) ?? false;
          const edit = rowEdit?.id === project.id ? rowEdit : null;
          return (
            <li
              key={project.id}
              className={`${rowClass} flex-wrap ${drag.dropClass(project.id)}`}
              {...(project.isPersonal ? {} : drag.props(project.id))}
            >
              {space && (
                <input
                  type="checkbox"
                  aria-label={`Include ${projectLabel(project)} in ${space.name}`}
                  checked={member}
                  onChange={() => onToggleMember(space.id, project.id)}
                  className="size-3.5 shrink-0"
                />
              )}
              <div className="min-w-0 flex-1 px-1">
                <div className="flex items-center gap-2">
                  <ProjectGlyph
                    name={projectLabel(project)}
                    neutral={project.isPersonal}
                  />
                  <span data-project-name="" className="min-w-0 truncate">
                    {projectLabel(project)}
                  </span>
                  {hosts.length > 1 && project.source && (
                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      {hostNames.get(project.source.hostId) ?? "Host"}
                    </span>
                  )}
                </div>
                {project.source && (
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={project.source.path}
                  >
                    {project.source.path}
                  </div>
                )}
              </div>
              {!project.isPersonal && (
                <RowMenu label={`Project actions: ${project.name}`}>
                  <Menu.Item
                    className={menuItemClass}
                    onSelect={() =>
                      setRowEdit({ kind: "rename", id: project.id })
                    }
                  >
                    Rename…
                  </Menu.Item>
                  <Menu.Item
                    className={menuItemClass}
                    disabled={!project.source}
                    onSelect={() =>
                      setRowEdit({ kind: "folder", id: project.id })
                    }
                  >
                    Change folder…
                  </Menu.Item>
                  <Menu.Item
                    className={menuItemClass}
                    disabled={filtering || index <= 0}
                    onSelect={() => void moveProject(index, index - 1)}
                  >
                    Move up
                  </Menu.Item>
                  <Menu.Item
                    className={menuItemClass}
                    disabled={
                      filtering || index < 0 || index === orderable.length - 1
                    }
                    onSelect={() => void moveProject(index, index + 1)}
                  >
                    Move down
                  </Menu.Item>
                  <Menu.Separator className="my-1 h-px bg-border" />
                  <Menu.Item
                    className={`${menuItemClass} text-destructive`}
                    onSelect={() =>
                      setRowEdit({ kind: "remove", id: project.id })
                    }
                  >
                    Remove…
                  </Menu.Item>
                </RowMenu>
              )}
              {edit?.kind === "rename" && (
                <div className="w-full">
                  <ProjectRenameForm
                    project={project}
                    onSubmit={async (name) => {
                      await projects.rpc.call("renameProject", {
                        projectId: project.id,
                        name,
                      });
                      projects.refresh();
                    }}
                    onClose={() => setRowEdit(null)}
                  />
                </div>
              )}
              {edit?.kind === "folder" && project.source && (
                <div className="w-full">
                  <ProjectFolderForm
                    project={project}
                    source={project.source}
                    rpc={projects.rpc}
                    onSubmit={async (path) => {
                      await projects.rpc.call("changeProjectFolder", {
                        projectId: project.id,
                        path,
                      });
                      projects.refresh();
                    }}
                    onClose={() => setRowEdit(null)}
                  />
                </div>
              )}
              {edit?.kind === "remove" && (
                <div className="w-full">
                  <ProjectRemoveForm
                    project={project}
                    threadCount={threadCounts.get(project.id) ?? 0}
                    onSubmit={async () => {
                      await projects.rpc.call("deleteProject", {
                        projectId: project.id,
                      });
                      await onProjectRemoved(project.id);
                      projects.refresh();
                    }}
                    onClose={() => setRowEdit(null)}
                  />
                </div>
              )}
            </li>
          );
        })}
        {space &&
          !filtering &&
          unavailable.map((id) => (
            <li key={id} className={rowClass}>
              <input
                type="checkbox"
                aria-label={`Include Unavailable project in ${space.name}`}
                checked
                onChange={() => onToggleMember(space.id, id)}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate px-1 text-muted-foreground">
                Unavailable project
              </span>
            </li>
          ))}
      </ul>
      {adding ? (
        <AddProjectForm
          rpc={projects.rpc}
          hosts={hosts}
          defaultHostId={
            rows.find((project) => project.source)?.source?.hostId ??
            hosts.find((host) => host.connected)?.id ??
            hosts[0]?.id ??
            null
          }
          hint={
            space
              ? `The project joins ${space.name}.`
              : "Pick the folder that holds the repository."
          }
          onSubmit={async (input) => {
            const created = await projects.rpc.call("createProject", input);
            if (space) onToggleMember(space.id, created.id);
            projects.refresh();
          }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <AddButton label="Add project…" onClick={() => setAdding(true)} />
      )}
      {spaces.length === 0 && !space && (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Create a space to group projects for the Threads sidebar.
        </p>
      )}
    </div>
  );
}
