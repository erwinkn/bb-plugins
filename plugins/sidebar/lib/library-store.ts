import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { libraryContract } from "./library-contract";
import {
  EMPTY_LIBRARY,
  LIBRARY_CHANNEL,
  libraryDocSchema,
  type LibraryDoc,
} from "./library-schema";

export const LIBRARY_KEY = "library";
/** KV marker set once the saved flags of pre-existing entries were written. */
export const SAVED_FLAG_BACKFILL_KEY = "saved-flag-backfill";

export function createLibraryStore(bb: BbPluginApi) {
  // The plugin server is one process; a promise chain makes every
  // read-modify-write atomic without a database transaction.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<LibraryDoc> => {
    const parsed = libraryDocSchema.safeParse(
      await bb.storage.kv.get<unknown>(LIBRARY_KEY),
    );
    return parsed.success ? parsed.data : EMPTY_LIBRARY;
  };
  const warn = (message: string, cause: unknown) =>
    bb.log.warn(
      `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  // The KV list stays the index. The flag in the thread's plugin metadata
  // is informational for other plugins and agents and is never read back.
  const setFlag = async (threadId: string) => {
    try {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: { saved: true, savedAt: Date.now() },
      });
    } catch (cause) {
      warn(`Could not mark thread ${threadId} as saved`, cause);
    }
  };
  const clearFlag = async (threadId: string) => {
    try {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: ["saved", "savedAt"],
      });
    } catch (cause) {
      warn(`Could not clear the saved flag of thread ${threadId}`, cause);
    }
  };
  // `change` returns the same ids reference to skip the write and signal.
  // Metadata follows the index, so a no-op write leaves the flags alone.
  const write = (
    change: (ids: string[]) => string[],
    flags: (before: string[], after: string[]) => Promise<unknown> = () =>
      Promise.resolve(),
  ): Promise<LibraryDoc> =>
    serialized(async () => {
      const current = await read();
      const ids = change(current.ids);
      if (ids === current.ids) return current;
      const next: LibraryDoc = { revision: current.revision + 1, ids };
      await bb.storage.kv.set(LIBRARY_KEY, next);
      // The payload is the document, so clients need no follow-up fetch.
      bb.realtime.publish(LIBRARY_CHANNEL, next);
      await flags(current.ids, ids);
      return next;
    });
  return {
    read,
    // An entry covers the thread's whole family through the sidebar's
    // ancestor rule, including children created after the save.
    save: (threadId: string): Promise<LibraryDoc> =>
      write(
        (ids) => (ids.includes(threadId) ? ids : [...ids, threadId]),
        () => setFlag(threadId),
      ),
    // Removing a save frees the family unless a descendant was saved on its
    // own; that entry keeps its branch in the library.
    remove: (threadId: string): Promise<LibraryDoc> =>
      write(
        (ids) => {
          const next = ids.filter((id) => id !== threadId);
          return next.length === ids.length ? ids : next;
        },
        () => clearFlag(threadId),
      ),
    // Archived or deleted threads leave the library; a restore lands in the
    // active view, not back in the library. Metadata survives an archive and
    // is cleared with it; a deleted thread takes its metadata with it.
    removeIds: (
      threadIds: readonly string[],
      { clearFlags }: { clearFlags: boolean },
    ): Promise<LibraryDoc> =>
      write(
        (ids) => {
          const drop = new Set(threadIds);
          const next = ids.filter((id) => !drop.has(id));
          return next.length === ids.length ? ids : next;
        },
        (before, after) =>
          clearFlags
            ? Promise.all(
                before.filter((id) => !after.includes(id)).map(clearFlag),
              )
            : Promise.resolve(),
      ),
    // Entries saved before the flag existed get it once. Threads that no
    // longer exist are skipped with a warning; the marker is set either way
    // so a stale entry cannot repeat the pass on every start.
    backfillFlags: async (): Promise<number> => {
      if (await bb.storage.kv.get<unknown>(SAVED_FLAG_BACKFILL_KEY)) return 0;
      const { ids } = await read();
      for (const id of ids) await setFlag(id);
      await bb.storage.kv.set(SAVED_FLAG_BACKFILL_KEY, {
        at: Date.now(),
        count: ids.length,
      });
      return ids.length;
    },
  };
}

export function registerLibrary(bb: BbPluginApi) {
  const store = createLibraryStore(bb);
  bb.rpc.register(libraryContract, {
    getLibrary: () => store.read(),
    save: ({ threadId }) => store.save(threadId),
    remove: ({ threadId }) => store.remove(threadId),
  });
  const strip = (threadId: string, clearFlags: boolean) =>
    store.removeIds([threadId], { clearFlags }).then(
      () => undefined,
      (cause: unknown) =>
        bb.log.warn(
          `Could not update the library: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    );
  bb.events.on("thread.archived", ({ thread }) => strip(thread.id, true));
  bb.events.on("thread.deleted", ({ thread }) => strip(thread.id, false));
  void store.backfillFlags().catch((cause: unknown) =>
    bb.log.warn(
      `Could not backfill saved flags: ${cause instanceof Error ? cause.message : String(cause)}`,
    ),
  );
  return store;
}
