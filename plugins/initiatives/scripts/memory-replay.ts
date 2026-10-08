/**
 * W220: build a memory tree with the plugin's own code for a slice of a real coordinator, read-only.
 *
 *   bb thread log <thread> --json --all > /tmp/events.json
 *   npx vite-node scripts/memory-replay.ts /tmp/events.json <from> <count> <out-dir> [effort]
 *
 * Luna is called through the pool's native Responses route with this agent's own pool token
 * ($ANTHROPIC_BASE_URL, $ANTHROPIC_AUTH_TOKEN), or with ROUTE=advisor through the plugin's own
 * route (the Pooler's advisor route, with `bb plugin token account-pool-local`). Tokens are never printed. Nothing is written to BB or the
 * plugin's database: the log, nodes, views and call stats go to <out-dir>, which holds transcript
 * text and belongs outside the repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/memory/builder";
import { DEFAULT_COORDINATOR_INSTRUCTIONS } from "../lib/guidance";
import { eventEntries, splitEntry, withSize, type EventRow, type MemoryMessage } from "../lib/memory/log";
import { cacheKey } from "../lib/memory/memory";
import { systemPrompt } from "../lib/memory/prompt";
import { responsesSummarizer, usageCost, type Summarizer, type Usage } from "../lib/memory/summarizer";
import { bytes, emptyViews, key, renderLine, viewBytes } from "../lib/memory/tree";

const [file, fromArg, countArg, out, effort = "xhigh"] = process.argv.slice(2);
if (!file || !out) throw new Error("usage: memory-replay.ts <events.json> <from> <count> <out-dir> [effort]");
const base = process.env.ANTHROPIC_BASE_URL;
const token = process.env.ANTHROPIC_AUTH_TOKEN;
if (!base || !token) throw new Error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are needed (the pool's native route).");
mkdirSync(out, { recursive: true });

const events = JSON.parse(readFileSync(file, "utf8")) as (EventRow & { threadId?: string })[];
const all = events.flatMap((row) => eventEntries(row, row.threadId ?? "thread", () => null)).flatMap(splitEntry);
console.error(`The whole log: ${all.length} messages.`);
const from = Number(fromArg ?? 0);
const messages: MemoryMessage[] = all.slice(from, from + Number(countArg ?? all.length)).map((e, i) => withSize(e, i));
writeFileSync(`${out}/log.jsonl`, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

const nodes: { l: number; i: number; how: NodeHow; tries: number; size: number }[] = [];
const texts = new Map<string, string>();
const calls: { usage: Usage; cost: number; ms: number; tries: number }[] = [];
const store: TreeStore = {
  messageCount: () => messages.length,
  message: (i) => messages[i] ?? null,
  node: (l, i) => texts.get(key(l, i)) ?? null,
  built: (l, from, to) => nodes.filter((n) => n.l === l && n.i >= from && n.i < to).map((n) => n.i),
  saveNode: (l, i, text, how, tries) => {
    texts.set(key(l, i), text);
    nodes.push({ l, i, how, tries, size: bytes(text) });
  },
  saveViews: () => {},
  recordCall: (call) => void calls.push(call),
};
const advisor = process.env.ROUTE === "advisor";
const pluginToken = advisor ? execFileSync("bb", ["plugin", "token", "account-pool-local"], { encoding: "utf8" }).trim() : "";
const native: Summarizer = responsesSummarizer({
  fetch: (...args) => fetch(...args),
  url: () => (advisor ? `${base}/advisor/v1/responses` : `${base}/v1/responses`),
  headers: async (): Promise<Record<string, string>> =>
    advisor ? { "x-bb-plugin-token": pluginToken } : { authorization: `Bearer ${token}`, originator: "codex_cli_rs" },
});
let failures = 0;
const builder = new TreeBuilder(store, emptyViews(), {
  summarize: async (request) => {
    const result = await native(request);
    if (!result.ok) {
      failures++;
      console.error(`call failed (${result.reason}): ${result.error.slice(0, 160)}`);
    }
    return result;
  },
  instructions: () => systemPrompt(DEFAULT_COORDINATOR_INSTRUCTIONS),
  effort: () => effort,
  concurrency: () => 8,
  cacheKey: cacheKey(`replay-${Date.now()}`),
  log: (message) => console.error(message),
});

const t0 = Date.now();
const progress = setInterval(() => console.error(`${Math.round((Date.now() - t0) / 1000)}s: ${nodes.length} nodes, ${calls.length} calls`), 30_000);
await builder.run(new AbortController().signal);
clearInterval(progress);
const wallMs = Date.now() - t0;

const sum = (f: (u: Usage) => number) => calls.reduce((s, c) => s + f(c.usage), 0);
const modelNodes = nodes.filter((n) => n.how === "model");
const sizes = modelNodes.map((n) => n.size).sort((a, b) => a - b);
const pct = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] ?? 0;
const latency = calls.map((c) => c.ms).sort((a, b) => a - b);
const lat = (p: number) => latency[Math.min(latency.length - 1, Math.floor(p * latency.length))] ?? 0;
const stats = {
  slice: { from, messages: messages.length, bytes: messages.reduce((s, m) => s + m.size, 0), kinds: Object.fromEntries(["user", "coord", "tool", "echo", "work", "note"].map((k) => [k, messages.filter((m) => m.kind === k).length])) },
  effort,
  route: advisor ? "advisor" : "native",
  wallSeconds: Math.round(wallMs / 1000),
  nodes: { total: nodes.length, model: modelNodes.length, free: nodes.filter((n) => n.how === "free").length, fallback: nodes.filter((n) => n.how === "fallback").length },
  calls: { count: calls.length, tries: calls.reduce((s, c) => s + c.tries, 0), firstTryFits: modelNodes.filter((n) => n.tries === 1).length, failedResponses: failures, latencyMs: { p50: lat(0.5), p90: lat(0.9), max: lat(1) } },
  lineBytes: { p50: pct(0.5), p90: pct(0.9), max: sizes.at(-1) ?? 0, over512: sizes.filter((s) => s > 512).length },
  tokens: { input: sum((u) => u.input), cached: sum((u) => u.cached), output: sum((u) => u.output), reasoning: sum((u) => u.reasoning) },
  cachedShare: Math.round((1000 * sum((u) => u.cached)) / Math.max(1, sum((u) => u.input))) / 10,
  costUsd: Math.round(calls.reduce((s, c) => s + usageCost(c.usage), 0) * 10_000) / 10_000,
  views: { chatBytes: viewBytes(builder.views.chat, builder.nodes), chatLines: builder.views.chat.length, memoryBytes: viewBytes(builder.views.compaction, builder.nodes), memoryLines: builder.views.compaction.length },
};
writeFileSync(`${out}/stats.json`, JSON.stringify(stats, null, 2));
writeFileSync(`${out}/memory-view.txt`, builder.views.compaction.map((n) => renderLine(n, builder.nodes)).join("\n") + "\n");
writeFileSync(`${out}/chat-view.txt`, builder.views.chat.map((n) => renderLine(n, builder.nodes)).join("\n") + "\n");
writeFileSync(`${out}/nodes.jsonl`, [...texts].map(([k, text]) => JSON.stringify({ k, text })).join("\n") + "\n");
console.log(JSON.stringify(stats, null, 2));
