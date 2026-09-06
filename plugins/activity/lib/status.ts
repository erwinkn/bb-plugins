import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export const STATUSES = [
  "attention",
  "unread",
  "working",
  "draft",
  "done",
] as const;
export type Status = (typeof STATUSES)[number];
export type SortBy = "updated" | "created";
export const STATUS_LABEL: Record<Status, string> = {
  attention: "Needs Attention",
  unread: "Unread",
  working: "Working",
  draft: "Draft",
  done: "Done",
};
export const STATUS_HELP: Record<Status, string> = {
  attention:
    "A question or approval needs your answer, or a run has an unread error.",
  unread: "A reply is ready and has not been read.",
  working: "An agent, command, workflow, plan, or goal is running.",
  draft:
    "Unsent text or attachments. Saved drafts become visible after you open their composer once.",
  done: "No current work, unread reply, pending input, or known draft. This does not confirm that the task is complete.",
};
const WORK_INDICATORS = new Set([
  "runtime",
  "background-agent",
  "background-command",
  "workflow",
  "plan-mode",
  "goal",
  "working-draft",
]);

// Display order and precedence are separate: work outranks an old unread flag.
export function statusOf(
  thread: PluginSidebarThread,
  hasDraft = false,
): Status {
  if (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error"
  )
    return "attention";
  if (
    WORK_INDICATORS.has(thread.indicator) ||
    Object.values(thread.activity).some((count) => count > 0)
  )
    return "working";
  if (thread.isUnread || thread.indicator === "unread-success") return "unread";
  if (hasDraft || thread.indicator === "draft") return "draft";
  return "done";
}

export function threadTitle(thread: PluginSidebarThread): string {
  return (
    thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread"
  );
}

export function compareThreads(
  a: PluginSidebarThread,
  b: PluginSidebarThread,
  sortBy: SortBy = "updated",
): number {
  const field = sortBy === "created" ? "createdAt" : "updatedAt";
  return (
    Number(b.isPinned) - Number(a.isPinned) ||
    b[field] - a[field] ||
    a.id.localeCompare(b.id)
  );
}
