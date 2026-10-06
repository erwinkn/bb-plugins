import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { advisorSummary } from "./advisor-schema";

export { ADVISOR_FEED_HREF, ADVISOR_UNSEEN_CHANNEL, advisorSummary, type AdvisorSummary } from "./advisor-schema";

// T106: the one Advisor entry is rendered here. The Sidebar never owns Advisor data:
// it reads the summary from the Advisor's read-only `unseen` RPC, and the Advisor
// pushes changes through `advisorChanged` (an app only hears its own plugin's realtime).
export const advisorContract = defineRpcContract({
  advisorEntry: {
    input: z.null(),
    output: z.object({ available: z.boolean(), summary: advisorSummary.nullable() }),
  },
  advisorChanged: {
    input: advisorSummary,
    output: z.object({ ok: z.literal(true) }),
  },
});
