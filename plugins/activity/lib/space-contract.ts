import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";

export const SPACE_NAME_MAX = 60;

// A space is a named project selection shared by every client of one BB
// server. The whole catalog is one document; `revision` guards concurrent
// edits from different clients.
export const spaceSchema = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(64)),
  name: z.string().check(z.minLength(1), z.maxLength(SPACE_NAME_MAX)),
  projectIds: z.array(z.string().check(z.minLength(1))),
});
export const catalogSchema = z.object({
  revision: z.number().check(z.int(), z.nonnegative()),
  spaces: z.array(spaceSchema),
});
export type Space = z.infer<typeof spaceSchema>;
export type SpaceCatalog = z.infer<typeof catalogSchema>;

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
