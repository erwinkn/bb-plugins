import { useEffect, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import type { ManagedProject } from "../lib/project-schema";
import type { Space } from "../lib/space-schema";
import { moveItem, newSpaceId } from "../lib/spaces";
import { toggleValue } from "../lib/client-state";
import { usePortalScopeProps } from "../lib/portal-scope";
import type { SpacesState } from "../lib/use-spaces";
import { useProjects } from "../lib/use-projects";
import { MenuContent, menuItemClass } from "./menus";
import { Modal } from "./modal";
import { AddProjectDialog, RemoveProjectDialog } from "./project-dialogs";
import { ProjectFolderForm, ProjectRenameForm } from "./project-forms";
import { SpaceDialog, type SpaceDialogKind } from "./space-dialog";

type Nested =
  | { kind: "space"; edit: SpaceDialogKind; id?: string }
  | { kind: "add-project" }
  | { kind: "remove-project"; id: string };
type RowEdit = { kind: "rename" | "folder"; id: string };
type Drag = { list: "spaces" | "projects"; id: string };

const rowClass =
  "group flex items-center gap-1 rounded px-1 py-1 text-sm hover:bg-accent/60";
const addButtonClass =
  "mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
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

function Grip({
  drag,
  onStart,
  onEnd,
}: {
  drag: Drag;
  onStart: (drag: Drag) => void;
  onEnd: () => void;
}) {
  return (
    <span
      draggable
      aria-hidden="true"
      title="Drag to reorder"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", drag.id);
        onStart(drag);
      }}
      onDragEnd={onEnd}
      className="cursor-grab select-none px-0.5 text-muted-foreground opacity-0 group-hover:opacity-60"
    >
      ⋮⋮
    </span>
  );
}

