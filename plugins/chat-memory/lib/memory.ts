import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import { TreeBuilder, type BuilderStatus } from "./builder";
import { readTurns, type ListEvents } from "./ingest";
import { UNAVAILABLE, turnEntries, type EventRow } from "./log";
import { COMPACTION_PROMPT, messageText, stamp, turnMessage, turnSystem } from "./prompt";
import { FairPermits } from "./permits";
import type { Settings } from "./settings";
import { MemoryStore, type MemoryMode, type Scope } from "./store";
import type { Summarizer } from "./summarizer";
import { NodeCache, children, end, label, nodeAt, renderLine, start, viewBytes } from "./tree";
import { WHOLE_BYTES, turnView } from "./turn";
import type { NodeRef } from "./tree";

export const PLUGIN_ID = "chat-memory";
export const zoomToolSchema = z.object({ id: z.number().int().min(0), n: z.number().int().min(1) }).strict();

/** A user-facing refusal or failure: its message is shown as is. */
export class MemoryError extends Error {
  override name = "MemoryError";
}
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const notFound = (error: unknown) => (error as { status?: number }).status === 404;

/** Event pages one copy reads per thread before yielding; the next pass goes on. */
const INGEST_PAGES = 20;
/** The memory's own progress (log and tree) reaches the UI at most this often; it also polls. */
const PROGRESS_PUBLISH_MS = 30_000;

/**
 * The hidden tool BB's Claude Code provider (Erwin's fork) calls before each new turn whose tools,
 * as BB resolves them for that turn, include it (FORK.md, "per-turn context from a hidden tool",
 * protocol 4); any other provider refuses a turn whose tools include it.
 */
export const TURN_CONTEXT_TOOL = "claude_code_turn_context";
export const turnAskSchema = z.object({
  protocol: z.literal(4),
  /** The turn's own text. */
  input: z.string(),
  /** Its BB request (the client/turn/requested event's requestId). */
  requestId: z.string().min(1),
  /** The provider session the thread runs in now. */
  sessionId: z.string().min(1).nullable(),
});
export type TurnAsk = z.infer<typeof turnAskSchema>;
/** A fresh session for the turn, or none: the thread's session goes on. */
export type TurnAnswer =
  | { session: "fresh"; sessionId: string; systemPrompt: string; input: string }
  | Record<string, never>;

/**
 * D458: how long an OptChat turn waits for its memory (its own last turn logged, the summaries the
 * view needs) before it fails. The fork's hook gives an answer 120 s.
 */
export const TURN_WAIT_MS = 90_000;
/** Failed reads of the thread's last turn a turn tries before it fails. */
export const TURN_READ_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 250;
/**
 * The key in an owner plugin's metadata on a thread it spawns that names the scope the thread
 * writes to (D446, D487): an Initiative's coordinators and discussions carry
 * {memoryScope: <Initiative id>}. BB's fork shows it to configure as the origin's metadata.
 */
export const MEMORY_SCOPE_KEY = "memoryScope";
/** The scope an owner's metadata on a thread names (MEMORY_SCOPE_KEY), or null. */
const scopeNamed = (owner: string, metadata: Readonly<Record<string, unknown>>) => {
  const key = metadata[MEMORY_SCOPE_KEY];
  return typeof key === "string" && key ? `${owner}:${key}` : null;
};
/** "<owner>:<key>" → owner. */
const ownerOf = (scopeId: string) => scopeId.slice(0, scopeId.indexOf(":"));
/** What the turn gate (BB's message.dispatch hook) answers. */
export type DispatchDecision = { action: "proceed" } | { action: "reject"; message: string };

/** What the memory needs to know about a BB thread. */
export interface ThreadFacts {
  providerId: string;
  title: string | null;
  originPluginId: string | null;
  archived: boolean;
}
/** What chat memory decides a session from, when BB builds it or resolves it for a turn. */
export interface SessionFacts {
  threadId: string;
  originPluginId: string | null;
  /** The origin plugin's metadata on the thread (BB's fork gives it to every configure); undefined when BB does not. */
  originMetadata: Readonly<Record<string, unknown>> | undefined;
  providerId: string;
}

