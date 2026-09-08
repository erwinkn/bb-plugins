import { z } from "zod/mini";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.
export const SPACE_NAME_MAX = 60;

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
