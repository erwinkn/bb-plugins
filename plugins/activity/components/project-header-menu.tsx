import { useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import type { Space } from "../lib/space-schema";
import { usePortalScopeProps } from "../lib/portal-scope";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { menuItemClass } from "./menus";

export type ProjectHeaderAction = "new-thread" | "rename" | "remove" | "manage";

// Right-click or long-press a project header for the project's actions. The
// caller renders the inline forms under the header.
export function ProjectHeaderMenu({
  projectId,
  projectName,
  isPersonal,
  spaces,
  onAction,
  onToggleSpace,
  children,
}: {
  projectId: string;
  projectName: string;
  isPersonal: boolean;
  spaces: readonly Space[];
  onAction: (action: ProjectHeaderAction) => void;
  onToggleSpace: (spaceId: string) => void;
  children: ReactNode;
}) {
  const scope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const longPress = useLongPressMenu(open);
  // Rename opens a form under the header, Remove and Manage open dialogs;
  // keep focus there instead of letting Radix return it to the header.
  const editing = useRef(false);
  const act = (action: ProjectHeaderAction) => {
    editing.current = action !== "new-thread";
    onAction(action);
  };
  const subContentClass =
    "z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg";
  return (
    <Menu.Root onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <div {...longPress} data-project-header={projectId}>
          {children}
        </div>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          {...scope}
          aria-label={`Actions for project ${projectName}`}
          onCloseAutoFocus={(event) => {
            if (!editing.current) return;
            editing.current = false;
            event.preventDefault();
          }}
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <Menu.Item
            className={menuItemClass}
            onSelect={() => act("new-thread")}
          >
            New thread
          </Menu.Item>
          {spaces.length > 0 && (
            <Menu.Sub>
              <Menu.SubTrigger className={menuItemClass}>
                <span className="flex-1">Spaces</span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ›
                </span>
              </Menu.SubTrigger>
              <Menu.Portal>
                <Menu.SubContent
                  {...scope}
                  sideOffset={4}
                  className={subContentClass}
                >
                  {spaces.map((space) => (
                    <Menu.CheckboxItem
                      key={space.id}
                      checked={space.projectIds.includes(projectId)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={() => onToggleSpace(space.id)}
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
          {!isPersonal && (
            <Menu.Item className={menuItemClass} onSelect={() => act("rename")}>
              Rename…
            </Menu.Item>
          )}
          <Menu.Item className={menuItemClass} onSelect={() => act("manage")}>
            Manage spaces and projects…
          </Menu.Item>
          {!isPersonal && (
            <>
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item
                className={`${menuItemClass} text-destructive`}
                onSelect={() => act("remove")}
              >
                Remove…
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
