import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import { catalogSchema, spaceSchema } from "./space-schema";

// Server-side only. Frontend code imports `spaceContract` as a type.
export const spaceContract = defineRpcContract({
  getSpaces: { input: z.null(), output: catalogSchema },
  saveSpaces: {
    input: z.object({
      expectedRevision: z.number().check(z.int(), z.nonnegative()),
      spaces: z.array(spaceSchema),
    }),
    output: catalogSchema,
  },
});
