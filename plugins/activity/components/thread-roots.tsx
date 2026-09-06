import { useId, useState, type ReactNode } from "react";
import { containsThread, type ThreadNode } from "../lib/thread-tree";

type DraftProject = { id: string; name: string };

export function ThreadRoots({
  label,
  pageSize,
  nodes,
  drafts,
  activeThreadId,
  renderRow,
  renderDraft,
}: {
  label: string;
  pageSize: number;
  nodes: ThreadNode[];
  drafts: DraftProject[];
  activeThreadId: string | null;
  renderRow: (node: ThreadNode) => ReactNode;
  renderDraft: (project: DraftProject) => ReactNode;
}) {
  const id = useId();
  const [limit, setLimit] = useState(pageSize);
  const activeIndex = nodes.findIndex((node) =>
    containsThread(node, activeThreadId),
  );
  // Slice before rendering so hidden rows do not mount their SDK hooks.
  const shown = nodes.filter(
    (_, index) => index < limit || index === activeIndex,
  );
  const shownDrafts = drafts.slice(0, Math.max(0, limit - nodes.length));
  const remaining =
    nodes.length + drafts.length - shown.length - shownDrafts.length;
  const expanded = limit > pageSize;
  const collapse = () => setLimit(pageSize);
  const buttonClass =
    "flex min-h-8 items-center gap-2 rounded px-2 text-xs text-[var(--subtle-foreground)] outline-none hover:bg-accent hover:text-foreground active:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11";
  return (
    <ul id={id} aria-label={`${label} threads`} className="m-0 list-none p-0">
      {shown.map(renderRow)}
      {shownDrafts.map(renderDraft)}
      {(remaining > 0 || expanded) && (
        <li className="flex flex-wrap items-center gap-x-1 pl-6">
          <button
            type="button"
            aria-controls={id}
            aria-expanded={expanded}
            aria-label={
              remaining > 0
                ? `Show more ${label} threads, ${remaining} hidden`
                : `Show fewer ${label} threads`
            }
            className={buttonClass}
            onClick={
              remaining > 0
                ? () => setLimit((value) => value + pageSize)
                : collapse
            }
          >
            {remaining > 0 ? "Show more" : "Show less"}
            {remaining > 0 && <span aria-hidden="true">· {remaining}</span>}
          </button>
          {remaining > 0 && expanded && (
            <button
              type="button"
              aria-label={`Show fewer ${label} threads`}
              aria-controls={id}
              className={buttonClass}
              onClick={(event) => {
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
