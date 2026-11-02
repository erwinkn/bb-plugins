/**
 * W572: compare summarizers on the same real compactions, read-only.
 *
 *   npx vite-node scripts/summarizer-bench.ts sample <out-dir> [<samples.jsonl>]
 *   npx vite-node scripts/summarizer-bench.ts run <out-dir> <arm> [limit]
 *   npx vite-node scripts/summarizer-bench.ts judge <out-dir> <arm> <arm> [<arm>...]
 *   npx vite-node scripts/summarizer-bench.ts report <out-dir> <arm> [<arm>...]
 *
 * sample reads the live database read-only and picks leaves and merges from four scopes. Each
 * sample keeps the request the builder would send: its <chat> (the compaction view up to the node,
 * replayed with the plugin's own view code over the scope's built lines, the node and its ancestors
 * left out so no answer leaks in) and its task. Given another run's samples.jsonl, it rebuilds those
 * same nodes instead of picking.
 *
 * An arm is "<model>-<effort>:<prompt>", the prompt read from <out-dir>/prompt-<prompt>.txt:
 * - luna-high:current: GPT-6 Luna through the Pooler's advisor route, as the plugin calls it.
 * - haiku-low:examples: Claude Haiku 5.5 through the Pooler's Claude route (the Claude subscription,
 *   with Claude Code's identity line first in the system prompt, which the route requires), the
 *   compaction prompt and the cached part of <chat> each behind a cache breakpoint. Effort low,
 *   medium or high (adaptive thinking), or "off" (thinking disabled, effort high).
 * - haiku-cli-low:current: the same through `claude -p` (one process per call; first try only),
 *   to measure that route's overhead; haiku-clisys-low:current puts the cached part of <chat> in
 *   its system prompt, the only part Claude Code caches apart from the last message.
 * Each call retries once with the builder's own "Too long" follow-up, then cuts, as the builder does.
 * Luna shares its one route with production memory: run it at CONCURRENCY=2 when the pool is
 * short, and every Luna call of the run pauses a minute or more after a 429.
 *
 * judge shows Claude Opus 5.5 each sample's input and the arms' lines, labels hidden and order
 * shuffled, and asks for a ranking and each line's defects against the prompt's priorities.
 * Everything goes to <out-dir>, which holds transcript text and belongs outside the repository.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { compactionInput } from "../lib/builder";
import type { MemoryKind } from "../lib/log";
import { cacheKey } from "../lib/memory";
import { cleanLine, COMPACTION_PROMPT, messageText, task, tooLong } from "../lib/prompt";
import { responsesSummarizer, usageCost, type InputItem } from "../lib/summarizer";
import { bytes, capLine, contextLines, emptyViews, end, feed, key, label, LIMIT, type NodeRef, type Nodes } from "../lib/tree";

const [command, out, ...rest] = process.argv.slice(2);
if (!command || !out) throw new Error("usage: summarizer-bench.ts sample|run|judge|report <out-dir> ...");
mkdirSync(out, { recursive: true });
const SAMPLES = `${out}/samples.jsonl`;
const DB = process.env.CHAT_MEMORY_DB ?? `${homedir()}/.bb/plugins/chat-memory/data.db`;
const SCOPES = ["initiatives:prj_7958f24542", "initiatives:prj_35ada95761", "initiatives:prj_175951a7f0:worker:140", "initiatives:prj_35ada95761:worker:306"];
/** Per scope: leaves by kind, then merges by level. */
const LEAVES: Partial<Record<MemoryKind, number>> = { user: 4, agent: 4, tool: 5, work: 2, echo: 1 };
/** User messages long enough to need a call are rare: they come from further back. */
const USER_WINDOW = 4000;
const MERGE_LEVELS = [1, 1, 1, 2, 2, 3, 3, 4, 5, 6];

interface Sample {
  id: string;
  scope: string;
  node: NodeRef;
  label: string;
  kind: MemoryKind | "merge";
  lines: string[];
  task: string;
  /** For the judge: the whole message, or the two lines and the messages they cover, abridged. */
  source: string;
  production: string;
}

