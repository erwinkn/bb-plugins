import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { MemoryStatus } from "./memory";
import { MEMORY_MODES } from "./store";

const id = z.string().min(1).max(200);

export const chatMemoryContract = defineRpcContract({
  /**
   * D446: an owner plugin's scope and its current threads, in order (an Initiative's coordinator
   * and later its discussion threads). Plugins only: the caller is the scope's owner. An empty
   * list closes the scope; its memory stays.
   */
  setScope: {
    /** hold: the owner holds automatic compaction (a paused Initiative); omitted leaves it as it is. */
    input: z.object({ key: id, threads: z.array(id).max(32), hold: z.boolean().optional() }).strict(),
    output: z.object({ scope: z.string() }),
  },
  /**
   * The memory view of the thread's scope (memory_read) and a line zoomed (memory_zoom), for an
   * owner's aliases: sessions built before T145 call initiative_read {view:"memory"} and
   * initiative_zoom.
   */
  read: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({ messages: z.number(), view: z.string(), note: z.string() }),
  },
  zoom: {
    input: z.object({ threadId: id, id: z.number().int().min(0), n: z.number().int().min(1) }).strict(),
    output: z.string(),
  },
  /** The memory of the scope a thread is a current thread of, or null when it has none. */
  status: {
    input: z.object({ threadId: id }).strict(),
    output: z.custom<MemoryStatus | null>(),
  },
  /**
   * D452: the user's switch, from this plugin's app only (plugins are refused; tools and the CLI
   * never write). A thread outside every scope gets its own; enabled:false closes a thread's own
   * scope. Refused with a reason when the mode could not run (D458, D460).
   */
  configure: {
    input: z
      .object({
        threadId: id,
        mode: z.enum(MEMORY_MODES).optional(),
        compactTokens: z.number().int().min(0).max(2_000_000).nullable().optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    output: z.custom<MemoryStatus | null>(),
  },
});
