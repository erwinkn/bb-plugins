import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { branchPullRequestContract } from "./branch-pull-request-contract";
import { isBranchPullRequestEnvironment } from "./branch-pull-request";

/** Thread reads per batch: loopback calls are cheap but still bounded. */
const LOOKUP_BATCH = 25;

export function registerBranchPullRequests(bb: BbPluginApi) {
  bb.rpc.register(branchPullRequestContract, {
    branchPullRequestEligibility: async ({ threadIds }) => {
      const ids = [...new Set(threadIds)];
      // Threads sharing an environment share one lookup; the same project
      // checkout backs every thread on it.
      const eligible: Record<string, boolean> = {};
      const environments = new Map<string, Promise<boolean>>();
      const evaluate = async (threadId: string): Promise<void> => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId === null) return;
        const environmentId = thread.environmentId;
        let pending = environments.get(environmentId);
        if (pending === undefined) {
          pending = bb.sdk.environments
            .get({ environmentId })
            .then(isBranchPullRequestEnvironment);
          environments.set(environmentId, pending);
        }
        eligible[threadId] = await pending;
      };
      for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
        await Promise.all(
          ids.slice(start, start + LOOKUP_BATCH).map(async (threadId) => {
            try {
              await evaluate(threadId);
            } catch {
              // A thread deleted mid-list or a read hiccup leaves it
              // unevaluated, and its row keeps showing the branch PR.
            }
          }),
        );
      }
      return { eligible };
    },
  });
}
