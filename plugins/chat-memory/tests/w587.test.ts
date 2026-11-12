import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { TreeBuilder, compactionInput, type TreeStore } from "../lib/builder";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENAI_RESPONSES_URL, openaiKey } from "../lib/pooler";
import { MIGRATIONS, MemoryStore } from "../lib/store";
import { PRICES, PRIMARY_BACKOFF, SUMMARIZER_MODEL, fallbackSummarizer, responsesSummarizer, usageCost, type Summarizer, type SummarizerRequest, type SummarizerResult, type Usage } from "../lib/summarizer";
import { emptyViews, key } from "../lib/tree";

// W587: Luna on OpenAI's API, on a pay-as-you-go key, takes the summarizer's calls while the Pooler's Codex route cannot run it.

const request = (over: Partial<SummarizerRequest> = {}): SummarizerRequest => ({
  instructions: "PROMPT",
  input: compactionInput(["1+1|a", "2+1|b", "3+1|c", "4+1|d", "5+1|e"], "<input>task</input>"),
  effort: "high",
  cacheKey: "scope",
  attribution: { initiative: "I1", thread: "thr_1", purpose: "memory-tree" },
  signal: new AbortController().signal,
  ...over,
});
const usage: Usage = { input: 10, cached: 0, output: 5, reasoning: 0 };
const ok = (text: string, model?: string): SummarizerResult => ({ ok: true, text, usage, latencyMs: 0, model });
const limited = (retryAfterMs?: number): SummarizerResult => ({ ok: false, reason: "rate-limited", error: "429 No Account Pooler account is currently eligible", retryAfterMs });

/** A summarizer that answers from a list and counts its calls. */
function scripted(...results: SummarizerResult[]) {
  const s = Object.assign(async () => (s.calls++, results.length > 1 ? results.shift()! : results[0]!), { calls: 0 }) as Summarizer & { calls: number };
  return s;
}

describe("W587 the Pooler falls back to OpenAI", () => {
  it("answers with OpenAI when the Pooler is rate-limited, then skips the Pooler until its Retry-After has passed", async () => {
    let now = 1_000_000;
    const logs: string[] = [];
    const pooler = scripted(limited(20 * 60_000), ok("from pooler", SUMMARIZER_MODEL));
    const openai = scripted(ok("from openai", SUMMARIZER_MODEL));
    const summarize = fallbackSummarizer(pooler, openai, { now: () => now, log: (m) => logs.push(m) });

    expect(await summarize(request())).toMatchObject({ ok: true, text: "from openai", model: SUMMARIZER_MODEL });
    expect([pooler.calls, openai.calls]).toEqual([1, 1]);
    expect(logs).toHaveLength(1);

    // While the Pooler backs off, OpenAI goes first: no Pooler call.
    now += 19 * 60_000;
    expect(await summarize(request())).toMatchObject({ text: "from openai" });
    expect([pooler.calls, openai.calls]).toEqual([1, 2]);

    // After it, the Pooler again.
    now += 2 * 60_000;
    expect(await summarize(request())).toMatchObject({ text: "from pooler", model: SUMMARIZER_MODEL });
    expect([pooler.calls, openai.calls]).toEqual([2, 2]);
  });

  it("backs the Pooler off 15 minutes without Retry-After, at most an hour, and also when its route is off", async () => {
    let now = 0;
    const pooler = scripted(limited(), limited(5 * 24 * 3_600_000), { ok: false, reason: "unavailable", error: "403 advisor route for codex is off" }, ok("pooler"));
    const openai = scripted(ok("openai"));
    const summarize = fallbackSummarizer(pooler, openai, { now: () => now });
    const poolerCallsAt = async (t: number) => ((now = t), await summarize(request()), pooler.calls);
    expect(await poolerCallsAt(0)).toBe(1);
    expect(await poolerCallsAt(PRIMARY_BACKOFF.default - 1)).toBe(1);
    expect(await poolerCallsAt(PRIMARY_BACKOFF.default)).toBe(2);
    // Days of Retry-After are capped at an hour: a new Codex account is found within one.
    const t = PRIMARY_BACKOFF.default + PRIMARY_BACKOFF.max;
    expect(await poolerCallsAt(t - 1)).toBe(2);
    expect(await poolerCallsAt(t)).toBe(3);
    // 403: unavailable falls back too.
    expect(openai.calls).toBe(5);
    expect(await poolerCallsAt(t + PRIMARY_BACKOFF.default)).toBe(4);
  });

  it("returns the fallback's refusal when both refuse, so the builder backs off as before", async () => {
    const openaiLimited: SummarizerResult = { ok: false, reason: "rate-limited", error: "429 claude", retryAfterMs: 60_000 };
    const summarize = fallbackSummarizer(scripted(limited()), scripted(openaiLimited), { now: () => 0 });
    expect(await summarize(request())).toEqual(openaiLimited);
  });

  it("keeps the Pooler's own failures: a refused request, a timeout or a 5xx does not fall back", async () => {
    for (const reason of ["failed", "timeout", "transient", "aborted"] as const) {
      const openai = scripted(ok("openai"));
      const summarize = fallbackSummarizer(scripted({ ok: false, reason, error: reason }), openai);
      expect(await summarize(request())).toMatchObject({ ok: false, reason });
      expect(openai.calls).toBe(0);
    }
  });
});

