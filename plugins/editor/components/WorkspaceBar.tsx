/**
 * The workspace picker above a Files or Changes panel: which thread's
 * workspace this tab inspects. Entries come from `useWorkspaces` — the
 * coordinator and the threads under it — and pick requests go through the
 * parent's dirty guard, never straight to a retarget.
 */
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { entryDisplayName, type WorkspaceEntry } from "@/lib/workspace-entries";
import type { WorkspacesState } from "@/lib/use-panel-target";
import { ContextMenu, menuAt, type MenuItem, type MenuState } from "./ContextMenu";
import { BranchGlyph, CheckIcon, ChevronIcon, CloudOffGlyph, FolderIcon, RefreshGlyph } from "./icons";

export interface SwitchConfirm {
  label: string;
  saveAndSwitch: () => void;
  keepAndSwitch: () => void;
  cancel: () => void;
}

export interface WorkspaceBarProps {
  state: WorkspacesState;
  /** The thread this tab currently inspects. */
  targetThreadId: string;
  /** The panel's own thread; its entry reads "This thread". */
  ownThreadId: string;
  inspecting: boolean;
  editingEnabled: boolean;
  onPick: (entry: WorkspaceEntry) => void;
  onSetEditing: (next: boolean) => void;
  /** Retry the workspaces fetch after a failed load. */
  onRefresh: () => void;
}

/** Role plus the metadata a developer checks before trusting a workspace. */
function entryDetail(entry: WorkspaceEntry): string {
  const parts = [
    entry.role === "coordinator"
      ? "Coordinator"
      : entry.role === "adhoc"
        ? "Adhoc thread"
        : entry.role === "worker"
          ? "Worker"
          : entry.role === "review"
            ? "Reviewer"
            : "Thread",
    entry.branch !== null ? `⎇ ${entry.branch}` : null,
    entry.workspaceKind === "managed-worktree" ? "managed worktree" : entry.workspaceKind === "unmanaged-worktree" ? "unmanaged worktree" : null,
    entry.environmentName !== null && entry.environmentName !== entry.branch ? entry.environmentName : null,
    entry.status,
    entry.reason,
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

export function WorkspaceBar({
  state,
  targetThreadId,
  ownThreadId,
  inspecting,
  editingEnabled,
  onPick,
  onSetEditing,
  onRefresh,
}: WorkspaceBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const current = state.entries.find((entry) => entry.threadId === targetThreadId) ?? null;
  // An error state still carries its last good list; a foreign target that
  // is not on it is stale whether the list refreshed or only survived.
  const stale = current === null && targetThreadId !== ownThreadId && (state.kind === "ready" || state.entries.length > 0);

  const items = useMemo<MenuItem[]>(() => {
    const rows: MenuItem[] = [
      { type: "label", label: state.named ? "Initiative workspaces" : "Workspaces" },
      ...state.entries.map(
        (entry): MenuItem =>
          entry.available || entry.threadId === targetThreadId
            ? {
                type: "toggle",
                label: `${entryDisplayName(entry)}${entry.threadId === ownThreadId ? " · this thread" : ""}`,
                title: entryDetail(entry),
                checked: entry.threadId === targetThreadId,
                onToggle: () => onPick(entry),
              }
            : {
                label: `${entryDisplayName(entry)}${entry.threadId === ownThreadId ? " · this thread" : ""}`,
                title: entryDetail(entry),
                disabled: true,
                onSelect: () => {},
              },
      ),
    ];
    if (state.kind === "error") {
      rows.push({ type: "separator" }, { type: "label", label: state.message ?? "The workspace list could not be loaded" });
    }
    if (state.degraded !== null) {
      rows.push({ type: "separator" }, { type: "label", label: state.degraded });
    }
    if (stale) {
      rows.push(
        { type: "separator" },
        { type: "label", label: "Selected target" },
        { label: `${targetThreadId} · unavailable`, icon: <CloudOffGlyph />, disabled: true, onSelect: () => {} },
      );
    }
    rows.push({ type: "separator" }, { label: "Reload workspaces", icon: <RefreshGlyph />, keepOpen: true, onSelect: onRefresh });
    if (inspecting) {
      rows.push({
        type: "toggle",
        label: "Edit this workspace",
        title: "Unsaved work still saves with the usual conflict checks",
        checked: editingEnabled,
        onToggle: (next) => onSetEditing(next),
      });
    }
    return rows;
  }, [state, stale, targetThreadId, ownThreadId, inspecting, editingEnabled, onPick, onSetEditing, onRefresh]);

  const triggerLabel =
    current !== null
      ? `${entryDisplayName(current)}${current.threadId === ownThreadId ? " · this thread" : ""}`
      : stale
        ? "Unavailable workspace"
        : "Workspaces…";

  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background pr-1.5 pl-3">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={current !== null ? entryDetail(current) : state.kind === "error" ? state.message ?? undefined : "Choose a workspace to inspect"}
        onClick={(event) => setMenu(menuAt(event.currentTarget, items, "min-w-64"))}
        className={cn(
          "flex min-w-0 shrink cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-foreground",
          "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        {stale ? <CloudOffGlyph className="text-warning-foreground" /> : current !== null && current.branch !== null ? <BranchGlyph /> : <FolderIcon />}
        <span className="truncate">{triggerLabel}</span>
        <ChevronIcon open className="text-muted-foreground" />
      </button>
      {inspecting ? (
        <span className="shrink-0 rounded-sm bg-surface-recessed px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Inspecting
        </span>
      ) : null}
      {inspecting ? (
        <button
          type="button"
          onClick={() => onSetEditing(!editingEnabled)}
          className={cn(
            "ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs",
            editingEnabled
              ? "font-medium text-foreground hover:bg-state-hover"
              : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {editingEnabled ? <CheckIcon className="text-state-good-foreground" /> : null}
          {editingEnabled ? "Editing on" : "Enable editing"}
        </button>
      ) : null}
      <ContextMenu state={menu && { ...menu, items }} onClose={() => setMenu(null)} />
    </div>
  );
}
