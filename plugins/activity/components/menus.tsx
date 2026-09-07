import type { ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { usePortalScopeProps } from "../lib/portal-scope";
import { STATUS_HELP, STATUS_LABEL, STATUSES } from "../lib/status";
import { toggleValue, updateState, useClientState } from "../lib/client-state";
import { StatusIcon } from "./status-icon";

export const menuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";
export function MenuContent({ children }: { children: ReactNode }) {
  const scope = usePortalScopeProps();
  return (
    <Menu.Portal>
      <Menu.Content
        {...scope}
        align="end"
        sideOffset={5}
        className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}
export function DisplayMenu() {
  const state = useClientState();
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Threads display options"
        title="Group and sort threads"
        className="rounded p-1.5 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 5h14M3 10h14M3 15h14" />
          <path d="M7 3v4m6 1v4m-7 1v4" strokeWidth="3" />
        </svg>
      </Menu.Trigger>
      <MenuContent>
        <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
          Group by
        </Menu.Label>
        <Menu.RadioGroup
          value={state.groupBy}
          onValueChange={(groupBy) =>
            updateState((current) => ({
              ...current,
              groupBy: groupBy === "project" ? "project" : "status",
            }))
          }
        >
          {(["status", "project"] as const).map((value) => (
            <Menu.RadioItem key={value} value={value} className={menuItemClass}>
              <span className="flex-1">
                {value === "status" ? "Status" : "Project"}
              </span>
              <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
          Sort by
        </Menu.Label>
        <Menu.RadioGroup
          value={state.sortBy}
          onValueChange={(sortBy) =>
            updateState((current) => ({
              ...current,
              sortBy: sortBy === "created" ? "created" : "updated",
            }))
          }
        >
          {(["updated", "created"] as const).map((value) => (
            <Menu.RadioItem key={value} value={value} className={menuItemClass}>
              <span className="flex-1">
                {value === "created" ? "Date created" : "Date updated"}
              </span>
              <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
          Show statuses
        </Menu.Label>
        {STATUSES.map((status) => (
          <Menu.CheckboxItem
            key={status}
            checked={!state.hidden.includes(status)}
            title={STATUS_HELP[status]}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() =>
              updateState((current) => ({
                ...current,
                hidden: toggleValue(current.hidden, status),
              }))
            }
            className={menuItemClass}
          >
            <StatusIcon status={status} />
            <span className="flex-1">{STATUS_LABEL[status]}</span>
            <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
          </Menu.CheckboxItem>
        ))}
        <Menu.CheckboxItem
          checked={state.showArchives}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(showArchives) =>
            updateState((current) => ({
              ...current,
              showArchives: showArchives === true,
            }))
          }
          className={menuItemClass}
        >
          <span aria-hidden="true" className="size-4" />
          <span className="flex-1">Archived</span>
          <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
        </Menu.CheckboxItem>
      </MenuContent>
    </Menu.Root>
  );
}