const readLines = <T>(file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
const abridge = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n / 2)}\n[… ${s.length - n} chars …]\n${s.slice(-n / 2)}`);

// ---------------------------------------------------------------------------------------------
// sample

function sample() {
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  const samples: Sample[] = [];
  const reuse = rest[0] ? readLines<Sample>(rest[0]) : null;
  // A fixed seed: the same sample on every run.
  let seed = 572;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (const scope of reuse ? [...new Set(reuse.map((s) => s.scope))] : SCOPES) {
    const log = db.prepare(`SELECT i, kind, text FROM log WHERE scope = ? ORDER BY i`).all(scope) as { i: number; kind: MemoryKind; text: string }[];
    const rows = db.prepare(`SELECT l, i, text, how FROM nodes WHERE scope = ?`).all(scope) as { l: number; i: number; text: string; how: string }[];
    const nodes = new Map(rows.map((r) => [key(r.l, r.i), r.text]));
    const how = new Map(rows.map((r) => [key(r.l, r.i), r.how]));
    const N = log.length;
    // Recent work: a window of the scope's last built messages, where nearby calls share a prefix.
    let last = N - 1;
    while (last > 0 && !nodes.has(key(0, last))) last--;
    const from = Math.max(0, last - 600);
    const picked: NodeRef[] = reuse ? reuse.filter((s) => s.scope === scope).map((s) => s.node) : [];
    if (reuse) last = Math.max(last, ...picked.map((n) => (n[0] === 0 ? n[1] : end(n))));
    else {
      for (const [kind, count] of Object.entries(LEAVES) as [MemoryKind, number][]) {
        const pool = log.filter((m) => m.i >= (kind === "user" ? last - USER_WINDOW : from) && m.i <= last && m.kind === kind && how.get(key(0, m.i)) === "model");
        // Tool messages: some of the largest, the rest at random.
        const large = kind === "tool" ? [...pool].sort((a, b) => b.text.length - a.text.length).slice(0, 2) : [];
        const chosen = new Set(large.map((m) => m.i));
        while (chosen.size < Math.min(count, pool.length)) chosen.add(pool[Math.floor(rand() * pool.length)]!.i);
        picked.push(...[...chosen].map((i): NodeRef => [0, i]));
      }
      for (const l of MERGE_LEVELS) {
        const pool = rows.filter((r) => r.l === l && r.how === "model" && end([r.l, r.i]) <= last && end([r.l, r.i]) >= from - 2 ** l && !picked.some(([pl, pi]) => pl === l && pi === r.i));
        if (pool.length) {
          const r = pool[Math.floor(rand() * pool.length)]!;
          picked.push([r.l, r.i]);
        }
      }
    }
    // Each sample's context is the compaction view the builder would have had: every built line, less
    // the node's own line and its ancestors (not built yet when it is). An ancestor ends where the node
    // does or later, so it can only enter the view at the node's own step: one replay over every built
    // line serves all samples, each step forking the view and hiding that sample's ancestors alone.
    const byT = new Map<number, NodeRef[]>();
    for (const n of picked) {
      const T = n[0] === 0 ? n[1] + 1 : end(n) + 1;
      byT.set(T, [...(byT.get(T) ?? []), n]);
    }
    const views = emptyViews();
    for (let t = 0; t <= last; t++) {
      const due = byT.get(views.fed + 1) ?? [];
      for (const n of due) {
        const hidden = new Set<string>();
        for (let k = n[0], j = n[1]; k <= 20; k++, j = Math.floor(j / 2)) hidden.add(key(k, j));
        const without: Nodes = { has: (k) => !hidden.has(k) && nodes.has(k), get: (k) => (hidden.has(k) ? undefined : nodes.get(k)) };
        const fork = structuredClone(views);
        feed(fork, without);
        const message = n[0] === 0 ? log[n[1]]! : undefined;
        const covered = n[0] === 0 ? "" : log.slice(n[1] * 2 ** n[0], end(n) + 1).map((m) => `[${m.i}] ${messageText({ kind: m.kind, text: abridge(m.text, 400) })}`).join("\n");
        samples.push({
          id: `${scope.replace(/^initiatives:/, "")}#${label(n)}`,
          scope,
          node: n,
          label: label(n),
          kind: message ? message.kind : "merge",
          lines: contextLines(n, fork.compaction, without),
          task: task(n, nodes, message),
          source: message ? messageText(message) : abridge(covered, 10_000),
          production: nodes.get(key(...n)) ?? "",
        });
      }
      feed(views, nodes);
    }
    console.error(`${scope}: ${N} messages, window ${from}..${last}, ${picked.length} samples`);
  }
  db.close();
  samples.sort((a, b) => a.scope.localeCompare(b.scope) || (a.node[0] === 0 ? a.node[1] : end(a.node)) - (b.node[0] === 0 ? b.node[1] : end(b.node)));
  writeFileSync(SAMPLES, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  const kinds: Record<string, number> = {};
  for (const s of samples) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  console.log(JSON.stringify({ samples: samples.length, kinds, contextBytes: { p50: pct(samples.map((s) => bytes(s.lines.join("\n"))), 0.5) } }));
  if (!existsSync(`${out}/prompt-current.txt`)) writeFileSync(`${out}/prompt-current.txt`, COMPACTION_PROMPT);
}

