import { z } from "zod";
import { addAbortListener } from "node:events";
import { createHash } from "node:crypto";
import { BUSY_STATUSES, ProjectError, errorMessage } from "../bb";
import type { Preferences } from "../settings";
import type { Store } from "../store";
import { TreeBuilder, type BuilderStatus } from "./builder";
import { readEvents, startsAfresh, type ListEvents } from "./ingest";
import { eventEntries, splitEntry } from "./log";
import { messageText, systemPrompt } from "./prompt";
import { FairPermits } from "./permits";
import { MemoryStore, type MemoryMode, type MemorySettings } from "./store";
import type { Summarizer } from "./summarizer";
import { NodeCache, end, label, nodeAt, children, renderLine, viewBytes } from "./tree";

export const zoomToolSchema = z.object({ id: z.number().int().min(0), n: z.number().int().min(1) }).strict();
export const dateToolSchema = z.object({ id: z.number().int().min(0) }).strict();

/** Event pages one ingest reads per thread before yielding; the next kick goes on. */
const INGEST_PAGES = 20;
/** A former coordinator still busy this long after its replacement stops holding the current one's log back. */
const TAIL_WAIT_MS = 10 * 60_000;
/** The sweep re-reads a quiet Initiative's coordinators this often; idle and event signals come first. */
const SWEEP_INGEST_MS = 5 * 60_000;
/**
 * Initiatives one sweep starts reading, so the first logs after an upgrade don't all start at
 * once; the least recently read go first, so every Initiative gets its turn (W244).
 */
const SWEEP_KICKS = 3;

export const OPTCHAT_NOTE = "optchat is stored, but its runtime is not available yet: until it is, the coordinator runs as hybrid.";
/**
 * W244: BB fixes a session's tools and instructions when it is built and mostly keeps them on
 * resume, so a coordinator from before every coordinator got its memory tools (D447) may lack
 * them; that matters once its mode compacts sooner than regular. Those coordinators are noted
 * once, at the first start that gives the tools in every mode, and keep the note until replaced.
 */
export const SESSION_NOTE = "This coordinator's session predates its memory tools, so it may lack initiative_zoom and initiative_date: replace the coordinator to give it them.";
const LEGACY_SEEDED = "memory-tools-legacy";
const legacyFlag = (threadId: string) => `${LEGACY_SEEDED}:${threadId}`;
/** The memory's own progress (log and tree) reaches the dashboards at most this often; they also poll. */
const PROGRESS_PUBLISH_MS = 30_000;

export interface MemoryStatus {
  mode: MemoryMode;
  /** The mode the coordinator actually runs in (optchat runs as hybrid for now). */
  effectiveMode: "regular" | "hybrid";
  note: string | null;
  /** SESSION_NOTE outside regular mode while the coordinator is one from before D447 (it may lack its memory tools). */
  session: string | null;
  compactTokens: number;
  compactTokensOverride: number | null;
  log: { messages: number; bytes: number; threads: number };
  tree: {
    summarized: number;
    nodes: number;
    /** Nodes a complete tree over the log has. */
    total: number;
    fallbacks: number;
    viewBytes: number;
    memoryViewBytes: number;
    state: BuilderStatus["state"];
    detail: string | null;
    until: number | null;
  };
  cost: { calls: number; tries: number; inputTokens: number; cachedTokens: number; outputTokens: number; usd: number; callSeconds: number };
}

/** A complete tree over n messages has floor(n/2^l) nodes on each level l. */
const treeSize = (n: number) => {
  let total = 0;
  for (let size = 1; size <= n; size *= 2) total += Math.floor(n / size);
  return total;
};

/**
 * D431 phase 1: each Initiative's shared memory. The log is read from BB's events of every
 * coordinator thread, starting, on its first read, from the current coordinator back to the
 * last handover (or new-Initiative start), the handover being a note. D447: GPT-6 Luna builds
 * the summary tree over it in the background in every mode, so a switch between modes is
 * instant; the coordinator reads its view, zoom and date in every mode.
 *
 * The mode is one setting per Initiative (regular, hybrid or optchat), for the coordinator and
 * later its discussion threads (D446). What depends on it is read at each turn: the compaction
 * limit (compactLimit) and, once it exists, the optchat runtime (settings().mode).
 *
 * Ingests and builds run detached and owned here: one of each per Initiative at a time, aborted
 * by dispose (the service signal disposes too) and when their Initiative is archived (stop).
 * Every Initiative's summarizer calls share one limit, memoryConcurrency, let in round-robin
 * by Initiative (W244). Nothing waits on them. An aborted run stays owned until it settles, and writes nothing more;
 * after dispose the store refuses every access (BB closes the database), whichever path asks.
 */
