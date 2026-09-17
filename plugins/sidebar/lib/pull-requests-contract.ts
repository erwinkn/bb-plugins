import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import { linkedPullRequestSchema } from "./pull-requests-schema";

const threadId = z.string().check(z.minLength(1));

// Server-side only. Frontend code imports `pullRequestsContract` as a type.
export const pullRequestsContract = defineRpcContract({
  /**
   * The github-prs links of the given threads, keyed by thread id (threads
   * without links are absent). One call covers the whole visible list so
   * rows never fetch individually.
   */
  linkedPullRequests: {
    input: z.object({
      threadIds: z.array(threadId).check(z.maxLength(1000)),
    }),
    output: z.object({
      pullRequests: z.record(z.string(), z.array(linkedPullRequestSchema)),
      /**
       * thread id → whether BB's environment branch PR may be shown as the
       * row's PR. False for shared project checkouts and default-branch
       * checkouts; threads that could not be evaluated are absent and the
       * row keeps showing the branch PR (the previous behavior).
       */
      branchPrEligible: z.record(z.string(), z.boolean()),
    }),
  },
  /**
   * Cross-plugin bump the GitHub plugin calls when a thread's links change.
   * Republished on the sidebar's own realtime channel, which its app can
   * subscribe to; `useRealtime` only delivers the owning plugin's signals.
   */
  pullRequestsChanged: {
    input: z.object({ threadId }),
    output: z.object({ ok: z.literal(true) }),
  },
});
