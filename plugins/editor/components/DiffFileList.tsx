/**
 * The list of files in a comparison. It is flat, because a comparison is
 * usually short and the directory matters less than the file. Files with no
 * line comparison stay in the list and can still be selected, so that the
 * pane can say why they have none.
 */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { DiffFileActions } from "./DiffFileActions";
import type { DiffEntry, DiffTarget } from "@/lib/diff-contract";
import { changeLabel, unavailableReason } from "@/lib/diff-view-state";
import { FileIcon, RefreshGlyph } from "./icons";

export interface DiffFileListProps {
  threadId: string;
  target: DiffTarget;
  onChanged: () => void;
  files: readonly DiffEntry[];
  /** Short name of what is compared, shown as the list heading. */
  title: string;
  activePath: string | null;
  /** Paths with unsaved edits, for the mark beside the file. */
  dirtyPaths: ReadonlySet<string>;
  isLoading: boolean;
  error: string | null;
  /** A comparison that returned no files can still have something to say. */
  message: string | null;
  truncated: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}

export function DiffFileList({
  threadId, target, onChanged,
  files,
  title,
  activePath,
  dirtyPaths,
  isLoading,
  error,
  message,
  truncated,
  onSelect,
  onRefresh,
}: DiffFileListProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath]);

  return (
    <div className="group/list flex h-full min-h-0 flex-col bg-background" data-testid="diff-file-list">
      <div className="flex h-9 shrink-0 items-center gap-0.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/list:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh the change list"
            className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            <RefreshGlyph className={cn(isLoading && "animate-spin")} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {error !== null ? <Note tone="error">{error}</Note> : null}
        {error === null && files.length === 0 ? (
          <Note tone="muted">{message ?? (isLoading ? "Loading the change list…" : "Nothing changed in this comparison.")}</Note>
        ) : null}
        <ul role="list" className="flex flex-col">
          {files.map((entry) => (
            <li key={`${JSON.stringify(target)}:${entry.path}`}>
              <DiffFileActions entry={entry} target={target} threadId={threadId} onChanged={onChanged}>
                <Row
                  entry={entry}
                  active={entry.path === activePath}
                  dirty={dirtyPaths.has(entry.path)}
                  rowRef={entry.path === activePath ? activeRef : undefined}
                  onSelect={() => onSelect(entry.path)}
                />
              </DiffFileActions>
            </li>
          ))}
        </ul>
        {truncated ? <Note tone="muted">The list shows the first files only. This comparison is larger.</Note> : null}
      </div>
    </div>
  );
}

function Row({
  entry,
  active,
  dirty,
  rowRef,
  onSelect,
}: {
  entry: DiffEntry;
  active: boolean;
  dirty: boolean;
  rowRef?: React.Ref<HTMLButtonElement>;
  onSelect: () => void;
}) {
  const name = entry.path.split("/").at(-1) ?? entry.path;
  const directory = entry.path.slice(0, entry.path.length - name.length).replace(/\/$/, "");
  const unavailable = unavailableReason(entry);
  const label = changeLabel(entry);
  const title =
    (entry.previousPath === null ? entry.path : `${entry.previousPath} → ${entry.path}`) +
    `\n${label}${unavailable === null ? "" : `\n${unavailable}`}`;
  return (
    <button
      type="button"
      ref={rowRef}
      onClick={onSelect}
      title={title}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 pl-3 text-left text-[13px] leading-5",
        "hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
        "max-md:pointer-coarse:min-h-8",
        active ? "bg-state-hover text-foreground" : "text-foreground/85",
      )}
    >
      <FileIcon path={name} className={cn("shrink-0", active ? "text-file-accent" : "text-muted-foreground", unavailable !== null && "opacity-50")} />
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", unavailable !== null && "text-muted-foreground")}>
        <span className="shrink-0 truncate">{name}</span>
        {directory === "" ? null : <span className="min-w-0 truncate text-[11px] text-subtle-foreground">{directory}</span>}
      </span>
      {dirty ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-foreground"
          role="status"
          aria-label="Unsaved changes"
          title="Unsaved changes"
        />
      ) : null}
      <ChangeMark entry={entry} unavailable={unavailable !== null} label={label} />
    </button>
  );
}

/**
 * What the row says on its right: the changed line counts for an ordinary
 * edit, a plus or minus in the same colors for a file that is new or gone,
 * and the words for anything else, because "renamed" or "no comparison"
 * matters more than a count.
 */
function ChangeMark({ entry, unavailable, label }: { entry: DiffEntry; unavailable: boolean; label: string }) {
  if (unavailable) return <span className="shrink-0 text-[11px] text-subtle-foreground">no comparison</span>;
  if (entry.changeKind === "added" || entry.origin === "untracked") {
    return <span className="shrink-0 font-mono text-xs font-medium text-success-foreground" role="img" aria-label={label} title={label}>+</span>;
  }
  if (entry.changeKind === "deleted") {
    return <span className="shrink-0 font-mono text-xs font-medium text-destructive" role="img" aria-label={label} title={label}>&minus;</span>;
  }
  if (entry.changeKind !== "modified" || entry.origin !== "tracked") {
    return <span className="shrink-0 text-[11px] text-subtle-foreground">{label}</span>;
  }
  if (entry.additions === 0 && entry.deletions === 0) {
    return <span className="shrink-0 text-[11px] text-subtle-foreground">{label.toLowerCase()}</span>;
  }
  return (
    <span
      className="flex shrink-0 items-center gap-1 font-mono text-[11px]"
      aria-label={`${entry.additions} lines added, ${entry.deletions} lines removed`}
    >
      {entry.additions > 0 ? <span className="text-success-foreground">+{entry.additions}</span> : null}
      {entry.deletions > 0 ? <span className="text-destructive">&minus;{entry.deletions}</span> : null}
    </span>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone: "error" | "muted" }) {
  return <p className={cn("px-3 py-2 text-xs", tone === "error" ? "text-destructive" : "text-muted-foreground")}>{children}</p>;
}
