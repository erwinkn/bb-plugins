import type { ReactNode } from "react";
import { HostIcon } from "../lib/host-icon";
import type { HostIconName } from "../lib/host-icon-names";

/**
 * The link of a top-level sidebar entry (an Initiative row, the Advisor entry):
 * full-width, rounded, with the shared hover and selected states.
 */
export function entryRowClass(active: boolean) {
  return `relative flex min-w-0 flex-1 select-none items-center gap-3 rounded-lg px-3 py-3 no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`;
}

/**
 * The inside of an entry link: the hue accent, the icon tile, the title over a
 * one-line status, then a trailing indicator. Without a hue (the Advisor) the
 * accent is dropped and the tile takes the text color.
 */
export function EntryRowBody({
  hue,
  icon,
  fallback,
  title,
  metadata,
  children,
}: {
  hue?: number;
  icon: HostIconName;
  fallback: HostIconName;
  title: string;
  metadata?: string;
  children?: ReactNode;
}) {
  return (
    <>
      {hue !== undefined && (
        <span
          aria-hidden="true"
          data-project-hue={hue}
          className="absolute bottom-3 left-0 top-3 w-0.5 rounded-full bg-current opacity-70"
        />
      )}
      <span
        aria-hidden="true"
        data-project-hue={hue}
        data-project-icon={icon}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-current/10"
      >
        <HostIcon name={icon} fallback={fallback} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5">
          {title}
        </span>
        {metadata && (
          <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
            {metadata}
          </span>
        )}
      </span>
      {children}
    </>
  );
}
