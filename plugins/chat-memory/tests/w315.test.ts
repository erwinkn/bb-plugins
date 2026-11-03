import { describe, expect, it, vi } from "vitest";
import { CALL_TIMEOUT_MS, TreeBuilder, type TreeStore } from "../lib/builder";
import { TURN_CONTEXT_TOOL, cacheKey } from "../lib/memory";
import { FairPermits } from "../lib/permits";
import { responsesSummarizer, type SummarizerRequest, type SummarizerResult } from "../lib/summarizer";
import { LIMIT, bytes, emptyViews, key } from "../lib/tree";
import { fakeLuna, fixture, stuckLuna } from "./fixture";

// W315: a turn's summaries go before background builds; a slow call is bounded and retried.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => {
  for (let k = 0; k < n; k++) await tick();
};
const ok = (text: string): SummarizerResult => ({ ok: true, text, usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 });

describe("W315 urgent calls go first", () => {
  it("lets an urgent call in before every waiting one, asking urgency when a permit frees", async () => {
    const permits = new FairPermits(() => 1);
    const order: string[] = [];
    let release!: () => void;
    const first = permits.run("bg", new AbortController().signal, () => new Promise<void>((resolve) => (release = resolve)));
    // Permits are given out once per macrotask (W568): the first call holds its permit before the rest ask.
    await tick();
    let needed = false;
    const work = (owner: string, name: string, urgent?: () => boolean) => permits.run(owner, new AbortController().signal, async () => void order.push(name), urgent);
    const waiting = [work("bg", "bg1"), work("bg", "bg2"), work("other", "other1"), work("turn", "turn1", () => needed), work("bg", "bg3")];
    await tick();
    // The turn comes to need its call while it waits.
    needed = true;
    release();
    await first;
    await Promise.all(waiting);
    expect(order).toEqual(["turn1", "bg1", "other1", "bg2", "bg3"]);
  });

  it("serves a waiting turn's summary before another scope's backlog", async () => {
    const f = fixture();
    // Every call waits until released, oldest first; which scope each one is for.
    const held: { scope: string; go: () => void }[] = [];
    const started: string[] = [];
    const scopes = new Map([["test:bg1", "bg"], ["test:bg2", "bg"], ["initiatives:prj_1", "turn"]].map(([id, name]) => [cacheKey(id!), name!]));
    f.memory.useSummarizer(async (r) => {
      const scope = scopes.get(r.cacheKey)!;
      started.push(scope);
      await new Promise<void>((resolve) => {
        held.push({ scope, go: resolve });
        r.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return r.signal.aborted ? { ok: false, reason: "aborted", error: "stopped" } : fakeLuna(r);
    });
    const release = async () => {
      held.shift()!.go();
      await ticks();
    };
    (f.memory as unknown as { deps: { settings: () => object } }).deps.settings = () => ({ regularCompactTokens: 0, hybridCompactTokens: 0, summarizerEffort: "high", summarizerConcurrency: 2 });
    // The coordinator's OptChat memory, up to date.
    await f.attach("initiatives", "prj_1", f.thread("a", { title: "Coordinator" }));
    f.turn("a", "hello");
    await f.idle("a");
    // Two other scopes' backlogs, 40 messages of 1 KB each: every permit taken, and calls waiting for one.
    for (const bg of ["bg1", "bg2"]) {
      const scope = `test:${bg}`;
      f.store.ensureScope(scope, "test");
      f.store.attach(f.thread(bg), scope);
      f.store.append(bg, Array.from({ length: 40 }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: bg, seq: i + 1 })), 40);
      f.memory.build(scope);
    }
    await ticks();
    expect(started).toEqual(["bg", "bg"]);
    // The coordinator's last reply is more than 32 KB: its first part needs a summary before the next turn.
    f.reply("a", "x".repeat(34_000));
    f.done("a");
    f.memory.waits.turn = 5_000;
    const turn = f.ask("a", f.say("a", "go on"), "go on");
    await ticks(60);
    // The first permit that frees goes to the turn's line, ahead of the backlog's queued calls.
    await release();
    expect(started.slice(2)).toEqual(["turn"]);
    let answered = false;
    void turn.then(() => {answered = true;});
    for (let n = 0; n < 20 && !answered; n++) { if (held.length) await release(); else await ticks(); }
    const answer = (await turn) as { session: string };
    expect(answer.session).toBe("fresh");
    f.memory.dispose();
    for (const h of held.splice(0)) h.go();
    await f.memory.settled();
  });
});

