import { z } from "zod/mini";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.
export const snoozeEntrySchema = z.object({
  threadId: z.string().check(z.minLength(1)),
  /** Wake time, epoch milliseconds. */
  until: z.number().check(z.int(), z.nonnegative()),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  /**
   * Set once the snooze ended (its time came or the agent produced activity).
   * A woke entry keeps the thread in Needs Attention until it is opened.
   */
  wokeAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  /** The thread was pinned when snoozed; the pin returns when the snooze ends. */
  wasPinned: z.boolean(),
});
export type SnoozeEntry = z.infer<typeof snoozeEntrySchema>;

export const snoozeDocSchema = z.object({
  revision: z.number().check(z.int(), z.nonnegative()),
  entries: z.array(snoozeEntrySchema),
});
export type SnoozeDoc = z.infer<typeof snoozeDocSchema>;

export const SNOOZE_CHANNEL = "snoozes-changed";
export const EMPTY_SNOOZES: SnoozeDoc = { revision: 0, entries: [] };

/** The snooze is still hiding the thread. */
export function isSleeping(entry: SnoozeEntry, now: number): boolean {
  return entry.wokeAt === null && entry.until > now;
}
/** The snooze ended and the thread has not been opened since. */
export function isWoke(entry: SnoozeEntry): boolean {
  return entry.wokeAt !== null;
}
/** Sleeping entries whose time has come, but that the poll has not seen yet. */
export function isDue(entry: SnoozeEntry, now: number): boolean {
  return entry.wokeAt === null && entry.until <= now;
}