// ---------------------------------------------------------------------------------------------
// run

interface Try {
  ms: number;
  bytes: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}
interface Result {
  id: string;
  arm: string;
  line: string;
  tries: Try[];
  cut: boolean;
  ms: number;
  error?: string;
  rateLimited: number;
  utilization?: string;
}

/** Luna calls wait until then after a 429. */
let pauseUntil = 0;

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const HAIKU = "claude-haiku-5-5";
const OPUS = "claude-opus-5-5";
/** List prices, $ per million tokens: input, cache read, 5-minute cache write, output. */
const CLAUDE_PRICES: Record<string, { input: number; cached: number; write: number; output: number }> = {
  [HAIKU]: { input: 0.1, cached: 0.01, write: 0.125, output: 0.5 },
  [OPUS]: { input: 4, cached: 0.4, write: 5, output: 20 },
};
const claudeCost = (model: string, t: Pick<Try, "input" | "cached" | "cacheWrite" | "output">) => {
  const p = CLAUDE_PRICES[model]!;
  return (t.input * p.input + t.cached * p.cached + t.cacheWrite * p.write + t.output * p.output) / 1e6;
};

type Content = { type: string; text?: string; [k: string]: unknown };
type Turn = { role: "user" | "assistant"; content: Content[] };

/** One Messages call through the Pooler's Claude route, retried on 429s; returns the reply and its usage.
 *  Each attempt, headers and body both, must finish within timeoutMs (Luna's calls get the same 120 s);
 *  a stalled attempt is aborted and retried like a reset connection. */
async function claudeCall(model: string, effort: string, system: string, messages: Turn[], maxTokens = 8192, timeoutMs = 120_000) {
  const base = process.env.ANTHROPIC_BASE_URL;
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!base || !token) throw new Error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are needed (the Pooler's Claude route).");
  const thinking = effort === "off" ? { type: "disabled" } : { type: "adaptive" };
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: IDENTITY }, { type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
    thinking,
    output_config: { effort: effort === "off" ? "high" : effort },
  };
  let rateLimited = 0;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    // A reset connection or a body cut short is a failed call, retried like a 5xx, never an exception.
    let res: Response;
    let json: any;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
          "user-agent": "claude-cli/2.1.316 (external, sdk-cli)",
          "x-app": "cli",
          "x-bb-purpose": "summarizer-bench",
          ...(process.env.BB_THREAD_ID ? { "x-bb-thread": process.env.BB_THREAD_ID } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        rateLimited += res.status === 429 ? 1 : 0;
        throw new Error(`${res.status} ${raw.slice(0, 200)}`);
      }
      // A 4xx is final: the same request would fail again.
      if (!res.ok) return { ok: false as const, error: `${res.status} ${raw.slice(0, 300)}`, rateLimited };
      json = JSON.parse(raw);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (attempt >= 4) return { ok: false as const, error, rateLimited };
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const ms = Date.now() - t0;
    const u = json.usage ?? {};
    const content = (json.content ?? []) as Content[];
    return {
      ok: true as const,
      content,
      text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
      ms,
      stop: json.stop_reason as string,
      usage: { input: u.input_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.thinking_tokens ?? 0 },
      utilization: res.headers.get("anthropic-ratelimit-unified-7d-utilization") ?? undefined,
      rateLimited,
    };
  }
}

