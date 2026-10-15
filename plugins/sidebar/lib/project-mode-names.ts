/** The Sidebar's own realtime channel: the app hears only this plugin's signals. */
export const INITIATIVES_CHANGED = "initiatives-changed";

/** Published with `{ projectId }` when the server's read of an Adventure's worker facts differs. */
export const ADVENTURE_WORKERS_CHANGED = "adventure-workers-changed";

/** Published when the server's snapshot of Initiative thread ids changes. */
export const INITIATIVE_THREADS_CHANGED = "initiative-threads-changed";

/** The Initiatives dashboard route: its nav panel path equals its plugin ID. */
export const INITIATIVES_PANEL = "/plugins/initiatives/initiatives";
