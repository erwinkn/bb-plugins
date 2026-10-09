import { dirname, join } from "node:path";
import { addAbortListener } from "node:events";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMPACT_TRIES, createCompaction } from "./lib/compaction";
import { chatMemoryContract } from "./lib/contract";
import { IMPORTED_FLAG, importInitiativesMemory, snapshotInitiatives, type ImportPaths } from "./lib/import";
import { sdkEvents } from "./lib/ingest";
import { ChatMemory, MemoryError, PLUGIN_ID, TURN_CONTEXT_TOOL, errorMessage, turnAskSchema, zoomToolSchema, type ThreadFacts } from "./lib/memory";
import { poolerSummarizer } from "./lib/pooler";
import { MEMORY_GUIDANCE } from "./lib/prompt";
import { defineSettings } from "./lib/settings";
import { MIGRATIONS, MemoryStore } from "./lib/store";

const SWEEP_INTERVAL_MS = 30_000;
/**
 * T143: memory_read and memory_zoom load upfront in Claude Code rather than behind ToolSearch,
 * through the fork's alwaysLoad. The SDK types lack the field and an upstream BB ignores it, so it
 * is spread in untyped.
 */
const ALWAYS_LOAD = { alwaysLoad: true } as {};
export const CHANGED_CHANNEL = "chat-memory-changed";

const notFound = (error: unknown) => (error as { status?: number }).status === 404;

/**
 * An agent tool's name, taken as soon as it is free. BB skips a registration whose name another
 * loaded plugin holds (the Initiatives plugin before T145 held the turn hook's), with only a
 * warning, and takes one later; registering a name a plugin holds already throws "already
 * registered". So claim() registers again: that tells which, and takes the name once its holder
 * lets it go (reloaded without it), with no reload of this plugin. held() only reads: BB lists a
 * plugin's tools before it calls its configure, so a configure that claimed the name could not
 * select it in the same call. A stopped plugin registers nothing: it keeps what it knew.
 */
