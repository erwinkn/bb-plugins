import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import { TreeBuilder, type BuilderStatus } from "./builder";
import { readEvents, type ListEvents } from "./ingest";
import { eventEntries, splitEntry, type EventRow, type LogEntry } from "./log";
import { COMPACTION_PROMPT, messageText, stamp, turnMessage, turnSystem } from "./prompt";
import { FairPermits } from "./permits";
import type { Settings } from "./settings";
import { MemoryStore, type Member, type MemoryMode, type Scope } from "./store";
import type { Summarizer } from "./summarizer";
import { NodeCache, children, end, label, nodeAt, renderLine, start, viewBytes } from "./tree";
import { turnView } from "./turn";
import type { NodeRef } from "./tree";

export const PLUGIN_ID = "chat-memory";
export const zoomToolSchema = z.object({ id: z.number().int().min(0), n: z.number().int().min(1) }).strict();

/** A user-facing refusal or failure: its message is shown as is. */
export class MemoryError extends Error {
  override name = "MemoryError";
}
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Event pages one ingest reads per thread before yielding; the next kick goes on. */
const INGEST_PAGES = 20;
/** The sweep re-reads a quiet scope this often; idle and event signals come first. */
const SWEEP_INGEST_MS = 5 * 60_000;
/** Scopes one sweep starts reading, least recently read first, so first logs don't all start at once (W244). */
const SWEEP_KICKS = 3;
/** The memory's own progress (log and tree) reaches the UI at most this often; it also polls. */
const PROGRESS_PUBLISH_MS = 30_000;
const BUSY_STATUSES = new Set(["active", "starting", "stopping"]);

/**
 * The hidden tool BB's Claude Code provider (Erwin's fork) calls before each new turn whose tools,
 * as BB resolves them for that turn, include it (FORK.md, "per-turn context from a hidden tool").
 * Protocol 4 decides by the turn's tools, on every path that starts one; any other provider refuses
 * a turn whose tools include it. Protocol 3 (the fork before T145) decided by the tools the session
 * was built with.
 */
export const TURN_CONTEXT_TOOL = "claude_code_turn_context";
/**
 * The provider's ask. Protocol 4 is {input, requestId, sessionId}; protocol 3 (the fork before
 * T145) adds outcome reports, which nothing reads any more (D458), so they are dropped here.
 */
