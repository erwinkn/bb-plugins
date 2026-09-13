import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";

// Server-side only. Frontend code imports `nestingContract` as a type.
export const nestingContract = defineRpcContract({
  setParent: {
    input: z.object({
      threadId: z.string().check(z.minLength(1)),
      parentThreadId: z.nullable(z.string().check(z.minLength(1))),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
});
