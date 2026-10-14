import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// dnd-kit mounts a visually-hidden aria-live="assertive" role="status" region
// for drag announcements; the sidebar's own status elements never set
// aria-live, so this picks the user-visible message.
export function visibleStatus(slot: {
  getAllByRole(role: string): HTMLElement[];
}): HTMLElement | undefined {
  return slot
    .getAllByRole("status")
    .find((element) => !element.hasAttribute("aria-live"));
}

export function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Test thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

/** A known-empty Initiative thread set, so the list renders at first paint. */
export function seedInitiativeCache(ids: string[] = []) {
  window.localStorage.setItem(
    "bb-plugin-sidebar:initiative-threads-cache",
    JSON.stringify(ids),
  );
}

export type ThreadLink = { id: string; parent: string; archived?: boolean };
/** A host thread store: `threads.list` filters the links by parent and, when given, archive flag. */
export const threadsList =
  (links: ThreadLink[]) =>
  async (
    q: { parentThreadId?: string; archived?: boolean; limit?: number; offset?: number } = {},
  ) =>
    links
      .filter(
        (link) =>
          link.parent === q.parentThreadId && (q.archived === undefined || !!link.archived === q.archived),
      )
      .slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200))
      .map((link) => ({ id: link.id }));