interface Run {
  abort: AbortController;
  /** Asked again while running: go on (or, once a stopped run settles, start over). */
  again: boolean;
  done: Promise<void>;
}

export class CoordinatorMemory {
  readonly store: MemoryStore;
  private disposed = false;
  private stopLink: Disposable | null = null;
  private ingests = new Map<string, Run>();
  private builds = new Map<string, Run>();
  private builders = new Map<string, TreeBuilder>();
  private lastIngest = new Map<string, number>();
  private published = new Map<string, number>();
  /** Summarizer calls in flight across every Initiative (W244). */
  readonly permits: FairPermits;

  constructor(
    private readonly deps: {
      ledger: Store;
      list: ListEvents;
      /** The thread's native status, or null when BB no longer has it. */
      threadStatus: (threadId: string) => Promise<string | null>;
      preferences: () => Preferences;
      summarizer: Summarizer;
      log: (message: string) => void;
      /** Something the dashboard shows changed. */
      changed?: (projectId: string) => void;
    },
  ) {
    this.store = new MemoryStore(deps.ledger.db, () => deps.ledger.now());
    this.permits = new FairPermits(() => deps.preferences().memoryConcurrency);
  }

  /** Test seam: the summarizer later calls use. */
  useSummarizer(summarizer: Summarizer) {
    this.deps.summarizer = summarizer;
  }

