import { describe, expect, it } from "vitest";
import { fixture } from "./fake-native";
import { responsesSummarizer, type Summarizer } from "../lib/memory/summarizer";

// W256: every summarizer call tells the Pooler which Initiative, coordinator thread and purpose it
// is for, so its usage report can attribute the Luna spend.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => { for (let k = 0; k < n; k++) await tick(); };
const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("W256 summarizer calls carry their attribution", () => {
  it("the Responses client sends the Initiative, thread and purpose as headers", async () => {
    const seen: RequestInit[] = [];
    const summarize = responsesSummarizer({
      fetch: (async (_url: string, init: RequestInit) => (seen.push(init), sse([{ type: "response.completed", response: { output: [], usage: {} } }]))) as never,
      url: () => "http://pool/advisor/v1/responses",
      headers: async () => ({ "x-bb-plugin-token": "t" }),
    });
    const request = { instructions: "", input: [], effort: "high", cacheKey: "k", signal: new AbortController().signal };
    await summarize({ ...request, attribution: { initiative: "ini_1", thread: "thr_coord", purpose: "memory-tree" } });
    expect(seen[0]!.headers).toMatchObject({ "x-bb-initiative": "ini_1", "x-bb-thread": "thr_coord", "x-bb-purpose": "memory-tree", "x-bb-plugin-token": "t" });
    // An Initiative with no coordinator thread sends none; a call with no attribution sends none of the three.
    await summarize({ ...request, attribution: { initiative: "ini_1", thread: null, purpose: "memory-tree" } });
    expect(seen[1]!.headers).not.toHaveProperty("x-bb-thread");
    await summarize(request);
    expect(Object.keys(seen[2]!.headers as object).filter((name) => /^x-bb-(initiative|thread|purpose)$/u.test(name))).toEqual([]);
  });

  it("a memory build names its Initiative, its current coordinator thread and memory-tree", async () => {
    const f = fixture();
    f.store.createProject({ id: "ini_a", name: "a", objective: "test", memberProjectIds: [], coordinatorThreadId: "thr_a" });
    f.store.createProject({ id: "ini_b", name: "b", objective: "test", memberProjectIds: [], coordinatorThreadId: "thr_b" });
    for (const id of ["ini_a", "ini_b"])
      f.service.memory.store.append(id, "none", Array.from({ length: 2 }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: "none", seq: i })), 2);
    const calls: { initiative?: string; thread?: string | null; purpose?: string }[] = [];
    const summarize: Summarizer = async (r) => (calls.push({ ...r.attribution }), { ok: true, text: "summary".padEnd(300, "."), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 });
    f.service.memory.useSummarizer(summarize);
    f.service.memory.build("ini_a");
    f.service.memory.build("ini_b");
    await ticks();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.initiative === "ini_a")).not.toHaveLength(0);
    for (const c of calls) expect(c).toEqual({ initiative: c.initiative, thread: c.initiative === "ini_a" ? "thr_a" : "thr_b", purpose: "memory-tree" });
    f.runtime.dispose();
    await f.service.memory.settled();
  });
});
