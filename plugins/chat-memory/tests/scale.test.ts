import { describe, expect, it } from "vitest";
import { STOPPED, eventEntries } from "../lib/log";
import { FairPermits } from "../lib/permits";
import type { Summarizer, SummarizerResult } from "../lib/summarizer";
import { fixture } from "./fixture";

// W244's permit and sweep regressions, and T143's stopped turns, moved with T145.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => {
  for (let k = 0; k < n; k++) await tick();
};
const line: SummarizerResult = { ok: true, text: "summary".padEnd(300, "."), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 };

/** A summarizer whose calls wait until released (or aborted), counting the calls in flight. */
function heldLuna() {
  const held: (() => void)[] = [];
  const luna = { active: 0, peak: 0, calls: 0, release: () => { for (const go of held.splice(0)) go(); } };
  const summarize: Summarizer = async (r) => {
    luna.calls++;
    luna.active++;
    luna.peak = Math.max(luna.peak, luna.active);
    r.onStart?.();
    await new Promise<void>((resolve) => {
      held.push(resolve);
      r.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    luna.active--;
    return r.signal.aborted ? { ok: false, reason: "aborted", error: "stopped" } : line;
  };
  return { luna, summarize };
}

/** A scope with `n` logged messages of 1 KB, from a thread of its own. */
async function seeded(f: ReturnType<typeof fixture>, key: string, n: number) {
  f.thread(key);
  const { scope } = await f.setScope("test", key, [key]);
  f.store.append(scope, Array.from({ length: n }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: key, seq: i + 1 })), new Map([[key, n]]));
  return scope;
}

describe("W244 one Luna limit across every scope", () => {
  it("lets one scope's waiting calls in by turns, and never starts one stopped while waiting", async () => {
    const permits = new FairPermits(() => 1);
    const order: string[] = [];
    let release!: () => void;
    const first = permits.run("a", new AbortController().signal, () => new Promise<void>((resolve) => (release = resolve)));
    const work = (owner: string, k: number) => permits.run(owner, new AbortController().signal, async () => void order.push(`${owner}${k}`));
    const waiting = [work("a", 1), work("a", 2), work("a", 3), work("b", 1), work("c", 1)];
    const stop = new AbortController();
    const stopped = permits.run("b", stop.signal, async () => void order.push("never"));
    stop.abort();
    expect(await stopped).toBeNull();
    release();
    await first;
    await Promise.all(waiting);
    expect(order).toEqual(["a1", "b1", "c1", "a2", "a3"]);
    expect(permits.inFlight).toBe(0);
  });

  for (const limit of [1, 8])
    it(`never runs more than the concurrency setting (${limit}) across 12 scopes, and every one advances`, async () => {
      const f = fixture();
      const { luna, summarize } = heldLuna();
      f.memory.useSummarizer(summarize);
      (f.memory as unknown as { deps: { settings: () => object } }).deps.settings = () => ({ regularCompactTokens: 0, hybridCompactTokens: 0, summarizerEffort: "high", summarizerConcurrency: limit });
      const scopes = await Promise.all(Array.from({ length: 12 }, (_, n) => seeded(f, `s${n}`, 8)));
      for (const scope of scopes) f.memory.build(scope);
      await ticks();
      expect(luna.active).toBe(limit);
      const pending = async () => (await Promise.all(scopes.map((s) => f.memory.status(s)))).some((s) => s.tree.summarized < 8 || s.tree.state !== "idle");
      for (let round = 0; round < 2000 && (await pending()); round++) {
        luna.release();
        await ticks(5);
        expect(luna.active).toBeLessThanOrEqual(limit);
      }
      expect(luna.peak).toBe(limit);
      expect(f.memory.permits.inFlight).toBe(0);
      f.memory.dispose();
      await f.memory.settled();
    });
});

describe("W244 every scope gets its first tree", () => {
  it("40 quiet scopes are all read within 14 sweeps", async () => {
    const f = fixture();
    let now = 1_900_000_000_000;
    (f.store as unknown as { now: () => number }).now = () => now;
    f.memory.useSummarizer(async () => line);
    const scopes: string[] = [];
    for (let n = 0; n < 40; n++) {
      f.thread(`t${n}`);
      f.say(`t${n}`, "short");
      f.store.ensureScope(`test:q${n}`, "test");
      f.store.setMembers(`test:q${n}`, [`t${n}`]);
      scopes.push(`test:q${n}`);
    }
    // ceil(40 / 3) sweeps, 30 s apart.
    for (let pass = 0; pass < 14; pass++) {
      f.memory.sweep();
      await f.memory.settled();
      now += 30_000;
    }
    const unread = [];
    for (const s of scopes) if ((await f.memory.status(s)).log.messages === 0) unread.push(s);
    expect(unread).toEqual([]);
  });
});

describe("W244 closing a scope stops its build at once", () => {
  it("aborts the call in flight, starts no other, and a waiting turn fails visibly", async () => {
    const f = fixture();
    const { luna, summarize } = heldLuna();
    f.memory.useSummarizer(summarize);
    (f.memory as unknown as { deps: { settings: () => object } }).deps.settings = () => ({ regularCompactTokens: 0, hybridCompactTokens: 0, summarizerEffort: "high", summarizerConcurrency: 1 });
    const scope = await seeded(f, "c", 4);
    f.memory.build(scope);
    await ticks();
    expect(luna.active).toBe(1);
    await f.setScope("test", "c", []);
    expect(luna.active).toBe(0);
    luna.release();
    await f.memory.settled();
    expect(luna.calls).toBe(1);
    expect((await f.memory.status(scope)).tree.nodes).toBe(0);
    // Nothing starts it again while it is closed.
    f.memory.build(scope);
    f.memory.sweep();
    await f.memory.settled();
    expect(luna.calls).toBe(1);
  });
});

describe("T143 stopped turns in the memory log", () => {
  it("marks a stopped turn after what it had said; a finished turn adds nothing", async () => {
    const f = fixture();
    await f.setScope("test", "c", [f.thread("c")]);
    const push = (type: string, data: Record<string, unknown>) => f.history.push({ threadId: "c", type, seq: f.history.length + 1, createdAt: f.history.length + 1, data });
    push("client/turn/requested", { direction: "outbound", source: "tell", initiator: "user", input: [{ type: "text", text: "Plan T4" }] });
    push("item/completed", { item: { type: "agentMessage", id: "a1", text: "First, the" } });
    push("turn/completed", { providerThreadId: "p", status: "interrupted" });
    push("client/turn/requested", { direction: "outbound", source: "tell", initiator: "user", input: [{ type: "text", text: "Go on" }] });
    push("item/completed", { item: { type: "agentMessage", id: "a2", text: "Done." } });
    push("turn/completed", { providerThreadId: "p", status: "completed" });
    await f.idle("c");
    expect(f.store.messages("test:c").map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: Plan T4", "agent: First, the", `work: ${STOPPED}`, "user: Go on", "agent: Done."]);
  });

  it("maps only an interrupted turn/completed", () => {
    const facts = { spawnedByPlugin: false, sender: (id: string) => id };
    const row = (status: string) => ({ seq: 1, type: "turn/completed", createdAt: 1, data: { status } });
    expect(eventEntries(row("interrupted"), "c", facts).map((e) => e.text)).toEqual([STOPPED]);
    expect(eventEntries(row("completed"), "c", facts)).toEqual([]);
    expect(eventEntries(row("failed"), "c", facts)).toEqual([]);
  });
});
