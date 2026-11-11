/** W584: what the drive's server (lib/drive.ts) and its view (drive-view.tsx) share; no Node imports. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const EDIT_MAX_BYTES = 1024 * 1024;

export type DriveEntry = { path: string; kind: "file" | "dir"; size: number; mtimeMs: number; title: string | null };
export type DriveList = { root: string; entries: DriveEntry[]; truncated: boolean };
/** `text` is null for a binary file or one over EDIT_MAX_BYTES. `version` is what a save must still find. */
export type DriveFile = { path: string; size: number; mtimeMs: number; version: string; text: string | null };
export type DriveSave = { saved: DriveFile } | { conflict: DriveFile | null };
export type DriveChange =
  | { kind: "mkdir"; path: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "delete"; path: string }
  | { kind: "upload"; path: string; base64: string; replace: boolean };

export const humanSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
