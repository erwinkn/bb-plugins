// Event-loop benchmark of the Pooler's request path. Sends a burst of concurrent Claude Code
// sized /v1/messages requests through the real plugin (fake BB host, fake Anthropic upstream that
// streams SSE) and reports the event-loop delay and GC pauses while they run.
//
//   npx tsx scripts/bench-request-path.ts [--count 20] [--min-mb 3] [--max-mb 8] [--rewrite]
//   npx tsx scripts/bench-request-path.ts --stages
//
// --rewrite makes metadata.user_id name another account than the pool's, so every request takes
// the account rewrite path. --stages instead times each synchronous step of one request on 1, 4
// and 8 MB bodies. Nothing here reaches the network.
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PerformanceObserver,
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";
import { parseArgs } from "node:util";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  bodyHash,
  createUsageTap,
  describeClaudeRequest,
  keepAliveBody,
} from "../src/cache-usage.js";
import { StringCheck } from "../src/json-scan.js";
import { parseRequestBody } from "../src/request-body.js";
import { createAccountPoolPlugin } from "../src/server.js";
import { claudeCodeBody } from "../src/testing/claude-body.js";

const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "20" },
    "min-mb": { type: "string", default: "3" },
    "max-mb": { type: "string", default: "8" },
    rewrite: { type: "boolean", default: false },
    rounds: { type: "string", default: "3" },
    stages: { type: "boolean", default: false },
  },
});
const COUNT = Number(args.count);
const MIN_MB = Number(args["min-mb"]);
const MAX_MB = Number(args["max-mb"]);
const ROUNDS = Number(args.rounds);
const POOL_UUID = "11111111-1111-4111-8111-111111111111";
const CLIENT_UUID = args.rewrite
  ? "22222222-2222-4222-8222-222222222222"
  : POOL_UUID;
const CHUNK = 64 * 1024;
const UPSTREAM = "https://upstream.example";

// Anthropic: streams 1-3 s of SSE, so the burst's responses do not all end on the same tick.
// The request body is not read: undici writes it to a socket without blocking the loop.
const upstreamFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("data:")) return Response.json({});
  if (url.includes("/oauth/")) return Response.json({});
  const events = 50 + Math.floor(Math.random() * 100);
  const encoder = new TextEncoder();
  const start = {
    type: "message_start",
    message: {
      id: "msg",
      model: "claude-opus-4-1",
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 800_000,
        cache_creation_input_tokens: 2_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 2_000,
        },
        output_tokens: 1,
      },
    },
  };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 0)
        controller.enqueue(
          encoder.encode(
            `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
          ),
        );
      else if (sent <= events) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(
          encoder.encode(
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"token ${sent} "}}\n\n`,
          ),
        );
      } else {
        controller.enqueue(
          encoder.encode(
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":100}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        );
        controller.close();
      }
      sent += 1;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "anthropic-ratelimit-unified-5h-utilization": "0.10",
      "anthropic-ratelimit-unified-5h-status": "allowed",
    },
  });
};

const coordinator = {
  initiativeId: "prj_1",
  initiativeName: "bench",
  archived: false,
  paused: false,
  coordinator: { threadId: "thr_0", generation: 1 },
  kind: "coordinator",
  role: "coordinator",
  worker: null,
  generation: 1,
  currentGeneration: 1,
  state: "active",
  former: false,
  retired: false,
  stopped: false,
  parent: null,
  assignment: null,
  next: null,
};

