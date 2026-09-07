import { useCallback, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ContextMenu, menuAt, type MenuItem, type MenuState } from "./ContextMenu";
import { ArrowLeftIcon, ArrowRightIcon, EditGlyph, FileIcon, MoreIcon, SearchIcon, SidebarLeftGlyph, SidebarRightGlyph } from "./icons";

export type SaveIndicator = "clean" | "dirty" | "saving" | "error";

export interface ToolbarProps {
  path: string;
  indicator: SaveIndicator;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onFind: () => void;
  menuItems: MenuItem[];
  treeOpen: boolean;
  treeSide: "left" | "right";
  onToggleTree: () => void;
  /** For a file with a rendered preview: whether the editor is showing, and the switch. */
  editing?: { active: boolean; onToggle: () => void };
}

/**
 * The row above the editor: history, the file, and on the right the edit
 * switch for previewed files, the menu, find, and the single file-tree
 * toggle (the tree header has none).
 */
export function Toolbar({ path, indicator, canGoBack, canGoForward, onBack, onForward, onFind, menuItems, treeOpen, treeSide, onToggleTree, editing }: ToolbarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const TreeGlyph = treeSide === "right" ? SidebarRightGlyph : SidebarLeftGlyph;
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 bg-background pr-1.5 pl-1">
      <ToolbarButton label="Back" onClick={onBack} disabled={!canGoBack}>
        <ArrowLeftIcon />
      </ToolbarButton>
      <ToolbarButton label="Forward" onClick={onForward} disabled={!canGoForward}>
        <ArrowRightIcon />
      </ToolbarButton>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5">
        <FileIcon path={path} className="text-muted-foreground" />
        <FilePath path={path} />
        <SaveDot indicator={indicator} />
      </div>
      {editing === undefined ? null : (
        <ToolbarButton label={editing.active ? "Show the preview" : "Edit the source"} onClick={editing.onToggle} pressed={editing.active}>
          <EditGlyph />
        </ToolbarButton>
      )}
      <ToolbarButton label="More actions" onClick={(event) => setMenu(menuAt(event.currentTarget, menuItems))} pressed={menu !== null}>
        <MoreIcon />
      </ToolbarButton>
      <ToolbarButton label="Find in file (⌘F)" onClick={onFind}>
        <SearchIcon />
      </ToolbarButton>
      <ToolbarButton label={treeOpen ? "Hide file tree (⌘B)" : "Show file tree (⌘B)"} onClick={onToggleTree} pressed={treeOpen}>
        <TreeGlyph />
      </ToolbarButton>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

function FilePath({ path }: { path: string }) {
  const segments = path.split("/").filter((segment) => segment !== "");
  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(path)
      .then(() => toast.success("Path copied"))
      .catch(() => toast.error("Failed to copy path"));
  }, [path]);
  return (
    <button
      type="button"
      onClick={copy}
      title={`${path}\nClick to copy`}
      aria-label={`Copy path ${path}`}
      className={cn(
        "block min-w-0 cursor-pointer truncate rounded-sm text-left font-mono text-xs leading-5",
        "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      style={{ direction: "rtl", textAlign: "left" }}
    >
      <bdi>
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <span key={`${index}-${segment}`} className={last ? "font-medium text-foreground" : "text-muted-foreground"}>
              {segment}
              {last ? null : <span className="mx-0.5 text-subtle-foreground">/</span>}
            </span>
          );
        })}
      </bdi>
    </button>
  );
}

function SaveDot({ indicator }: { indicator: SaveIndicator }) {
  if (indicator === "clean") return null;
  const label =
    indicator === "saving" ? "Saving…" : indicator === "error" ? "Could not open or save this file" : "Unsaved changes (⌘S to save)";
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center" title={label} role="status" aria-label={label}>
      <span
        className={cn(
          "size-2 rounded-full transition-colors",
          indicator === "saving" && "animate-pulse bg-foreground",
          indicator === "dirty" && "bg-foreground",
          indicator === "error" && "bg-destructive",
        )}
      />
    </span>
  );
}

export function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  className,
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={cn(
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-40",
        pressed && "bg-state-hover text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
