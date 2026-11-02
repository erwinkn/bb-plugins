import { z } from "zod";
import { errorMessage, type Sdk } from "./bb";

export const CHAT_MEMORY_PLUGIN_ID = "chat-memory";
/**
 * T145, T153 (D446, D487, D491): an Initiative's memory belongs to the Chat memory plugin: its
 * log, summary tree, mode, memory tools and turn hook. A thread this plugin spawns into it (a
 * coordinator, a successor) carries this key in its spawn metadata, and Chat memory attaches it at
 * its first configure. Claude work workers name their own private scope instead.
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

/**
 * W568: an Adventure coordinator's memory goes first in Chat memory's summarizer queue, after the
 * calls a waiting turn needs and before every worker's. The priority belongs to the scope, so a
 * replacement coordinator, which takes over the scope (R3), keeps it.
 */
export async function prioritizeMemory(sdk: Sdk, projectId: string): Promise<void> {
  await sdk.plugins.callRpc({ pluginId: CHAT_MEMORY_PLUGIN_ID, method: "prioritize", input: { key: projectId, priority: 1 }, outputSchema: z.object({ scope: z.string() }) });
}

/** Stable across native sessions and generations; never shared with a coordinator or reviewer. */
export const workerMemoryKey = (worker: import("./store").WorkerRecord) => `${worker.projectId}:worker:${worker.num}`;
export const workerHasPrivateMemory = (worker: import("./store").WorkerRecord) =>
  worker.role === "work" && worker.providerId === "claude-code" && worker.state !== "retired" && !!worker.threadId;
const workerStatusSchema = z.object({
  scope: z.object({ id: z.string(), owner: z.string() }),
  mode: z.enum(["regular", "optchat"]),
  tree: z.object({ ready: z.boolean(), ingesting: z.boolean(), requiredFailure: z.string().min(1).nullable().optional() }).optional(),
}).nullable();

/** Only concurrent calls share a status read. Never cache mode across actual wakes/configures. */
export function createWorkerMemory(sdk: Sdk) {
  const pending = new Map<string, Promise<boolean>>();
  const states = new Map<string, string>();
  const admission = new Map<string, { ready: boolean; requiredFailure: string | null }>();
  async function bounded<T>(run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Chat memory did not answer within 2 s")), 2000);
      })]);
    } finally { clearTimeout(timer); }
  }
  return {
    ready(worker: import("./store").WorkerRecord) { return admission.get(`${worker.threadId}:initiatives:${workerMemoryKey(worker)}`)?.ready === true; },
    requiredFailure(worker: import("./store").WorkerRecord) { return admission.get(`${worker.threadId}:initiatives:${workerMemoryKey(worker)}`)?.requiredFailure ?? null; },
    state(worker: import("./store").WorkerRecord) {
      return workerHasPrivateMemory(worker) ? states.get(worker.threadId!) ?? "UniiChat attachment not confirmed" : null;
    },
    ensure(worker: import("./store").WorkerRecord): Promise<boolean> {
      if (!workerHasPrivateMemory(worker)) return Promise.resolve(false);
      const threadId = worker.threadId!;
      const scope = `initiatives:${workerMemoryKey(worker)}`;
      const identity = `${threadId}:${scope}`;
      const current = pending.get(identity);
      if (current) return current;
      const run = (async () => {
        try {
          const status = () => bounded(async () => workerStatusSchema.parse(await sdk.plugins.callRpc({
            pluginId: CHAT_MEMORY_PLUGIN_ID, method: "status", input: { threadId }, outputSchema: workerStatusSchema,
          })));
          let confirmed = await status();
          if (confirmed && (confirmed.scope.id !== scope || confirmed.scope.owner !== "initiatives"))
            throw new Error(`Existing scope ${confirmed.scope.id} differs from ${scope}; private migration is held to preserve previously logged history`);
          if (!confirmed) {
            states.set(threadId, "UniiChat attaching private scope; history catch-up is owned by Chat memory");
            const attached = await bounded(async () => z.object({ scope: z.literal(scope) }).parse(await sdk.plugins.callRpc({
              pluginId: CHAT_MEMORY_PLUGIN_ID, method: "attach", input: { threadId, key: workerMemoryKey(worker) }, outputSchema: z.object({ scope: z.literal(scope) }),
            })));
            if (attached.scope !== scope) throw new Error("Private scope attachment did not confirm");
            confirmed = await status();
          }
          if (confirmed?.scope.id !== scope || confirmed.scope.owner !== "initiatives") throw new Error("Private scope did not confirm");
          const optchat = confirmed.mode === "optchat";
          const prepared = !optchat || (confirmed.tree?.ready === true && confirmed.tree.ingesting === false);
          const requiredFailure = optchat ? confirmed.tree?.requiredFailure ?? null : null;
          admission.set(identity, { ready: prepared && requiredFailure === null, requiredFailure });
          states.set(threadId, optchat
            ? `UniiChat private scope confirmed (${scope}); ${requiredFailure ?? (prepared ? "history ready" : "preparing history; turns stay queued")}`
            : `Private scope confirmed (${scope}), mode ${confirmed.mode}; legacy cold guard applies`);
          return optchat;
        } catch (error) {
          const message = `UniiChat private memory not confirmed for ${worker.ref}: ${errorMessage(error)}`;
          admission.delete(identity);
          states.set(threadId, message);
          throw new Error(message);
        }
      })();
      pending.set(identity, run);
      void run.finally(() => pending.delete(identity)).catch(() => {});
      return run;
    },
  };
}
