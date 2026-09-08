import { z } from "zod/mini";

// Shared by the server and the frontend bundle; no `@get-bb/plugin-sdk` here.
export const PROJECT_NAME_MAX = 80;

export const managedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  /** Default source folder; null for the personal project. */
  source: z.nullable(
    z.object({ id: z.string(), hostId: z.string(), path: z.string() }),
  ),
});
export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
});
export const projectInventorySchema = z.object({
  projects: z.array(managedProjectSchema),
  hosts: z.array(hostSchema),
});
export const directoryListingSchema = z.object({
  directory: z.string(),
  parent: z.nullable(z.string()),
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
});

export type ManagedProject = z.infer<typeof managedProjectSchema>;
export type ProjectHost = z.infer<typeof hostSchema>;
export type ProjectInventory = z.infer<typeof projectInventorySchema>;
export type DirectoryListing = z.infer<typeof directoryListingSchema>;

/** BB's personal project holds threads outside any project. */
export const NO_PROJECT_LABEL = "No project";

/** The name shown for a project; the personal project reads "No project". */
export function projectLabel(project: {
  name: string;
  isPersonal: boolean;
}): string {
  return project.isPersonal ? NO_PROJECT_LABEL : project.name;
}

/** Last path segment, used as the default name for a new project. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(index + 1);
}