/** A store of `count` messages of 1 KB each, every node kept in memory. */
function memoryStore(count: () => number) {
  const texts = new Map<string, string>();
  const store: TreeStore = {
    messageCount: count,
    message: (i) => ({ kind: "agent", text: `${i} `.padEnd(1000, "y") }),
    node: (l, i) => texts.get(key(l, i)) ?? null,
    built: () => [],
    saveNode: (l, i, text) => void texts.set(key(l, i), text),
    saveViews: () => {},
    recordCall: () => {},
  };
  return { store, texts };
}
/** A summarizer whose calls wait to be let go: each one's task ("3", "0+2 and 2+2"), urgency and request. */
function heldSummarizer() {
  const calls: { task: string; urgent: () => boolean; request: SummarizerRequest; go: (text?: string) => void }[] = [];
  const summarize = (r: SummarizerRequest, urgent: () => boolean) =>
    new Promise<SummarizerResult>((resolve) => {
      r.onStart?.();
      r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "stopped" }));
      const task = /compress message (\d+)|merge lines (\d+\+\d+ and \d+\+\d+)/.exec(r.input.find((m) => m.role === "user")!.content[0]!.text)!.slice(1).find(Boolean)!;
      calls.push({ task, urgent, request: r, go: (text = `summary of ${task}`) => resolve(ok(text)) });
    });
  return { calls, summarize };
}

describe("W315 a turn's lines go first, in batches", () => {
  it("marks a turn's nodes and their merges urgent, never starts more than the limit, and lets go once released", async () => {
    let count = 2;
    const { store } = memoryStore(() => count);
    const { calls, summarize } = heldSummarizer();
    const builder = new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "", effort: () => "high", concurrency: () => 2, cacheKey: "k" });
    const stop = new AbortController();
    const run = builder.run(stop.signal);
    await ticks();
    expect(calls.map((c) => [c.task, c.urgent()])).toEqual([["0", false], ["1", false]]);
    // A turn needs messages 0..2: the calls already waiting become urgent; message 3, its own, is not.
    count = 4;
    const release = builder.need(3);
    expect(calls.map((c) => c.urgent())).toEqual([true, true]);
    // Lines of 300 bytes: their merge needs a call too, urgent as well (it is before message 2),
    // but it starts after line 2, which the turn needs (W570).
    for (const c of calls.splice(0)) c.go("m".repeat(300));
    await ticks();
    expect(calls.map((c) => [c.task, c.urgent()])).toEqual([["2", true], ["0+1 and 1+1", true]]);
    calls.splice(0)[0]!.go("m".repeat(300));
    await ticks();
    expect(calls.map((c) => [c.task, c.urgent()])).toEqual([["3", false]]);
    expect(builder.summarized(3)).toBe(true);
    release();
    stop.abort();
    await run;
  });

  it("starts a 3,000-message backlog a turn needs in batches: the event loop never blocks 50 ms, no more calls pending than permits", async () => {
    const { store } = memoryStore(() => 3000);
    const permits = new FairPermits(() => 8);
    const held: { go: () => void; urgent: boolean }[] = [];
    let pending = 0;
    let peakPending = 0;
    const builder = new TreeBuilder(store, emptyViews(), {
      // Through 8 permits; every call waits to be let go.
      summarize: async (r, urgent) => {
        peakPending = Math.max(peakPending, ++pending);
        try {
          const work = () =>
            new Promise<SummarizerResult>((resolve) => {
              r.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", error: "stopped" }));
              held.push({ go: () => resolve(ok("summary")), urgent: urgent() });
            });
          return (await permits.run("k", r.signal, work, urgent)) ?? { ok: false, reason: "aborted", error: "stopped" };
        } finally {
          pending--;
        }
      },
      instructions: () => "",
      effort: () => "high",
      concurrency: () => 8,
      cacheKey: "k",
    });
    const release = builder.need(3000);
    const stop = new AbortController();
    const run = builder.run(stop.signal);
    let longest = 0;
    const turns = async (n: number) => {
      for (let k = 0; k < n; k++) {
        const t = performance.now();
        await tick();
        longest = Math.max(longest, performance.now() - t);
      }
    };
    await turns(50);
    expect(held.length).toBe(8);
    expect(held.every((h) => h.urgent)).toBe(true);
    // 25 rounds of 8 calls let go: the build goes on in batches.
    for (let round = 0; round < 25; round++) {
      for (const h of held.splice(0)) h.go();
      await turns(20);
    }
    expect(builder.unsummarized(3000)).toBeLessThanOrEqual(3000 - 25 * 8 + 8);
    expect(longest).toBeLessThan(50);
    expect(peakPending).toBeLessThanOrEqual(8);
    release();
    stop.abort();
    await run;
  });
});

