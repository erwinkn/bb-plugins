import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { TURN_CONTEXT_TOOL, type TurnAnswer } from "../lib/memory";
import type { EventRow } from "../lib/log";
import type { Summarizer, SummarizerRequest } from "../lib/summarizer";

/** Luna that answers at once: "summary of <message or pair>". */
export const fakeLuna: Summarizer = async (r: SummarizerRequest) => {
  const task = (r.input[0]!.content[1] as { text: string }).text;
  const name = /compress message (\d+)/.exec(task)?.[1] ?? /merge lines (\d+\+\d+ and \d+\+\d+)/.exec(task)![1];
  return { ok: true, text: `summary of ${name}`, usage: { input: 2000, cached: 1500, output: 100, reasoning: 50 }, latencyMs: 1 };
};
/** Luna that never answers (until its call is aborted). */
export const stuckLuna: Summarizer = (r) => new Promise((resolve) => r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "stopped" })));

interface Thread {
  providerId: string;
  title: string | null;
  originPluginId: string | null;
  parentThreadId: string | null;
  status: string;
  archived?: boolean;
  /** The origin plugin's metadata on it (MEMORY_SCOPE_KEY names the scope it writes to). */
  metadata?: Record<string, unknown>;
}
type Row = EventRow & { threadId: string };

/**
 * The plugin on BB's fake host, with BB's thread events and threads faked: `history` holds the
 * events every thread recorded, served the way an older BB's events.list serves them (`limit` per
 * type; readTurns takes the first `limit` rows either way). A thread not in `threads` is a 404.
 */
