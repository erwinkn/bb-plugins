import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export { ADVISOR_FEED_HREF, ADVISOR_UNSEEN_CHANNEL } from "./advisor-links";

const unseen = z.number().int().nonnegative();

// T106: the one Advisor entry is rendered here. The Sidebar never owns Advisor data:
// it reads the count from the Advisor's read-only `unseen` RPC, and the Advisor
// pushes changes through `advisorChanged` (an app only hears its own plugin's realtime).
export const advisorContract = defineRpcContract({
  advisorEntry: {
    input: z.null(),
    output: z.object({ available: z.boolean(), unseen: unseen.nullable() }),
  },
  advisorChanged: {
    input: z.object({ unseen }),
    output: z.object({ ok: z.literal(true) }),
  },
});
