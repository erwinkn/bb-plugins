import type { ReactNode } from "react";

/** A small square control in a section header: the + or the list options. */
export const sectionActionClass =
  "relative flex size-4 items-center justify-center rounded text-[var(--subtle-foreground)] outline-none before:absolute before:-inset-1.5 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground";

/**
 * The muted title over a section of the Initiatives view (Initiatives, then
 * the thread list) with its one action on the right.
 */
export function SectionHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      data-section-header={title}
      className="flex h-7 items-center gap-2 px-2 text-xs text-[var(--subtle-foreground)]"
    >
      <h2 className="m-0 min-w-0 flex-1 truncate text-xs font-medium">
        {title}
      </h2>
      {trailing}
    </div>
  );
}
