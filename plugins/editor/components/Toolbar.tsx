import { useCallback } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ExternalIcon, FileIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, RotateIcon } from "./icons";

export type SaveIndicator = "clean" | "dirty" | "saving" | "error";

export interface ToolbarProps {
  path: string;
  indicator: SaveIndicator;
  isRefreshing: boolean;
  onRefresh: () => void;
  treeOpen: boolean;
  onToggleTree: () => void;
  onOpenInTab: (() => void) | null;
  onSave: (() => void) | null;
}

export function Toolbar({ path, indicator, isRefreshing, onRefresh, treeOpen, onToggleTree, onOpenInTab, onSave }: ToolbarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-surface-raised pr-2 pl-1">
      <ToolbarButton label={treeOpen ? "Hide file tree (⌘B)" : "Show file tree (⌘B)"} onClick={onToggleTree} pressed={treeOpen}>
        {treeOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
      </ToolbarButton>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
        <FileIcon path={path} className="text-subtle-foreground" />
        <Breadcrumbs path={path} />
      </div>
      <SaveDot indicator={indicator} onSave={onSave} />
      <ToolbarButton label={isRefreshing ? "Reloading file" : "Reload from disk"} onClick={onRefresh} disabled={isRefreshing}>
        <RotateIcon className={cn(isRefreshing && "animate-spin")} />
      </ToolbarButton>
      {onOpenInTab ? (
        <ToolbarButton label="Open in a new tab" onClick={onOpenInTab}>
          <ExternalIcon />
        </ToolbarButton>
      ) : null}
    </div>
  );
}

function Breadcrumbs({ path }: { path: string }) {
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
        "flex min-w-0 cursor-pointer items-center rounded-sm text-left font-mono text-xs leading-5",
        "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      style={{ direction: "rtl" }}
    >
      <bdi className="truncate">
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

function SaveDot({ indicator, onSave }: { indicator: SaveIndicator; onSave: (() => void) | null }) {
  if (indicator === "clean") return null;
  const label =
    indicator === "saving" ? "Saving…" : indicator === "error" ? "Could not save — unsaved changes" : "Unsaved changes (⌘S to save)";
  return (
    <button
      type="button"
      onClick={onSave ?? undefined}
      disabled={onSave === null}
      title={label}
      aria-label={label}
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-state-hover disabled:cursor-default"
    >
      <span
        className={cn(
          "size-2 rounded-full transition-colors",
          indicator === "saving" && "animate-pulse bg-foreground",
          indicator === "dirty" && "bg-foreground",
          indicator === "error" && "bg-destructive",
        )}
      />
    </button>
  );
}

export function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
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
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      {children}
    </button>
  );
}