export function toolClaim(register: () => void, onTaken: () => void = () => {}) {
  let holds = false;
  const attempt = () => {
    try {
      register();
      return false;
    } catch (error) {
      if (/already registered/.test(errorMessage(error))) return true;
      throw error;
    }
  };
  return {
    held: () => holds,
    claim() {
      if (holds) return true;
      try {
        // A registration that returns either took the name or was skipped: the next one tells.
        holds = attempt() || attempt();
      } catch {
        return holds;
      }
      if (holds) onTaken();
      return holds;
    },
  };
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new MemoryStore(db);
  // T145: the Initiatives plugin's memory, once, from a verified snapshot of its database
  // (<dataDir>/plugins/<id>/data.db), never from the database itself (lib/import.ts).
  const importPaths: ImportPaths = {
    live: join(bb.server.experimental_dataDir, "plugins", "initiatives", "data.db"),
    // Beside this plugin's own database.
    snapshot: join(dirname(db.name), "initiatives-snapshot.db"),
  };
  let importPending: string | null = null;
  const runImport = () => {
    const result = importInitiativesMemory(store, importPaths);
    importPending = result && "pending" in result ? result.pending : null;
    if (result && "imported" in result) bb.log.info(`Imported the Initiatives memory: ${JSON.stringify(result.imported)}`);
    if (importPending) bb.log.warn(`The Initiatives memory is not imported yet (${importPending}): run \`bb ${PLUGIN_ID} import-initiatives\`. Until then Initiatives' memory scopes wait.`);
    return result;
  };
  runImport();
  const settings = defineSettings(bb);
  const turnContextTool = {
    name: TURN_CONTEXT_TOOL,
    description: "Internal to BB's Claude Code provider: how the next turn of a thread with chat memory runs (OptChat). Never call it.",
    parameters: z.object({}).passthrough(),
    execute: async (args: Record<string, unknown>, { threadId }: { threadId: string }) => {
      const ask = turnAskSchema.safeParse(args);
      if (!ask.success) throw new MemoryError(`${TURN_CONTEXT_TOOL} is called by BB's Claude Code provider only (protocol 3 or 4).`);
      return JSON.stringify(await memory.turnContext(threadId, ask.data));
    },
  };
  const recheck = () => void bb.experimental_hooks.recheck("message.dispatch").catch((error) => bb.log.warn(`Chat memory could not ask BB to re-check held messages: ${errorMessage(error)}`));
  // D431 phase 2: not shown to the model. BB's Claude Code provider calls it before each new turn
  // (TurnAsk); "{}" lets the session go on. A failure throws, so the provider fails the turn and
  // keeps its input (D458): never a silent fallback to the old session.
  const hook = toolClaim(() => bb.agents.registerTool(turnContextTool), () => {
    bb.log.info(`Chat memory holds ${TURN_CONTEXT_TOOL}.`);
    recheck();
  });
  const memory = new ChatMemory({
    store,
    list: sdkEvents(bb.sdk),
    thread: async (threadId): Promise<ThreadFacts | null> => {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        return { providerId: t.providerId, title: t.title ?? null, originPluginId: t.originPluginId ?? null, parentThreadId: t.parentThreadId ?? null };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    ownerMetadata: async (threadId, pluginId) => (await bb.sdk.threads.getPluginMetadata({ threadId, pluginId })) as Record<string, unknown>,
    status: async (threadId) => {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        return t.archivedAt || t.deletedAt ? "archived" : t.status;
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    settings: settings.current,
    summarizer: poolerSummarizer(bb),
    log: (message) => bb.log.warn(message),
    changed: (scope) => bb.realtime.publish(CHANGED_CHANNEL, { scope }),
    hookOwned: () => hook.held(),
    recheck,
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
    setScope: ({ key, threads, hold }, { experimental_caller: caller }) => {
      if (caller.kind !== "plugin") throw new MemoryError("A memory scope's threads are set by the plugin that owns it.");
      // Its memory comes first: a scope registered before the import would start an empty log.
      if (caller.pluginId === "initiatives" && importPending) throw new MemoryError(`Chat memory has not imported the Initiatives memory yet (${importPending}): run \`bb ${PLUGIN_ID} import-initiatives\`.`);
      // An owner's first call after its own reload is when the hook it held may have come free.
      hook.claim();
      return { scope: memory.setScope(caller.pluginId, key, threads, hold) };
    },
    read: ({ threadId }) => memory.read(memory.scopeOf(threadId).id),
    zoom: ({ threadId, id, n }) => memory.zoom(memory.scopeOf(threadId).id, id, n),
    status: async ({ threadId }) => {
      const scope = store.currentScopeOf(threadId);
      return scope ? memory.status(scope.id) : null;
    },
    // D452: only the user switches a memory, from this plugin's app. Plugins are refused here;
    // agents have no tool or CLI that writes. BB gives a client RPC no finer identity, so a local
    // caller who knows this method can still reach it (accepted, as in Initiatives' setMemory).
    configure: async ({ threadId, ...patch }, { experimental_caller: caller }) => {
      if (caller.kind !== "client") throw new MemoryError("Only the user switches a thread's memory, from its Memory panel.");
      hook.claim();
      return memory.configure(threadId, patch);
    },
  });

  // D447: a thread with memory gets its tools and one line of guidance in every mode, since BB fixes
  // a session's tools when it is built and a mode switch applies at the next turn (sessionTools).
  bb.agents.configure((ctx) => {
    const tools = memory.sessionTools({
      threadId: ctx.thread.id,
      parentThreadId: ctx.thread.parentThreadId,
      originPluginId: ctx.origin.pluginId ?? null,
      // BB's fork only (FORK.md), so not in the SDK's types.
      originMetadata: (ctx.origin as { pluginMetadata?: Record<string, unknown> }).pluginMetadata,
      providerId: ctx.provider.id,
    });
    // For BB's next resolution: this one listed the tools already.
    hook.claim();
    return tools ? { tools, skills: ["chat-memory"], instructions: MEMORY_GUIDANCE } : { tools: [], skills: [] };
  });

  // D458, D460: an OptChat message that cannot run as OptChat is refused here, early and with its
  // reason, or held while the cause may pass (lib/memory.ts admit). The turn itself enforces the
  // mode on every path (FORK.md). Every message passes here before BB builds or resolves its
  // session, so this is where a turn hook that came free is taken, in time for that configure.
  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    hook.claim();
    return memory.admit({
      threadId: ctx.thread.id,
      providerId: ctx.requestedExecution.providerId,
      attempt: ctx.attempt,
      originPluginId: ctx.thread.originPluginId ?? null,
      parentThreadId: ctx.thread.parentThreadId ?? null,
    });
  });

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
  bb.agents.registerTool(turnContextTool);
  hook.claim();

  // A thread's turn ended or it is working: its scopes' logs catch up; its context may need compacting.
  const kick = (threadId: string) => {
    for (const scope of store.scopesReading(threadId)) memory.kick(scope);
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
  bb.events.on("experimental_thread.events", ({ thread }) => kick(thread.id));
  bb.events.on("thread.idle", ({ thread }) => {
    kick(thread.id);
    compact(thread.id);
  });

  bb.background.service("chat-memory-sweep", {
    async start(signal) {
      stopSignal = signal;
      memory.start(signal);
      // Messages an earlier instance held go through the gate again.
      recheck();
      try {
        while (!signal.aborted) {
          hook.claim();
          memory.sweep();
          // A failed compaction is tried again while its thread stays idle (compaction decides when).
          for (const { threadId } of store.compactFailures(COMPACT_TRIES)) compact(threadId);
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
      {
        name: "import-initiatives",
        summary: "T145 cutover: snapshot the Initiatives database read only, verify it, and import its memory from the snapshot (once)",
        usage: `bb ${PLUGIN_ID} import-initiatives`,
      },
    ],
    async run(argv, ctx) {
      const args = argv.filter((a) => a !== "--json");
      const [action, ...rest] = args;
      const usage = `Usage: bb ${PLUGIN_ID} status [thread-id] | read [thread-id] | zoom <id> <n> [thread-id] | import-initiatives. Switching a memory is the user's, from the thread's Memory panel.`;
      try {
        const scopeOf = (threadId: string | undefined) => memory.scopeOf(threadId ?? ctx.threadId);
        let result: unknown;
        if (action === "import-initiatives" && rest.length === 0) {
          if (!importPending) return { exitCode: 0, stdout: `Nothing to import: ${store.meta(IMPORTED_FLAG) ?? "no Initiatives database"}` };
          const snapshot = snapshotInitiatives(store, importPaths);
          const outcome = runImport();
          if (importPending) throw new MemoryError(`The snapshot was taken but not imported: ${importPending}.`);
          result = { snapshot: { path: importPaths.snapshot, ...snapshot }, ...(outcome ?? {}) };
        } else if (action === "status" && rest.length <= 1) result = await memory.status(scopeOf(rest[0]).id);
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
