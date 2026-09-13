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
