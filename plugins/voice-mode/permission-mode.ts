import { z } from "zod";

/** BB's public launch modes. `auto` is labelled "Approve for me" in the product. */
export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** An inherited profile omits the launch field so BB resolves its project/product default. */
export const workerPermissionModeSchema = z.union([z.literal("inherit"), permissionModeSchema]);
export type WorkerPermissionMode = z.infer<typeof workerPermissionModeSchema>;

/** Caller override > named profile > BB project/product default. */
export function resolvePermissionMode(profileMode: WorkerPermissionMode, override?: PermissionMode): PermissionMode | undefined {
  if (override) return override;
  return profileMode === "inherit" ? undefined : profileMode;
}
