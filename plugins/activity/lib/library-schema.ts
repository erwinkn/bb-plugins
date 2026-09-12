import { z } from "zod/mini";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.
export const libraryEntrySchema = z.object({
  id: z.string().check(z.minLength(1)),
  savedAt: z.number(),
});
export const libraryDocSchema = z.object({
  revision: z.number().check(z.int(), z.nonnegative()),
  entries: z.array(libraryEntrySchema),
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export type LibraryDoc = z.infer<typeof libraryDocSchema>;

export const LIBRARY_CHANNEL = "library-changed";
export const EMPTY_LIBRARY: LibraryDoc = { revision: 0, entries: [] };
