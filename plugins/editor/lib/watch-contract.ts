/**
 * The contract between the plugin server and its host module, which runs on
 * the machine that holds the files. The server asks the host to watch a set
 * of workspace roots; the host reports what changed under them. Nothing here
 * may import a private BB package: the host bundle is built on its own.
 */
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Beyond this many paths in one batch the client reloads every open file. */
export const MAX_CHANGED_PATHS = 512;

export const watchContract = defineRpcContract({
  /**
   * Make the host's watches match `roots`: start the missing ones, stop the
   * rest. It is idempotent and returns at once; the watches outlive the call.
   */
  syncWatches: {
    input: z.object({ roots: z.array(z.string().min(1).max(4096)).max(64) }).strict(),
    output: z.object({
      watching: z.array(z.string()),
      failed: z.array(z.object({ rootPath: z.string(), message: z.string() })),
    }).strict(),
  },
});

export const watchSignals = {
  changed: {
    payload: z.object({
      rootPath: z.string(),
      /** `rescan` means the watcher lost events, or too many arrived at once. */
      kind: z.enum(["changed", "rescan"]),
      /** Root-relative paths in the host's separator, empty for a rescan. */
      paths: z.array(z.object({ path: z.string(), type: z.enum(["create", "update", "delete"]) })).max(MAX_CHANGED_PATHS),
    }).strict(),
  },
} satisfies ExperimentalHostSignals;

export type WatchSignals = typeof watchSignals;

/** The realtime channel the server publishes change notices on. */
export const FILES_CHANGED_CHANNEL = "files-changed";

export const filesChangedSchema = z.object({
  /** The root key the `watch` RPC returned. */
  root: z.string(),
  kind: z.enum(["changed", "rescan"]),
  /** Root-relative paths with POSIX or Windows separators, as the root has them. */
  changes: z.array(z.object({ path: z.string(), type: z.enum(["create", "update", "delete"]) })),
  seq: z.number().int(),
});

export type FilesChangedSignal = z.infer<typeof filesChangedSchema>;
