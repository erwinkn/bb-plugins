import { useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import {
  folderName,
  PROJECT_NAME_MAX,
  type ManagedProject,
} from "../lib/project-schema";
import { SPACE_NAME_MAX, type Space } from "../lib/space-schema";
import { moveItem, newSpaceId, type Scope } from "../lib/spaces";
import { toggleValue } from "../lib/client-state";
import { usePortalScopeProps } from "../lib/portal-scope";
import type { SpacesState } from "../lib/use-spaces";
import { useProjects } from "../lib/use-projects";
import { InlineForm, NameField } from "./inline-form";
import { MenuContent, menuItemClass } from "./menus";
import { PathField } from "./path-field";

type SpaceEdit = { kind: "create" } | { kind: "rename" | "delete"; id: string };
type ProjectEdit =
  { kind: "add" } | { kind: "rename" | "folder" | "remove"; id: string };
type Drag = { list: "spaces" | "projects"; id: string };

const rowClass =
  "group flex items-center gap-1 rounded px-1 py-1 text-sm hover:bg-accent/60";
const sectionTitleClass =
  "mb-1 mt-4 flex items-center px-2 text-xs font-medium text-[var(--subtle-foreground)] first:mt-0";
const addButtonClass =
  "mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu.Root>
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

// One place to see and change spaces and projects. Space edits save to the
// plugin catalog; project edits go through BB and show up in every client.
export function ManageView({
  spaces,
  scope,
  sidebarProjects,
  threadCounts,
  activeProjectId,
  compact,
  onSelectAll,
  onSelectSpace,
  onNewThread,
  onBack,
  report,
}: {
  spaces: SpacesState;
  scope: Scope;
  sidebarProjects: readonly PluginSidebarProject[];
  threadCounts: ReadonlyMap<string, number>;
  activeProjectId: string | null;
  compact: boolean;
  onSelectAll: () => void;
  onSelectSpace: (id: string) => void;
  onNewThread: (projectId: string) => void;
  onBack: () => void;
  report: (cause: unknown) => void;
}) {
  const signature = sidebarProjects
    .map((project) => `${project.id}:${project.name}`)
    .join("|");
  const projects = useProjects(signature);
  const portal = usePortalScopeProps();
  const [spaceEdit, setSpaceEdit] = useState<SpaceEdit | null>(null);
  const [projectEdit, setProjectEdit] = useState<ProjectEdit | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const catalog = spaces.catalog.spaces;
  const selected = scope.kind === "space" ? scope.space : null;
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
  const unavailable = selected
    ? selected.projectIds.filter((id) => !listed.has(id))
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
    if (list === "spaces") {
      moveSpace(
        catalog.findIndex((space) => space.id === drag.id),
        catalog.findIndex((space) => space.id === targetId),
      );
    } else {
      void moveProject(
        orderable.findIndex((project) => project.id === drag.id),
        orderable.findIndex((project) => project.id === targetId),
      );
    }
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
  const seedProjectIds = activeProjectId ? [activeProjectId] : [];
  const activeName = rows.find(
    (project) => project.id === activeProjectId,
  )?.name;

  return (
    <div data-activity-manage="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <button
          type="button"
          aria-label="Back to threads"
          onClick={onBack}
          className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden="true">‹</span> Threads
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
          Spaces and projects
        </h2>
      </div>
      <div
        className={`px-2 pb-3 ${compact ? "" : "min-h-0 flex-1 overflow-y-auto"}`}
      >
        <h3 className={sectionTitleClass}>Spaces</h3>
        <ul aria-label="Spaces" className="m-0 list-none p-0">
          <li className={rowClass}>
            {!compact && <span className="w-4" aria-hidden="true" />}
            <button
              type="button"
              aria-current={scope.kind === "all" ? "true" : undefined}
              onClick={onSelectAll}
              className={`min-w-0 flex-1 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${scope.kind === "all" ? "font-medium" : ""}`}
            >
              All projects
            </button>
          </li>
          {catalog.map((space, index) => (
            <li
              key={space.id}
              className={`${rowClass} ${dropClass(space.id)}`}
              {...dragProps("spaces", space.id)}
            >
              {!compact && (
                <Grip
                  drag={{ list: "spaces", id: space.id }}
                  onStart={setDrag}
                  onEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                />
              )}
              <button
                type="button"
                aria-current={selected?.id === space.id ? "true" : undefined}
                onClick={() => onSelectSpace(space.id)}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === space.id ? "font-medium" : ""}`}
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
                    setSpaceEdit({ kind: "rename", id: space.id })
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
                    setSpaceEdit({ kind: "delete", id: space.id })
                  }
                >
                  Delete…
                </Menu.Item>
              </RowMenu>
            </li>
          ))}
        </ul>
        {spaceEdit?.kind === "create" && (
          <SpaceNameForm
            label="New space"
            submitLabel="Create"
            hint={
              activeName
                ? `Starts with ${activeName}. Check more projects below.`
                : "Check its projects below after creating it."
            }
            onSubmit={async (name) => {
              const id = newSpaceId();
              await saveSpaces([
                ...catalog,
                { id, name, projectIds: seedProjectIds },
              ]);
              onSelectSpace(id);
            }}
            onClose={() => setSpaceEdit(null)}
          />
        )}
        {spaceEdit?.kind === "rename" && (
          <SpaceNameForm
            key={spaceEdit.id}
            label="Rename space"
            submitLabel="Save"
            initial={catalog.find((space) => space.id === spaceEdit.id)?.name}
            onSubmit={(name) =>
              updateSpace(spaceEdit.id, (space) => ({ ...space, name })).then(
                () => undefined,
              )
            }
            onClose={() => setSpaceEdit(null)}
          />
        )}
        {spaceEdit?.kind === "delete" && (
          <InlineForm
            key={spaceEdit.id}
            label="Delete space"
            submitLabel="Delete"
            destructive
            onSubmit={async () => {
              await saveSpaces(
                catalog.filter((space) => space.id !== spaceEdit.id),
              );
              if (selected?.id === spaceEdit.id) onSelectAll();
            }}
            onClose={() => setSpaceEdit(null)}
          >
            <p className="w-full text-sm">
              Delete space “
              {catalog.find((space) => space.id === spaceEdit.id)?.name}”?
              Projects and threads are not affected.
            </p>
          </InlineForm>
        )}
        {!spaceEdit && (
          <button
            type="button"
            onClick={() => setSpaceEdit({ kind: "create" })}
            className={addButtonClass}
          >
            + New space…
          </button>
        )}

        <h3 className={sectionTitleClass}>
          <span className="min-w-0 flex-1 truncate">Projects</span>
        </h3>
        {selected && (
          <p className="mb-1 px-2 text-xs text-muted-foreground">
            Checked projects belong to {selected.name}.
          </p>
        )}
        {projects.error && (
          <div role="alert" className="mb-1 px-2 text-xs text-destructive">
            Cannot load project folders.
            <button className="ml-2 underline" onClick={projects.refresh}>
              Retry
            </button>
          </div>
        )}
        <ul aria-label="Projects" className="m-0 list-none p-0">
          {rows.map((project) => {
            const index = orderable.findIndex(
              (entry) => entry.id === project.id,
            );
            const member = selected?.projectIds.includes(project.id) ?? false;
            return (
              <li
                key={project.id}
                className={`${rowClass} ${dropClass(project.id)}`}
                {...(project.isPersonal
                  ? {}
                  : dragProps("projects", project.id))}
              >
                {!compact &&
                  (project.isPersonal ? (
                    <span className="w-4" aria-hidden="true" />
                  ) : (
                    <Grip
                      drag={{ list: "projects", id: project.id }}
                      onStart={setDrag}
                      onEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                    />
                  ))}
                {selected && (
                  <input
                    type="checkbox"
                    aria-label={`Include ${project.name} in ${selected.name}`}
                    checked={member}
                    onChange={() => toggleMember(selected.id, project.id)}
                    className="size-3.5 shrink-0 accent-[var(--primary)]"
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
                          setProjectEdit({ kind: "rename", id: project.id })
                        }
                      >
                        Rename…
                      </Menu.Item>
                      <Menu.Item
                        className={menuItemClass}
                        disabled={!project.source}
                        onSelect={() =>
                          setProjectEdit({ kind: "folder", id: project.id })
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
                          setProjectEdit({ kind: "remove", id: project.id })
                        }
                      >
                        Remove…
                      </Menu.Item>
                    </>
                  )}
                </RowMenu>
              </li>
            );
          })}
          {selected &&
            unavailable.map((id) => (
              <li key={id} className={rowClass}>
                {!compact && <span className="w-4" aria-hidden="true" />}
                <input
                  type="checkbox"
                  aria-label={`Include Unavailable project in ${selected.name}`}
                  checked
                  onChange={() => toggleMember(selected.id, id)}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate px-1 text-muted-foreground">
                  Unavailable project
                </span>
              </li>
            ))}
        </ul>
        {projectEdit?.kind === "rename" && (
          <ProjectRenameForm
            key={projectEdit.id}
            project={rows.find((project) => project.id === projectEdit.id)}
            onSubmit={async (name) => {
              await projects.rpc.call("renameProject", {
                projectId: projectEdit.id,
                name,
              });
              projects.refresh();
            }}
            onClose={() => setProjectEdit(null)}
          />
        )}
        {projectEdit?.kind === "folder" && (
          <ProjectFolderForm
            key={projectEdit.id}
            project={rows.find((project) => project.id === projectEdit.id)}
            rpc={projects.rpc}
            onSubmit={async (path) => {
              await projects.rpc.call("changeProjectFolder", {
                projectId: projectEdit.id,
                path,
              });
              projects.refresh();
            }}
            onClose={() => setProjectEdit(null)}
          />
        )}
        {projectEdit?.kind === "remove" && (
          <ProjectRemoveForm
            key={projectEdit.id}
            project={rows.find((project) => project.id === projectEdit.id)}
            threadCount={threadCounts.get(projectEdit.id) ?? 0}
            onSubmit={async () => {
              await projects.rpc.call("deleteProject", {
                projectId: projectEdit.id,
              });
              // Drop the project from every space so no space keeps a
              // dangling member.
              if (
                catalog.some((space) =>
                  space.projectIds.includes(projectEdit.id),
                )
              )
                await saveSpaces(
                  catalog.map((space) => ({
                    ...space,
                    projectIds: space.projectIds.filter(
                      (id) => id !== projectEdit.id,
                    ),
                  })),
                );
              projects.refresh();
            }}
            onClose={() => setProjectEdit(null)}
          />
        )}
        {projectEdit?.kind === "add" && (
          <AddProjectForm
            rpc={projects.rpc}
            hosts={hosts}
            defaultHostId={
              rows.find((project) => project.source)?.source?.hostId ??
              hosts.find((host) => host.connected)?.id ??
              hosts[0]?.id ??
              null
            }
            spaceName={selected?.name}
            onSubmit={async (input) => {
              const created = await projects.rpc.call("createProject", input);
              if (selected)
                await updateSpace(selected.id, (space) => ({
                  ...space,
                  projectIds: [...space.projectIds, created.id],
                }));
              projects.refresh();
            }}
            onClose={() => setProjectEdit(null)}
          />
        )}
        {!projectEdit && (
          <button
            type="button"
            onClick={() => setProjectEdit({ kind: "add" })}
            className={addButtonClass}
          >
            + Add project…
          </button>
        )}
      </div>
    </div>
  );
}

function SpaceNameForm({
  label,
  submitLabel,
  initial = "",
  hint,
  onSubmit,
  onClose,
}: {
  label: string;
  submitLabel: string;
  initial?: string;
  hint?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <InlineForm
      label={label}
      submitLabel={submitLabel}
      canSubmit={trimmed.length > 0}
      hint={hint}
      onSubmit={() => onSubmit(trimmed)}
      onClose={onClose}
    >
      <NameField
        label="Space name"
        value={name}
        max={SPACE_NAME_MAX}
        onChange={setName}
      />
    </InlineForm>
  );
}

export function ProjectRenameForm({
  project,
  onSubmit,
  onClose,
}: {
  project: ManagedProject | undefined;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const trimmed = name.trim();
  return (
    <InlineForm
      label="Rename project"
      submitLabel="Save"
      canSubmit={trimmed.length > 0 && trimmed !== project?.name}
      onSubmit={() => onSubmit(trimmed)}
      onClose={onClose}
    >
      <NameField
        label="Project name"
        value={name}
        max={PROJECT_NAME_MAX}
        onChange={setName}
      />
    </InlineForm>
  );
}

function ProjectFolderForm({
  project,
  rpc,
  onSubmit,
  onClose,
}: {
  project: ManagedProject | undefined;
  rpc: ReturnType<typeof useProjects>["rpc"];
  onSubmit: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState(project?.source?.path ?? "");
  const [error, setError] = useState<string | null>(null);
  const trimmed = path.trim().replace(/\/+$/, "") || path.trim();
  if (!project?.source) return null;
  return (
    <InlineForm
      label="Change folder"
      submitLabel="Save"
      canSubmit={trimmed.length > 0 && trimmed !== project.source.path}
      hint={
        error ??
        `Folder for ${project.name} on this host. Threads keep their history.`
      }
      onSubmit={() => onSubmit(trimmed)}
      onClose={onClose}
    >
      <PathField
        rpc={rpc}
        hostId={project.source.hostId}
        value={path}
        onChange={setPath}
        onError={setError}
      />
    </InlineForm>
  );
}

export function ProjectRemoveForm({
  project,
  threadCount,
  onSubmit,
  onClose,
}: {
  project: ManagedProject | undefined;
  threadCount: number;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  if (!project) return null;
  const threads =
    threadCount === 1
      ? "its 1 active thread"
      : `its ${threadCount} active threads`;
  return (
    <InlineForm
      label="Remove project"
      submitLabel="Remove"
      destructive
      canSubmit={typed.trim() === project.name}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <p className="w-full text-sm">
        Remove “{project.name}”? This deletes the project from BB together with{" "}
        {threads} and its archive. Files on disk are not touched.
      </p>
      <input
        aria-label="Type the project name to confirm"
        placeholder={project.name}
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setTyped(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </InlineForm>
  );
}

function AddProjectForm({
  rpc,
  hosts,
  defaultHostId,
  spaceName,
  onSubmit,
  onClose,
}: {
  rpc: ReturnType<typeof useProjects>["rpc"];
  hosts: readonly { id: string; name: string; connected: boolean }[];
  defaultHostId: string | null;
  spaceName?: string;
  onSubmit: (input: {
    name: string;
    hostId: string;
    path: string;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [hostId, setHostId] = useState(defaultHostId ?? "");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedPath = path.trim().replace(/\/+$/, "") || path.trim();
  const effectiveName = (nameTouched ? name : folderName(trimmedPath)).trim();
  return (
    <InlineForm
      label="Add project"
      submitLabel="Add"
      canSubmit={
        hostId.length > 0 && trimmedPath.length > 0 && effectiveName.length > 0
      }
      hint={
        error ??
        (spaceName
          ? `The project joins ${spaceName}.`
          : "Pick the folder that holds the repository.")
      }
      onSubmit={() =>
        onSubmit({ name: effectiveName, hostId, path: trimmedPath })
      }
      onClose={onClose}
    >
      {hosts.length > 1 && (
        <select
          aria-label="Host"
          value={hostId}
          onChange={(event) => setHostId(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
              {host.connected ? "" : " (offline)"}
            </option>
          ))}
        </select>
      )}
      <div className="flex w-full items-center gap-2">
        <PathField
          rpc={rpc}
          hostId={hostId}
          value={path}
          onChange={setPath}
          onError={setError}
        />
      </div>
      <NameField
        label="Project name"
        value={nameTouched ? name : folderName(trimmedPath)}
        max={PROJECT_NAME_MAX}
        onChange={(value) => {
          setNameTouched(true);
          setName(value);
        }}
      />
    </InlineForm>
  );
}