export function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "chat-memory-"));
  const history: Row[] = [];
  const threads = new Map<string, Thread>();
  const compacts: string[] = [];
  /** Every events.list call, in order. */
  const reads: Array<{ threadId: string; types: string[]; afterSeq?: string }> = [];
  let failReads = false;
  let seq = 100;
  let at = Date.UTC(2026, 9, 8, 12, 0);
  const { bb, harness } = createFakePluginHost({
    pluginId: "chat-memory",
    dataDir,
    agentSkillIds: ["chat-memory"],
    sdk: {
      threads: {
        events: {
          list: async (args: { threadId: string; types: string[]; order: "asc" | "desc"; limit: string; afterSeq?: string }) => {
            reads.push(args);
            if (failReads) throw new Error("events unavailable");
            if (!threads.has(args.threadId)) throw Object.assign(new Error("not found"), { status: 404 });
            const rows = history.filter((r) => r.threadId === args.threadId && args.types.includes(r.type) && (args.afterSeq === undefined || r.seq > Number(args.afterSeq)));
            const order = (a: Row, b: Row) => (args.order === "asc" ? a.seq - b.seq : b.seq - a.seq);
            return args.types.flatMap((type) => rows.filter((r) => r.type === type).sort(order).slice(0, Number(args.limit))).sort(order);
          },
        },
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (!t) throw Object.assign(new Error("not found"), { status: 404 });
          return makeThreadResponse({ id: threadId, providerId: t.providerId, title: t.title, originPluginId: t.originPluginId, parentThreadId: t.parentThreadId, status: t.status as never, archivedAt: t.archived ? at : null });
        },
        compact: async ({ threadId }: { threadId: string }) => {
          compacts.push(threadId);
          return {};
        },
      },
    } as never,
  });
  const exposed = plugin(bb);
  const { memory, store } = exposed;
  memory.useSummarizer(fakeLuna);
  memory.waits = { turn: 1_500 };
  // Nothing outlives its test, and its database goes with it.
  onTestFinished(() => {
    memory.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const record = (threadId: string, type: string, data: Record<string, unknown>) => {
    history.push({ threadId, seq: ++seq, type, createdAt: ++at, data });
    return seq;
  };
  const f = {
    bb,
    harness,
    memory,
    store,
    history,
    threads,
    compacts,
    reads,
    dataDir,
    failReads: (on: boolean) => void (failReads = on),
    /** BB's message.dispatch pass, as chat memory's gate answers it. */
    dispatch(threadId: string, options: { providerId?: string; attempt?: "start-turn" | "join-turn" } = {}) {
      const t = threads.get(threadId);
      const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
      return hook(
        makeMessageDispatchHookContext({
          thread: makeThreadResponse({ id: threadId, providerId: t?.providerId ?? "claude-code" }),
          requestedExecution: { providerId: options.providerId ?? t?.providerId ?? "claude-code", model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
          attempt: options.attempt ?? "start-turn",
        } as never),
      );
    },
    thread(id: string, facts: Partial<Thread> = {}) {
      threads.set(id, { providerId: "claude-code", title: null, originPluginId: null, parentThreadId: null, status: "idle", ...facts });
      return id;
    },
    /** The user (or a sender) sends a message: BB records its request; returns its request id. */
    say(threadId: string, text: string, data: Record<string, unknown> = {}) {
      const requestId = `creq_${seq + 1}`;
      record(threadId, "client/turn/requested", { direction: "outbound", source: "tell", initiator: "user", senderThreadId: null, requestId, input: [{ type: "text", text }], ...data });
      return requestId;
    },
    reply: (threadId: string, text: string) => record(threadId, "item/completed", { item: { type: "agentMessage", id: `i${seq}`, text } }),
    /** The thread's turn ends: BB records its turn/completed. */
    done: (threadId: string, status: "completed" | "failed" | "interrupted" = "completed") => record(threadId, "turn/completed", { status }),
    /** A whole turn: the message, the reply, its end. Returns the request id. */
    turn(threadId: string, text: string, reply = `re: ${text}`) {
      const requestId = f.say(threadId, text);
      f.reply(threadId, reply);
      f.done(threadId);
      return requestId;
    },
    /** The provider reports an error in the thread's turn (BB's provider/error), as the turn's failure says it. */
    providerError: (threadId: string, detail: string) => record(threadId, "provider/error", { message: "Provider error", detail }),
    usage: (threadId: string, usedTokens: number) => record(threadId, "thread/contextWindowUsage/updated", { contextWindowUsage: { usedTokens } }),
    /** An owner plugin attaches threads to its scope "<owner>:<key>" (D491). Returns the scope. */
    async attach(owner: string, key: string, ...threadIds: string[]) {
      let scope = "";
      for (const threadId of threadIds) ({ scope } = (await harness.behavior.callRpc("attach", { threadId, key }, { experimental_caller: { kind: "plugin", pluginId: owner } })) as { scope: string });
      await memory.settled();
      return scope;
    },
    /** The user switches a thread's memory from the app. */
    configure: (threadId: string, patch: Record<string, unknown>) => harness.behavior.callRpc("configure", { threadId, ...patch }),
    /** BB's Claude Code bridge asks how the thread's next turn runs. */
    async ask(threadId: string, requestId: string, input: string, extra: Record<string, unknown> = {}) {
      const answer = await harness.behavior.callAgentTool(TURN_CONTEXT_TOOL, { protocol: 4, input, requestId, sessionId: `s-${threadId}`, ...extra }, { threadId });
      return JSON.parse(answer as string) as TurnAnswer;
    },
    /** A thread's turn ended: BB says so; the memory copies its completed turns and builds. */
    async idle(threadId: string) {
      await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText: null } as never);
      await memory.settled();
    },
    async failed(threadId: string) {
      await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: threadId }), error: "failed" } as never);
      await memory.settled();
    },
    async archived(threadId: string) {
      threads.get(threadId)!.archived = true;
      await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: threadId }) } as never);
      await memory.settled();
    },
    /** The log of a scope, as "kind: text" lines. */
    log: (scopeId: string) => store.messages(scopeId).map((m) => `${m.kind}: ${m.text}`),
    configureAgent: (threadId: string, options: { providerId?: string; parentThreadId?: string | null; origin?: string | null } = {}) =>
      harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: threadId, title: null, parentThreadId: options.parentThreadId ?? null, sourceThreadId: null },
          provider: { id: options.providerId ?? "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
          // As BB's fork gives it: the origin plugin's metadata on the thread.
          origin: { kind: null, pluginId: options.origin ?? null, ...(options.origin ? { pluginMetadata: threads.get(threadId)?.metadata ?? {} } : {}) },
        } as never),
      ),
  };
  return f;
}
export type Fixture = ReturnType<typeof fixture>;
