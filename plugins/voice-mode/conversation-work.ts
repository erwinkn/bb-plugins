import { z } from "zod";
import type Database from "better-sqlite3";
import { LiveStore } from "./live-store.ts";

export const taskViewSchema = z.object({
  op_id: z.string(), thread_id: z.string().nullable(), title: z.string(), kind: z.enum(["worker", "thread"]),
  profile: z.string().nullable(), status: z.enum(["spawning", "running", "turn_ended", "failed", "stopped", "unknown"]),
  last_text: z.string().nullable(), updated_at: z.number(), truncated: z.boolean().optional(),
});
export const watchViewSchema = z.object({ thread_id: z.string(), root_thread_id: z.string(), state: z.enum(["active", "disabled"]), updated_at: z.number() });
export const conversationWorkSchema = z.object({ tasks: z.array(taskViewSchema), subscriptions: z.array(watchViewSchema), asOf: z.number() });
export type ConversationWork = z.infer<typeof conversationWorkSchema>;
export const EMPTY_CONVERSATION_WORK: ConversationWork = { tasks: [], subscriptions: [], asOf: 0 };

/** Session history can read stored work without claiming a call or changing a watch. */
export function readConversationWork(db: Database.Database, conversationId: string): ConversationWork {
  const store = new LiveStore(db);
  return conversationWorkSchema.parse({
    tasks: store.tasks(conversationId).map(task => ({ ...task, last_text: task.last_text?.slice(-6000) ?? null, truncated: (task.last_text?.length ?? 0) > 6000 })),
    subscriptions: store.watches(conversationId).filter(watch => !watch.thread_id.startsWith("spawn:")), asOf: Date.now(),
  });
}