describe("W315 bounded calls", () => {
  it("cuts a call a turn waits for at its bound like any other (R12: no turn waits long for it)", async () => {
    const { store } = memoryStore(() => 1);
    const { calls, summarize } = heldSummarizer();
    const builder = new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "", effort: () => "high", concurrency: () => 1, cacheKey: "k" });
    const release = builder.need(1);
    const stop = new AbortController();
    const run = builder.run(stop.signal);
    await ticks();
    expect(calls[0]!.request).toMatchObject({ timeoutMs: CALL_TIMEOUT_MS });
    expect(Object.keys(calls[0]!.request)).not.toContain("extendMs");
    release();
    stop.abort();
    await run;
  });


  it("gives up a call with no reply within its bound as a timeout, never as a stop", async () => {
    // As fetch does: rejects once its signal aborts, at once if it has.
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const stop = () => reject(new DOMException("aborted", "AbortError"));
        if (init!.signal!.aborted) stop();
        init!.signal!.addEventListener("abort", stop);
      });
    const summarize = responsesSummarizer({ fetch: hang as typeof fetch, url: () => "http://luna", headers: async () => ({}) });
    const request: SummarizerRequest = { instructions: "", input: [], effort: "high", cacheKey: "k", signal: new AbortController().signal };
    expect(await summarize({ ...request, timeoutMs: 20 })).toMatchObject({ ok: false, reason: "timeout", error: "no reply within 0.02 s" });
    const stop = new AbortController();
    const stopped = summarize({ ...request, signal: stop.signal, timeoutMs: 60_000 });
    stop.abort();
    expect(await stopped).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("retries a timed-out line at once with a doubled bound, and fails it visibly after 3", async () => {
    const texts = new Map<string, string>();
    const store: TreeStore = {
      messageCount: () => 1,
      message: () => ({ kind: "agent", text: "y".repeat(2000) }),
      node: (l, i) => texts.get(key(l, i)) ?? null,
      built: (l, from, to) => [...texts.keys()].map((k) => k.split(":").map(Number)).filter(([nl, ni]) => nl === l && ni! >= from && ni! < to).map(([, ni]) => ni!),
      saveNode: (l, i, text) => void texts.set(key(l, i), text),
      saveViews: () => {},
      recordCall: () => {},
    };
    const bounds: (number | undefined)[] = [];
    let timeouts = 1;
    const builder = new TreeBuilder(store, emptyViews(), {
      summarize: async (r) => (bounds.push(r.timeoutMs), timeouts-- > 0 ? { ok: false, reason: "timeout", error: "no reply within 30 s" } : ok("summary")),
      instructions: () => "",
      effort: () => "high",
      concurrency: () => 8,
      cacheKey: "k",
    });
    await builder.run(new AbortController().signal);
    // No pause for the scope: the line was tried again at once, with twice the time.
    expect(bounds).toEqual([CALL_TIMEOUT_MS, 2 * CALL_TIMEOUT_MS]);
    expect(texts.get("0:0")).toBe("summary");
    expect(builder.status.state).toBe("idle");

    texts.clear();
    bounds.length = 0;
    timeouts = 3;
    const again = new TreeBuilder(store, emptyViews(), { ...builder["options"] });
    await again.run(new AbortController().signal);
    expect(bounds).toEqual([CALL_TIMEOUT_MS, 2 * CALL_TIMEOUT_MS, 4 * CALL_TIMEOUT_MS]);
    expect(again.failedBefore(1)).toEqual({ i: 0, error: "no reply within 30 s" });
  });
});

