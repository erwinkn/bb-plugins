import { addAbortListener } from "node:events";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMPACT_TRIES, createCompaction } from "./lib/compaction";
import { chatMemoryContract } from "./lib/contract";
import { sdkEvents } from "./lib/ingest";
import { ChatMemory, MemoryError, PLUGIN_ID, TURN_CONTEXT_TOOL, errorMessage, notFound, turnAskSchema, zoomToolSchema, type ThreadFacts } from "./lib/memory";
import { poolerSummarizer } from "./lib/pooler";
import { MEMORY_GUIDANCE } from "./lib/prompt";
import { defineSettings } from "./lib/settings";
import { MIGRATIONS, MemoryStore } from "./lib/store";

/** Failed compactions are tried again this often (compaction decides when)... */
const SWEEP_INTERVAL_MS = 30_000;
/** ...and turn ends BB never announced are caught this often (D485). */
const INGEST_SWEEP_MS = 5 * 60_000;
/**
 * T143: memory_read and memory_zoom load upfront in Claude Code rather than behind ToolSearch,
 * through the fork's alwaysLoad. The SDK types lack the field and an upstream BB ignores it, so it
 * is spread in untyped.
 */
const ALWAYS_LOAD = { alwaysLoad: true } as {};
export const CHANGED_CHANNEL = "chat-memory-changed";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new MemoryStore(db);
  const settings = defineSettings(bb);
  const memory = new ChatMemory({
    store,
    list: sdkEvents(bb.sdk),
    thread: async (threadId): Promise<ThreadFacts | null> => {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        return { providerId: t.providerId, title: t.title ?? null, originPluginId: t.originPluginId ?? null, archived: !!(t.archivedAt || t.deletedAt) };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    settings: settings.current,
    summarizer: poolerSummarizer(bb),
    log: (message) => bb.log.warn(message),
    changed: (scope) => bb.realtime.publish(CHANGED_CHANNEL, { scope }),
  });
  const compaction = createCompaction({
    sdk: bb.sdk,
    store,
    limit: (scope) => memory.compactLimit(scope),
    log: (message) => bb.log.info(message),
    changed: (scope) => bb.realtime.publish(CHANGED_CHANNEL, { scope }),
  });
  const compactions = new Map<string, AbortController>();
  let stopSignal: AbortSignal | undefined;
  bb.onDispose(() => {
    for (const abort of compactions.values()) abort.abort();
    memory.dispose();
  });

  bb.rpc.register(chatMemoryContract, {
    attach: ({ threadId, key }, { experimental_caller: caller }) => {
      if (caller.kind !== "plugin") throw new MemoryError("A thread is attached to a memory by the plugin that owns it.");
      return { scope: memory.attach(threadId, `${caller.pluginId}:${key}`)! };
    },
    read: ({ threadId }) => memory.read(memory.scopeOf(threadId).id),
    zoom: ({ threadId, id, n }) => memory.zoom(memory.scopeOf(threadId).id, id, n),
    status: async ({ threadId }) => {
      const scope = store.scopeOf(threadId);
      return scope ? memory.status(scope.id) : null;
    },
    // D452: only the user switches a memory, from this plugin's app. Plugins are refused here;
    // agents have no tool or CLI that writes. BB gives a client RPC no finer identity, so a local
    // caller who knows this method can still reach it (accepted, as in Initiatives' setMemory).
    configure: async ({ threadId, ...patch }, { experimental_caller: caller }) => {
      if (caller.kind !== "client") throw new MemoryError("Only the user switches a thread's memory, from its Memory panel.");
      return memory.configure(threadId, patch);
    },
  });

  // D447: a thread with memory gets its tools and one line of guidance in every mode, since BB fixes
  // a session's tools when it is built and a mode switch applies at the next turn (sessionTools).
  bb.agents.configure((ctx) => {
    const tools = memory.sessionTools({
      threadId: ctx.thread.id,
      originPluginId: ctx.origin.pluginId ?? null,
      // BB's fork only (FORK.md), so not in the SDK's types.
      originMetadata: (ctx.origin as { pluginMetadata?: Record<string, unknown> }).pluginMetadata,
      providerId: ctx.provider.id,
    });
    return tools ? { tools, skills: ["chat-memory"], instructions: MEMORY_GUIDANCE } : { tools: [], skills: [] };
  });

  // D460: an OptChat message that cannot run as OptChat is refused here, early and with its reason
  // (lib/memory.ts admit). The turn itself enforces the mode on every path (FORK.md).
  bb.experimental_hooks.on("message.dispatch", (ctx) =>
    memory.admit({ threadId: ctx.thread.id, providerId: ctx.requestedExecution.providerId, attempt: ctx.attempt }),
  );

  bb.agents.registerTool({
    ...ALWAYS_LOAD,
    name: "memory_read",
    description: "Read your memory view: the whole chat as one-line summaries \"id+n|text\", oldest first. Open a line with memory_zoom.",
    parameters: z.object({}).strict(),
    execute: async (_input, { threadId }) => JSON.stringify(memory.read(memory.scopeOf(threadId).id)),
  });
  bb.agents.registerTool({
    ...ALWAYS_LOAD,
    name: "memory_zoom",
    description: "Open line id+n of your memory view into the two lines it was made from; n:1 gives message id whole. Each line starts with the time of its first message.",
    parameters: zoomToolSchema,
    execute: async ({ id, n }, { threadId }) => memory.zoom(memory.scopeOf(threadId).id, id, n),
  });
  // Sessions built while Initiatives owned memory still call initiative_zoom and initiative_read
  // {view:"memory"}: Initiatives keeps both as aliases over this plugin's read and zoom RPCs.
  // D431 phase 2: not shown to the model. BB's Claude Code provider calls it before each new turn
  // (TurnAsk); "{}" lets the session go on. A failure throws, so the provider fails the turn and
  // keeps its input (D458): never a silent fallback to the old session.
  bb.agents.registerTool({
    name: TURN_CONTEXT_TOOL,
    description: "Internal to BB's Claude Code provider: how the next turn of a thread with chat memory runs (OptChat). Never call it.",
    parameters: z.object({}).passthrough(),
    execute: async (args: Record<string, unknown>, { threadId, signal }: { threadId: string; signal: AbortSignal }) => {
      const ask = turnAskSchema.safeParse(args);
      if (!ask.success) throw new MemoryError(`${TURN_CONTEXT_TOOL} is called by BB's Claude Code provider only (protocol 4).`);
      return JSON.stringify(await memory.turnContext(threadId, ask.data, signal));
    },
  });

  // D485: a turn ended (stopped included), failed, or its thread was archived (its final copy):
  // its completed turns are copied; after an idle its context may need compacting. The cursor makes
  // every trigger idempotent, so a duplicate copies nothing and a missed one waits for the next.
  const ingest = (threadId: string) => {
    if (store.thread(threadId)?.scope) memory.kick(threadId);
  };
  const compact = (threadId: string) => {
    if (compactions.has(threadId) || stopSignal?.aborted) return;
    const abort = new AbortController();
    const link = stopSignal ? addAbortListener(stopSignal, () => abort.abort()) : null;
    compactions.set(threadId, abort);
    void compaction
      .afterIdle(threadId, abort.signal)
      .catch((error) => {
        if (!abort.signal.aborted) bb.log.warn(`Compaction check for ${threadId} failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        link?.[Symbol.dispose]();
        compactions.delete(threadId);
      });
  };
  bb.events.on("thread.idle", ({ thread }) => {
    ingest(thread.id);
    compact(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => ingest(thread.id));
  bb.events.on("thread.archived", ({ thread }) => ingest(thread.id));

  bb.background.service("chat-memory-sweep", {
    async start(signal) {
      stopSignal = signal;
      memory.start(signal);
      try {
        // The startup walk takes archived threads too: their archive may have come while the plugin was down.
        let swept = -Infinity;
        for (let first = true; !signal.aborted; first = false) {
          if (Date.now() - swept >= INGEST_SWEEP_MS) {
            swept = Date.now();
            await memory.sweep(!first);
            // A stop during the sweep's reads ends it at once: no more database work, no next wait.
            if (signal.aborted) break;
          }
          for (const threadId of store.compactFailures(COMPACT_TRIES)) compact(threadId);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, SWEEP_INTERVAL_MS);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
          });
        }
      } finally {
        memory.dispose();
      }
    },
  });

  bb.cli.register({
    name: PLUGIN_ID,
    summary: "Read a thread's chat memory: its status, its memory view, and any line zoomed",
    commands: [
      { name: "status", summary: "The memory of a thread's scope: mode, threads, log, tree, cost, problems", usage: `bb ${PLUGIN_ID} status [thread-id]` },
      { name: "read", summary: "The memory view (memory_read): one-line summaries, oldest first", usage: `bb ${PLUGIN_ID} read [thread-id]` },
      { name: "zoom", summary: "Open line id+n into its two lines; n 1 gives message id whole; each line starts with its time", usage: `bb ${PLUGIN_ID} zoom <id> <n> [thread-id]` },
    ],
    async run(argv, ctx) {
      const args = argv.filter((a) => a !== "--json");
      const [action, ...rest] = args;
      const usage = `Usage: bb ${PLUGIN_ID} status [thread-id] | read [thread-id] | zoom <id> <n> [thread-id]. Switching a memory is the user's, from the thread's Memory panel.`;
      try {
        const scopeOf = (threadId: string | undefined) => memory.scopeOf(threadId ?? ctx.threadId);
        let result: unknown;
        if (action === "status" && rest.length <= 1) result = await memory.status(scopeOf(rest[0]).id);
        else if (action === "read" && rest.length <= 1) result = memory.read(scopeOf(rest[0]).id);
        else if (action === "zoom" && rest.length >= 2 && rest.length <= 3) result = memory.zoom(scopeOf(rest[2]).id, Number(rest[0]), Number(rest[1]));
        else return { exitCode: 2, stderr: usage };
        return { exitCode: 0, stdout: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      }
    },
  });

  return { memory, store, settings, compaction };
}