// Spaces on the left, the chosen space's projects on the right. Space edits
// save to the plugin catalog; project edits go through BB and show up in
// every client.
export function ManageDialog({
  spaces,
  initialSpaceId,
  sidebarProjects,
  threadCounts,
  compact,
  onNewThread,
  onClose,
  report,
}: {
  spaces: SpacesState;
  /** The space to edit first; defaults to the first space. */
  initialSpaceId: string | null;
  sidebarProjects: readonly PluginSidebarProject[];
  threadCounts: ReadonlyMap<string, number>;
  compact: boolean;
  onNewThread: (projectId: string) => void;
  onClose: () => void;
  report: (cause: unknown) => void;
}) {
  const signature = sidebarProjects
    .map((project) => `${project.id}:${project.name}`)
    .join("|");
  const projects = useProjects(signature);
  const portal = usePortalScopeProps();
  const catalog = spaces.catalog.spaces;
  const [editingId, setEditingId] = useState<string | null>(
    initialSpaceId ?? catalog[0]?.id ?? null,
  );
  const editing = catalog.find((space) => space.id === editingId) ?? null;
  // A space deleted elsewhere falls back to the first one.
  useEffect(() => {
    if (editingId && !catalog.some((space) => space.id === editingId))
      setEditingId(catalog[0]?.id ?? null);
    else if (!editingId && catalog[0]) setEditingId(catalog[0].id);
  }, [catalog, editingId]);
  const [nested, setNested] = useState<Nested | null>(null);
  const [rowEdit, setRowEdit] = useState<RowEdit | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const rows: ManagedProject[] =
    projects.inventory?.projects ??
    sidebarProjects.map((project) => ({
      id: project.id,
      name: project.name,
      isPersonal: project.isPersonal,
      source: null,
    }));
  const hosts = projects.inventory?.hosts ?? [];
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
  const orderable = rows.filter((project) => !project.isPersonal);
  const listed = new Set(rows.map((project) => project.id));
  const unavailable = editing
    ? editing.projectIds.filter((id) => !listed.has(id))
    : [];

  const saveSpaces = (next: Space[]) => spaces.save(next);
  const updateSpace = (id: string, change: (space: Space) => Space) =>
    saveSpaces(
      catalog.map((space) => (space.id === id ? change(space) : space)),
    );
  const toggleMember = (spaceId: string, projectId: string) =>
    updateSpace(spaceId, (space) => ({
      ...space,
      projectIds: toggleValue(space.projectIds, projectId),
    })).catch(report);
  const moveSpace = (from: number, to: number) => {
    if (to < 0 || to >= catalog.length) return;
    saveSpaces(moveItem(catalog, from, to)).catch(report);
  };
  const moveProject = async (from: number, to: number) => {
    if (to < 0 || to >= orderable.length || from === to) return;
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
  const dropOn = (list: Drag["list"], targetId: string) => {
    if (!drag || drag.list !== list) return;
    if (list === "spaces")
      moveSpace(
        catalog.findIndex((space) => space.id === drag.id),
        catalog.findIndex((space) => space.id === targetId),
      );
    else
      void moveProject(
        orderable.findIndex((project) => project.id === drag.id),
        orderable.findIndex((project) => project.id === targetId),
      );
    setDrag(null);
    setOver(null);
  };
  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const dragProps = (list: Drag["list"], id: string) =>
    compact
      ? {}
      : {
          onDragOver: (event: React.DragEvent) => {
            if (drag?.list !== list) return;
            event.preventDefault();
            setOver(id);
          },
          onDragLeave: () =>
            setOver((current) => (current === id ? null : current)),
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            dropOn(list, id);
          },
        };
  const dropClass = (id: string) =>
    over === id && drag?.id !== id ? "ring-1 ring-ring" : "";
  const spacer = !compact && <span className="w-4" aria-hidden="true" />;
  const nestedSpace =
    nested?.kind === "space"
      ? catalog.find((space) => space.id === nested.id)
      : undefined;
  const removing =
    nested?.kind === "remove-project"
      ? rows.find((project) => project.id === nested.id)
      : undefined;

  const spacesPane = (
    <div
      className={
        compact
          ? "border-b border-border p-3"
          : "flex w-56 shrink-0 flex-col border-r border-border p-3"
      }
    >
      <h3 className="mb-1 px-1 text-xs font-medium text-[var(--subtle-foreground)]">
        Spaces
      </h3>
      {catalog.length === 0 && (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          No spaces yet. A space is a named set of projects.
        </p>
      )}
      <ul aria-label="Spaces" className="m-0 list-none p-0">
        {catalog.map((space, index) => (
          <li
            key={space.id}
            className={`${rowClass} ${dropClass(space.id)} ${editing?.id === space.id ? "bg-accent" : ""}`}
            {...dragProps("spaces", space.id)}
          >
            {!compact && (
              <Grip
                drag={{ list: "spaces", id: space.id }}
                onStart={setDrag}
                onEnd={endDrag}
              />
            )}
            <button
              type="button"
              aria-current={editing?.id === space.id ? "true" : undefined}
              onClick={() => setEditingId(space.id)}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${editing?.id === space.id ? "font-medium" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <span className="text-xs text-muted-foreground">
                {space.projectIds.length}
              </span>
            </button>
            <RowMenu label={`Space actions: ${space.name}`}>
              <Menu.Item
                className={menuItemClass}
                onSelect={() =>
                  setNested({ kind: "space", edit: "rename", id: space.id })
                }
              >
                Rename…
              </Menu.Item>
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
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item
                className={`${menuItemClass} text-destructive`}
                onSelect={() =>
                  setNested({ kind: "space", edit: "delete", id: space.id })
                }
              >
                Delete…
              </Menu.Item>
            </RowMenu>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setNested({ kind: "space", edit: "create" })}
        className={addButtonClass}
      >
        + New space…
      </button>
    </div>
  );

  const projectsPane = (
    <div className={compact ? "p-3" : "min-w-0 flex-1 p-3"}>
      <h3 className="mb-1 px-1 text-xs font-medium text-[var(--subtle-foreground)]">
        {editing ? `Projects in ${editing.name}` : "Projects"}
      </h3>
      <p className="mb-2 px-1 text-xs text-muted-foreground">
        {editing
          ? "Check the projects that belong to this space."
          : "Create a space to group projects."}
      </p>
      {projects.error && (
        <div role="alert" className="mb-1 px-1 text-xs text-destructive">
          Cannot load project folders.
          <button className="ml-2 underline" onClick={projects.refresh}>
            Retry
          </button>
        </div>
      )}
      <ul aria-label="Projects" className="m-0 list-none p-0">
        {rows.map((project) => {
          const index = orderable.findIndex((entry) => entry.id === project.id);
          const member = editing?.projectIds.includes(project.id) ?? false;
          const edit = rowEdit?.id === project.id ? rowEdit : null;
          return (
            <li
              key={project.id}
              className={`${rowClass} flex-wrap ${dropClass(project.id)}`}
              {...(project.isPersonal ? {} : dragProps("projects", project.id))}
            >
              {!compact &&
                (project.isPersonal ? (
                  spacer
                ) : (
                  <Grip
                    drag={{ list: "projects", id: project.id }}
                    onStart={setDrag}
                    onEnd={endDrag}
                  />
                ))}
              {editing && (
                <input
                  type="checkbox"
                  aria-label={`Include ${project.name} in ${editing.name}`}
                  checked={member}
                  onChange={() => toggleMember(editing.id, project.id)}
                  className="size-3.5 shrink-0"
                />
              )}
              <div className="min-w-0 flex-1 px-1">
                <div className="flex items-center gap-2">
                  <span data-project-name="" className="min-w-0 truncate">
                    {project.name}
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
              <RowMenu label={`Project actions: ${project.name}`}>
                <Menu.Item
                  className={menuItemClass}
                  onSelect={() => onNewThread(project.id)}
                >
                  New thread
                </Menu.Item>
                {catalog.length > 0 && (
                  <Menu.Sub>
                    <Menu.SubTrigger className={menuItemClass}>
                      <span className="flex-1">Spaces</span>
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground"
                      >
                        ›
                      </span>
                    </Menu.SubTrigger>
                    <Menu.Portal>
                      <Menu.SubContent
                        {...portal}
                        sideOffset={4}
                        className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                      >
                        {catalog.map((space) => (
                          <Menu.CheckboxItem
                            key={space.id}
                            checked={space.projectIds.includes(project.id)}
                            onSelect={(event) => event.preventDefault()}
                            onCheckedChange={() =>
                              toggleMember(space.id, project.id)
                            }
                            className={menuItemClass}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {space.name}
                            </span>
                            <Menu.ItemIndicator aria-hidden="true">
                              ✓
                            </Menu.ItemIndicator>
                          </Menu.CheckboxItem>
                        ))}
                      </Menu.SubContent>
                    </Menu.Portal>
                  </Menu.Sub>
                )}
                {!project.isPersonal && (
                  <>
                    <Menu.Separator className="my-1 h-px bg-border" />
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
                      disabled={index <= 0}
                      onSelect={() => void moveProject(index, index - 1)}
                    >
                      Move up
                    </Menu.Item>
                    <Menu.Item
                      className={menuItemClass}
                      disabled={index < 0 || index === orderable.length - 1}
                      onSelect={() => void moveProject(index, index + 1)}
                    >
                      Move down
                    </Menu.Item>
                    <Menu.Separator className="my-1 h-px bg-border" />
                    <Menu.Item
                      className={`${menuItemClass} text-destructive`}
                      onSelect={() =>
                        setNested({ kind: "remove-project", id: project.id })
                      }
                    >
                      Remove…
                    </Menu.Item>
                  </>
                )}
              </RowMenu>
              {edit?.kind === "rename" && (
                <div className="w-full">
                  <ProjectRenameForm
                    key={project.id}
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
                    key={project.id}
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
            </li>
          );
        })}
        {editing &&
          unavailable.map((id) => (
            <li key={id} className={rowClass}>
              {spacer}
              <input
                type="checkbox"
                aria-label={`Include Unavailable project in ${editing.name}`}
                checked
                onChange={() => toggleMember(editing.id, id)}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate px-1 text-muted-foreground">
                Unavailable project
              </span>
            </li>
          ))}
      </ul>
      <button
        type="button"
        onClick={() => setNested({ kind: "add-project" })}
        className={addButtonClass}
      >
        + Add project…
      </button>
    </div>
  );

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Spaces and projects"
        description="Pick a space, then check the projects that belong to it."
        compact={compact}
        wide
      >
        <div
          data-activity-manage=""
          className={compact ? "flex flex-col" : "flex min-h-[420px]"}
        >
          {spacesPane}
          {projectsPane}
        </div>
      </Modal>
      {nested?.kind === "space" && (
        <SpaceDialog
          key={`${nested.edit}:${nested.id ?? ""}`}
          kind={nested.edit}
          space={nestedSpace}
          projects={rows}
          compact={compact}
          onSubmit={async ({ name, projectIds }) => {
            if (nested.edit === "create") {
              const id = newSpaceId();
              await saveSpaces([...catalog, { id, name, projectIds }]);
              setEditingId(id);
            } else if (nested.edit === "rename" && nestedSpace) {
              await updateSpace(nestedSpace.id, (space) => ({
                ...space,
                name,
              }));
            } else if (nested.edit === "delete" && nestedSpace) {
              await saveSpaces(
                catalog.filter((space) => space.id !== nestedSpace.id),
              );
            }
          }}
          onClose={() => setNested(null)}
        />
      )}
      {nested?.kind === "add-project" && (
        <AddProjectDialog
          rpc={projects.rpc}
          hosts={hosts}
          defaultHostId={
            rows.find((project) => project.source)?.source?.hostId ??
            hosts.find((host) => host.connected)?.id ??
            hosts[0]?.id ??
            null
          }
          spaceName={editing?.name}
          compact={compact}
          onSubmit={async (input) => {
            const created = await projects.rpc.call("createProject", input);
            if (editing)
              await updateSpace(editing.id, (space) => ({
                ...space,
                projectIds: [...space.projectIds, created.id],
              }));
            projects.refresh();
          }}
          onClose={() => setNested(null)}
        />
      )}
      {removing && (
        <RemoveProjectDialog
          projectName={removing.name}
          threadCount={threadCounts.get(removing.id) ?? 0}
          compact={compact}
          onSubmit={async () => {
            await projects.rpc.call("deleteProject", {
              projectId: removing.id,
            });
            // Drop the project from every space so none keeps a dangling member.
            if (catalog.some((space) => space.projectIds.includes(removing.id)))
              await saveSpaces(
                catalog.map((space) => ({
                  ...space,
                  projectIds: space.projectIds.filter(
                    (id) => id !== removing.id,
                  ),
                })),
              );
            projects.refresh();
          }}
          onClose={() => setNested(null)}
        />
      )}
    </>
  );
}