describe("W315 a stopped call never starts", () => {
  const completed = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }] } })}\n\n`);
  const request = (signal: AbortSignal): SummarizerRequest => ({ instructions: "", input: [], effort: "high", cacheKey: "k", signal, timeoutMs: 60_000 });

  it("sends nothing for a call stopped before it starts, or between its permit's grant and its start", async () => {
    let fetches = 0;
    const summarize = responsesSummarizer({ fetch: (async () => (fetches++, completed())) as typeof fetch, url: () => "http://luna", headers: async () => ({}) });
    const stopped = new AbortController();
    stopped.abort();
    expect(await summarize(request(stopped.signal))).toMatchObject({ ok: false, reason: "aborted" });
    // Granted at once, then stopped before FairPermits.run goes on.
    const permits = new FairPermits(() => 1);
    const stop = new AbortController();
    const call = permits.run("k", stop.signal, () => summarize(request(stop.signal)));
    stop.abort();
    expect(await call).toBeNull();
    expect(permits.inFlight).toBe(0);
    expect(fetches).toBe(0);
  });

  it("gives up a token lookup that never answers at the call's bound, and never sends the request after", async () => {
    let fetches = 0;
    let token!: (headers: Record<string, string>) => void;
    // As the Pooler's: it ignores its signal.
    const summarize = responsesSummarizer({ fetch: (async () => (fetches++, completed())) as typeof fetch, url: () => "http://luna", headers: () => new Promise((resolve) => (token = resolve)) });
    const call = summarize({ ...request(new AbortController().signal), timeoutMs: 20 });
    const result = await Promise.race([call, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500))]);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    token({});
    await ticks();
    expect(fetches).toBe(0);
    // Stopped by its caller, it is a stop.
    const stop = new AbortController();
    const stopped = summarize(request(stop.signal));
    stop.abort();
    expect(await stopped).toMatchObject({ ok: false, reason: "aborted" });
  });
});

describe("W315 a stopped turn stops waiting", () => {
  it("ends its wait for summaries when BB stops the turn, and lets go of its priority", async () => {
    const f = fixture();
    await f.attach("initiatives", "a", f.thread("a"));
    f.turn("a", "hello");
    await f.idle("a");
    f.memory.useSummarizer(stuckLuna);
    // More than 32 KB without a summary: the turn waits for one.
    f.reply("a", "x".repeat(34_000));
    f.done("a");
    const requestId = f.say("a", "continue");
    f.memory.waits.turn = 5_000;
    const stop = new AbortController();
    const turn = f.harness.behavior.callAgentTool(TURN_CONTEXT_TOOL, { protocol: 4, input: "continue", requestId, sessionId: "s-a" }, { threadId: "a", signal: stop.signal });
    const outcome = turn.then(
      () => "answered",
      (error: Error) => error.message,
    );
    await ticks(30);
    const builder = (f.memory as unknown as { builders: Map<string, TreeBuilder> }).builders.get("initiatives:a")!;
    expect(builder["needs"].size).toBe(1);
    stop.abort();
    const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500))]);
    expect(result).toMatch(/the turn stopped/);
    expect(builder["needs"].size).toBe(0);
    f.memory.dispose();
    await f.memory.settled();
  });
});

describe("W315 a line too long costs one more call, not four", () => {
  // W574: asked for 448 bytes, a 20% overshoot (537) fits at once; a 30% one (582) is asked once
  // more for 448, overshoots again and is cut: never a third call.
  it.each([
    [1.2, 1, false],
    [1.3, 2, true],
  ])("asks for less than the limit: a summarizer that overshoots its ask by x%s takes %s calls a line (cut: %s)", async (overshoot, perLine, cut) => {
    const texts = new Map<string, string>();
    const store: TreeStore = {
      messageCount: () => 8,
      message: (i) => ({ kind: "agent", text: `${i} `.padEnd(1000, "y") }),
      node: (l, i) => texts.get(key(l, i)) ?? null,
      built: () => [],
      saveNode: (l, i, text) => void texts.set(key(l, i), text),
      saveViews: () => {},
      recordCall: () => {},
    };
    let calls = 0;
    const builder = new TreeBuilder(store, emptyViews(), {
      // Luna as measured: whatever it is asked, it writes a fifth to a third more.
      summarize: async (r) => {
        calls++;
        const said = r.input.flatMap((m) => m.content.map((c) => c.text)).join("\n");
        const asked = Number([...said.matchAll(/at most (\d+) bytes/g)].at(-1)![1]);
        return ok("x".repeat(Math.floor(asked * overshoot)));
      },
      instructions: () => "",
      effort: () => "high",
      concurrency: () => 8,
      cacheKey: "k",
    });
    await builder.run(new AbortController().signal);
    // 8 messages of 1 KB: 8 lines and 7 merges, every one too long at first.
    expect(texts.size).toBe(15);
    expect([...texts.values()].every((t) => bytes(t) <= LIMIT)).toBe(true);
    expect(calls).toBe(perLine * 15);
    expect([...texts.values()].every((t) => t.endsWith(" [cut]") === cut)).toBe(true);
  });
});
