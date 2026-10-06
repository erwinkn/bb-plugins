/** The Sidebar's own realtime channel: the app hears only this plugin's signals. */
export const INITIATIVES_CHANGED = "initiatives-changed";

/**
 * The Initiatives dashboard route of whichever plugin serves the tree. Its
 * nav panel path equals its plugin ID, before (`projects`) and after
 * (`initiatives`) the move.
 */
export const initiativesPanel = (pluginId: "initiatives" | "projects" = "initiatives") =>
  `/plugins/${pluginId}/${pluginId}`;
