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
export type ManagedProject = z.infer<typeof managedProjectSchema>;

/** BB's personal project holds threads outside any project. */
export const NO_PROJECT_LABEL = "No project";

/** The name shown for a project; the personal project reads "No project". */
export function projectLabel(project: {
  name: string;
  isPersonal: boolean;
}): string {
  return project.isPersonal ? NO_PROJECT_LABEL : project.name;
}