/** The builder's input as one Claude user turn: the cached part of <chat> behind its own breakpoint. */
function claudeTurn(input: InputItem[]): Turn {
  const blocks = input.map((item, k): Content => ({ type: "text", text: item.content[0]!.text, ...(k === 0 && input.length > 1 ? { cache_control: { type: "ephemeral" } } : {}) }));
  return { role: "user", content: blocks };
}

async function runOne(s: Sample, arm: string, prompt: string, luna: ReturnType<typeof responsesSummarizer> | null): Promise<Result> {
  const [modelEffort] = arm.split(":");
  const parts = modelEffort!.split("-");
  const effort = parts.at(-1)!;
  const cli = parts.includes("cli") || parts.includes("clisys");
  const t0 = Date.now();
  const tries: Try[] = [];
  let rateLimited = 0;
  let utilization: string | undefined;
  let best: string | null = null;
  const input = compactionInput(s.lines, s.task);
  if (cli) {
    // clisys: the cached part of <chat> goes after the prompt in Claude Code's system prompt, which it caches.
    const inSystem = parts.includes("clisys") && input.length > 1;
    const r = inSystem ? await cliCall(`${prompt}\n\n${input[0]!.content[0]!.text}`, input[1]!.content[0]!.text, effort) : await cliCall(prompt, input.map((i) => i.content[0]!.text).join(""), effort);
    if (!r.ok) return { id: s.id, arm, line: "", tries, cut: false, ms: Date.now() - t0, error: r.error, rateLimited };
    const line = cleanLine(r.text);
    tries.push({ ms: r.ms, bytes: bytes(line), ...r.usage, reasoning: 0 });
    if (!line) return { id: s.id, arm, line: "", tries, cut: false, ms: Date.now() - t0, error: "empty reply", rateLimited };
    return { id: s.id, arm, line: capLine(line), tries, cut: bytes(line) > LIMIT, ms: Date.now() - t0, rateLimited, utilization: `wall ${r.wallMs} api ${r.apiMs}` };
  }
  let lunaInput = input;
  const turns: Turn[] = [claudeTurn(input)];
  for (let a = 0; a < 2; a++) {
    let text: string;
    if (luna) {
      while (Date.now() < pauseUntil) await new Promise((res) => setTimeout(res, pauseUntil - Date.now()));
      const r = await luna({ instructions: prompt, input: lunaInput, effort, cacheKey: cacheKey(`bench-${arm}-${s.scope}`), attribution: { initiative: null, thread: process.env.BB_THREAD_ID ?? null, purpose: "summarizer-bench" }, signal: new AbortController().signal, timeoutMs: 120_000 });
      if (!r.ok) {
        if (r.usage) tries.push({ ms: Date.now() - t0, bytes: 0, input: r.usage.input, cached: r.usage.cached, cacheWrite: 0, output: r.usage.output, reasoning: r.usage.reasoning });
        if (r.reason === "rate-limited") {
          // Production shares this route: after any 429 every call of the run pauses a minute or more.
          rateLimited++;
          pauseUntil = Math.max(pauseUntil, Date.now() + Math.max(60_000, r.retryAfterMs ?? 0));
          console.error(`429: pausing until ${new Date(pauseUntil).toISOString()}`);
          if (rateLimited <= 3) {
            a--;
            continue;
          }
        }
        if (best !== null) break;
        return { id: s.id, arm, line: "", tries, cut: false, ms: Date.now() - t0, error: `${r.reason}: ${r.error.slice(0, 200)}`, rateLimited };
      }
      text = r.text;
      tries.push({ ms: r.latencyMs, bytes: bytes(cleanLine(text)), input: r.usage.input, cached: r.usage.cached, cacheWrite: 0, output: r.usage.output, reasoning: r.usage.reasoning });
    } else {
      const r = await claudeCall(HAIKU, effort, prompt, turns);
      rateLimited += r.rateLimited;
      if (!r.ok) {
        if (best !== null) break;
        return { id: s.id, arm, line: "", tries, cut: false, ms: Date.now() - t0, error: r.error, rateLimited };
      }
      text = r.text;
      utilization = r.utilization;
      tries.push({ ms: r.ms, bytes: bytes(cleanLine(text)), ...r.usage });
      turns.push({ role: "assistant", content: r.content }, { role: "user", content: [{ type: "text", text: tooLong(cleanLine(text)) }] });
    }
    const line = cleanLine(text);
    if (!line) {
      if (best !== null) break;
      return { id: s.id, arm, line: "", tries, cut: false, ms: Date.now() - t0, error: "empty reply", rateLimited };
    }
    if (best === null || bytes(line) < bytes(best)) best = line;
    if (bytes(line) <= LIMIT) break;
    lunaInput = [...lunaInput, { role: "assistant", content: [{ type: "output_text", text }] }, { role: "user", content: [{ type: "input_text", text: tooLong(line) }] }];
  }
  // As the builder does: a failed or empty retry keeps the shortest line so far, cut to fit.
  return { id: s.id, arm, line: capLine(best!), tries, cut: bytes(best!) > LIMIT, ms: Date.now() - t0, rateLimited, utilization };
}

