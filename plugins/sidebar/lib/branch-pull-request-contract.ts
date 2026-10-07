import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";

const threadId = z.string().check(z.minLength(1));

// Server-side only. Frontend code imports `branchPullRequestContract` as a type.
export const branchPullRequestContract = defineRpcContract({
  /**
   * thread id → whether BB's environment branch PR may be shown as the
   * row's PR. False for shared project checkouts and default-branch
   * checkouts; threads that could not be evaluated are absent and the row
   * keeps showing the branch PR. One call covers the whole visible list so
   * rows never fetch individually.
   */
  branchPullRequestEligibility: {
    input: z.object({
      threadIds: z.array(threadId).check(z.maxLength(1000)),
    }),
    output: z.object({
      eligible: z.record(z.string(), z.boolean()),
    }),
  },
});