  start(signal?: AbortSignal) {
    this.disposed = false;
    this.store.open();
    if (!this.deps.ledger.hasFlag(LEGACY_SEEDED)) {
      for (const project of this.deps.ledger.projects())
        if (project.coordinatorThreadId) this.deps.ledger.setFlag(legacyFlag(project.coordinatorThreadId));
      this.deps.ledger.setFlag(LEGACY_SEEDED);
    }
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

  // Settings -------------------------------------------------------------------------

  settings(projectId: string): MemorySettings {
    return this.store.settings(projectId);
  }
  /** D447: the tree is built for every live Initiative, whatever its mode. */
  building(projectId: string) {
    const project = this.deps.ledger.project(projectId);
    return !!project && project.archivedAt === null;
  }
  /** The compaction limit of the Initiative's memory threads: its own, else the setting for its mode. Read at each turn. */
  compactLimit(projectId: string) {
    const { mode, compactTokens } = this.settings(projectId);
    if (compactTokens !== null) return compactTokens;
    const preferences = this.deps.preferences();
    return mode === "regular" ? preferences.coordinatorCompactTokens : preferences.hybridCompactTokens;
  }

  configure(projectId: string, patch: { mode?: MemoryMode; compactTokens?: number | null }, author: "user" | "coordinator") {
    const project = this.deps.ledger.project(projectId);
    if (!project || project.archivedAt !== null) throw new ProjectError(`Unknown Initiative ${projectId}.`);
    const before = this.settings(projectId);
    const next: MemorySettings = {
      mode: patch.mode ?? before.mode,
      compactTokens: patch.compactTokens === undefined ? before.compactTokens : patch.compactTokens,
    };
    this.store.saveSettings(projectId, next);
    const who = author === "user" ? "you" : "the coordinator";
    if (next.mode !== before.mode)
      this.deps.ledger.log(projectId, "project", `Memory set to ${next.mode} by ${who}, from the next turn${next.mode === "optchat" ? " (runs as hybrid until the optchat runtime exists)" : ""}`);
    if (next.compactTokens !== before.compactTokens)
      this.deps.ledger.log(projectId, "project", next.compactTokens === null ? `Compaction limit reset to the ${next.mode} default by ${who}` : `Compaction limit set to ${Math.round(next.compactTokens / 1000)}k tokens by ${who}`);
    return this.status(projectId);
  }

  /** The log or tree grew: tell the dashboards, at most every PROGRESS_PUBLISH_MS per Initiative. */
  private progressed(projectId: string) {
    const now = this.deps.ledger.now();
    if (now - (this.published.get(projectId) ?? -Infinity) < PROGRESS_PUBLISH_MS) return;
    this.published.set(projectId, now);
    this.deps.changed?.(projectId);
  }

  // Ingest and build ------------------------------------------------------------------

  /** The current coordinator's Initiative, for the per-second thread event; null for others. */
  projectOfCoordinator(threadId: string) {
    const row = this.deps.ledger.db.prepare(`SELECT id FROM projects WHERE coordinator_thread_id = ? AND archived_at IS NULL`).get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Bring the log up to date, then build if the mode builds. Detached; repeated kicks coalesce. */
  kick(projectId: string) {
    if (this.disposed) return;
    const running = this.ingests.get(projectId);
    if (running) {
      running.again = true;
      return;
    }
    // Its signal is checked between reads, never given to the SDK (W193: BB's SDK records a composite on every signal it gets).
    const entry: Run = { abort: new AbortController(), again: false, done: Promise.resolve() };
    const { signal } = entry.abort;
    // The entry leaves the map in the same step as the loop's last check, so a kick is never lost.
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          this.lastIngest.set(projectId, this.deps.ledger.now());
          const read = await this.ingest(projectId, signal);
          if (signal.aborted) break;
          // A long first log is read in slices; the next one follows at once.
          if (read.behind) entry.again = true;
          if (read.appended) this.progressed(projectId);
          if (this.building(projectId)) this.build(projectId);
        } while (entry.again && !signal.aborted);
      } catch (error) {
        if (!signal.aborted) this.deps.log(`Coordinator memory log for ${projectId} failed: ${errorMessage(error)}`);
      } finally {
        this.ingests.delete(projectId);
      }
    })();
    this.ingests.set(projectId, entry);
  }

  /** The sweep's kick: the least recently read Initiatives not read for a while (a missed idle, a first log). */
  sweep() {
    const now = this.deps.ledger.now();
    const read = (projectId: string) => this.lastIngest.get(projectId) ?? -Infinity;
    this.deps.ledger
      .projects()
      .filter((p) => p.archivedAt === null && !this.ingests.has(p.id) && now - read(p.id) >= SWEEP_INGEST_MS)
      .sort((a, b) => read(a.id) - read(b.id))
      .slice(0, SWEEP_KICKS)
      .forEach((p) => this.kick(p.id));
  }

  /**
   * New messages of every coordinator thread still read, oldest thread first: how many were
   * logged, and whether a thread has more than one slice of pages left. The log is in order: a
   * thread is read only once every earlier one has been read through, so a backlog or a failed
   * read holds the later threads back. Every write follows a check that the signal (or dispose)
   * has not stopped the pass.
   */
  async ingest(projectId: string, signal?: AbortSignal) {
    const stopped = () => this.disposed || signal?.aborted === true;
    const project = this.deps.ledger.project(projectId);
    let appended = 0;
    const result = (behind = false) => ({ appended, behind });
    if (!project || project.archivedAt !== null) {
      this.stopBuilding(projectId);
      return result();
    }
    if (!this.store.cursors(projectId).length) {
      const chain = await this.seedChain(projectId, project.coordinatorThreadId, stopped);
      if (stopped()) return result();
      const now = this.deps.ledger.now();
      chain.forEach((threadId, k) => this.store.addCursor(projectId, threadId, now - chain.length + k));
    }
    if (project.coordinatorThreadId) this.store.addCursor(projectId, project.coordinatorThreadId);
    const workerRef = (threadId: string) => {
      const m = this.deps.ledger.membership(threadId, true);
      return m?.project.id === projectId ? (m.worker?.ref ?? (m.workerNum === 0 ? "coordinator" : null)) : null;
    };
    for (const cursor of this.store.cursors(projectId)) {
      if (cursor.done) continue;
      const former = cursor.threadId !== project.coordinatorThreadId;
      let after = cursor.lastSeq;
      let more = true;
      try {
        // A former coordinator is read until it is quiet, its status first: once it is quiet, all
        // its events are below the boundary of the reads that follow, so its log is then complete.
        if (stopped()) return result();
        const status = former ? await this.deps.threadStatus(cursor.threadId) : null;
        for (let page = 0; more && page < INGEST_PAGES; page++) {
          if (stopped()) return result();
          const read = await readEvents(this.deps.list, cursor.threadId, after, stopped);
          if (stopped()) return result();
          const entries = read.rows.flatMap((row) => eventEntries(row, cursor.threadId, workerRef)).flatMap(splitEntry);
          if (read.through > after) this.store.append(projectId, cursor.threadId, entries, read.through);
          appended += entries.length;
          more = read.more;
          after = read.through;
        }
        if (more) return result(true);
        if (former) {
          if (status !== null && BUSY_STATUSES.has(status)) {
            // Still busy: its last events may be past this read's boundary, so later threads wait
            // for the read that begins once it is quiet (the next kick, never a loop), for up to
            // TAIL_WAIT_MS after its replacement. Then they go on, and its tail follows when it lands.
            const replacedAt = this.deps.ledger.generations(projectId, 0).find((g) => g.threadId === cursor.threadId)?.endedAt ?? null;
            if (replacedAt === null || this.deps.ledger.now() - replacedAt < TAIL_WAIT_MS) return result();
            const flag = `memory-tail:${projectId}:${cursor.threadId}`;
            if (!this.deps.ledger.hasFlag(flag)) {
              this.deps.ledger.setFlag(flag);
              this.deps.ledger.log(projectId, "project", `Coordinator memory: the former coordinator (thread ${cursor.threadId}) is still busy 10 minutes after its replacement, so the current coordinator is logged meanwhile; its last messages join the log when they land, possibly after newer ones`);
            }
            continue;
          }
          this.store.finishCursor(projectId, cursor.threadId);
        }
      } catch (error) {
        if (stopped()) return result();
        if ((error as { status?: number }).status !== 404) {
          this.deps.log(`Coordinator memory could not read ${cursor.threadId}: ${errorMessage(error)}`);
          return result();
        }
        this.store.finishCursor(projectId, cursor.threadId);
      }
    }
    return result();
  }

  /**
   * The first log's threads, oldest first: the current coordinator, and earlier ones back to a
   * thread that holds everything before it (a handover or a new Initiative), else to the first.
   * One read per generation. A failed read throws, so nothing is saved and the next pass looks
   * again: a partial chain would never be completed.
   */
  private async seedChain(projectId: string, current: string | null, stopped: () => boolean) {
    const generations = this.deps.ledger.generations(projectId, 0).map((g) => g.threadId).reverse();
    const newestFirst = [...new Set([...(current ? [current] : []), ...generations])];
    const chain: string[] = [];
    for (const threadId of newestFirst) {
      if (stopped()) break;
      chain.unshift(threadId);
      try {
        if (await startsAfresh(this.deps.list, threadId)) break;
      } catch (error) {
        // A deleted thread holds nothing to log; the chain goes on past it.
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    return chain;
  }

  private builder(projectId: string) {
    let builder = this.builders.get(projectId);
    if (!builder) {
      const tree = this.store.tree(projectId);
      builder = new TreeBuilder(tree, this.store.views(projectId), {
        // A call waiting for a permit and stopped meanwhile never starts.
        summarize: async (request) =>
          (await this.permits.run(projectId, request.signal, () => this.deps.summarizer(request))) ?? { ok: false, reason: "aborted", error: "stopped" },
        instructions: () => systemPrompt(this.deps.preferences().coordinatorInstructions),
        effort: () => this.deps.preferences().memoryEffort,
        concurrency: () => this.deps.preferences().memoryConcurrency,
        cacheKey: cacheKey(projectId),
        now: () => this.deps.ledger.now(),
        log: (message) => this.deps.log(`${projectId}: ${message}`),
      });
      this.builders.set(projectId, builder);
    }
    return builder;
  }

  /** Start (or extend) the background build. Behind a stopped run that is still settling, it starts once that one has. */
  build(projectId: string) {
    if (this.disposed || !this.building(projectId)) return;
    const running = this.builds.get(projectId);
    if (running) {
      running.again = true;
      return;
    }
    const entry: Run = { abort: new AbortController(), again: false, done: Promise.resolve() };
    const { signal } = entry.abort;
    const builder = this.builder(projectId);
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await builder.run(signal);
          if (!signal.aborted) this.progressed(projectId);
        } while (entry.again && !signal.aborted);
      } catch (error) {
        if (!signal.aborted) this.deps.log(`Coordinator memory tree for ${projectId} failed: ${errorMessage(error)}`);
      } finally {
        this.builds.delete(projectId);
        if (signal.aborted && entry.again && !this.disposed && this.building(projectId)) this.build(projectId);
      }
    })();
    this.builds.set(projectId, entry);
  }

  /** The Initiative is archived: abort its ingest and build at once (W244). */
  stop(projectId: string) {
    this.ingests.get(projectId)?.abort.abort();
    this.stopBuilding(projectId);
  }

  /**
   * Cancel the build; what is built stays, and a later build goes on from there with a fresh
   * builder. The run stays owned until it settles; its summary waiters get false now.
   */
  stopBuilding(projectId: string) {
    this.builds.get(projectId)?.abort.abort();
    this.builders.get(projectId)?.close();
    this.builders.delete(projectId);
  }

  // Reads ----------------------------------------------------------------------------

  /** The built nodes and saved views: the running builder's, else the stored ones, read node by node. */
  private tree(projectId: string) {
    const builder = this.builders.get(projectId);
    return builder ? { nodes: builder.nodes, views: builder.views } : { nodes: new NodeCache((l, i) => this.store.node(projectId, l, i)), views: this.store.views(projectId) };
  }

  status(projectId: string): MemoryStatus {
    const settings = this.settings(projectId);
    const coordinator = this.deps.ledger.project(projectId)?.coordinatorThreadId ?? null;
    const messages = this.store.count(projectId);
    const { nodes, views } = this.tree(projectId);
    const totals = this.store.totals(projectId);
    const builder = this.builders.get(projectId);
    const state = builder?.status.state ?? (this.builds.has(projectId) ? "building" : "idle");
    return {
      mode: settings.mode,
      effectiveMode: settings.mode === "regular" ? "regular" : "hybrid",
      note: settings.mode === "optchat" ? OPTCHAT_NOTE : null,
      session: settings.mode !== "regular" && coordinator && this.deps.ledger.hasFlag(legacyFlag(coordinator)) ? SESSION_NOTE : null,
      compactTokens: this.compactLimit(projectId),
      compactTokensOverride: settings.compactTokens,
      log: { messages, bytes: totals.logBytes, threads: this.store.cursors(projectId).length },
      tree: {
        summarized: views.fed,
        nodes: totals.nodes,
        total: treeSize(messages),
        fallbacks: totals.fallbacks,
        viewBytes: viewBytes(views.chat, nodes),
        memoryViewBytes: viewBytes(views.compaction, nodes),
        state,
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
    };
  }

  /**
   * A view as "id+n|text" lines, oldest first. "memory" is the compaction view (16–32 KB), what a
   * coordinator reads after a compaction; "chat" is the 64–128 KB view an optchat turn will see.
   */
  view(projectId: string, which: "memory" | "chat" = "memory") {
    const { nodes, views } = this.tree(projectId);
    const view = which === "chat" ? views.chat : views.compaction;
    return {
      messages: this.store.count(projectId),
      summarized: views.fed,
      lines: view.map((n) => renderLine(n, nodes)),
      bytes: viewBytes(view, nodes),
    };
  }

  /** zoom(id, n): the two lines line id+n was made from; n = 1 gives message id whole. */
  zoom(projectId: string, id: number, n: number) {
    const total = this.store.count(projectId);
    if (n === 1) {
      const m = this.store.message(projectId, id);
      if (!m) throw new ProjectError(`No message ${id}: the log holds messages 0 to ${total - 1}.`);
      return messageText(m);
    }
    const node = nodeAt(id, n);
    if (!node) throw new ProjectError(`${id}+${n} is no line: n is a power of 2 and id a multiple of n.`);
    if (end(node) >= total) throw new ProjectError(`${label(node)} goes past the last message, ${total - 1}.`);
    const { nodes } = this.tree(projectId);
    return children(node).map((c) => renderLine(c, nodes)).join("\n");
  }

  /**
   * Resolves once messages 0..count-1 have their line (the gist's rule before a turn: wait until
   * earlier messages are summarized); false when the signal aborts, the Initiative is archived,
   * or the build stops (archive, dispose) before then.
   */
  async waitSummarized(projectId: string, count: number, signal: AbortSignal) {
    if (this.disposed || !this.building(projectId)) return false;
    this.build(projectId);
    const builder = this.builder(projectId);
    if (builder.summarized(count)) return true;
    return new Promise<boolean>((resolve) => {
      const done = (result: boolean) => {
        unsubscribe();
        signal.removeEventListener("abort", aborted);
        resolve(result);
      };
      const aborted = () => done(false);
      const unsubscribe = builder.onBuilt(() => (builder.closed ? done(false) : builder.summarized(count) && done(true)));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  date(projectId: string, id: number) {
    const m = this.store.message(projectId, id);
    if (!m) throw new ProjectError(`No message ${id}.`);
    return `${new Date(m.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** A stable prompt-cache session per Initiative, shaped like the UUID Codex sends. */
export function cacheKey(projectId: string) {
  const h = createHash("sha256").update(`initiatives-memory:${projectId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
