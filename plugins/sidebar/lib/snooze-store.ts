import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { snoozeContract } from "./snooze-contract";
import {
  EMPTY_SNOOZE_PRESETS,
  SNOOZE_PRESETS_CHANNEL,
  normalizePresets,
  snoozePresetsDocSchema,
  type SnoozePreset,
  type SnoozePresetsDoc,
} from "./snooze-presets";
import {
  EMPTY_SNOOZES,
  SNOOZE_CHANNEL,
  isDue,
  isSleeping,
  isWoke,
  snoozeDocSchema,
  type SnoozeDoc,
  type SnoozeEntry,
} from "./snooze-schema";

export const SNOOZE_KEY = "snoozes";
export const SNOOZE_PRESETS_KEY = "snooze-presets";
/** One durable cron row; every tick wakes whatever is past due. */
export const SNOOZE_SCHEDULE = "snooze-wake";
export const SNOOZE_CRON = "* * * * *";
/** Metadata keys mirrored into the thread for agents and other plugins. */
const METADATA_KEYS = ["snoozed", "snoozedUntil"];

export class SnoozeError extends Error {}

export type SnoozeStore = ReturnType<typeof createSnoozeStore>;

export function createSnoozeStore(bb: BbPluginApi) {
  // The plugin server is one process; a promise chain makes every
  // read-modify-write atomic without a database transaction.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<SnoozeDoc> => {
    const parsed = snoozeDocSchema.safeParse(
      await bb.storage.kv.get<unknown>(SNOOZE_KEY),
    );
    return parsed.success ? parsed.data : EMPTY_SNOOZES;
  };
  const warn = (message: string, cause: unknown) =>
    bb.log.warn(
      `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  // Host side effects are best effort: the KV document stays the index, and
  // a failed pin, unread, or metadata call is logged, not retried.
  const attempt = async (message: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      warn(message, cause);
    }
  };
  const setFlag = (entry: SnoozeEntry) =>
    attempt(`Could not mark thread ${entry.threadId} as snoozed`, () =>
      bb.sdk.threads.updatePluginMetadata({
        threadId: entry.threadId,
        set: { snoozed: true, snoozedUntil: entry.until },
      }),
    );
  const clearFlag = (threadId: string) =>
    attempt(`Could not clear the snoozed flag of thread ${threadId}`, () =>
      bb.sdk.threads.updatePluginMetadata({
        threadId,
        remove: METADATA_KEYS,
      }),
    );
  const restorePin = (entry: SnoozeEntry) =>
    entry.wasPinned
      ? attempt(`Could not pin thread ${entry.threadId} again`, () =>
          bb.sdk.threads.pin({ threadId: entry.threadId }),
        )
      : Promise.resolve();
  // `change` returns the same entries reference to skip the write and signal.
  const write = (
    change: (entries: SnoozeEntry[]) => SnoozeEntry[],
    effects: (
      before: SnoozeEntry[],
      after: SnoozeEntry[],
    ) => Promise<unknown> = () => Promise.resolve(),
  ): Promise<SnoozeDoc> =>
    serialized(async () => {
      const current = await read();
      const entries = change(current.entries);
      if (entries === current.entries) return current;
      const next: SnoozeDoc = { revision: current.revision + 1, entries };
      await bb.storage.kv.set(SNOOZE_KEY, next);
      // The payload is the document, so clients need no follow-up fetch.
      bb.realtime.publish(SNOOZE_CHANNEL, next);
      await effects(current.entries, entries);
      return next;
    });
  // Ending a snooze restores the pin; the wake path also marks the thread
  // unread so BB's own unread signal joins the plugin's woke flag.
  const end = (
    select: (entry: SnoozeEntry) => boolean,
    now: number,
    { markUnread }: { markUnread: boolean },
  ): Promise<SnoozeDoc> =>
    write(
      (entries) =>
        entries.some(select)
          ? entries.map((entry) =>
              select(entry) ? { ...entry, wokeAt: now } : entry,
            )
          : entries,
      async (before) => {
        for (const entry of before.filter(select)) {
          if (markUnread)
            await attempt(
              `Could not mark thread ${entry.threadId} as unread`,
              () => bb.sdk.threads.markUnread({ threadId: entry.threadId }),
            );
          await restorePin(entry);
          await clearFlag(entry.threadId);
        }
      },
    );
  const readPresets = async (): Promise<SnoozePresetsDoc> => {
    const parsed = snoozePresetsDocSchema.safeParse(
      await bb.storage.kv.get<unknown>(SNOOZE_PRESETS_KEY),
    );
    return parsed.success ? parsed.data : EMPTY_SNOOZE_PRESETS;
  };
  return {
    read,
    readPresets,
    /** Replace the preset list; a validation error rejects before any write. */
    savePresets: (input: unknown): Promise<SnoozePresetsDoc> => {
      const presets: SnoozePreset[] = normalizePresets(input);
      return serialized(async () => {
        const current = await readPresets();
        const next: SnoozePresetsDoc = {
          revision: current.revision + 1,
          presets,
        };
        await bb.storage.kv.set(SNOOZE_PRESETS_KEY, next);
        bb.realtime.publish(SNOOZE_PRESETS_CHANNEL, next);
        return next;
      });
    },
    snooze: async (
      threadId: string,
      until: number,
      now = Date.now(),
    ): Promise<SnoozeDoc> => {
      if (!Number.isFinite(until) || until <= now)
        throw new SnoozeError("The wake time must be in the future.");
      // A missing thread rejects here, before anything is written.
      const thread = await bb.sdk.threads.get({ threadId });
      const pinnedNow = thread.pinnedAt !== null;
      if (pinnedNow)
        await attempt(`Could not unpin thread ${threadId}`, () =>
          bb.sdk.threads.unpin({ threadId }),
        );
      let created: SnoozeEntry | null = null;
      return write(
        (entries) => {
          const existing = entries.find((entry) => entry.threadId === threadId);
          created = {
            threadId,
            until: Math.round(until),
            createdAt: now,
            wokeAt: null,
            // A sleeping thread is already unpinned; keep what it remembers.
            wasPinned:
              pinnedNow ||
              (existing !== undefined && isSleeping(existing, now)
                ? existing.wasPinned
                : false),
          };
          return [
            ...entries.filter((entry) => entry.threadId !== threadId),
            created,
          ];
        },
        () => (created ? setFlag(created) : Promise.resolve()),
      );
    },
    unsnooze: (threadId: string, now = Date.now()): Promise<SnoozeDoc> =>
      write(
        (entries) => {
          const next = entries.filter((entry) => entry.threadId !== threadId);
          return next.length === entries.length ? entries : next;
        },
        async (before) => {
          for (const entry of before) {
            if (entry.threadId !== threadId) continue;
            // A woke entry restored its pin already.
            if (!isWoke(entry) && entry.until > now) await restorePin(entry);
            await clearFlag(threadId);
          }
        },
      ),
    // Opening a woke thread clears it; sleeping entries are untouched.
    acknowledge: (threadId: string): Promise<SnoozeDoc> =>
      write((entries) => {
        const next = entries.filter(
          (entry) => !(entry.threadId === threadId && isWoke(entry)),
        );
        return next.length === entries.length ? entries : next;
      }),
    // The schedule tick: every entry past due wakes, including any that came
    // due while BB was down.
    wake: (now = Date.now()): Promise<SnoozeDoc> =>
      end((entry) => isDue(entry, now), now, { markUnread: true }),
    // Agent activity ends the sleep early; the activity carries its own
    // unread or attention signal, so the thread is not marked unread.
    activity: (threadId: string, now = Date.now()): Promise<SnoozeDoc> =>
      end(
        (entry) => entry.threadId === threadId && isSleeping(entry, now),
        now,
        { markUnread: false },
      ),
    // Archived or deleted threads drop their entry without a pin restore.
    // Metadata survives an archive and is cleared with it; a deleted thread
    // takes its metadata with it.
    removeIds: (
      threadIds: readonly string[],
      { clearFlags }: { clearFlags: boolean },
    ): Promise<SnoozeDoc> =>
      write(
        (entries) => {
          const drop = new Set(threadIds);
          const next = entries.filter((entry) => !drop.has(entry.threadId));
          return next.length === entries.length ? entries : next;
        },
        (before, after) =>
          clearFlags
            ? Promise.all(
                before
                  .filter((entry) => !after.includes(entry))
                  .map((entry) => clearFlag(entry.threadId)),
              )
            : Promise.resolve(),
      ),
  };
}

/** Thread events that count as agent activity on a snoozed thread. */
export const ACTIVITY_EVENTS = [
  "thread.active",
  "thread.idle",
  "thread.failed",
  "interaction.pending",
] as const;

export function registerSnoozes(bb: BbPluginApi): SnoozeStore {
  const store = createSnoozeStore(bb);
  const report = (message: string) => (cause: unknown) =>
    bb.log.warn(
      `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  bb.rpc.register(snoozeContract, {
    getSnoozes: () => store.read(),
    snooze: ({ threadId, until }) => store.snooze(threadId, until),
    unsnooze: ({ threadId }) => store.unsnooze(threadId),
    acknowledge: ({ threadId }) => store.acknowledge(threadId),
    getSnoozePresets: () => store.readPresets(),
    saveSnoozePresets: ({ presets }) => store.savePresets(presets),
  });
  // One durable row keyed by name. Missed ticks are not replayed after a
  // restart, but the next tick wakes everything past due, so nothing is lost.
  bb.background.schedule(SNOOZE_SCHEDULE, SNOOZE_CRON, () =>
    store.wake().then(() => undefined),
  );
  // Catch up right away instead of waiting for the first sweep after a load.
  void store.wake().catch(report("Could not wake due snoozes"));
  for (const event of ACTIVITY_EVENTS) {
    bb.events.on(event, ({ thread }) =>
      store
        .activity(thread.id)
        .then(() => undefined, report("Could not end the snooze")),
    );
  }
  const strip = (threadId: string, clearFlags: boolean) =>
    store
      .removeIds([threadId], { clearFlags })
      .then(() => undefined, report("Could not update the snooze list"));
  bb.events.on("thread.archived", ({ thread }) => strip(thread.id, true));
  bb.events.on("thread.deleted", ({ thread }) => strip(thread.id, false));
  return store;
}