export interface MemoryStatus {
  scope: { id: string; owner: string };
  mode: MemoryMode;
  /** The compaction limit in effect (0: off), and the scope's own, if set. */
  compactTokens: number;
  compactTokensOverride: number | null;
  /** The threads that write to it now. */
  threads: Array<{
    threadId: string;
    title: string | null;
    providerId: string | null;
    compactedAt: number | null;
    /** Its last compaction failed, with this error; null once one succeeds. */
    compactError: string | null;
  }>;
  log: { messages: number; bytes: number };
  tree: {
    summarized: number;
    nodes: number;
    /** Nodes a complete tree over the log has. */
    total: number;
    fallbacks: number;
    /** Lines whose summary failed after bounded retries (D458): turns that need them fail. */
    failed: number;
    viewBytes: number;
    memoryViewBytes: number;
    state: BuilderStatus["state"];
    detail: string | null;
    until: number | null;
  };
  cost: { calls: number; tries: number; inputTokens: number; cachedTokens: number; outputTokens: number; usd: number; callSeconds: number };
  /** D458: why the mode cannot run as set for one of its threads, shown wherever the mode is. */
  problems: string[];
}

/** A complete tree over n messages has floor(n/2^l) nodes on each level l. */
const treeSize = (n: number) => {
  let total = 0;
  for (let size = 1; size <= n; size *= 2) total += Math.floor(n / size);
  return total;
};

interface Run {
  abort: AbortController;
  /** Asked again while running: go on. */
  again: boolean;
  done: Promise<void>;
  /** The last pass's failure, if it failed. */
  error: unknown;
}

/**
 * D457: every scope's memory. A thread writes to at most one scope at a time (its row in the
 * threads table, D491); its completed turns are copied into that scope's log, and GPT-6 Luna
 * builds the summary tree over it in the background in every mode (D447), so a switch between
 * modes is instant. The mode is one setting per scope, read at each turn:
 * - regular: the thread's session goes on, compacted past the regular limit (300k);
 * - hybrid: the same, compacted past the hybrid limit (150k); memory_read and memory_zoom bring
 *   back what compactions dropped;
 * - optchat: each turn is a fresh session over the memory view (turnContext); never compacted.
 *
 * Copies run one per thread, builds one per scope, detached and owned here, aborted by dispose
 * (the service signal disposes too). Every scope's summarizer calls share one limit, let in
 * round-robin by scope (W244). After dispose nothing new starts and nothing more is written.
 */
export class ChatMemory {
  readonly store: MemoryStore;
  readonly permits: FairPermits;
  /** Aborted by dispose: what a sweep waits for gives up then, so it never writes after it. */
  private life = new AbortController();
  private stopLink: Disposable | null = null;
  private ingests = new Map<string, Run>();
  private builds = new Map<string, Run>();
  private builders = new Map<string, TreeBuilder>();
  private published = new Map<string, number>();
  /** By thread: the view lines its last OptChat turn froze into its system prompt. */
  private frozen = new Map<string, NodeRef[]>();
  private facts = new Map<string, Promise<ThreadFacts | null>>();
  /** The wait bound (ms); tests shorten it. */
  waits = { turn: TURN_WAIT_MS };

  constructor(
    private readonly deps: {
      store: MemoryStore;
      list: ListEvents;
      /** The thread's facts now, or null once BB no longer has it. */
      thread: (threadId: string) => Promise<ThreadFacts | null>;
      settings: () => Settings;
      summarizer: Summarizer;
      log: (message: string) => void;
      /** Something the UI shows for the scope changed. */
      changed?: (scopeId: string) => void;
    },
  ) {
    this.store = deps.store;
    this.permits = new FairPermits(() => deps.settings().summarizerConcurrency);
  }

  /** Test seam: the summarizer later calls use. */
  useSummarizer(summarizer: Summarizer) {
    this.deps.summarizer = summarizer;
  }

  private get disposed() {
    return this.life.signal.aborted;
  }

  start(signal?: AbortSignal) {
    if (this.disposed) this.life = new AbortController();
    this.stopLink?.[Symbol.dispose]();
    this.stopLink = signal ? addAbortListener(signal, () => this.dispose()) : null;
  }
  /** Abort the sweep, every copy and build, and give up every summary waiter. */
  dispose() {
    this.life.abort();
    this.stopLink?.[Symbol.dispose]();
    this.stopLink = null;
    for (const run of [...this.ingests.values(), ...this.builds.values()]) run.abort.abort();
    for (const builder of this.builders.values()) builder.close();
    this.builders.clear();
  }
  /** Resolves once no copy or build this service started is running. */
  async settled() {
    while (this.ingests.size || this.builds.size)
      await Promise.all([...this.ingests.values(), ...this.builds.values()].map((run) => run.done));
  }

