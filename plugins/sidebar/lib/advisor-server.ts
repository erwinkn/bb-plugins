import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { advisorContract } from "./advisor-contract";
import { ADVISOR_UNSEEN_CHANNEL } from "./advisor-links";

const advisorRunning = async (bb: BbPluginApi) => {
  const installed = (await bb.sdk.plugins.list()).plugins.find((p) => p.id === "advisor");
  return Boolean(installed?.enabled && installed.status === "running");
};

export function registerAdvisorEntry(bb: BbPluginApi) {
  bb.rpc.register(advisorContract, {
    // No Advisor: no row. A running Advisor whose count cannot be read keeps its row without a count.
    advisorEntry: async () => {
      if (!(await advisorRunning(bb))) return { available: false, unseen: null };
      try {
        const r = await bb.sdk.plugins.callRpc({
          pluginId: "advisor",
          method: "unseen",
          input: null,
          outputSchema: z.object({ unseen: z.number().int().nonnegative() }),
        });
        return { available: true, unseen: r.unseen };
      } catch (cause: unknown) {
        bb.log.warn(`Could not read the Advisor's unseen count: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { available: true, unseen: null };
      }
    },
    advisorChanged: ({ unseen }) => {
      bb.realtime.publish(ADVISOR_UNSEEN_CHANNEL, { unseen });
      return { ok: true as const };
    },
  });
}
