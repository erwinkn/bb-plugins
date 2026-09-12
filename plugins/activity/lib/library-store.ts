import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { libraryContract } from "./library-contract";
import {
  EMPTY_LIBRARY,
  LIBRARY_CHANNEL,
  libraryDocSchema,
  type LibraryDoc,
  type LibraryEntry,
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
  // `change` returns the same entries reference to skip the write and signal.
  const write = (
    change: (entries: LibraryEntry[]) => LibraryEntry[],
  ): Promise<LibraryDoc> =>
    serialized(async () => {
      const current = await read();
      const entries = change(current.entries);
      if (entries === current.entries) return current;
      const next: LibraryDoc = {
        revision: current.revision + 1,
        entries,
      };
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
      write((entries) =>
        entries.some((entry) => entry.id === threadId)
          ? entries
          : [...entries, { id: threadId, savedAt: Date.now() }],
      ),
    // Removing a save frees the family unless a descendant was saved on its
    // own; that entry keeps its branch in the library.
    remove: (threadId: string): Promise<LibraryDoc> =>
      write((entries) => {
        const next = entries.filter((entry) => entry.id !== threadId);
        return next.length === entries.length ? entries : next;
      }),
    // Archived or deleted threads leave the library; a restore lands in the
    // active view, not back in the library.
    removeIds: (threadIds: readonly string[]): Promise<LibraryDoc> =>
      write((entries) => {
        const drop = new Set(threadIds);
        const next = entries.filter((entry) => !drop.has(entry.id));
        return next.length === entries.length ? entries : next;
      }),
    replaceAll: (entries: LibraryEntry[]): Promise<LibraryDoc> =>
      write((current) => {
        const seen = new Set<string>();
        const next = entries.filter(
          (entry) => !seen.has(entry.id) && (seen.add(entry.id), true),
        );
        return next.length === current.length &&
          next.every((entry, i) => entry.id === current[i]?.id)
          ? current
          : next;
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

// `bb.cli.register` accepts one registration per plugin, so the CLI lives in
// activity-cli.ts and calls this for the library subcommands.
export async function runLibraryCli(
  store: ReturnType<typeof createLibraryStore>,
  action: string | undefined,
  payload: string | undefined,
): Promise<{ exitCode: number; stdout?: string; stderr?: string } | null> {
  if (action !== "library-export" && action !== "library-import") return null;
  if (action === "library-export")
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(await store.read(), null, 2)}\n`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload ?? "");
  } catch {
    return { exitCode: 2, stderr: "Import expects one JSON argument.\n" };
  }
  const document = libraryDocSchema.safeParse(parsed);
  const entries = document.success
    ? document.data.entries
    : (parsed as { entries?: unknown })?.entries;
  const list = libraryDocSchema.shape.entries.safeParse(entries);
  if (!list.success)
    return { exitCode: 2, stderr: "Import expects a library document.\n" };
  const next = await store.replaceAll(list.data);
  return {
    exitCode: 0,
    stdout: `Imported ${next.entries.length} saved thread(s) at revision ${next.revision}.\n`,
  };
}