  /** A thread's facts, read once per thread (its title and provider; `archived` is read fresh where it matters); null once BB no longer has it. */
  threadFacts(threadId: string) {
    let facts = this.facts.get(threadId);
    if (!facts) {
      facts = this.deps.thread(threadId);
      this.facts.set(threadId, facts);
      // A failed read is tried again next time.
      facts.catch(() => this.facts.delete(threadId));
    }
    return facts;
  }

  // Threads and scopes ---------------------------------------------------------------------

  /**
   * D491: the thread writes to `scopeId` from its next completed turn on, or to none (null). What
   * it logged stays where it is; what it has not is copied to the new scope. Returns the scope.
   */
  attach(threadId: string, scopeId: string | null) {
    const before = this.store.thread(threadId)?.scope ?? null;
    this.store.transaction(() => {
      if (scopeId) this.store.ensureScope(scopeId, ownerOf(scopeId));
      this.store.attach(threadId, scopeId);
    });
    for (const id of new Set([before, scopeId])) if (id) this.deps.changed?.(id);
    if (scopeId) this.kick(threadId);
    return scopeId;
  }

  // Sessions (D458, D460) ------------------------------------------------------------------

  /**
   * D447: the memory tools a session gets, when BB builds it and again whenever BB resolves a turn:
   * every thread that writes to a scope, in every mode. D490: the turn hook only in OptChat, where a
   * Claude Code thread asks for its view before each turn and BB refuses every turn of a thread on
   * another provider (FORK.md): OptChat runs on Claude Code only (D460, T146). A thread chat memory
   * meets for the first time with its owner's MEMORY_SCOPE_KEY is attached to that scope here, in
   * the same synchronous call, so its first turn already has it (D487).
   */
  sessionTools(t: SessionFacts): string[] | null {
    const named = t.originPluginId && t.originMetadata ? scopeNamed(t.originPluginId, t.originMetadata) : null;
    if (named && !this.store.thread(t.threadId)) {
      this.store.transaction(() => {
        this.store.ensureScope(named, ownerOf(named));
        this.store.attachNew(t.threadId, named);
      });
    }
    const scope = this.store.scopeOf(t.threadId);
    if (!scope) return null;
    return ["memory_read", "memory_zoom", ...(scope.mode === "optchat" ? [TURN_CONTEXT_TOOL] : [])];
  }

  /**
   * D460: the turn gate, before BB sends a message on (its message.dispatch hook). It refuses, with
   * the reason and its message kept, a new turn of an OptChat thread on another provider (Codex,
   * T146). BB would refuse the turn anyway (the hook is in its tools); this only explains it early.
   */
  async admit(d: { threadId: string; providerId: string; attempt: "start-turn" | "join-turn" }): Promise<DispatchDecision> {
    if (d.attempt === "join-turn" || d.providerId === "claude-code" || this.store.scopeOf(d.threadId)?.mode !== "optchat") return { action: "proceed" };
    const name = await this.threadName(d.threadId);
    return { action: "reject", message: `OptChat runs on Claude Code only for now (T146): ${name} runs on ${d.providerId}, so this message was not sent. Switch its memory mode in the Memory pill to send it.` };
  }

  /** "Title" or the thread's id. */
  private async threadName(threadId: string) {
    const facts = await this.threadFacts(threadId).catch(() => null);
    return facts?.title ? `"${facts.title}"` : threadId;
  }

  /** The compaction limit of a scope's threads (0: off): its own, else the setting for its mode; OptChat sessions never grow. */
  compactLimit(scope: Pick<Scope, "mode" | "compactTokens">) {
    if (scope.mode === "optchat") return 0;
    if (scope.compactTokens !== null) return scope.compactTokens;
    const settings = this.deps.settings();
    return scope.mode === "regular" ? settings.regularCompactTokens : settings.hybridCompactTokens;
  }

