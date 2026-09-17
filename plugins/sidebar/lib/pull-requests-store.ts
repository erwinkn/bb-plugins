import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { pullRequestsContract } from "./pull-requests-contract";
import {
  GITHUB_PRS_PLUGIN_ID,
  LINKED_PULL_REQUESTS_CHANNEL,
  PULL_REQUESTS_METADATA_KEY,
  isBranchPullRequestEnvironment,
  readLinkedPullRequests,
  type LinkedPullRequest,
} from "./pull-requests-schema";

/** Metadata reads per batch: loopback calls are cheap but still bounded. */
const METADATA_BATCH = 25;

export function registerPullRequests(bb: BbPluginApi) {
  bb.rpc.register(pullRequestsContract, {
    linkedPullRequests: async ({ threadIds }) => {
      const pullRequests: Record<string, LinkedPullRequest[]> = {};
      const ids = [...new Set(threadIds)];
      // Threads sharing an environment share one lookup; the same project
      // checkout backs every thread on it.
      const branchPrEligible: Record<string, boolean> = {};
      const environments = new Map<string, Promise<boolean>>();
      const eligibility = async (threadId: string): Promise<void> => {
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
        branchPrEligible[threadId] = await pending;
      };
      for (let start = 0; start < ids.length; start += METADATA_BATCH) {
        await Promise.all(
          ids.slice(start, start + METADATA_BATCH).map(async (threadId) => {
            try {
              const metadata = await bb.sdk.threads.getPluginMetadata({
                threadId,
                pluginId: GITHUB_PRS_PLUGIN_ID,
              });
              const links = readLinkedPullRequests(
                metadata[PULL_REQUESTS_METADATA_KEY],
              );
              if (links.length > 0) pullRequests[threadId] = links;
            } catch {
              // A thread deleted mid-list or a read hiccup drops the row,
              // not the request.
            }
            try {
              await eligibility(threadId);
            } catch {
              // Unevaluated threads stay absent from the eligibility map and
              // the row keeps showing the branch PR it used to.
            }
          }),
        );
      }
      return { pullRequests, branchPrEligible };
    },
    pullRequestsChanged: ({ threadId }) => {
      bb.realtime.publish(LINKED_PULL_REQUESTS_CHANNEL, { threadId });
      return { ok: true as const };
    },
  });
}