/** One `claude -p` call: a fresh process with only our system prompt, no tools, settings, MCP or session file.
 *  A process still running after timeoutMs is killed, with its process group, and counts as a failed call. */
function cliCall(system: string, prompt: string, effort: string, timeoutMs = 120_000) {
  return new Promise<{ ok: true; text: string; ms: number; wallMs: number; apiMs: number; usage: { input: number; cached: number; cacheWrite: number; output: number } } | { ok: false; error: string }>((resolve) => {
    const t0 = Date.now();
    const cwd = `${out}/cli-cwd`;
    mkdirSync(cwd, { recursive: true });
    const child = spawn("claude", ["-p", "--model", HAIKU, "--system-prompt", system, "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", "--effort", effort, "--output-format", "json"], { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // The child leads its own process group, so a deadline kills it with every helper it started; a helper
    // that inherited stdout or stderr would otherwise hold "close" back forever. The deadline settles at once.
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {} // already gone
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      killGroup();
      settle({ ok: false, error: `killed (SIGKILL) after ${Date.now() - t0} ms` });
    }, timeoutMs);
    // Settle once: a missing executable emits "error" (maybe without "close"), and a process that exits
    // before reading its input makes stdin emit EPIPE; either would otherwise crash the whole run.
    const settle = (r: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", (e) => {
      killGroup();
      settle({ ok: false, error: `spawn: ${e.message}` });
    });
    child.stdin.on("error", () => {}); // EPIPE: the exit code and output below tell what happened
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(prompt);
    child.on("close", (code, signal) => {
      const wallMs = Date.now() - t0;
      if (signal) return settle({ ok: false, error: `killed (${signal}) after ${wallMs} ms` });
      let d: any;
      try {
        d = JSON.parse(stdout);
      } catch {
        d = null;
      }
      if (code !== 0 || !d || d.type !== "result" || d.is_error || typeof d.result !== "string") settle({ ok: false, error: `exit ${code}: ${(stderr || stdout).slice(0, 300)}` });
      else {
        const u = d.usage ?? {};
        settle({ ok: true, text: d.result, ms: wallMs, wallMs, apiMs: d.duration_api_ms ?? 0, usage: { input: u.input_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 } });
      }
    });
  });
}

async function run() {
  const [arm, limitArg] = rest;
  if (!arm) throw new Error("run <out-dir> <arm> [limit]");
  const promptName = arm.split(":")[1] ?? "current";
  const prompt = readFileSync(`${out}/prompt-${promptName}.txt`, "utf8");
  const file = `${out}/results-${arm}.jsonl`;
  const done = new Set(readLines<Result>(file).filter((r) => !r.error).map((r) => r.id));
  const samples = readLines<Sample>(SAMPLES).slice(0, limitArg ? Number(limitArg) : undefined).filter((s) => !done.has(s.id));
  let luna: ReturnType<typeof responsesSummarizer> | null = null;
  if (arm.startsWith("luna")) {
    const base = process.env.ANTHROPIC_BASE_URL;
    const pluginToken = execFileSync("bb", ["plugin", "token", "account-pool-local"], { encoding: "utf8" }).trim();
    luna = responsesSummarizer({ fetch: (...args) => fetch(...args), url: () => `${base}/advisor/v1/responses`, headers: async () => ({ "x-bb-plugin-token": pluginToken }) });
  }
  const concurrency = Number(process.env.CONCURRENCY ?? 8);
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < samples.length) {
        const s = samples[next++]!;
        const r = await runOne(s, arm, prompt, luna);
        appendFileSync(file, JSON.stringify(r) + "\n");
        console.error(`${arm} ${s.id}: ${r.error ?? `${bytes(r.line)} B in ${r.tries.length} tries, ${r.ms} ms`}`);
      }
    }),
  );
  console.error(`${arm}: ${samples.length} samples in ${Math.round((Date.now() - t0) / 1000)} s`);
}

