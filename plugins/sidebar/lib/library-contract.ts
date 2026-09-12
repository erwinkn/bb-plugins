import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import { libraryDocSchema } from "./library-schema";

// Server-side only. Frontend code imports `libraryContract` as a type.
export const libraryContract = defineRpcContract({
  getLibrary: { input: z.null(), output: libraryDocSchema },
  // Both mutations return the stored document so the caller can apply it
  // without waiting for the realtime signal.
  save: {
    input: z.object({ threadId: z.string().check(z.minLength(1)) }),
    output: libraryDocSchema,
  },
  remove: {
    input: z.object({ threadId: z.string().check(z.minLength(1)) }),
    output: libraryDocSchema,
  },
});