  /**
   * D452: the user's change, from the app only (the RPC refuses plugins; tools and the CLI never
   * write). A thread that writes to no scope gets its own; enabled:false detaches a thread from its
   * own. D460: OptChat is refused unless every thread of the scope runs on Claude Code.
   */
  async configure(threadId: string, patch: { mode?: MemoryMode; compactTokens?: number | null; enabled?: boolean }) {
    let scope = this.store.scopeOf(threadId);
    if (patch.enabled === false) {
      if (!scope) return null;
      if (scope.owner !== PLUGIN_ID) throw new MemoryError(`This thread's memory belongs to the ${scope.owner} plugin, which decides its threads.`);
      this.attach(threadId, null);
      return null;
    }
    if (!scope) {
      if (!(await this.threadFacts(threadId))) throw new MemoryError(`Unknown thread ${threadId}.`);
      scope = this.store.scope(this.attach(threadId, `${PLUGIN_ID}:${threadId}`)!)!;
    }
    const next = { mode: patch.mode ?? scope.mode, compactTokens: patch.compactTokens === undefined ? scope.compactTokens : patch.compactTokens };
    if (next.mode === "optchat" && scope.mode !== "optchat") {
      const refusal = await this.optchatRefusal(scope.id);
      if (refusal) throw new MemoryError(refusal);
    }
    if (next.mode !== scope.mode || next.compactTokens !== scope.compactTokens) {
      this.store.saveSettings(scope.id, next);
      this.deps.log(`${scope.id}: memory set to ${next.mode}${next.compactTokens === null ? "" : `, compaction past ${next.compactTokens} tokens`}, from the next turn`);
      this.deps.changed?.(scope.id);
    }
    return this.status(scope.id);
  }

  /** Why OptChat cannot run in every thread of the scope (a provider other than Claude Code), or null. */
  private async optchatRefusal(scopeId: string) {
    for (const t of this.store.threadsOf(scopeId)) {
      const facts = await this.threadFacts(t.threadId);
      if (facts?.providerId !== "claude-code")
        return `OptChat runs on Claude Code only for now (T146): ${facts?.title ? `"${facts.title}"` : t.threadId} runs on ${facts?.providerId ?? "an unknown provider"}.`;
    }
    return null;
  }

  /** The log or tree grew: tell the UI, at most every PROGRESS_PUBLISH_MS per scope. */
  private progressed(scopeId: string) {
    const now = this.store.now();
    if (now - (this.published.get(scopeId) ?? -Infinity) < PROGRESS_PUBLISH_MS) return;
    this.published.set(scopeId, now);
    this.deps.changed?.(scopeId);
  }

  // Copy and build -----------------------------------------------------------------------

