import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { advisorContract } from "./advisor-contract";
import { ADVISOR_UNSEEN_CHANNEL, advisorSummary } from "./advisor-schema";

const advisorRunning = async (bb: BbPluginApi) => {
  const installed = (await bb.sdk.plugins.list()).plugins.find((p) => p.id === "advisor");
  return Boolean(installed?.enabled && installed.status === "running");
};

export function registerAdvisorEntry(bb: BbPluginApi) {
  bb.rpc.register(advisorContract, {
    // No Advisor: no row. A running Advisor whose summary cannot be read keeps its row without one.
    advisorEntry: async () => {
      if (!(await advisorRunning(bb))) return { available: false, summary: null };
      try {
        const summary = await bb.sdk.plugins.callRpc({
          pluginId: "advisor",
          method: "unseen",
          input: null,
          outputSchema: advisorSummary,
        });
        return { available: true, summary };
      } catch (cause: unknown) {
        bb.log.warn(`Could not read the Advisor's summary: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { available: true, summary: null };
      }
    },
    advisorChanged: (summary) => {
      bb.realtime.publish(ADVISOR_UNSEEN_CHANNEL, summary);
      return { ok: true as const };
    },
  });
}
