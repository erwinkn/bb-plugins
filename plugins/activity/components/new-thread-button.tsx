import * as Menu from "@radix-ui/react-dropdown-menu";
import { inScope, type Scope, type ScopeProject } from "../lib/spaces";
import { MenuContent, menuItemClass } from "./menus";

const buttonClass =
  "rounded px-2 py-1 text-lg leading-none text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

// New thread stays in the current scope: the active project when it belongs,
// otherwise the only member, otherwise a choice among members.
export function NewThreadButton({
  scope,
  activeProjectId,
  projects,
  onOpen,
}: {
  scope: Scope;
  activeProjectId: string | null;
  projects: ScopeProject[];
  onOpen: (projectId?: string) => void;
}) {
  const members = projects.filter((project) => inScope(scope, project.id));
  // A space with no listed projects has nowhere in scope to open a thread;
  // BB's default project would land outside the space.
  if (scope.kind !== "all" && members.length === 0)
    return (
      <button
        type="button"
        aria-label="New thread"
        aria-disabled="true"
        title="Add projects to this space first."
        className={`${buttonClass} cursor-default opacity-50 hover:bg-transparent`}
      >
        +
      </button>
    );
  const direct =
    scope.kind === "all" || (activeProjectId && inScope(scope, activeProjectId))
      ? (activeProjectId ?? undefined)
      : members.length === 1
        ? members[0].id
        : null;
  if (direct !== null)
    return (
      <button
        type="button"
        aria-label="New thread"
        onClick={() => onOpen(direct)}
        className={buttonClass}
      >
        +
      </button>
    );
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="New thread" className={buttonClass}>
        +
      </Menu.Trigger>
      <MenuContent>
        <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
          New thread in
        </Menu.Label>
        {members.map((project) => (
          <Menu.Item
            key={project.id}
            className={menuItemClass}
            onSelect={() => onOpen(project.id)}
          >
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
          </Menu.Item>
        ))}
      </MenuContent>
    </Menu.Root>
  );
}
