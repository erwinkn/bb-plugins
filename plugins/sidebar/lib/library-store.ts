import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { libraryContract } from "./library-contract";
import {
  EMPTY_LIBRARY,
  LIBRARY_CHANNEL,
  libraryDocSchema,
  type LibraryDoc,
} from "./library-schema";

export const LIBRARY_KEY = "library";

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
  // `change` returns the same ids reference to skip the write and signal.
  const write = (
    change: (ids: string[]) => string[],
  ): Promise<LibraryDoc> =>
    serialized(async () => {
      const current = await read();
      const ids = change(current.ids);
      if (ids === current.ids) return current;
      const next: LibraryDoc = { revision: current.revision + 1, ids };
      await bb.storage.kv.set(LIBRARY_KEY, next);
      // The payload is the document, so clients need no follow-up fetch.
      bb.realtime.publish(LIBRARY_CHANNEL, next);
      return next;
    });
  return {
    read,
    // An entry covers the thread's whole family through the sidebar's
    // ancestor rule, including children created after the save.
    save: (threadId: string): Promise<LibraryDoc> =>
      write((ids) => (ids.includes(threadId) ? ids : [...ids, threadId])),
    // Removing a save frees the family unless a descendant was saved on its
    // own; that entry keeps its branch in the library.
    remove: (threadId: string): Promise<LibraryDoc> =>
      write((ids) => {
        const next = ids.filter((id) => id !== threadId);
        return next.length === ids.length ? ids : next;
      }),
    // Archived or deleted threads leave the library; a restore lands in the
    // active view, not back in the library.
    removeIds: (threadIds: readonly string[]): Promise<LibraryDoc> =>
      write((ids) => {
        const drop = new Set(threadIds);
        const next = ids.filter((id) => !drop.has(id));
        return next.length === ids.length ? ids : next;
      }),
  };
}

export function registerLibrary(bb: BbPluginApi) {
  const store = createLibraryStore(bb);
  bb.rpc.register(libraryContract, {
    getLibrary: () => store.read(),
    save: ({ threadId }) => store.save(threadId),
    remove: ({ threadId }) => store.remove(threadId),
  });
  const strip = (threadId: string) =>
    store.removeIds([threadId]).then(
      () => undefined,
      (cause: unknown) =>
        bb.log.warn(
          `Could not update the library: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    );
  bb.events.on("thread.archived", ({ thread }) => strip(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => strip(thread.id));
  return store;
}
