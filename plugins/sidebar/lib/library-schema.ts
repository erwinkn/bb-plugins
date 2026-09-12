import { z } from "zod/mini";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.
export const libraryDocSchema = z.object({
  revision: z.number().check(z.int(), z.nonnegative()),
  ids: z.array(z.string().check(z.minLength(1))),
});
export type LibraryDoc = z.infer<typeof libraryDocSchema>;

export const LIBRARY_CHANNEL = "library-changed";
export const EMPTY_LIBRARY: LibraryDoc = { revision: 0, ids: [] };
