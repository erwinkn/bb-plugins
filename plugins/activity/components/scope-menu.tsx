import * as Menu from "@radix-ui/react-dropdown-menu";
import { useRef } from "react";
import type { SpaceCatalog } from "../lib/space-schema";
import { inScope, scopeLabel, type Scope } from "../lib/spaces";
import { MenuContent, menuItemClass } from "./menus";

export interface ScopeProject {
  id: string;
  name: string;
}
export type SpaceEdit = "create" | "rename" | "delete";

const chevron = (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-3.5 shrink-0 text-muted-foreground"
  >
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </svg>
);

// The Threads heading is the scope selector: saved spaces above, the project
// checklist below. In All projects every project is checked; unchecking one
// starts an ad-hoc selection. With a space selected, toggling edits the space.
export function ScopeMenu({
  scope,
  catalog,
  projects,
  onSelectAll,
  onSelectSpace,
  onToggleProject,
  onEdit,
}: {
  scope: Scope;
  catalog: SpaceCatalog;
  projects: ScopeProject[];
  onSelectAll: () => void;
  onSelectSpace: (id: string) => void;
  onToggleProject: (id: string) => void;
  onEdit: (edit: SpaceEdit) => void;
}) {
  const label = scopeLabel(scope);
  // An edit action opens a form that needs focus. Radix would otherwise move
  // focus back to the trigger after the menu closes.
  const editing = useRef(false);
  const edit = (kind: SpaceEdit) => {
    editing.current = true;
    onEdit(kind);
  };
  const radioValue =
    scope.kind === "space" ? scope.space.id : scope.kind === "all" ? "all" : "";
  // Members that BB no longer lists stay visible so they can be removed.
  const listed = new Set(projects.map((project) => project.id));
  const unavailable = [...(scope.projectIds ?? [])]
    .filter((id) => !listed.has(id))
    .map((id) => ({ id, name: "Unavailable project" }));
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Threads: ${label}`}
        title="Choose which projects to show"
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-left text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">{label}</span>
        {chevron}
      </Menu.Trigger>
      <MenuContent
        align="start"
        className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (!editing.current) return;
          editing.current = false;
          event.preventDefault();
        }}
      >
        <Menu.RadioGroup
          value={radioValue}
          onValueChange={(value) =>
            value === "all" ? onSelectAll() : onSelectSpace(value)
          }
        >
          <Menu.RadioItem value="all" className={menuItemClass}>
            <span className="flex-1">All projects</span>
            <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
          </Menu.RadioItem>
          {catalog.spaces.map((space) => (
            <Menu.RadioItem
              key={space.id}
              value={space.id}
              className={menuItemClass}
            >
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
          {scope.kind === "space" ? `Projects in ${scope.space.name}` : "Projects"}
        </Menu.Label>
        {[...projects, ...unavailable].map((project) => (
          <Menu.CheckboxItem
            key={project.id}
            checked={inScope(scope, project.id)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggleProject(project.id)}
            className={menuItemClass}
          >
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
          </Menu.CheckboxItem>
        ))}
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item className={menuItemClass} onSelect={() => edit("create")}>
          New space…
        </Menu.Item>
        {scope.kind === "space" && (
          <>
            <Menu.Item className={menuItemClass} onSelect={() => edit("rename")}>
              Rename space…
            </Menu.Item>
            <Menu.Item className={menuItemClass} onSelect={() => edit("delete")}>
              Delete space…
            </Menu.Item>
          </>
        )}
      </MenuContent>
    </Menu.Root>
  );
}
