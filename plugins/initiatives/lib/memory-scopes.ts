import { z } from "zod";
import { errorMessage, type Sdk } from "./bb";

export const CHAT_MEMORY_PLUGIN_ID = "chat-memory";
/**
 * T145, T153 (D446, D487, D491): an Initiative's memory belongs to the Chat memory plugin: its
 * log, summary tree, mode, memory tools and turn hook. A thread this plugin spawns into it (a
 * coordinator, a successor) carries this key in its spawn metadata, and Chat memory attaches it at
 * its first configure. Workers carry none, so they never write to it.
 */
export const MEMORY_SCOPE_KEY = "memoryScope";

/**
 * An adopted thread is attached with Chat memory's attach RPC (D491): its next turns go to the
 * Initiative's memory; what it logged before stays where it was. Null once attached, else a note
 * for the adoption's answer.
 */
export async function attachMemory(sdk: Sdk, threadId: string, projectId: string): Promise<string | null> {
  try {
    await sdk.plugins.callRpc({ pluginId: CHAT_MEMORY_PLUGIN_ID, method: "attach", input: { threadId, key: projectId }, outputSchema: z.object({ scope: z.string() }) });
    return null;
  } catch (error) {
    return `Chat memory could not attach it to the Initiative's memory (${errorMessage(error)}): its turns stay out of that memory until it is.`;
  }
}
