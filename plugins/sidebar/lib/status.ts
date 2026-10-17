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
/** Newest first is the default; ascending shows the oldest thread first. */
export type SortDirection = "descending" | "ascending";
export const STATUS_LABEL: Record<Status, string> = {
  attention: "Needs Attention",
  unread: "Unread",
  working: "Working",
  draft: "Draft",
  done: "Done",
};
export const STATUS_HELP: Record<Status, string> = {
  attention:
    "A question or approval needs your answer, a run has an unread error, or a snooze ended and the thread has not been opened since.",
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
// `woke` is the sidebar's own signal: a snooze ended and the thread has not
// been opened since, so it needs attention even without a host indicator.
export function statusOf(
  thread: PluginSidebarThread,
  hasDraft = false,
  woke = false,
): Status {
  if (
    woke ||
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

/** Why a thread needs attention, in `statusOf`'s order; null when it does not. */
export type AttentionReason = "input" | "error" | "snooze";
export const ATTENTION_REASON: Record<AttentionReason, string> = {
  input: "waiting for your answer",
  error: "with an unread error",
  snooze: "back from snooze",
};
export function attentionReason(
  thread: PluginSidebarThread,
  woke = false,
): AttentionReason | null {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input")
    return "input";
  if (thread.indicator === "unread-error") return "error";
  return woke ? "snooze" : null;
}

/**
 * What a list's entry and header say about its rows: the most urgent of
 * Needs Attention, Unread and Working, why ("10 back from snooze · 3
 * unread"), and the threads Mark all as read would clear.
 */
export function listSummary(
  rows: readonly { thread: PluginSidebarThread; status: Status }[],
  woke: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): { status: Status | null; text: string; unread: string[] } {
  const statuses = new Set(rows.map((row) => row.status));
  const reasons = new Map<AttentionReason, number>();
  const unread: string[] = [];
  for (const { thread } of rows) {
    const reason = attentionReason(thread, woke.has(thread.id));
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (thread.isUnread || woke.has(thread.id)) unread.push(thread.id);
  }
  const unreadCount = rows.filter((row) => row.thread.isUnread).length;
  return {
    status:
      (["attention", "unread", "working"] as const).find((s) =>
        statuses.has(s),
      ) ?? null,
    text: [
      ...(Object.keys(ATTENTION_REASON) as AttentionReason[])
        .filter((reason) => reasons.has(reason))
        .map((reason) => `${reasons.get(reason)} ${ATTENTION_REASON[reason]}`),
      unreadCount ? `${unreadCount} unread` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    unread,
  };
}

export function threadTitle(thread: Pick<PluginSidebarThread, "title" | "titleFallback">): string {
  return (
    thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread"
  );
}

/**
 * When a thread last saw activity. Reading, pinning or renaming a thread
 * bumps its `updatedAt`, so a thread opened while unread would jump to the
 * top; BB's attention stamp (a turn finishing, a run failing) is what its own
 * list sorts by, and reading leaves it alone. BB stamps attention only on
 * root threads, so a child keeps `updatedAt`, which its turns bump.
 */
export function activityAt(
  thread: Pick<PluginSidebarThread, "parentThreadId" | "latestAttentionAt" | "updatedAt">,
): number {
  return thread.parentThreadId === null
    ? thread.latestAttentionAt
    : thread.updatedAt;
}

/** The time a list sorted by `sortBy` orders and shows a thread by. */
export function sortTime(thread: PluginSidebarThread, sortBy: SortBy): number {
  return sortBy === "created" ? thread.createdAt : activityAt(thread);
}

export function compareThreads(
  a: PluginSidebarThread,
  b: PluginSidebarThread,
  sortBy: SortBy = "updated",
  direction: SortDirection = "descending",
): number {
  const delta = sortTime(a, sortBy) - sortTime(b, sortBy);
  // Pins lead in both directions; only the date order flips.
  return (
    Number(b.isPinned) - Number(a.isPinned) ||
    (direction === "ascending" ? delta : -delta) ||
    a.id.localeCompare(b.id)
  );
}
