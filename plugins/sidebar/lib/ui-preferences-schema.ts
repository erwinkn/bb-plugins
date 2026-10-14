import { z } from "zod/mini";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.

/** Plugin realtime channel carrying one `SyncedPreferenceEntry` per write. */
export const UI_PREFERENCES_CHANNEL = "ui-preferences-changed";

// The BB sidebar preferences this plugin represents. Every other key stays
// BB's own; the plugin never reads or writes it.
export const SYNCED_KEYS = [
  "sidebar.collapsedSections",
  "sidebar.collapsedProjects",
] as const;
export type SyncedKey = (typeof SYNCED_KEYS)[number];

const revision = z.number().check(z.int(), z.nonnegative());
const collapsedSections = z.array(z.enum(["pinned", "threads"]));
const collapsedProjects = z.array(z.string().check(z.minLength(1)));

const entry = <Schema extends z.ZodMiniType>(value: Schema) =>
  z.object({ revision, value });

export const syncedPreferencesSchema = z.object({
  "sidebar.collapsedSections": entry(collapsedSections),
  "sidebar.collapsedProjects": entry(collapsedProjects),
});
export type SyncedPreferences = z.infer<typeof syncedPreferencesSchema>;

const write = <Key extends SyncedKey, Schema extends z.ZodMiniType>(
  key: Key,
  value: Schema,
) =>
  z.object({
    key: z.literal(key),
    value,
    expectedRevision: revision,
  });
export const syncedPreferenceWriteSchema = z.union([
  write("sidebar.collapsedSections", collapsedSections),
  write("sidebar.collapsedProjects", collapsedProjects),
]);
export type SyncedPreferenceWrite = z.infer<typeof syncedPreferenceWriteSchema>;

const stored = <Key extends SyncedKey, Schema extends z.ZodMiniType>(
  key: Key,
  value: Schema,
) => z.object({ key: z.literal(key), revision, value });
export const syncedPreferenceEntrySchema = z.union([
  stored("sidebar.collapsedSections", collapsedSections),
  stored("sidebar.collapsedProjects", collapsedProjects),
]);
export type SyncedPreferenceEntry = z.infer<typeof syncedPreferenceEntrySchema>;