// ---------------------------------------------------------------------------------------------
// judge

const JUDGE = `You judge one-line summaries written for an AI agent's long-term memory. Each line stands in for
its input for weeks; what it omits is lost for good. The writers were told, in order of value:
1. The user's words matter most: orders, decisions, corrections, questions and reasons, kept close to verbatim.
2. Then anything with lasting effect, and what failed and why.
3. Then findings, open questions and the agent's replies.
4. Least of all, tool steps: what was run on what, and its outcome (ids, SHAs, counts, pass or fail).
Also: name minor items in a word or two rather than drop them; copy names, numbers, ids, paths and errors
exactly; tag each item with its kind (user:, agent:, tool:, echo:, work:, note:) and credit quoted text to
its real author; never make anything look further along than it was (a plan or attempt written as done);
never add what the input lacks. All lines had the same byte budget (about 512 bytes).

You get the input (a message, or two adjacent lines to merge plus the messages they cover), the <chat>
the writers saw before it (older memory lines), and several candidate lines labelled with letters. Judge
them against the input. The writers could use <chat> to make a reference clear (who W12 is, what a file is
for): a detail taken from <chat> is not invented; one found in neither the input nor <chat> is. Reply with JSON only:
{"ranking": [["B"], ["A","C"], ...] best first, equal lines grouped,
 "defects": {"A": ["short defect", ...], ...},
 "notes": "one sentence on what separated them"}
Defects: name concrete problems (missing user words, wrong or missing tag, wrong author, id altered or
dropped, overstated progress, invented content, important item dropped, noise kept over signal).`;