describe("W587 the direct route", () => {
  const completed = () =>
    new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "a line" }] }], usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });

  it("sends the Pooler request to OpenAI with the key alone: no session_id, no Pooler attribution, and says it was direct", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => (sent.push({ url, init }), completed())) as unknown as typeof fetch;
    const pooler = responsesSummarizer({ fetch: fetcher, url: () => "http://pool/responses", headers: async () => ({ "x-bb-plugin-token": "tok" }) });
    const openai = responsesSummarizer({ fetch: fetcher, url: () => OPENAI_RESPONSES_URL, headers: async () => ({ authorization: "Bearer sk-test" }), direct: true });
    expect(await pooler(request())).not.toHaveProperty("direct");
    expect(await openai(request())).toMatchObject({ ok: true, text: "a line", model: SUMMARIZER_MODEL, direct: true });
    const [viaPooler, direct] = sent;
    expect(direct!.url).toBe("https://api.openai.com/v1/responses");
    expect(Object.keys(direct!.init.headers as object).sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(viaPooler!.init.headers).toMatchObject({ session_id: "scope", "x-bb-thread": "thr_1", "x-bb-plugin-token": "tok" });
    // The same body on both routes, prompt_cache_key included.
    expect(direct!.init.body).toBe(viaPooler!.init.body);
    expect(JSON.parse(String(direct!.init.body))).toMatchObject({ model: SUMMARIZER_MODEL, prompt_cache_key: "scope", store: false, reasoning: { effort: "high" } });
  });

  it("reads the key from its dotenv file at each call; a missing file or line is no key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w587-"));
    const file = join(dir, "openai.env");
    try {
      await expect(openaiKey(file)).rejects.toThrow(/no OPENAI_API_KEY/);
      writeFileSync(file, "OTHER=1\n");
      await expect(openaiKey(file)).rejects.toThrow(/no OPENAI_API_KEY/);
      writeFileSync(file, 'OPENAI_API_KEY="sk-one"\n');
      expect(await openaiKey(file)).toBe("sk-one");
      writeFileSync(file, "export OPENAI_API_KEY=sk-two");
      expect(await openaiKey(file)).toBe("sk-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back from a real Pooler 429 to a real OpenAI reply, and a missing key leaves the Pooler's refusal", async () => {
    const fetcher = (async (url: string) => (url.startsWith("http://pool") ? new Response("No Account Pooler account is currently eligible", { status: 429, headers: { "retry-after": "60" } }) : completed())) as unknown as typeof fetch;
    const pooler = responsesSummarizer({ fetch: fetcher, url: () => "http://pool/responses", headers: async () => ({}) });
    let key: string | null = null;
    const openai = responsesSummarizer({ fetch: fetcher, url: () => OPENAI_RESPONSES_URL, headers: async () => ({ authorization: `Bearer ${key ?? (await openaiKey("/nonexistent/openai.env"))}` }), direct: true });
    const logs: string[] = [];
    const summarize = fallbackSummarizer(pooler, openai, { log: (m) => logs.push(m) });
    const refused = await summarize(request());
    expect(refused).toMatchObject({ ok: false, reason: "rate-limited", retryAfterMs: 60_000 });
    expect(refused).not.toHaveProperty("direct");
    expect(logs).toEqual([]);
    key = "sk-test";
    expect(await summarize(request())).toMatchObject({ ok: true, text: "a line", direct: true });
    expect(logs).toHaveLength(1);
  });
});

describe("W587 cost is priced at the model that answered, and tagged when paid directly", () => {
  afterEach(() => void delete PRICES["test-model"]);

  it("prices each try at its own model's rates", async () => {
    PRICES["test-model"] = { input: 10, cached: 1, output: 100 };
    expect(usageCost(usage, "test-model")).toBeCloseTo((10 * 10 + 5 * 100) / 1e6);
    expect(usageCost(usage)).toBeCloseTo(usageCost(usage, SUMMARIZER_MODEL));

    const texts = new Map<string, string>();
    const calls: { cost: number; direct?: number }[] = [];
    const store: TreeStore = {
      messageCount: () => 1,
      message: () => ({ kind: "agent", text: "y".repeat(2000) }),
      node: (l, i) => texts.get(key(l, i)) ?? null,
      built: () => [],
      saveNode: (l, i, text) => void texts.set(key(l, i), text),
      saveViews: () => {},
      recordCall: ({ cost, direct }) => void calls.push({ cost, direct }),
    };
    // A first reply too long (the Pooler), the retry from the direct route.
    const replies: SummarizerResult[] = [ok("x".repeat(700), SUMMARIZER_MODEL), { ...ok("short", "test-model"), direct: true }];
    const builder = new TreeBuilder(store, emptyViews(), { summarize: async () => replies.shift()!, instructions: () => "", effort: () => "high", concurrency: () => 1, cacheKey: "k" });
    await builder.run(new AbortController().signal);
    expect(texts.get("0:0")).toBe("short");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cost).toBeCloseTo(usageCost(usage, SUMMARIZER_MODEL) + usageCost(usage, "test-model"));
    expect(calls[0]!.direct).toBeCloseTo(usageCost(usage, "test-model"));
  });

  it("keeps the directly paid part of a scope's cost in its own column", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    const store = new MemoryStore(db);
    const tree = store.tree("chat-memory:thr_1");
    tree.recordCall({ usage, cost: 0.5, ms: 1, tries: 1 });
    tree.recordCall({ usage, cost: 0.25, direct: 0.25, ms: 1, tries: 1 });
    expect(store.totals("chat-memory:thr_1")).toMatchObject({ calls: 2, costUsd: 0.75, directUsd: 0.25 });
    db.close();
  });
});
