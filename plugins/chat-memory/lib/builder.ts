import { createHash } from "node:crypto";
import type { MemoryMessage } from "./log";
import { cleanLine, messageText, task, tooLong } from "./prompt";
import { usageCost, type Attribution, type InputItem, type Summarizer, type Usage } from "./summarizer";
import { LIMIT, NodeCache, bytes, children, contextLines, end, feed, key, label, settleViews, type NodeRef, type Views } from "./tree";

/** What the builder reads and writes; the plugin backs it with its database, tests with memory. */
export interface TreeStore {
  messageCount(): number;
  message(i: number): Pick<MemoryMessage, "kind" | "text"> | null;
  /** A built node's text, or null. */
  node(l: number, i: number): string | null;
  /** The built nodes of level l with from <= i < to, by index (their text stays unread). */
  built(l: number, from: number, to: number): number[];
  saveNode(l: number, i: number, text: string, how: NodeHow, tries: number): void;
  saveViews(views: Views): void;
  recordCall(call: { usage: Usage; cost: number; ms: number; tries: number }): void;
}
/**
 * model: a summarizer call; free: fits as is; fallback: cut to fit after failed calls, by the
 * Initiatives builder before T145 (imported lines only: a failed line now stays unbuilt, D458).
 */
export type NodeHow = "model" | "free" | "fallback";

export interface BuilderOptions {
  summarize: Summarizer;
  /** The compactions' system prompt. */
  instructions: () => string;
  effort: () => string;
  concurrency: () => number;
  /** The prompt-cache session, one per scope. */
  cacheKey: string;
  /** Who the calls are for, read at each call: a scope's threads change. */
  attribution?: () => Attribution;
  now?: () => number;
  log?: (message: string) => void;
  /** Pauses after a 429 grow from min to max; an unavailable route pauses for `unavailable` (ms). */
  backoff?: { min: number; max: number; unavailable: number };
}

export type BuilderStatus =
  | { state: "idle" | "building"; detail: null; until: null }
  | { state: "backoff" | "unavailable"; detail: string; until: number };

const ATTEMPTS = 5;
/** Nodes of one level that one step of the load's recovery reads, before yielding the event loop. */
const RECOVER_SLICE = 4096;
const FAILURES = 3;
/** A line that failed FAILURES times is tried again, FAILURES more times, this long after. */
const FAILED_RETRY_MS = 30 * 60_000;
const BACKOFF = { min: 15_000, max: 10 * 60_000, unavailable: 10 * 60_000 };

type Pause = { reason: "rate-limited" | "transient" | "unavailable"; error: string; retryAfterMs?: number };
type Outcome =
  /** pause: a length retry was refused after an earlier try gave a line; the line stands, new calls wait. */
  | { kind: "built"; pause?: Pause }
  | { kind: "failed"; error: string }
  | ({ kind: "pause" } & Pause)
  | { kind: "aborted" };

/**
 * Builds one scope's tree in the background, as the gist and W216 do: message nodes start
 * once fewer than `concurrency` earlier ones are unbuilt, a merge starts once both halves are
 * built, and ready nodes wait in a queue (never found by scanning the tree). Up to `concurrency`
 * calls run at once; a call waits while another is writing the same cached prefix. A line over
 * 512 bytes is retried in the same conversation up to 5 times, keeping the shortest.
 *
 * run() returns when everything logged so far is built, or when its signal aborts: calls in
 * flight are cancelled and their nodes queued again, and nothing more is written. 429s pause
 * every new call with a growing backoff (or the server's Retry-After); an unavailable route
 * pauses for 10 minutes. A line whose call fails 3 times stays unbuilt and failed (never cut to
 * fit: a turn must not read part of a message as its summary), and is tried again 30 minutes later.
 *
 * Only the nodes in use are held: texts are read from the store through a bounded cache, and
 * the first run after a load finds the ready nodes from which nodes exist, in slices.
 */
export class TreeBuilder {
  private ready: NodeRef[] = [];
  private queued = new Set<string>();
  private failures = new Map<string, number>();
  /** Lines whose calls failed FAILURES times: their last error, and when. */
  private failed = new Map<string, { node: NodeRef; error: string; at: number }>();
  private writers = new Map<string, Promise<void>>();
  private pauseUntil = 0;
  private backoffMs = 0;
  private listeners = new Set<() => void>();
  private recovered = false;
  /** Fed messages without their line yet, once recovered: the build's frontier, never the history. */
  private unbuilt = new Set<number>();
  /** Its scope closed or the service stopped: listeners hear it once more. */
  closed = false;
  readonly nodes: NodeCache;
  status: BuilderStatus = { state: "idle", detail: null, until: null };

