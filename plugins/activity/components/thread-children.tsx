import { useId, useState, type ReactNode } from "react";
import {
  CHILD_PAGE_SIZE,
  MAX_NESTING_DEPTH,
  containsThread,
  flattenDescendants,
  type ThreadNode,
} from "../lib/thread-tree";

export function ThreadChildren({
  nodes,
  parentTitle,
  depth,
  activeThreadId,
  renderRow,
}: {
  nodes: ThreadNode[];
  parentTitle: string;
  depth: number;
  activeThreadId: string | null;
  renderRow: (node: ThreadNode, depth: number) => ReactNode;
}) {
  const id = useId();
  const [limit, setLimit] = useState(CHILD_PAGE_SIZE);
  const flat = depth === MAX_NESTING_DEPTH;
  const relationship = flat ? "descendants" : "children";
  const items = flat ? flattenDescendants(nodes) : nodes;
  // Opening a thread outside the sidebar must not leave its row hidden.
  // Include its path without also mounting every preceding sibling.
  const activeIndex = items.findIndex((node) =>
    containsThread(node, activeThreadId),
  );
  const shown = items.filter(
    (_, index) => index < limit || index === activeIndex,
  );
  const remaining = items.length - shown.length;
  const expanded = limit > CHILD_PAGE_SIZE;
  const buttonClass =
    "flex min-h-8 items-center gap-2 rounded px-2 text-xs text-[var(--subtle-foreground)] outline-none hover:bg-accent hover:text-foreground active:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11";
  const collapse = () => setLimit(CHILD_PAGE_SIZE);
  return (
    <ul
      id={id}
      data-thread-children-depth={depth}
      aria-label={`${flat ? "Descendants" : "Children"} of ${parentTitle}`}
      className="m-0 list-none p-0"
    >
      {shown.map((node) => renderRow(node, depth))}
      {(remaining > 0 || expanded) && (
        <li
          className="flex flex-wrap items-center gap-x-1"
          style={{ paddingLeft: `${1.25 + depth * 1.5}rem` }}
        >
          <button
            type="button"
            aria-controls={id}
            aria-expanded={expanded}
            aria-label={
              remaining > 0
                ? `Show more ${relationship} of ${parentTitle}, ${remaining} hidden`
                : `Show fewer ${relationship} of ${parentTitle}`
            }
            className={buttonClass}
            onClick={
              remaining > 0
                ? () => setLimit((value) => value + CHILD_PAGE_SIZE)
                : collapse
            }
          >
            {remaining > 0 ? "Show more" : "Show less"}
            {remaining > 0 && <span aria-hidden="true">· {remaining}</span>}
          </button>
          {remaining > 0 && expanded && (
            <button
              type="button"
              aria-label={`Show fewer ${relationship} of ${parentTitle}`}
              aria-controls={id}
              className={buttonClass}
              onClick={(event) => {
                // This secondary control disappears after collapsing.
                (
                  event.currentTarget
                    .previousElementSibling as HTMLButtonElement
                )?.focus();
                collapse();
              }}
            >
              Show less
            </button>
          )}
        </li>
      )}
    </ul>
  );
}