async function judge() {
  const arms = rest;
  if (arms.length < 2) throw new Error("judge <out-dir> <arm> <arm> ...");
  const file = `${out}/judge-${arms.join("+")}.jsonl`;
  const done = new Set(readLines<{ id: string }>(file).map((r) => r.id));
  const results = new Map(arms.map((arm) => [arm, new Map(readLines<Result>(`${out}/results-${arm}.jsonl`).filter((r) => r.line).map((r) => [r.id, r]))]));
  // Each sample shows the arms that have a line for it: at least two.
  const samples = readLines<Sample>(SAMPLES).filter((s) => !done.has(s.id) && arms.filter((a) => results.get(a)!.has(s.id)).length >= 2);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let next = 0;
  await Promise.all(
    Array.from({ length: Number(process.env.CONCURRENCY ?? 6) }, async () => {
      while (next < samples.length) {
        const s = samples[next++]!;
        const order = arms.filter((a) => results.get(a)!.has(s.id)).sort(() => rand() - 0.5);
        const letters = order.map((_, k) => String.fromCharCode(65 + k));
        const candidates = order.map((arm, k) => `${letters[k]}: ${results.get(arm)!.get(s.id)!.line}`).join("\n\n");
        // A leaf's source is the whole message the writers had; a merge's adds what its two lines cover.
        const what = s.kind === "merge" ? `Merge of two lines:\n${s.task.split("<input>\n")[1]?.replace("</input>", "")}\nThe messages they cover (abridged):\n${s.source}` : `Message:\n${s.source}`;
        const chat = s.lines.map((line) => `${line}\n`).join("");
        const text = `<chat>\n${chat}</chat>\n\n<input>\n${what}\n</input>\n\n<candidates>\n${candidates}\n</candidates>`;
        const r = await claudeCall(OPUS, "high", JUDGE, [{ role: "user", content: [{ type: "text", text }] }], 16_000, 300_000);
        if (!r.ok) {
          console.error(`judge ${s.id}: ${r.error}`);
          continue;
        }
        const json = r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1);
        let verdict: { ranking: string[][]; defects: Record<string, string[]>; notes: string };
        try {
          verdict = JSON.parse(json);
        } catch {
          console.error(`judge ${s.id}: unparsable reply`);
          continue;
        }
        const byArm = (letter: string) => order[letters.indexOf(letter)]!;
        const rank: Record<string, number> = {};
        verdict.ranking.forEach((group, k) => group.forEach((letter) => (rank[byArm(letter)] = k)));
        const defects = Object.fromEntries(Object.entries(verdict.defects ?? {}).map(([letter, list]) => [byArm(letter), list]));
        appendFileSync(file, JSON.stringify({ id: s.id, kind: s.kind, order, rank, defects, notes: verdict.notes, usage: r.usage, cost: claudeCost(OPUS, r.usage) }) + "\n");
        console.error(`judge ${s.id}: ${JSON.stringify(rank)}`);
      }
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// report

function report() {
  const samples = new Map(readLines<Sample>(SAMPLES).map((s) => [s.id, s]));
  const table: Record<string, unknown>[] = [];
  for (const arm of rest) {
    const all = readLines<Result>(`${out}/results-${arm}.jsonl`);
    // The last result per sample (a rerun after an error replaces it).
    const results = [...new Map(all.map((r) => [r.id, r])).values()];
    const ok = results.filter((r) => !r.error);
    const tries = ok.flatMap((r) => r.tries);
    const model = arm.startsWith("luna") ? "luna" : HAIKU;
    const sum = (f: (t: Try) => number) => tries.reduce((s, t) => s + f(t), 0);
    // Cost counts every paid attempt, including failed results and the runs a rerun replaced.
    const paid = all.flatMap((r) => r.tries);
    const cost = model === "luna" ? paid.reduce((s, t) => s + usageCost({ input: t.input, cached: t.cached, output: t.output, reasoning: t.reasoning }), 0) : paid.reduce((s, t) => s + claudeCost(HAIKU, t), 0);
    // Claude reports input, cache reads and cache writes apart; Luna's input includes its cached part.
    const inputTotal = model === "luna" ? sum((t) => t.input) : sum((t) => t.input + t.cached + t.cacheWrite);
    const cached = sum((t) => t.cached);
    const firstMs = ok.map((r) => r.tries[0]!.ms);
    table.push({
      arm,
      samples: results.length,
      errors: results.length - ok.length,
      rateLimited: results.reduce((s, r) => s + r.rateLimited, 0),
      calls: tries.length,
      paidCalls: paid.length,
      callsPerLine: Math.round((100 * tries.length) / Math.max(1, ok.length)) / 100,
      firstTryFit: `${Math.round((100 * ok.filter((r) => r.tries[0]!.bytes <= LIMIT).length) / Math.max(1, ok.length))}%`,
      firstBytesP50: pct(ok.map((r) => r.tries[0]!.bytes), 0.5),
      cut: ok.filter((r) => r.cut).length,
      lineBytesP50: pct(ok.map((r) => bytes(r.line)), 0.5),
      callMsP50: pct(tries.map((t) => t.ms), 0.5),
      callMsP90: pct(tries.map((t) => t.ms), 0.9),
      firstMsP50: pct(firstMs, 0.5),
      lineMsP50: pct(ok.map((r) => r.ms), 0.5),
      lineMsP90: pct(ok.map((r) => r.ms), 0.9),
      leafMsP50: pct(ok.filter((r) => samples.get(r.id)?.kind !== "merge").map((r) => r.ms), 0.5),
      mergeMsP50: pct(ok.filter((r) => samples.get(r.id)?.kind === "merge").map((r) => r.ms), 0.5),
      cachedShare: `${Math.round((1000 * cached) / Math.max(1, inputTotal)) / 10}%`,
      cacheWriteTokens: sum((t) => t.cacheWrite),
      inputTokensPerCall: Math.round(inputTotal / Math.max(1, tries.length)),
      outputTokensPerCall: Math.round(sum((t) => t.output) / Math.max(1, tries.length)),
      reasoningPerCall: Math.round(sum((t) => t.reasoning) / Math.max(1, tries.length)),
      costPer1000Lines: Math.round((1000 * cost * 1000) / Math.max(1, ok.length)) / 1000,
      utilization: [...new Set(ok.map((r) => r.utilization).filter(Boolean))].slice(0, 4),
    });
  }
  console.log(JSON.stringify(table, null, 1));
}

if (command === "sample") sample();
else if (command === "run") await run();
else if (command === "judge") await judge();
else if (command === "report") report();
else throw new Error(`unknown command ${command}`);
