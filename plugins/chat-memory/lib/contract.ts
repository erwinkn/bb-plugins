import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { MemoryStatus } from "./memory";
import { MEMORY_MODES } from "./store";

const id = z.string().min(1).max(200);

export const chatMemoryContract = defineRpcContract({
  /**
   * D491: an owner plugin attaches a thread to one of its scopes, "<owner>:<key>" (Initiatives,
   * when it adopts an existing thread): its next completed turns go there, what it logged stays
   * where it is. Plugins only. A thread an owner spawns is attached from its spawn metadata instead
   * (memoryScope), at its first configure.
   */
  attach: {
    input: z.object({ threadId: id, key: id }).strict(),
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
  /** The memory a thread writes to, or null when it has none. */
  status: {
    input: z.object({ threadId: id }).strict(),
    output: z.custom<MemoryStatus | null>(),
  },
  /**
   * D452: the user's switch, from this plugin's app only (plugins are refused; tools and the CLI
   * never write). A thread that writes to no scope gets its own; enabled:false detaches it from its
   * own. Refused with a reason when the mode could not run (D460).
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
