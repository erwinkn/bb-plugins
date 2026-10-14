import { useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import { usePortalScopeProps } from "../lib/portal-scope";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { menuItemClass } from "./menus";

export type ProjectHeaderAction = "new-thread" | "rename" | "remove";

// Right-click or long-press a project header for the project's actions. The
// caller renders the inline forms under the header.
export function ProjectHeaderMenu({
  projectId,
  projectName,
  isPersonal,
  onAction,
  children,
}: {
  projectId: string;
  projectName: string;
  isPersonal: boolean;
  onAction: (action: ProjectHeaderAction) => void;
  children: ReactNode;
}) {
  const scope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const longPress = useLongPressMenu(open);
  // Rename and Remove open a form under the header; keep focus there instead
  // of letting Radix return it here.
  const editing = useRef(false);
  const act = (action: ProjectHeaderAction) => {
    editing.current = action !== "new-thread";
    onAction(action);
  };
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
          {!isPersonal && (
            <Menu.Item className={menuItemClass} onSelect={() => act("rename")}>
              Rename…
            </Menu.Item>
          )}
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
