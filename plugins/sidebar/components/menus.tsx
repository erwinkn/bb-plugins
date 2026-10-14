import type { ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { usePortalScopeProps } from "../lib/portal-scope";
import { STATUS_HELP, STATUS_LABEL, STATUSES } from "../lib/status";
import {
  toggleValue,
  updateState,
  useClientState,
  type ThreadListing,
} from "../lib/client-state";
import { StatusIcon } from "./status-icon";
import { ArchiveIcon } from "./archive-icon";
import { HostIcon } from "../lib/host-icon";
import { sectionActionClass } from "./section-header";

export const menuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";
export function MenuContent({
  children,
  align = "end",
  className = "",
  onCloseAutoFocus,
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const scope = usePortalScopeProps();
  return (
    <Menu.Portal>
      <Menu.Content
        {...scope}
        align={align}
        sideOffset={5}
        onCloseAutoFocus={onCloseAutoFocus}
        className={`z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg ${className}`}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}
function SubMenuContent({ children }: { children: ReactNode }) {
  const scope = usePortalScopeProps();
  return (
    <Menu.Portal>
      <Menu.SubContent
        {...scope}
        sideOffset={4}
        className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {children}
      </Menu.SubContent>
    </Menu.Portal>
  );
}

const GROUPING_LABEL: Record<ThreadListing["groupBy"], string> = {
  none: "None",
  status: "Status",
  project: "Project",
};

/** The current order in one word, shown next to Ordering. */
export function orderingLabel(listing: ThreadListing): string {
  const descending = listing.sortDirection === "descending";
  return listing.sortBy === "updated"
    ? descending
      ? "Recent"
      : "Least recent"
    : descending
      ? "Newest"
      : "Oldest";
}

/**
 * The options of the thread list under the Initiatives list: Grouping and
 * Ordering submenus (each naming its current value), then which statuses,
 * Snoozed and Archived show. Choices stay on this client.
 */
export function ListingMenu() {
  const state = useClientState();
  const listing = state.listing;
  const set = (patch: Partial<ThreadListing>) =>
    updateState((current) => ({
      ...current,
      listing: { ...current.listing, ...patch },
    }));
  const subTriggerClass = `${menuItemClass} data-[state=open]:bg-accent`;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Thread list options"
        title="Group, order and filter threads"
        className={sectionActionClass}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
        </svg>
      </Menu.Trigger>
      <MenuContent>
        <Menu.Sub>
          <Menu.SubTrigger className={subTriggerClass}>
            <span className="flex-1">Grouping</span>
            <span className="text-muted-foreground">
              {GROUPING_LABEL[listing.groupBy]}
            </span>
            <HostIcon name="ChevronRight" className="size-3.5 shrink-0" />
          </Menu.SubTrigger>
          <SubMenuContent>
            <Menu.RadioGroup
              value={listing.groupBy}
              onValueChange={(groupBy) =>
                set({
                  groupBy:
                    groupBy === "status" || groupBy === "project"
                      ? groupBy
                      : "none",
                })
              }
            >
              {(["none", "status", "project"] as const).map((value) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  className={menuItemClass}
                >
                  <span className="flex-1">{GROUPING_LABEL[value]}</span>
                  <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </SubMenuContent>
        </Menu.Sub>
        <Menu.Sub>
          <Menu.SubTrigger className={subTriggerClass}>
            <span className="flex-1">Ordering</span>
            <span className="text-muted-foreground">
              {orderingLabel(listing)}
            </span>
            <HostIcon name="ChevronRight" className="size-3.5 shrink-0" />
          </Menu.SubTrigger>
          <SubMenuContent>
            <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
              Sort by
            </Menu.Label>
            <Menu.RadioGroup
              value={listing.sortBy}
              onValueChange={(sortBy) =>
                set({ sortBy: sortBy === "created" ? "created" : "updated" })
              }
            >
              {(["updated", "created"] as const).map((value) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  className={menuItemClass}
                >
                  <span className="flex-1">
                    {value === "created" ? "Date created" : "Date updated"}
                  </span>
                  <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.RadioGroup
              value={listing.sortDirection}
              onValueChange={(sortDirection) =>
                set({
                  sortDirection:
                    sortDirection === "ascending" ? "ascending" : "descending",
                })
              }
            >
              {(["descending", "ascending"] as const).map((value) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  className={menuItemClass}
                >
                  <span className="flex-1">
                    {value === "ascending" ? "Oldest first" : "Newest first"}
                  </span>
                  <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </SubMenuContent>
        </Menu.Sub>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Label className="px-2 py-1 text-xs text-muted-foreground">
          Show
        </Menu.Label>
        <ShowItems />
      </MenuContent>
    </Menu.Root>
  );
}

/** Status, Snoozed and Archived visibility. */
function ShowItems() {
  const state = useClientState();
  return (
    <>
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
        checked={state.showSnoozed}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(showSnoozed) =>
          updateState((current) => ({
            ...current,
            showSnoozed: showSnoozed === true,
          }))
        }
        className={menuItemClass}
      >
        <HostIcon
          name="Clock"
          fallback="Circle"
          className="size-4 shrink-0 text-[var(--subtle-foreground)]"
        />
        <span className="flex-1">Snoozed</span>
        <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
      </Menu.CheckboxItem>
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
        <ArchiveIcon />
        <span className="flex-1">Archived</span>
        <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
      </Menu.CheckboxItem>
    </>
  );
}
