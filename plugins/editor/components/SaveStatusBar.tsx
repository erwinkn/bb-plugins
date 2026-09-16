import type { SessionOverviewEntry } from "@/lib/file-session";
import { cn } from "@/lib/utils";

/**
 * The plugin-wide unsaved-work line, always under the workbench. A failed
 * save names its file even when the file's own tab is not mounted — the
 * session keeps the failure, and retrying is the session's job.
 */
export function SaveStatusBar({ entries }: { entries: SessionOverviewEntry[] }) {
  if (entries.length === 0) return null;
  const failed = entries.filter((entry) => entry.save === "error" || entry.save === "conflict");
  const saving = entries.some((entry) => entry.save === "saving");
  const label =
    failed.length > 0
      ? `Save failed: ${failed[0]!.path}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}${
          failed[0]!.message === null ? "" : ` — ${failed[0]!.message}`
        }`
      : saving
        ? "Saving…"
        : `${entries.length} unsaved ${entries.length === 1 ? "file" : "files"}`;
  return (
    <div
      role="status"
      className={cn(
        "flex h-6 shrink-0 items-center border-t border-border/60 px-3 text-xs",
        failed.length > 0 ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className="truncate">{label}</span>
    </div>
  );
}