export const turnAskSchema = z.object({
  protocol: z.union([z.literal(3), z.literal(4)]),
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
 * D458: how long an OptChat turn waits for its memory (its log caught up with it, every earlier
 * message summarized) before it fails. The fork's hook gives an answer 120 s (protocol 4); the
 * fork before T145 gave 20 s (protocol 3).
 */
export const TURN_WAIT_MS = { 3: 15_000, 4: 90_000 } as const;
/** Failed reads of the thread's log a turn tries before it fails. */
export const TURN_READ_ATTEMPTS = 3;
/** Between two reads of a log that has not reached a turn's request yet. */
const CATCH_UP_PAUSE_MS = 250;
/** Requests read while looking for a turn's own (newest first). */
const REQUEST_PAGE = 100;
const REQUEST_PAGES = 3;
/** Between two looks for a thread its owner is adding to an OptChat memory. */
const MEMBERSHIP_POLL_MS = 100;
/**
 * The key in an owner plugin's thread metadata that names the scope the thread will join (D446): a
 * new Initiative coordinator is spawned with {memoryScope: <Initiative id>}, and its first turn may
 * ask before the owner's registration lands. A thread without it is not expected in any scope.
 */
export const MEMORY_SCOPE_KEY = "memoryScope";
/** The scope an owner's metadata on a thread names (MEMORY_SCOPE_KEY), or null. */
const scopeNamed = (owner: string, metadata: Readonly<Record<string, unknown>>) => {
  const key = metadata[MEMORY_SCOPE_KEY];
  return typeof key === "string" && key ? `${owner}:${key}` : null;
};
/** What the turn gate (BB's message.dispatch hook) answers. */
export type DispatchDecision = { action: "proceed" } | { action: "wait"; reason: string; sendAt?: number } | { action: "reject"; message: string };
/** A dispatch that waits on something passing (the turn hook coming free, a failed read) is tried again this often (BB re-attempts it at sendAt)... */
const GATE_RETRY_MS = 5_000;
/** ...this many times in all; the last is refused, its message kept (D458, D459). */
export const GATE_TRIES = 3;

const LEGACY_PROVIDER =
  "BB's Claude Code provider here is older than protocol 4: a session built without the memory hook does not ask for its memory, so OptChat cannot run on every turn until BB restarts with the new provider.";

/** What the memory needs to know about a BB thread. */
export interface ThreadFacts {
  providerId: string;
  title: string | null;
  originPluginId: string | null;
  parentThreadId: string | null;
}
/** What chat memory decides a session from, when BB builds it or resolves it for a turn. */
export interface SessionFacts {
  threadId: string;
  parentThreadId: string | null;
  originPluginId: string | null;
  /** The origin plugin's metadata on the thread (BB's fork gives it to every configure); undefined when BB does not. */
  originMetadata: Readonly<Record<string, unknown>> | undefined;
  providerId: string;
}
/** A thread's status now, or null once BB no longer has it. */
export type ThreadStatus = (threadId: string) => Promise<string | null>;

export interface MemoryStatus {
  scope: { id: string; owner: string };
  mode: MemoryMode;
  /** The compaction limit in effect (0: off), and the scope's own, if set. */
  compactTokens: number;
  compactTokensOverride: number | null;
  threads: Array<{
    threadId: string;
    title: string | null;
    providerId: string | null;
    state: Member["state"];
    /** Its last turn that asked for its turn context, and the provider's protocol then. */
    askedAt: number | null;
    askedProtocol: number | null;
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
  /** Asked again while running: go on (or, once a stopped run settles, start over). */
  again: boolean;
  done: Promise<void>;
  /** The last pass's failure, if it failed. */
  error: unknown;
}

/**
 * D457: every scope's memory. A scope's log is read from BB's events of its threads; GPT-6 Luna
 * builds the summary tree over it in the background in every mode (D447), so a switch between
 * modes is instant. The mode is one setting per scope, read at each turn:
 * - regular: the thread's session goes on, compacted past the regular limit (300k);
 * - hybrid: the same, compacted past the hybrid limit (150k); memory_read and memory_zoom bring
 *   back what compactions dropped;
 * - optchat: each turn is a fresh session over the memory view (turnContext); never compacted.
 *
 * Ingests and builds run detached and owned here: one of each per scope at a time, aborted by
 * dispose (the service signal disposes too) and, for builds, when the scope closes. Every scope's
 * summarizer calls share one limit, let in round-robin by scope (W244). An aborted run stays owned
 * until it settles, and writes nothing more; after dispose the store refuses every access.
 */
export class ChatMemory {
  readonly store: MemoryStore;
  readonly permits: FairPermits;
  private disposed = false;
  private stopLink: Disposable | null = null;
  private ingests = new Map<string, Run>();
  private builds = new Map<string, Run>();
  private builders = new Map<string, TreeBuilder>();
  private lastIngest = new Map<string, number>();
  private published = new Map<string, number>();
  /** By thread: the view lines its last OptChat turn froze into its system prompt. */
  private frozen = new Map<string, NodeRef[]>();
  private facts = new Map<string, Promise<ThreadFacts | null>>();
  /** By thread: how many times the turn gate has held its message for something that may pass. */
  private gateWaits = new Map<string, number>();
  /**
   * A turn asked with protocol 3: this BB's Claude Code provider is older than protocol 4, so a
   * turn whose session was built without the hook does not ask, and OptChat cannot be enforced
   * (A471). Only a BB restart changes the provider; a reload of this plugin forgets it until the
   * next protocol 3 ask.
   */
  private legacyProvider = false;
  /** The wait bounds (ms); tests shorten them. */
  waits: { turn: Record<TurnAsk["protocol"], number> } = { turn: { ...TURN_WAIT_MS } };

  constructor(
    private readonly deps: {
      store: MemoryStore;
      list: ListEvents;
      /** The thread's facts, or null once BB no longer has it (read once per thread). */
      thread: (threadId: string) => Promise<ThreadFacts | null>;
      /** An owner plugin's metadata on one of its threads (MEMORY_SCOPE_KEY names the scope it will join). */
      ownerMetadata: (threadId: string, pluginId: string) => Promise<Record<string, unknown>>;
      status: ThreadStatus;
      settings: () => Settings;
      summarizer: Summarizer;
      log: (message: string) => void;
      /** Something the UI shows for the scope changed. */
      changed?: (scopeId: string) => void;
      /** Whether this plugin holds the turn hook's name; asking takes it once it is free (server.ts). */
      hookOwned: () => boolean;
      /** Something a held dispatch waits on changed: BB asks the turn gate again. */
      recheck?: () => void;
    },
  ) {
    this.store = deps.store;
    this.permits = new FairPermits(() => deps.settings().summarizerConcurrency);
  }

  /** Test seam: the summarizer later calls use. */
  useSummarizer(summarizer: Summarizer) {
    this.deps.summarizer = summarizer;
  }

  start(signal?: AbortSignal) {
    this.disposed = false;
    this.store.open();
    this.stopLink?.[Symbol.dispose]();
    this.stopLink = signal ? addAbortListener(signal, () => this.dispose()) : null;
  }
  /** Abort every ingest and build, give up every summary waiter, and close the store to them all. */
  dispose() {
    this.disposed = true;
    this.store.close();
    this.stopLink?.[Symbol.dispose]();
    this.stopLink = null;
    for (const run of [...this.ingests.values(), ...this.builds.values()]) run.abort.abort();
    for (const builder of this.builders.values()) builder.close();
    this.builders.clear();
  }
  /** Resolves once no ingest or build this service started is running. */
  async settled() {
    while (this.ingests.size || this.builds.size)
      await Promise.all([...this.ingests.values(), ...this.builds.values()].map((run) => run.done));
  }

  /** A thread's facts, read once per thread; null once BB no longer has it. */
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

  // Scopes -------------------------------------------------------------------------------

  /**
   * An owner plugin's scope and its current threads, in order (D446: an Initiative's coordinator
   * and its discussion threads). No threads closes it: its log and tree stop, and stay.
   */
  setScope(owner: string, key: string, threadIds: readonly string[], hold?: boolean) {
    const id = `${owner}:${key}`;
    // Closing a scope that never existed (an Initiative archived before it had memory) leaves no trace.
    if (!threadIds.length && !this.store.scope(id)) return id;
    this.store.transaction(() => {
      this.store.ensureScope(id, owner);
      if (hold !== undefined) this.store.setHold(id, hold);
      this.store.setMembers(id, threadIds);
    });
    if (threadIds.length) this.kick(id);
    else this.stopBuilding(id);
    this.deps.changed?.(id);
    this.deps.recheck?.();
    return id;
  }

  // Sessions (D458, D460) ------------------------------------------------------------------

  /**
   * D447: the memory tools a session gets, when BB builds it and again whenever BB resolves a turn:
   * a current thread of a scope, and a top-level thread of a plugin that owns scopes (its owner
   * adds it right after the spawn, once the session is built). While this plugin holds the turn
   * hook, a Claude Code thread gets it too, in every mode, so every turn asks how it runs. A thread
   * on another provider gets it only in an OptChat scope, where it makes BB refuse every turn of
   * it (FORK.md): OptChat runs on Claude Code only (D460, T146). A new thread its owner has not
   * added yet counts as in the scope its owner's metadata names, unless it was in it and left
   * (A473: a pending coordinator's Send now skips the gate, and its owner adds it only after this
   * resolution); without that metadata it counts as in OptChat, so it is refused rather than run
   * unchecked.
   */
  sessionTools(t: SessionFacts): string[] | null {
    const scope = this.store.currentScopeOf(t.threadId);
    const owner = !scope && t.parentThreadId === null && t.originPluginId && this.store.ownsScopes(t.originPluginId) ? t.originPluginId : null;
    if (!scope && !owner) return null;
    const mode = scope ? scope.mode : owner && this.expectedMode(t.threadId, owner, t.originMetadata);
    const hook = this.deps.hookOwned() && (t.providerId === "claude-code" || mode === "optchat");
    return ["memory_read", "memory_zoom", ...(hook ? [TURN_CONTEXT_TOOL] : [])];
  }

  /** The mode of the scope a new thread's owner will add it to, from the owner's metadata on it. */
  private expectedMode(threadId: string, owner: string, metadata: SessionFacts["originMetadata"]): MemoryMode | null {
    if (metadata === undefined) return "optchat";
    return this.joining(threadId, scopeNamed(owner, metadata))?.mode ?? null;
  }

  /**
   * D458, D459, D460: the turn gate, before BB sends a message on (its message.dispatch hook). It
   * refuses, with the reason and its message kept, a turn of an OptChat thread that cannot run as
   * OptChat: a thread on another provider (Codex, T146), a Claude Code provider older than protocol
   * 4. What may pass (the turn hook not yet this plugin's, a failed read) holds it GATE_RETRY_MS at
   * a time, GATE_TRIES times in all, then refuses it too. Every other dispatch, and every message
   * that joins a running turn, goes on: the turn itself asks for its context (FORK.md), whichever
   * path starts it, so the gate is not what enforces the mode, only what explains it early.
   */
  async admit(d: { threadId: string; providerId: string; attempt: "start-turn" | "join-turn"; originPluginId: string | null; parentThreadId: string | null }): Promise<DispatchDecision> {
    if (d.attempt === "join-turn") return { action: "proceed" };
    const decision = await this.gate(d);
    if (decision.action === "wait") {
      const tries = (this.gateWaits.get(d.threadId) ?? 0) + 1;
      if (tries < GATE_TRIES) {
        this.gateWaits.set(d.threadId, tries);
        return { ...decision, reason: `${decision.reason} Trying again shortly (${tries} of ${GATE_TRIES}).`, sendAt: this.store.now() + GATE_RETRY_MS };
      }
      this.gateWaits.delete(d.threadId);
      return { action: "reject", message: `${decision.reason} This message was not sent after ${GATE_TRIES} tries; send it again.` };
    }
    this.gateWaits.delete(d.threadId);
    return decision;
  }

  private async gate(d: { threadId: string; providerId: string; originPluginId: string | null; parentThreadId: string | null }): Promise<DispatchDecision> {
    let scope = this.store.currentScopeOf(d.threadId);
    if (!scope && d.providerId !== "claude-code" && d.parentThreadId === null && d.originPluginId && this.store.ownsScopes(d.originPluginId)) {
      // A new thread its owner will add: no turn of it asks before it joins, so the gate stops it.
      const expected = await this.expectedScope(d.threadId, d.originPluginId).then(
        (id) => ({ id }),
        (error: unknown) => ({ error: errorMessage(error) }),
      );
      if ("error" in expected) return { action: "wait", reason: `Chat memory could not read which memory this thread joins (${expected.error}).` };
      scope = this.joining(d.threadId, expected.id);
    }
    if (scope?.mode !== "optchat") return { action: "proceed" };
    const name = await this.threadName(d.threadId);
    const switchIt = "Switch its memory mode in the Memory pill to send it.";
    if (d.providerId !== "claude-code") return { action: "reject", message: `OptChat runs on Claude Code only for now (T146): ${name} runs on ${d.providerId}, so this message was not sent. ${switchIt}` };
    if (this.legacyProvider) return { action: "reject", message: `${LEGACY_PROVIDER} This message was not sent. ${switchIt}` };
    if (!this.deps.hookOwned()) return { action: "wait", reason: "Chat memory is taking over its turn hook from the plugin that still holds it (Initiatives before T145): reload that plugin." };
    return { action: "proceed" };
  }

  /** "Title" or the thread's id. */
  private async threadName(threadId: string) {
    const facts = await this.threadFacts(threadId).catch(() => null);
    return facts?.title ? `"${facts.title}"` : threadId;
  }

  /**
   * The scope an owner plugin's top-level thread will join, from the owner's metadata on it
   * (MEMORY_SCOPE_KEY), or null when it names none (a handover writer, an ad hoc thread).
   */
  private async expectedScope(threadId: string, owner: string) {
    return scopeNamed(owner, await this.deps.ownerMetadata(threadId, owner));
  }

  /** The scope a thread is still to join: the one its owner named, unless it was in it and left (a former coordinator). */
  private joining(threadId: string, scopeId: string | null) {
    return scopeId && !this.store.member(scopeId, threadId) ? this.store.scope(scopeId) : null;
  }

  /** Whether the scope's tree builds: it has a current thread (D447: in every mode). */
  building(scopeId: string) {
    return this.store.members(scopeId).some((m) => m.state === "current");
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
   * write). A thread outside every scope gets its own. D460 and D458: OptChat is refused unless
   * every current thread runs on Claude Code, this plugin holds the turn hook and the provider asks
   * on every turn (protocol 4), so the mode can never be set where it would not run.
   */
  async configure(threadId: string, patch: { mode?: MemoryMode; compactTokens?: number | null; enabled?: boolean }) {
    let scope = this.store.currentScopeOf(threadId);
    if (patch.enabled === false) {
      if (!scope) return null;
      if (scope.owner !== PLUGIN_ID) throw new MemoryError(`This thread's memory belongs to the ${scope.owner} plugin, which decides its threads.`);
      this.setScope(PLUGIN_ID, threadId, []);
      return null;
    }
    if (!scope) {
      if (!(await this.threadFacts(threadId))) throw new MemoryError(`Unknown thread ${threadId}.`);
      this.setScope(PLUGIN_ID, threadId, [threadId]);
      scope = this.store.currentScopeOf(threadId)!;
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
      // A message the turn gate held for OptChat may go now.
      if (next.mode !== scope.mode) this.deps.recheck?.();
    }
    return this.status(scope.id);
  }

  /**
   * Why OptChat cannot run in every current thread of the scope, or null: a provider other than
   * Claude Code, the turn hook not this plugin's yet, a Claude Code provider older than protocol 4.
   */
  private async optchatRefusal(scopeId: string) {
    const current = await Promise.all(
      this.store.members(scopeId).filter((m) => m.state === "current").map(async (m) => ({ m, facts: await this.threadFacts(m.threadId) })),
    );
    const name = ({ m, facts }: (typeof current)[number]) => (facts?.title ? `"${facts.title}"` : m.threadId);
    const codex = current.find((t) => t.facts?.providerId !== "claude-code");
    if (codex) return `OptChat runs on Claude Code only for now (T146): ${name(codex)} runs on ${codex.facts?.providerId ?? "an unknown provider"}.`;
    if (!this.deps.hookOwned()) return "Chat memory's turn hook is still held by another plugin (Initiatives before T145): reload that plugin, then try again.";
    if (this.legacyProvider) return LEGACY_PROVIDER;
    return null;
  }

  /** The log or tree grew: tell the UI, at most every PROGRESS_PUBLISH_MS per scope. */
  private progressed(scopeId: string) {
    const now = this.store.now();
    if (now - (this.published.get(scopeId) ?? -Infinity) < PROGRESS_PUBLISH_MS) return;
    this.published.set(scopeId, now);
    this.deps.changed?.(scopeId);
  }

  // Ingest and build ---------------------------------------------------------------------

  /** Bring the log up to date, then build. Detached; repeated kicks coalesce. Returns the run. */
  kick(scopeId: string): Run | null {
    if (this.disposed) return null;
    const running = this.ingests.get(scopeId);
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
          this.lastIngest.set(scopeId, this.store.now());
          const read = await this.ingest(scopeId, signal);
          if (signal.aborted) break;
          // A long first log is read in slices; the next one follows at once.
          if (read.behind) entry.again = true;
          if (read.appended) this.progressed(scopeId);
          if (this.building(scopeId)) this.build(scopeId);
        } while (entry.again && !signal.aborted);
      } catch (error) {
        entry.error = error;
        if (!signal.aborted) this.deps.log(`Memory log for ${scopeId} failed: ${errorMessage(error)}`);
      } finally {
        this.ingests.delete(scopeId);
      }
    })();
    this.ingests.set(scopeId, entry);
    return entry;
  }

  /** The sweep's kick: the least recently read scopes not read for a while (a missed idle, a first log). */
  sweep() {
    const now = this.store.now();
    const read = (scopeId: string) => this.lastIngest.get(scopeId) ?? -Infinity;
    this.store
      .readingScopes()
      .filter((s) => !this.ingests.has(s.id) && now - read(s.id) >= SWEEP_INGEST_MS)
      .sort((a, b) => read(a.id) - read(b.id))
      .slice(0, SWEEP_KICKS)
      .forEach((s) => this.kick(s.id));
  }

  /**
   * One read of every thread the scope still reads, merged by time into the log in one append.
   * A retired thread is read until it is quiet, its status first: once it is quiet, all its events
   * are below the boundary of the reads that follow, so its log is then complete. A deleted thread
   * (404) holds nothing more. Any other failed read appends nothing: the next kick reads again.
   * Every write follows a check that the signal (or dispose) has not stopped the pass.
   */
  async ingest(scopeId: string, signal?: AbortSignal) {
    const stopped = () => this.disposed || signal?.aborted === true;
    const reading = this.store.members(scopeId).filter((m) => m.state !== "done");
    const runs: LogEntry[][] = [];
    const through = new Map<string, number>();
    const finished: string[] = [];
    let behind = false;
    for (const m of reading) {
      if (stopped()) return { appended: 0, behind: false };
      try {
        const quiet = m.state === "retired" ? !BUSY_STATUSES.has((await this.deps.status(m.threadId)) ?? "deleted") : false;
        let after = m.lastSeq;
        let more = true;
        const entries: LogEntry[] = [];
        for (let page = 0; more && page < INGEST_PAGES; page++) {
          if (stopped()) return { appended: 0, behind: false };
          const read = await readEvents(this.deps.list, m.threadId, after, stopped);
          const facts = await this.logFacts(m.threadId, read.rows);
          entries.push(...read.rows.flatMap((row) => eventEntries(row, m.threadId, facts)).flatMap(splitEntry));
          more = read.more;
          after = read.through;
        }
        runs.push(entries);
        if (after > m.lastSeq) through.set(m.threadId, after);
        if (more) behind = true;
        else if (quiet) finished.push(m.threadId);
      } catch (error) {
        if (stopped()) return { appended: 0, behind: false };
        if ((error as { status?: number }).status !== 404) throw error;
        finished.push(m.threadId);
      }
    }
    if (stopped()) return { appended: 0, behind: false };
    const entries = mergeByTime(runs);
    this.store.transaction(() => {
      this.store.append(scopeId, entries, through);
      for (const threadId of finished) this.store.finishMember(scopeId, threadId);
    });
    return { appended: entries.length, behind };
  }

  /** What eventEntries needs for a page of a thread's events: whether a plugin spawned the thread, and its senders' names. */
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
   * Who the scope's summarizer calls are for, in the Pooler's ledger: its first current thread,
   * and its Initiative, which the ledger keeps in a column of its own.
   */
  private attribution(scopeId: string) {
    const scope = this.store.scope(scopeId);
    const first = this.store.members(scopeId).find((m) => m.state === "current")?.threadId ?? null;
    const initiative = scope?.owner === "initiatives" ? scopeId.slice("initiatives:".length) : null;
    return { initiative, thread: first, purpose: "memory-tree" };
  }

  /** Start (or extend) the background build. Behind a stopped run that is still settling, it starts once that one has. */
  build(scopeId: string) {
    if (this.disposed || !this.building(scopeId)) return;
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
        if (signal.aborted && entry.again && !this.disposed && this.building(scopeId)) this.build(scopeId);
      }
    })();
    this.builds.set(scopeId, entry);
  }

  /**
   * Cancel the build; what is built stays, and a later build goes on from there with a fresh
   * builder. The run stays owned until it settles; its summary waiters give up now.
   */
  stopBuilding(scopeId: string) {
    this.builds.get(scopeId)?.abort.abort();
    this.builders.get(scopeId)?.close();
    this.builders.delete(scopeId);
  }

  // Reads ------------------------------------------------------------------------------

  /** The built nodes and saved views: the running builder's, else the stored ones, read node by node. */
  private tree(scopeId: string) {
    const builder = this.builders.get(scopeId);
    return builder ? { nodes: builder.nodes, views: builder.views } : { nodes: new NodeCache((l, i) => this.store.node(scopeId, l, i)), views: this.store.views(scopeId) };
  }

  /** The scope a tool or read from this thread uses: the one it is a current thread of. */
  scopeOf(threadId: string | undefined) {
    const scope = threadId ? this.store.currentScopeOf(threadId) : null;
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
      this.store.members(scopeId).map(async (m) => {
        const facts = await this.threadFacts(m.threadId).catch(() => null);
        return {
          threadId: m.threadId,
          title: facts?.title ?? null,
          providerId: facts?.providerId ?? null,
          state: m.state,
          askedAt: m.askedAt,
          askedProtocol: m.askedProtocol,
          compactedAt: m.compactedAt,
          compactError: m.compactError,
        };
      }),
    );
    const problems: string[] = [];
    const current = threads.filter((t) => t.state === "current");
    const name = (t: (typeof threads)[number]) => (t.title ? `"${t.title}"` : t.threadId);
    if (scope.mode === "optchat") {
      for (const t of current) {
        if (t.providerId !== "claude-code") problems.push(`OptChat cannot run in ${name(t)} (${t.providerId ?? "unknown provider"}): its turns are refused until you switch the mode or replace it with a Claude Code thread.`);
      }
      if (!this.deps.hookOwned()) problems.push("Chat memory's turn hook is still held by another plugin (Initiatives before T145): OptChat messages are held, then refused, until that plugin is reloaded.");
      if (this.legacyProvider) problems.push(`${LEGACY_PROVIDER} OptChat turns are refused until then.`);
    }
    for (const t of current) if (t.compactError !== null) problems.push(`Compacting ${name(t)} failed: ${t.compactError}. It is tried again after its next turns.`);
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
   * holds its newest lines, the time and the message. An OptChat turn that cannot get its view
   * throws (D458): the provider fails the turn visibly and keeps its input, never runs it in the
   * old session. It waits at most TURN_WAIT_MS for its membership, for the log to catch up with it
   * and for every earlier message to be summarized (gist §6), and tries a failed read at most
   * TURN_READ_ATTEMPTS times. A turn stopped meanwhile (signal) stops waiting for its summaries.
   */
  async turnContext(threadId: string, ask: TurnAsk, signal?: AbortSignal): Promise<TurnAnswer> {
    const deadline = this.store.now() + this.waits.turn[ask.protocol];
    const fail = (why: string) => new MemoryError(`OptChat memory unavailable for this turn: ${why}. The message was not sent; send it again, or switch this thread's memory mode.`);
    if (ask.protocol === 3) this.legacyProvider = true;
    const scope = await this.scopeForTurn(threadId, deadline, fail);
    if (!scope) return {};
    // While a reload stops this instance the store is closed: the answer is the same.
    if (!this.store.isClosed) this.store.asked(scope.id, threadId, ask.protocol);
    if (scope.mode !== "optchat") return {};
    if (ask.protocol === 3) throw fail("BB's Claude Code provider is older than protocol 4 (restart BB to run the new one)");
    if (this.store.isClosed) throw fail("Chat memory is closed: the plugin stopped");
    try {
      const request = await this.attempts(() => this.findRequest(threadId, ask.requestId), deadline, fail, "the turn's request could not be read");
      if (!request) throw fail(`its request ${ask.requestId} is not among the thread's last ${REQUEST_PAGE * REQUEST_PAGES} requests`);
      // A retry re-submits a request that is logged already: the view ends before the original.
      const originalId = typeof request.data?.retryOfRequestId === "string" ? request.data.retryOfRequestId : null;
      const original = originalId === null ? null : await this.attempts(() => this.findRequest(threadId, originalId), deadline, fail, `the original of retried request ${ask.requestId} could not be read`);
      if (originalId !== null && !original) throw fail(`the original ${originalId} of its retried request is not among the thread's last ${REQUEST_PAGE * REQUEST_PAGES} requests`);
      await this.catchUp(scope.id, threadId, request.seq, deadline, fail);
      const cut = this.store.firstFrom(scope.id, threadId, (original ?? request).seq) ?? this.store.count(scope.id);
      await this.waitSummarized(scope.id, cut, deadline, fail, signal);
      const { nodes, views } = this.tree(scope.id);
      const view = turnView({ chat: views.chat, fed: views.fed, nodes, cut, frozen: this.frozen.get(threadId) ?? null });
      this.frozen.set(threadId, view.frozen);
      return { session: "fresh", sessionId: randomUUID(), systemPrompt: turnSystem(view.frozenLines), input: turnMessage(this.store.now(), ask.input, view.tailLines) };
    } catch (error) {
      throw error instanceof MemoryError ? error : fail(errorMessage(error));
    }
  }

  /**
   * The scope a turn's thread is current in, or null when it is in none (D458: told apart from a
   * membership still to come). An owner plugin's top-level thread whose metadata names a scope (a
   * new Initiative coordinator) may ask before its owner's registration lands: in an OptChat scope
   * it waits for it until the turn's deadline, then fails; in any other mode its session goes on.
   * A thread that was in that scope and left it is in none. Failed reads are tried again, then fail.
   */
  private async scopeForTurn(threadId: string, deadline: number, fail: (why: string) => Error) {
    const current = this.store.currentScopeOf(threadId);
    if (current) return current;
    const facts = await this.attempts(() => this.threadFacts(threadId), deadline, fail, "the thread could not be read");
    if (!facts || facts.parentThreadId !== null || !facts.originPluginId || !this.store.ownsScopes(facts.originPluginId)) return null;
    const origin = facts.originPluginId;
    const expected = await this.attempts(() => this.expectedScope(threadId, origin), deadline, fail, `the ${origin} plugin's metadata on the thread could not be read`);
    if (this.joining(threadId, expected)?.mode !== "optchat") return null;
    while (this.store.now() < deadline && !this.disposed) {
      await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_POLL_MS));
      const joined = this.store.currentScopeOf(threadId);
      if (joined) return joined;
    }
    throw fail(`the ${origin} plugin has not added it to its memory yet`);
  }

  ownsScopes(pluginId: string) {
    return this.store.ownsScopes(pluginId);
  }

  /** `work`, tried again after a failure at most TURN_READ_ATTEMPTS times in all, before the deadline; then the turn fails, saying `what`. */
  private async attempts<T>(work: () => Promise<T>, deadline: number, fail: (why: string) => Error, what: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await within(work(), deadline - this.store.now());
        if (!result) throw fail(`${what} in time`);
        return result.value;
      } catch (error) {
        if (error instanceof MemoryError || attempt >= TURN_READ_ATTEMPTS || this.store.now() + CATCH_UP_PAUSE_MS >= deadline) {
          throw error instanceof MemoryError ? error : fail(`${what} (${errorMessage(error)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, CATCH_UP_PAUSE_MS));
      }
    }
  }

  /** The thread's client/turn/requested event for `requestId`, newest first, a few pages at most; null if not there. */
  private async findRequest(threadId: string, requestId: string) {
    let before: number | null = null;
    for (let page = 0; page < REQUEST_PAGES; page++) {
      const rows = await this.deps.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: String(REQUEST_PAGE), ...(before === null ? {} : { beforeSeq: String(before) }) });
      const request = rows.find((row) => row.data?.requestId === requestId);
      if (request) return request;
      if (rows.length < REQUEST_PAGE) return null;
      before = Math.min(...rows.map((row) => row.seq));
    }
    return null;
  }

  /** Read the log through the turn's request (`seq`) before the deadline, retrying a failed read at most TURN_READ_ATTEMPTS times. */
  private async catchUp(scopeId: string, threadId: string, seq: number, deadline: number, fail: (why: string) => Error) {
    for (let failures = 0; ; ) {
      if ((this.store.member(scopeId, threadId)?.lastSeq ?? -1) >= seq) return;
      const run = this.kick(scopeId);
      if (!run) throw fail("the memory is closed");
      if (!(await within(run.done, deadline - this.store.now()))) throw fail("its log did not catch up with it in time");
      if (run.error && ++failures >= TURN_READ_ATTEMPTS) throw fail(`reading the thread failed ${failures} times (${errorMessage(run.error)})`);
      // BB has not served the request's events yet: read again shortly, not at once.
      if ((this.store.member(scopeId, threadId)?.lastSeq ?? -1) < seq) await new Promise((resolve) => setTimeout(resolve, CATCH_UP_PAUSE_MS));
    }
  }

  /**
   * Wait until messages 0..count-1 have their line, before the deadline (gist §6), unless the turn
   * stops; their calls go first meanwhile (W315).
   */
  private async waitSummarized(scopeId: string, count: number, deadline: number, fail: (why: string) => Error, signal?: AbortSignal) {
    if (this.disposed || !this.building(scopeId)) throw fail("the memory is closed");
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
    let unlink: Disposable | undefined;
    const done = new Promise<boolean | Error>((resolve) => {
      unlink = signal && addAbortListener(signal, () => resolve(fail("the turn stopped")));
      unsubscribe = builder.onBuilt(() => {
        if (builder.closed) resolve(false);
        else if (builder.summarized(count)) resolve(true);
        else {
          const failure = failed();
          if (failure) resolve(failure);
        }
      });
    });
    const settled = await within(done, deadline - this.store.now()).finally(() => (unsubscribe(), unlink?.[Symbol.dispose](), release()));
    if (settled?.value === true) return;
    if (settled?.value instanceof Error) throw settled.value;
    if (settled?.value === false) throw fail("the memory closed");
    const status = builder.status;
    const why = status.state === "backoff" ? `the summarizer is rate-limited (${status.detail})` : status.state === "unavailable" ? `the summarizer is unavailable (${status.detail})` : "the summarizer is still writing them";
    throw fail(`${builder.unsummarized(count)} earlier messages have no summary yet: ${why}`);
  }
}

/** The promise's value once it settles, or null once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then((value) => ({ value })), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

/** A sending thread as "[name] …" shows it: its title, short, or its id. */
const senderName = (facts: ThreadFacts | null, id: string) => {
  const title = facts?.title?.trim();
  return title ? (title.length > 48 ? `${title.slice(0, 47)}…` : title) : id;
};

/** Several threads' entries, each in its own order, merged oldest first (ties keep thread order). */
export function mergeByTime(runs: readonly LogEntry[][]): LogEntry[] {
  if (runs.length <= 1) return runs[0] ?? [];
  const at = runs.map(() => 0);
  const merged: LogEntry[] = [];
  for (;;) {
    let best = -1;
    for (let k = 0; k < runs.length; k++) {
      const next = runs[k]![at[k]!];
      if (next && (best < 0 || next.at < runs[best]![at[best]!]!.at)) best = k;
    }
    if (best < 0) return merged;
    merged.push(runs[best]![at[best]!++]!);
  }
}

/** A stable prompt-cache session per scope, shaped like the UUID Codex sends. */
export function cacheKey(scopeId: string) {
  const h = createHash("sha256").update(`chat-memory:${scopeId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