  constructor(
    private readonly store: TreeStore,
    readonly views: Views,
    private readonly options: BuilderOptions,
  ) {
    this.nodes = new NodeCache((l, i) => store.node(l, i));
  }

  /**
   * Once per load, in slices that yield the event loop: the nodes that were ready when the builder
   * last stopped, unbuilt with both halves built. It reads which nodes exist, never their text.
   */
  private async recover(signal: AbortSignal) {
    const fed = this.views.fed;
    for (let l = 0; 2 ** l <= fed; l++) {
      const count = Math.floor(fed / 2 ** l);
      for (let from = 0; from < count; from += RECOVER_SLICE) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal.aborted) return;
        const to = Math.min(count, from + RECOVER_SLICE);
        const built = new Set(this.store.built(l, from, to));
        const halves = l ? new Set(this.store.built(l - 1, 2 * from, 2 * to)) : null;
        for (let i = from; i < to; i++) {
          if (built.has(i)) continue;
          if (l === 0) this.unbuilt.add(i);
          if (!halves || (halves.has(2 * i) && halves.has(2 * i + 1))) this.enqueue([l, i]);
        }
      }
    }
    // A stop between a node's write and its views' save leaves a merge the durable nodes allow.
    this.saveSettled();
    this.recovered = true;
    this.notify();
  }

  private concurrency() {
    return Math.max(1, this.options.concurrency());
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private enqueue(n: NodeRef) {
    if (!this.nodes.has(key(...n))) this.requeue(n);
  }
  /** Queue a node known to be unbuilt (its call did not build it), from local state only. */
  private requeue(n: NodeRef) {
    const k = key(...n);
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.ready.push(n);
  }
  /** A built node makes its parent ready when its sibling is built too. */
  private settle([l, i]: NodeRef) {
    if (this.nodes.has(key(l, i ^ 1))) this.enqueue([l + 1, i >> 1]);
  }
  /** Recent messages still being summarized (failed ones wait for their retry, so they hold no slot). */
  private unbuiltRecent() {
    let n = 0;
    for (const i of this.unbuilt) if (i >= this.views.fed - 64 && !this.failed.has(key(0, i))) n++;
    return n;
  }

  private build(n: NodeRef, text: string, how: NodeHow, tries: number) {
    const k = key(...n);
    if (this.nodes.has(k)) return;
    this.nodes.set(k, text);
    this.store.saveNode(n[0], n[1], text, how, tries);
    if (n[0] === 0) this.unbuilt.delete(n[1]);
    this.settle(n);
    this.saveSettled();
    this.notify();
  }
  /** Go on with any merge the built nodes allow, and save the views if they changed. */
  private saveSettled() {
    const merging = this.views.merging;
    const merges = settleViews(this.views, this.nodes);
    if (merges.chat || merges.compaction || merging !== this.views.merging) this.store.saveViews(this.views);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
  /** Called after every node built, after the load's recovery, and once on close; returns the unsubscribe. */
  onBuilt(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** No more nodes will come from this builder: waiters give up. */
  close() {
    this.closed = true;
    this.notify();
  }
  /** Whether messages 0..count-1 all have their line. */
  summarized(count: number) {
    if (!this.recovered || this.views.fed < count) return false;
    for (const i of this.unbuilt) if (i < count) return false;
    return true;
  }

  /** How many of messages 0..count-1 have no line yet. */
  unsummarized(count: number) {
    let n = Math.max(0, count - this.views.fed);
    for (const i of this.unbuilt) if (i < count) n++;
    return n;
  }

  /** The first of messages 0..count-1 whose summary failed, if any: a turn that needs it cannot wait it out. */
  failedBefore(count: number) {
    let first: { i: number; error: string } | null = null;
    for (const { node, error } of this.failed.values()) if (node[0] === 0 && node[1] < count && (!first || node[1] < first.i)) first = { i: node[1], error };
    return first;
  }
  /** The lines that failed, oldest first. */
  failedLines() {
    return [...this.failed.values()].sort((a, b) => a.node[1] * 2 ** a.node[0] - b.node[1] * 2 ** b.node[0]).map(({ node, error }) => ({ line: label(node), error }));
  }
  /** Failed lines whose wait is over go back in the queue. */
  private retryFailed() {
    const now = this.now();
    for (const [k, { node, at }] of this.failed) {
      if (now - at < FAILED_RETRY_MS) continue;
      this.failed.delete(k);
      this.requeue(node);
    }
  }

  /** Text that fits as is: a short message, or two lines that fit together. */
  private freeText([l, i]: NodeRef) {
    if (l === 0) {
      const m = this.store.message(i);
      const text = m && messageText(m);
      return text !== null && bytes(text) <= LIMIT ? text : null;
    }
    const [a, b] = children([l, i]).map((c) => this.nodes.get(key(...c))!);
    return bytes(a!) + 1 + bytes(b!) <= LIMIT ? `${a}\n${b}` : null;
  }
  /** Build every queued node that needs no call, and drop ones built meanwhile. */
  private buildFree() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let k = 0; k < this.ready.length; k++) {
        const n = this.ready[k]!;
        const free = this.nodes.has(key(...n)) ? null : this.freeText(n);
        if (!this.nodes.has(key(...n)) && free === null) continue;
        this.ready.splice(k--, 1);
        this.queued.delete(key(...n));
        if (free !== null) this.build(n, free, "free", 0);
        progressed = true;
      }
    }
  }

  async run(signal: AbortSignal) {
    const running = new Map<string, Promise<void>>();
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", (onAbort = () => resolve()), { once: true }));
    try {
      if (!this.recovered) await this.recover(signal);
      this.retryFailed();
      while (!signal.aborted) {
        const total = this.store.messageCount();
        let fed = false;
        while (this.views.fed < total && this.unbuiltRecent() < this.concurrency()) {
          feed(this.views, this.nodes);
          this.unbuilt.add(this.views.fed - 1);
          this.enqueue([0, this.views.fed - 1]);
          fed = true;
        }
        if (fed) this.store.saveViews(this.views);
        this.buildFree();
        this.ready.sort((a, b) => end(a) - end(b) || a[0] - b[0]);
        const now = this.now();
        if (now >= this.pauseUntil) {
          if (this.status.state !== "building" && (running.size || this.ready.length)) this.status = { state: "building", detail: null, until: null };
          while (running.size < this.concurrency() && this.ready.length) {
            const n = this.ready.shift()!;
            const k = key(...n);
            this.queued.delete(k);
            if (running.has(k) || this.nodes.has(k)) continue;
            running.set(k, this.compact(n, signal).then((outcome) => {
              running.delete(k);
              this.settleCall(n, outcome, signal);
            }));
          }
        }
        if (!running.size && !this.ready.length && this.views.fed >= total) {
          // Up to date; a pause still under way stays shown, as the next call waits for it.
          if (now >= this.pauseUntil) this.status = { state: "idle", detail: null, until: null };
          return;
        }
        if (!running.size) await sleep(Math.max(0, this.pauseUntil - this.now()), signal);
        else await Promise.race([...running.values(), aborted]);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await Promise.allSettled(running.values());
    }
  }

  private settleCall(n: NodeRef, outcome: Outcome, signal: AbortSignal) {
    const k = key(...n);
    if (outcome.kind === "built") {
      this.failures.delete(k);
      if (outcome.pause) this.pause(outcome.pause);
      else this.backoffMs = 0;
      return;
    }
    // Stopped: nothing more is read or written; the node waits for the next run.
    if (outcome.kind === "aborted" || signal.aborted) return this.requeue(n);
    if (outcome.kind === "pause") {
      this.requeue(n);
      return this.pause(outcome);
    }
    const failures = (this.failures.get(k) ?? 0) + 1;
    this.failures.set(k, failures);
    if (failures < FAILURES) return this.requeue(n);
    this.options.log?.(`Memory line ${label(n)} failed ${failures} times (${outcome.error}); it stays unsummarized, and is tried again in ${FAILED_RETRY_MS / 60_000} minutes.`);
    this.failures.delete(k);
    this.failed.set(k, { node: n, error: outcome.error, at: this.now() });
    // Turns waiting for it learn at once that it will not come.
    this.notify();
  }

  /** Every new call waits: a growing backoff (or Retry-After) after a 429, 10 minutes for an unavailable route. */
  private pause({ reason, error, retryAfterMs }: Pause) {
    const unavailable = reason === "unavailable";
    const backoff = this.options.backoff ?? BACKOFF;
    if (!unavailable) this.backoffMs = Math.min(backoff.max, Math.max(backoff.min, this.backoffMs * 2));
    const wait = unavailable ? backoff.unavailable : Math.max(Math.min(retryAfterMs ?? 0, 60 * 60_000), this.backoffMs);
    this.pauseUntil = Math.max(this.pauseUntil, this.now() + wait);
    this.status = { state: unavailable ? "unavailable" : "backoff", detail: error, until: this.pauseUntil };
  }

  /** One compaction: the compaction view up to the node as context, then the task; retries in the same conversation. */
  private async compact(node: NodeRef, signal: AbortSignal): Promise<Outcome> {
    const lines = contextLines(node, this.views.compaction, this.nodes);
    const whole = Math.floor(lines.length / 4);
    const blocks: string[] = [];
    for (let b = 0; b * 4 < lines.length; b++) blocks.push((b === 0 ? "<chat>\n" : "") + lines.slice(b * 4, b * 4 + 4).join("\n") + "\n");
    const message = node[0] === 0 ? this.store.message(node[1]) : undefined;
    if (node[0] === 0 && !message) return { kind: "failed", error: `message ${node[1]} is missing from the log` };
    const taskText = `${blocks.length ? "" : "<chat>\n"}</chat>\n${task(node, this.nodes, message ?? undefined)}`;
    // Calls sharing a cached prefix that is still being written wait for it.
    const prefix = createHash("md5").update(lines.slice(0, whole * 4).join("\n")).digest("hex");
    const t0 = this.now();
    await this.writers.get(prefix);
    if (signal.aborted) return { kind: "aborted" };
    let release!: () => void;
    const writing = new Promise<void>((resolve) => (release = resolve));
    this.writers.set(prefix, writing);
    const started = () => {
      release();
      if (this.writers.get(prefix) === writing) this.writers.delete(prefix);
    };
    const usage: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
    let input: InputItem[] = [{ role: "user", content: [{ type: "input_text", text: blocks.join("") }, { type: "input_text", text: taskText }] }];
    let best: string | null = null;
    let tries = 0;
    let outcome: Outcome | null = null;
    let pause: Pause | undefined;
    try {
      for (let a = 0; a < ATTEMPTS; a++) {
        const r = await this.options.summarize({ instructions: this.options.instructions(), input, effort: this.options.effort(), cacheKey: this.options.cacheKey, attribution: this.options.attribution?.(), signal, onStart: started });
        started();
        tries++;
        if (r.usage) addUsage(usage, r.usage);
        if (!r.ok) {
          if (r.reason === "aborted") outcome = { kind: "aborted" };
          else if (r.reason === "failed") {
            if (best === null) outcome = { kind: "failed", error: r.error };
          } else {
            const refused: Pause = { reason: r.reason, error: r.error, retryAfterMs: r.retryAfterMs };
            // After a line, a refused retry keeps that line, but new calls still wait out the refusal.
            if (best === null) outcome = { kind: "pause", ...refused };
            else pause = refused;
          }
          break;
        }
        const line = cleanLine(r.text);
        if (!line) {
          if (best === null) outcome = { kind: "failed", error: "empty reply" };
          break;
        }
        if (best === null || bytes(line) < bytes(best)) best = line;
        if (bytes(line) <= LIMIT) break;
        input = [...input, { role: "assistant", content: [{ type: "output_text", text: r.text }] }, { role: "user", content: [{ type: "input_text", text: tooLong(line) }] }];
      }
    } finally {
      started();
      // Once stopped the store may already be closed: nothing more is written.
      if (!signal.aborted && (usage.input || usage.output)) this.store.recordCall({ usage, cost: usageCost(usage), ms: this.now() - t0, tries });
    }
    if (outcome) return outcome;
    if (signal.aborted) return { kind: "aborted" };
    this.build(node, best!, "model", tries);
    return pause ? { kind: "built", pause } : { kind: "built" };
  }
}

function addUsage(total: Usage, u: Usage) {
  total.input += u.input;
  total.cached += u.cached;
  total.output += u.output;
  total.reasoning += u.reasoning;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