  /**
   * Copy the thread's completed turns into the scope it writes to, then build that scope. Detached,
   * one run per thread; a kick while it runs makes it read once more. Returns the run.
   */
  kick(threadId: string): Run | null {
    if (this.disposed) return null;
    const running = this.ingests.get(threadId);
    if (running) {
      running.again = true;
      return running;
    }
    // Its signal is checked between reads, never given to the SDK (W193: BB's SDK records a composite on every signal it gets).
    const entry: Run = { abort: new AbortController(), again: false, done: Promise.resolve(), error: null };
    const { signal } = entry.abort;
    // The entry leaves the map in the same step as the loop's last check, so a kick is never lost.
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          entry.error = null;
          const copied = await this.ingest(threadId, signal);
          if (signal.aborted) break;
          // A long history is read in slices; the next one follows at once.
          if (copied.more) entry.again = true;
          if (copied.scope) {
            this.progressed(copied.scope);
            this.build(copied.scope);
          }
        } while (entry.again && !signal.aborted);
      } catch (error) {
        entry.error = error;
        if (!signal.aborted) this.deps.log(`Memory log of ${threadId} failed: ${errorMessage(error)}`);
      } finally {
        this.ingests.delete(threadId);
      }
    })();
    this.ingests.set(threadId, entry);
    return entry;
  }

  /**
   * D487: one read of the thread's events after its cursor, through its last completed turn,
   * appended to the scope its row names when the append commits (store.append). A thread that
   * writes to none is not read. A deleted thread (404) is forgotten. Any other failed read appends
   * nothing: the next trigger reads again. Returns the scope appended to, if any.
   */
  async ingest(threadId: string, signal?: AbortSignal): Promise<{ scope: string | null; more: boolean }> {
    const stopped = () => this.disposed || signal?.aborted === true;
    const t = this.store.thread(threadId);
    if (!t?.scope) return { scope: null, more: false };
    try {
      const read = await readTurns(this.deps.list, threadId, t.cursor, INGEST_PAGES, stopped);
      if (read.through === t.cursor) return { scope: null, more: false };
      const entries = turnEntries(read.rows, threadId, await this.logFacts(threadId, read.rows));
      if (stopped()) return { scope: null, more: false };
      const appended = this.store.append(threadId, entries, read.through);
      return { scope: appended?.appended ? appended.scope : null, more: read.more && appended !== null };
    } catch (error) {
      if (stopped() || !notFound(error)) throw error;
      this.store.forget(threadId);
      return { scope: null, more: false };
    }
  }

  /**
   * D485: the safety net for turn ends BB never announced (its events are fire-and-forget): every
   * attached thread whose last turn/completed is past its cursor is copied, then every scope with a
   * thread builds (a failed line's retry comes due). The startup walk takes archived threads too;
   * the recurring one skips them (`skipArchived`), as their archive was a final copy. Dispose ends
   * it at once, even mid-read: it returns before touching the database again.
   */
  async sweep(skipArchived: boolean) {
    const { signal } = this.life;
    const threads = this.store.attachedThreads();
    for (const t of threads) {
      if (signal.aborted) return;
      try {
        const [latest] = await abortable(this.deps.list({ threadId: t.threadId, types: ["turn/completed"], order: "desc", limit: "1" }), signal);
        if (!latest || latest.seq <= t.cursor) continue;
        if (skipArchived && (await abortable(this.deps.thread(t.threadId), signal))?.archived) continue;
        this.kick(t.threadId);
      } catch (error) {
        if (signal.aborted) return;
        if (notFound(error)) this.store.forget(t.threadId);
        else this.deps.log(`Memory sweep could not read ${t.threadId}: ${errorMessage(error)}`);
      }
    }
    for (const scope of new Set(threads.map((t) => t.scope!))) this.build(scope);
  }

  /** What turnEntries needs for a page of a thread's events: whether a plugin spawned the thread, and its senders' names. */
  private async logFacts(threadId: string, rows: readonly EventRow[]) {
    const facts = await this.threadFacts(threadId);
    const senders = [...new Set(rows.flatMap((r) => (typeof r.data?.senderThreadId === "string" ? [r.data.senderThreadId as string] : [])))];
    const names = new Map(
      await Promise.all(senders.map(async (id) => [id, senderName(await this.threadFacts(id).catch(() => null), id)] as const)),
    );
    return { spawnedByPlugin: !!facts?.originPluginId, sender: (id: string) => names.get(id) ?? id };
  }

  private builder(scopeId: string) {
    let builder = this.builders.get(scopeId);
    if (!builder) {
      builder = new TreeBuilder(this.store.tree(scopeId), this.store.views(scopeId), {
        // A call waiting for a permit and stopped meanwhile never starts.
        summarize: async (request, urgent) =>
          (await this.permits.run(scopeId, request.signal, () => this.deps.summarizer(request), urgent)) ?? { ok: false, reason: "aborted", error: "stopped" },
        instructions: () => COMPACTION_PROMPT,
        effort: () => this.deps.settings().summarizerEffort,
        concurrency: () => this.deps.settings().summarizerConcurrency,
        cacheKey: cacheKey(scopeId),
        attribution: () => this.attribution(scopeId),
        now: () => this.store.now(),
        log: (message) => this.deps.log(`${scopeId}: ${message}`),
      });
      this.builders.set(scopeId, builder);
    }
    return builder;
  }

  /**
   * Who the scope's summarizer calls are for, in the Pooler's ledger: its first thread, and its
   * Initiative, which the ledger keeps in a column of its own.
   */
  private attribution(scopeId: string) {
    const initiative = ownerOf(scopeId) === "initiatives" ? scopeId.slice("initiatives:".length) : null;
    return { initiative, thread: this.store.threadsOf(scopeId)[0]?.threadId ?? null, purpose: "memory-tree" };
  }

  /** Start (or extend) the background build. */
  build(scopeId: string) {
    if (this.disposed) return;
    const running = this.builds.get(scopeId);
    if (running) {
      running.again = true;
      return;
    }
    const entry: Run = { abort: new AbortController(), again: false, done: Promise.resolve(), error: null };
    const { signal } = entry.abort;
    const builder = this.builder(scopeId);
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await builder.run(signal);
          if (!signal.aborted) this.progressed(scopeId);
        } while (entry.again && !signal.aborted);
      } catch (error) {
        entry.error = error;
        if (!signal.aborted) this.deps.log(`Memory tree for ${scopeId} failed: ${errorMessage(error)}`);
      } finally {
        this.builds.delete(scopeId);
      }
    })();
    this.builds.set(scopeId, entry);
  }

  // Reads ------------------------------------------------------------------------------

  /** The built nodes and saved views: the running builder's, else the stored ones, read node by node. */
  private tree(scopeId: string) {
    const builder = this.builders.get(scopeId);
    return builder ? { nodes: builder.nodes, views: builder.views } : { nodes: new NodeCache((l, i) => this.store.node(scopeId, l, i)), views: this.store.views(scopeId) };
  }

  /** The scope a tool or read from this thread uses: the one it writes to. */
  scopeOf(threadId: string | undefined) {
    const scope = threadId ? this.store.scopeOf(threadId) : null;
    if (!scope) throw new MemoryError("This thread has no chat memory: turn it on in the thread's Memory panel.");
    return scope;
  }

  async status(scopeId: string): Promise<MemoryStatus> {
    const scope = this.store.scope(scopeId);
    if (!scope) throw new MemoryError(`Unknown memory scope ${scopeId}.`);
    const messages = this.store.count(scopeId);
    const { nodes, views } = this.tree(scopeId);
    const totals = this.store.totals(scopeId);
    const builder = this.builders.get(scopeId);
    const threads = await Promise.all(
      this.store.threadsOf(scopeId).map(async (t) => {
        const facts = await this.threadFacts(t.threadId).catch(() => null);
        return { threadId: t.threadId, title: facts?.title ?? null, providerId: facts?.providerId ?? null, compactedAt: t.compactedAt, compactError: t.compactError };
      }),
    );
    const problems: string[] = [];
    const name = (t: (typeof threads)[number]) => (t.title ? `"${t.title}"` : t.threadId);
    if (scope.mode === "optchat") {
      for (const t of threads) {
        if (t.providerId !== "claude-code") problems.push(`OptChat cannot run in ${name(t)} (${t.providerId ?? "unknown provider"}): its turns are refused until you switch the mode or replace it with a Claude Code thread.`);
      }
    }
    for (const t of threads) if (t.compactError !== null) problems.push(`Compacting ${name(t)} failed: ${t.compactError}. It is tried again after its next turns.`);
    const failed = builder?.failedLines() ?? [];
    if (failed.length)
      problems.push(`${failed.length} memory line${failed.length === 1 ? "" : "s"} could not be summarized (${failed[0]!.line}: ${failed[0]!.error}); tried again within 30 minutes. Until then, OptChat turns that need them fail.`);
    if (builder?.status.state === "unavailable") problems.push(`The summarizer is unavailable: ${builder.status.detail}`);
    return {
      scope: { id: scope.id, owner: scope.owner },
      mode: scope.mode,
      compactTokens: this.compactLimit(scope),
      compactTokensOverride: scope.compactTokens,
      threads,
      log: { messages, bytes: totals.logBytes },
      tree: {
        summarized: views.fed,
        nodes: totals.nodes,
        total: treeSize(messages),
        fallbacks: totals.fallbacks,
        failed: failed.length,
        viewBytes: viewBytes(views.chat, nodes),
        memoryViewBytes: viewBytes(views.compaction, nodes),
        state: builder?.status.state ?? (this.builds.has(scopeId) ? "building" : "idle"),
        detail: builder?.status.detail ?? null,
        until: builder?.status.until ?? null,
      },
      cost: {
        calls: totals.calls,
        tries: totals.tries,
        inputTokens: totals.inputTokens,
        cachedTokens: totals.cachedTokens,
        outputTokens: totals.outputTokens,
        usd: Math.round(totals.costUsd * 10_000) / 10_000,
        callSeconds: Math.round(totals.callMs / 1000),
      },
      problems,
    };
  }

  /** memory_read: the compaction view (16–32 KB) as "id+n|text" lines, oldest first. */
  read(scopeId: string) {
    const { nodes, views } = this.tree(scopeId);
    const messages = this.store.count(scopeId);
    const pending = views.fed < messages ? ` Messages ${views.fed} to ${messages - 1} are not in the view yet: read them with n:1.` : "";
    return {
      messages,
      view: views.compaction.map((n) => renderLine(n, nodes)).join("\n"),
      note: `One line per summary, "id+n|text": the n messages from id on, oldest first; "(not summarized yet: zoom it)" marks a line still being written. Open line 64+32 with memory_zoom {id:64,n:32}: its two halves; n:1 gives one message whole. Each line zoom gives starts with the time of its first message.${pending}`,
    };
  }

  /**
   * zoom(id, n): the two lines line id+n was made from; n = 1 gives message id whole. Each line
   * starts with the time of its first message (T143): "2026-10-08 17:49Z 64+16|text".
   */
  zoom(scopeId: string, id: number, n: number) {
    const total = this.store.count(scopeId);
    const at = (i: number) => stamp(this.store.message(scopeId, i)!.at);
    if (n === 1) {
      const m = this.store.message(scopeId, id);
      if (!m) throw new MemoryError(`No message ${id}: the log holds messages 0 to ${total - 1}.`);
      return `${stamp(m.at)} ${id}+1|${messageText(m)}`;
    }
    const node = nodeAt(id, n);
    if (!node) throw new MemoryError(`${id}+${n} is no line: n is a power of 2 and id a multiple of n.`);
    if (end(node) >= total) throw new MemoryError(`${label(node)} goes past the last message, ${total - 1}.`);
    const { nodes } = this.tree(scopeId);
    return children(node).map((c) => `${at(start(c))} ${renderLine(c, nodes)}`).join("\n");
  }

  // Turns ------------------------------------------------------------------------------

  /**
   * How a thread's next turn runs, asked before each new turn (TURN_CONTEXT_TOOL). One path per
   * mode (D459): regular and hybrid answer no session, so the thread's own goes on; optchat answers
   * a fresh session whose system prompt ends with the view's older lines and whose first message
   * holds its newest lines, the time and the message.
   *
   * An OptChat turn first copies the thread's own completed turns (the previous one, and any whose
   * idle a reload missed), then views the scope the thread writes to then: everything logged is
   * history, since the log holds completed turns only and this one has not started. The newest
   * messages without a summary are shown whole up to WHOLE_BYTES; it waits for the summaries of
   * every message before those (D487). A turn that cannot get its view throws (D458): the provider
   * fails it visibly and keeps its input. It waits at most TURN_WAIT_MS, tries a failed read at
   * most TURN_READ_ATTEMPTS times, and stops waiting once the turn is stopped (signal).
   */
  async turnContext(threadId: string, ask: TurnAsk, signal?: AbortSignal): Promise<TurnAnswer> {
    const deadline = this.store.now() + this.waits.turn;
    const fail = (why: string) => new MemoryError(`${UNAVAILABLE}: ${why}. The message was not sent; send it again, or switch this thread's memory mode.`);
    if (this.store.scopeOf(threadId)?.mode !== "optchat") return {};
    try {
      await this.attempts(() => this.caughtUp(threadId, fail), deadline, fail, signal, "its last turn could not be read");
      // A move meanwhile (D491): the view is that of the scope it writes to now.
      const scope = this.store.scopeOf(threadId);
      if (scope?.mode !== "optchat") return {};
      const cut = this.store.count(scope.id);
      await this.waitSummarized(scope.id, this.store.tailStart(scope.id, cut, WHOLE_BYTES), deadline, fail, signal);
      const { nodes, views } = this.tree(scope.id);
      const view = turnView({ chat: views.chat, fed: views.fed, nodes, cut, frozen: this.frozen.get(threadId) ?? null, message: (i) => this.store.message(scope.id, i) });
      this.frozen.set(threadId, view.frozen);
      return { session: "fresh", sessionId: randomUUID(), systemPrompt: turnSystem(view.frozenLines), input: turnMessage(this.store.now(), ask.input, view.tailLines) };
    } catch (error) {
      throw error instanceof MemoryError ? error : fail(errorMessage(error));
    }
  }

  /** One copy of the thread that started after this call, settled. */
  private async caughtUp(threadId: string, fail: (why: string) => Error) {
    const run = this.kick(threadId);
    if (!run) throw fail("Chat memory is stopping");
    await run.done;
    if (run.error) throw run.error;
  }

  /** `work`, tried again after a failure at most TURN_READ_ATTEMPTS times in all, before the deadline and while the turn runs; then the turn fails, saying `what`. */
  private async attempts(work: () => Promise<void>, deadline: number, fail: (why: string) => Error, signal: AbortSignal | undefined, what: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await within(work(), deadline - this.store.now(), signal);
        if (result === "stopped") throw fail("the turn stopped");
        if (!result) throw fail(`${what} in time`);
        return;
      } catch (error) {
        if (error instanceof MemoryError || attempt >= TURN_READ_ATTEMPTS || this.store.now() + RETRY_PAUSE_MS >= deadline) {
          throw error instanceof MemoryError ? error : fail(`${what} (${errorMessage(error)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
      }
    }
  }

  /**
   * Wait until messages 0..count-1 have their line, before the deadline, unless the turn stops;
   * their calls go first meanwhile (W315).
   */
  private async waitSummarized(scopeId: string, count: number, deadline: number, fail: (why: string) => Error, signal?: AbortSignal) {
    if (this.disposed) throw fail("Chat memory is stopping");
    if (signal?.aborted) throw fail("the turn stopped");
    this.build(scopeId);
    const builder = this.builder(scopeId);
    if (builder.summarized(count)) return;
    // D458: a summary that failed its bounded tries is no summary; the turn fails now, never on a cut message.
    const failed = () => {
      const f = builder.failedBefore(count);
      return f && fail(`message ${f.i} could not be summarized (${f.error}); it is tried again within 30 minutes`);
    };
    const failure = failed();
    if (failure) throw failure;
    const release = builder.need(count, deadline);
    let unsubscribe = () => {};
    const done = new Promise<boolean | Error>((resolve) => {
      unsubscribe = builder.onBuilt(() => {
        if (builder.closed) resolve(false);
        else if (builder.summarized(count)) resolve(true);
        else {
          const failure = failed();
          if (failure) resolve(failure);
        }
      });
    });
    const settled = await within(done, deadline - this.store.now(), signal).finally(() => (unsubscribe(), release()));
    if (settled === "stopped") throw fail("the turn stopped");
    if (settled?.value === true) return;
    if (settled?.value instanceof Error) throw settled.value;
    if (settled?.value === false) throw fail("Chat memory is stopping");
    const status = builder.status;
    const why = status.state === "backoff" ? `the summarizer is rate-limited (${status.detail})` : status.state === "unavailable" ? `the summarizer is unavailable (${status.detail})` : "the summarizer is still writing them";
    throw fail(`${builder.unsummarized(count)} earlier messages have no summary yet: ${why}`);
  }
}

/** The promise's value once it settles; null once `ms` have passed; "stopped" once the signal aborts. */
async function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<{ value: T } | null | "stopped"> {
  if (signal?.aborted) return "stopped";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlink: Disposable | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, ms)))),
      new Promise<"stopped">((resolve) => (unlink = signal && addAbortListener(signal, () => resolve("stopped")))),
    ]);
  } finally {
    clearTimeout(timer);
    unlink?.[Symbol.dispose]();
  }
}

/** The promise's value, or a rejection once the signal aborts; the promise itself is left to settle. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let unlink: Disposable | undefined;
  const aborted = new Promise<never>((_, reject) => (unlink = addAbortListener(signal, () => reject(signal.reason))));
  return Promise.race([promise, aborted]).finally(() => unlink?.[Symbol.dispose]());
}

/** A sending thread as "[name] …" shows it: its title, short, or its id. */
const senderName = (facts: ThreadFacts | null, id: string) => {
  const title = facts?.title?.trim();
  return title ? (title.length > 48 ? `${title.slice(0, 47)}…` : title) : id;
};

/** A stable prompt-cache session per scope, shaped like the UUID Codex sends. */
export function cacheKey(scopeId: string) {
  const h = createHash("sha256").update(`chat-memory:${scopeId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
