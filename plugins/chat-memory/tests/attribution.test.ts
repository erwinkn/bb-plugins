import { describe, expect, it } from "vitest";
import { responsesSummarizer, type Summarizer } from "../lib/summarizer";
import { fixture } from "./fixture";

// W256, moved with T145: every summarizer call tells the Pooler which memory scope it is for (its
// first thread, and its Initiative when it has one) and why, so its usage report can attribute
// the Luna spend.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => { for (let k = 0; k < n; k++) await tick(); };
const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("W256 summarizer calls carry their attribution", () => {
  it("the Responses client sends the Initiative, thread and purpose as headers, and leaves out what is null", async () => {
    const seen: RequestInit[] = [];
    const summarize = responsesSummarizer({
      fetch: (async (_url: string, init: RequestInit) => (seen.push(init), sse([{ type: "response.completed", response: { output: [], usage: {} } }]))) as never,
      url: () => "http://pool/advisor/v1/responses",
      headers: async () => ({ "x-bb-plugin-token": "t" }),
    });
    const request = { instructions: "", input: [], effort: "high", cacheKey: "k", signal: new AbortController().signal };
    await summarize({ ...request, attribution: { initiative: "ini_1", thread: "thr_coord", purpose: "memory-tree" } });
    expect(seen[0]!.headers).toMatchObject({ "x-bb-initiative": "ini_1", "x-bb-thread": "thr_coord", "x-bb-purpose": "memory-tree", "x-bb-plugin-token": "t" });
    await summarize({ ...request, attribution: { initiative: null, thread: "thr_plain", purpose: "memory-tree" } });
    expect(seen[1]!.headers).not.toHaveProperty("x-bb-initiative");
    expect(seen[1]!.headers).toMatchObject({ "x-bb-thread": "thr_plain" });
    await summarize(request);
    expect(Object.keys(seen[2]!.headers as object).filter((name) => /^x-bb-(initiative|thread|purpose)$/u.test(name))).toEqual([]);
  });

  it("a build names its scope's Initiative (an Initiatives scope), its first thread and memory-tree", async () => {
    const f = fixture();
    const calls: unknown[] = [];
    const summarize: Summarizer = async (r) => (calls.push({ ...r.attribution }), { ok: true, text: "summary".padEnd(300, "."), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 });
    f.memory.useSummarizer(summarize);
    await f.attach("initiatives", "ini_a", f.thread("thr_a"), f.thread("thr_talk"));
    await f.configure(f.thread("thr_plain"), {});
    for (const [scope, thread] of [["initiatives:ini_a", "thr_a"], ["chat-memory:thr_plain", "thr_plain"]] as const) {
      f.store.append(thread, Array.from({ length: 2 }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: thread, seq: i + 1 })), 2);
      f.memory.build(scope);
    }
    await ticks();
    await f.memory.settled();
    expect(new Set(calls.map((c) => JSON.stringify(c)))).toEqual(
      new Set([JSON.stringify({ initiative: "ini_a", thread: "thr_a", purpose: "memory-tree" }), JSON.stringify({ initiative: null, thread: "thr_plain", purpose: "memory-tree" })]),
    );
  });
});