function sessionOf(index: number): string {
  return `6f1d3c1e-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-bench-"));
  const host = createFakePluginHost({
    pluginId: "account-pool-local",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool-local", enabled: true }],
        }),
        token: async () => ({ token: "projects-token" }),
      },
      threads: {
        context: async ({ threadId }: { threadId: string }) => ({
          usage: {
            snapshot: {
              providerSessionId: sessionOf(Number(threadId.slice(4))),
            },
          },
        }),
      },
    } as never,
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: UPSTREAM,
    codexUpstreamBaseUrl: UPSTREAM,
  });
  await host.bb.storage.kv.set("warming-config", {
    mode: "warm",
    coordinatorMinutes: 20,
    maxLeaseBodyKiB: 16_384,
  });
  await createAccountPoolPlugin({
    fetch: upstreamFetch,
    usageUrl: "data:application/json,{}",
    refreshUrl: `${UPSTREAM}/oauth/token`,
    projectsFetch: async (input) => {
      const threadId = new URL(String(input)).searchParams.get("threadId");
      return Response.json({
        version: 1,
        threadId,
        observedAt: 1,
        membership: coordinator,
      });
    },
    importCredentials: async () => ({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 24 * 3_600_000,
      subscriptionType: "max",
      rateLimitTier: "max_5x",
      email: "pool@example.com",
      accountUuid: POOL_UUID,
    }),
  })(host.bb);
  await host.harness.behavior.callRpc("account.add", {
    provider: "claude",
    source: { kind: "import" },
    label: "bench",
    priority: 100,
  });
  const service = host.harness.behavior.runService("hub");
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    { threadId: "thr_0", projectId: "p", hostId: "host-one" },
  );
  const token = entries.find(
    (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
  )?.value as string;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await host.harness.behavior.runCli(["status", "--json"]);
    if (JSON.parse(status.stdout).accepting === true) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Every thread is linked to its session, so completions are admitted as warming leases.
  for (let index = 0; index < COUNT; index += 1)
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: { id: `thr_${index}`, providerId: "claude-code" } as never,
      lastAssistantText: null,
    });

  const bodies = Array.from({ length: COUNT }, (_, index) =>
    claudeCodeBody({
      bytes: (MIN_MB + ((MAX_MB - MIN_MB) * index) / Math.max(1, COUNT - 1)) * 1e6,
      sessionId: sessionOf(index),
      accountUuid: CLIENT_UUID,
      seed: index,
    }),
  );
  const totalMb = bodies.reduce((sum, body) => sum + body.byteLength, 0) / 1e6;

  const send = async (body: Uint8Array) => {
    let offset = 0;
    // Each chunk arrives on its own event-loop turn, as from a socket.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setImmediate(resolve));
        if (offset >= body.byteLength) return controller.close();
        controller.enqueue(body.subarray(offset, offset + CHUNK));
        offset += CHUNK;
      },
    });
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          "anthropic-version": "2023-06-01",
        },
        body: stream,
        duplex: "half",
      } as RequestInit,
    );
    const text = await response.text();
    if (response.status !== 200 || !text.includes("message_stop"))
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  };

  console.log(
    `${COUNT} concurrent requests, ${MIN_MB}-${MAX_MB} MB (${totalMb.toFixed(0)} MB total), account rewrite ${args.rewrite ? "on" : "off"}, ${ROUNDS} rounds`,
  );
  const results: Array<Record<string, number>> = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const gcs: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) gcs.push(entry.duration);
    });
    observer.observe({ entryTypes: ["gc"] });
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    // A 1 ms ticker sees every gap, however short the burst.
    let last = performance.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    histogram.enable();
    const started = performance.now();
    await Promise.all(bodies.map(send));
    // The ledger and the warmer finish their work on later turns.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const elapsed = performance.now() - started;
    histogram.disable();
    clearInterval(ticker);
    observer.disconnect();
    const row = {
      round: round + 1,
      wallMs: Math.round(elapsed),
      maxGapMs: Math.round(maxGap),
      maxDelayMs: Math.round(histogram.max / 1e6),
      p99DelayMs: Math.round(histogram.percentile(99) / 1e6),
      meanDelayMs: Number((histogram.mean / 1e6).toFixed(1)),
      gcCount: gcs.length,
      gcMaxMs: Math.round(Math.max(0, ...gcs)),
      gcTotalMs: Math.round(gcs.reduce((sum, value) => sum + value, 0)),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  service.controller.abort();
  await service.done;
  await host.harness.lifecycle.dispose();
  await fs.rm(dataDir, { recursive: true, force: true });
  const worst = (key: string) => Math.max(...results.map((row) => row[key]));
  console.log(
    `worst: max delay ${worst("maxGapMs")} ms, p99 ${worst("p99DelayMs")} ms, GC max ${worst("gcMaxMs")} ms`,
  );
}

// The median of a few runs of one synchronous step, in ms. Each run gets its own input from
// setup, untimed, so no run reuses what an earlier one cached.
function timed<T>(setup: () => T, run: (input: T) => unknown): number {
  run(setup());
  const times: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const input = setup();
    const started = performance.now();
    run(input);
    times.push(performance.now() - started);
  }
  return Number(times.sort((left, right) => left - right)[3].toFixed(2));
}

// What the hub does as a body arrives: its strings are checked 64 KiB at a time.
function arrive(body: Uint8Array): Uint8Array {
  const check = new StringCheck();
  for (let offset = 0; offset < body.byteLength; offset += CHUNK)
    check.push(body.subarray(offset, offset + CHUNK));
  check.finish(body);
  return body;
}

function stages() {
  const encoder = new TextEncoder();
  const sse = encoder.encode(
    Array.from(
      { length: 2_000 },
      (_, index) =>
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"token ${index} "}}\n\n`,
    ).join(""),
  );
  const uuid = "44444444-4444-4444-8444-444444444444";
  for (const mb of [1, 4, 8]) {
    const body = claudeCodeBody({ bytes: mb * 1e6, seed: mb });
    // A copy as the hub hands it on (checked on arrival), or one never checked.
    const arrived = () => arrive(body.slice());
    const unchecked = () => body.slice();
    const chunk = body.subarray(0, CHUNK);
    console.log(
      JSON.stringify({
        bodyMb: Number((body.byteLength / 1e6).toFixed(2)),
        // Per 64 KiB chunk, each on its own event-loop turn.
        arrivalCheckPerChunkMs: timed(
          () => new StringCheck(),
          (check) => check.push(chunk),
        ),
        parseMs: timed(arrived, (input) => parseRequestBody(input)),
        rewriteMs: timed(
          () => parseRequestBody(arrived()),
          (parsed) => parsed.forAccount(uuid),
        ),
        // At the end of the response. Includes the hash.
        describeMs: timed(
          () => parseRequestBody(arrived()).forAccount(uuid),
          (upstream) => describeClaudeRequest(upstream),
        ),
        hashMs: timed(unchecked, (input) => bodyHash(input)),
        keepAliveBodyMs: timed(
          () => parseRequestBody(arrived()).forAccount(uuid),
          (upstream) => keepAliveBody(upstream),
        ),
        // A body nobody checked on arrival pays the string check in its first walk.
        parseUncheckedMs: timed(unchecked, (input) => parseRequestBody(input)),
        sseTap2000EventsMs: timed(
          () => createUsageTap("text/event-stream"),
          (tap) => {
            for (let offset = 0; offset < sse.byteLength; offset += 1_024)
              tap.push(sse.subarray(offset, offset + 1_024));
            tap.usage();
          },
        ),
      }),
    );
  }
}

if (args.stages) stages();
else await main();
