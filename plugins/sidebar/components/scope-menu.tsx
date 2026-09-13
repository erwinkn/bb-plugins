import * as Menu from "@radix-ui/react-dropdown-menu";
import { useRef } from "react";
import type { SpaceCatalog } from "../lib/space-schema";
import { LIBRARY_SCOPE_ID, scopeLabel, type Scope } from "../lib/spaces";
import type { Status } from "../lib/status";
import { HostIcon } from "../lib/host-icon";
import { MenuContent, menuItemClass } from "./menus";
import { StatusIcon } from "./status-icon";

const chevron = (
  <HostIcon
    name="ChevronDown"
    fallback="ArrowDown"
    className="size-3.5 shrink-0 text-muted-foreground"
  />
);

const layers = (
  <HostIcon
    name="Layers"
    fallback="GridView"
    className="size-3.5 shrink-0 text-[var(--bbp-file,var(--timeline-accent))]"
  />
);

const bookmark = (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4 shrink-0 text-muted-foreground"
  >
    <path d="M5 2.5h6a.5.5 0 0 1 .5.5v10l-3.5-2.6L4.5 13V3a.5.5 0 0 1 .5-.5z" />
  </svg>
);

// The Threads heading is the scope selector: All projects, a saved space, or
// the saved-thread library. Everything else lives on the Spaces page.
export function ScopeMenu({
  scope,
  catalog,
  librarySignal,
  onSelectAll,
  onSelectSpace,
  onSelectLibrary,
  onManage,
}: {
  scope: Scope;
  catalog: SpaceCatalog;
  /** Highest-priority status among saved threads; null when none need a look. */
  librarySignal: Status | null;
  onSelectAll: () => void;
  onSelectSpace: (id: string) => void;
  onSelectLibrary: () => void;
  onManage: () => void;
}) {
  const label = scopeLabel(scope);
  // Manage leaves the sidebar for the Spaces page; Radix would otherwise
  // move focus back to the trigger after the menu closes.
  const leaving = useRef(false);
  const manage = () => {
    leaving.current = true;
    onManage();
  };
  const radioValue =
    scope.kind === "space"
      ? scope.space.id
      : scope.kind === "library"
        ? LIBRARY_SCOPE_ID
        : "all";
  const signal =
    librarySignal === "attention"
      ? "Library: a saved thread needs attention"
      : "Library: a saved thread is unread";
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={
          librarySignal && scope.kind !== "library"
            ? `Threads: ${label}. ${signal}.`
            : `Threads: ${label}`
        }
        title="Choose which threads to show"
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-left text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {scope.kind === "space" && layers}
        <span className="min-w-0 truncate">{label}</span>
        {librarySignal && scope.kind !== "library" && (
          <StatusIcon status={librarySignal} size="small" />
        )}
        {chevron}
      </Menu.Trigger>
      <MenuContent
        align="start"
        className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (!leaving.current) return;
          leaving.current = false;
          event.preventDefault();
        }}
      >
        <Menu.RadioGroup
          value={radioValue}
          onValueChange={(value) =>
            value === "all"
              ? onSelectAll()
              : value === LIBRARY_SCOPE_ID
                ? onSelectLibrary()
                : onSelectSpace(value)
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
              {layers}
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.RadioItem
            value={LIBRARY_SCOPE_ID}
            className={menuItemClass}
            title="Saved threads kept out of the active list"
          >
            {bookmark}
            <span className="min-w-0 flex-1 truncate">Library</span>
            {librarySignal && (
              <span role="img" aria-label={signal}>
                <StatusIcon status={librarySignal} size="small" />
              </span>
            )}
            <Menu.ItemIndicator aria-hidden="true">✓</Menu.ItemIndicator>
          </Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item className={menuItemClass} onSelect={manage}>
          Manage spaces…
        </Menu.Item>
      </MenuContent>
    </Menu.Root>
  );
}
