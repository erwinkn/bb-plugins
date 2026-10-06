import { z } from "zod";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.

/** Realtime channel the Sidebar republishes the Advisor's entry summary on. */
export const ADVISOR_UNSEEN_CHANNEL = "advisor-unseen";
/** The Advisor's feed page (its navPanel route; BB serves it even when the host row is hidden). */
export const ADVISOR_FEED_HREF = "/plugins/advisor/advisor";

const count = z.number().int().nonnegative();

/** What the Advisor entry shows: the unseen badge, and whether and what the Advisor reviews. */
export const advisorSummary = z.object({
  unseen: count,
  reviewing: z.boolean(),
  initiatives: count,
  threads: count,
});
export type AdvisorSummary = z.infer<typeof advisorSummary>;
