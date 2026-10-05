// Transport contract (T76/A154 §6, A161 F2, A168), against fake fetch only.
// Nothing here reaches a network.

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config/settings.js";
import { exchange } from "../src/transport/http.js";
import { createJevTransport, createTransport, type TransportDeps } from "../src/transport/transports.js";
import { SONNET_BODY_KEYS, parseLunaSse, sonnetBody } from "../src/transport/wires.js";
import type { FetchLike } from "../src/transport/types.js";

type Call = { url: string; init: RequestInit };

function deps(respond: (call: Call) => Response | Promise<Response>, over: Partial<TransportDeps> = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond({ url, init });
  };
  const d: TransportDeps = {
    fetch,
    loopbackBaseUrl: () => "http://127.0.0.1:38886",
    poolerToken: async () => `tok-${++tokens}`,
    secret: async (k) => ({ anthropicApiKey: "sk-ant-test", openaiApiKey: "sk-oa-test", typesafeApiKey: "ts-test" })[k],
    ...over,
  };
  return { d, calls, tokens: () => tokens };
}

const cfg = (raw: Record<string, unknown>) => resolveConfig({ maxOutputTokens: 2000, ...raw }).config;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const SONNET_OK = {
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: JSON.stringify({ findings: [], resolved: [] }) }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 80 },
};
const req = { body: "{}", cards: [] };
const signal = () => new AbortController().signal;

describe("Anthropic Messages (sonnet)", () => {
  it("builds the allow-listed body: no tools, metadata, fallbacks, cache_control or inference_geo", () => {
    const b = sonnetBody("charter", "packet", { maxTokens: 2000, effort: "low", thinking: "adaptive" });
    expect(Object.keys(b).sort()).toEqual([...SONNET_BODY_KEYS].sort());
    const text = JSON.stringify(b);
    for (const banned of ["cache_control", "inference_geo", "tools", "fallbacks", "metadata", '"ttl"']) expect(text).not.toContain(banned);
    expect(b).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 2000, thinking: { type: "adaptive" }, output_config: { effort: "low" }, stream: false });
  });

  it("direct key: one POST with x-api-key and no OAuth beta; completed with usage", async () => {
    const { d, calls } = deps(() => json(SONNET_OK));
    const t = createTransport(cfg({ route: "sonnet:anthropic-api" }), d);
    const r = await t.send(req, signal());
    expect(r).toMatchObject({ outcome: "completed", dispatched: "sent", model: "claude-sonnet-5-5", usage: { input: 1200, output: 80 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-test" });
  });

  it("pool: token fetched per review, Pooler route, no identity headers of our own", async () => {
    const { d, calls, tokens } = deps(() => json(SONNET_OK, 200, { "x-account-pool-dispatch": "sent" }));
    const t = createTransport(cfg({ route: "sonnet:pool" }), d);
    await t.send(req, signal());
    await t.send(req, signal());
    expect(tokens()).toBe(2);
    expect(calls[0]!.url).toBe("http://127.0.0.1:38886/api/v1/plugins/account-pool-local/http/advisor/v1/messages");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json", "x-bb-plugin-token": "tok-1", "anthropic-version": "2023-06-01" });
  });

  it("model mismatch, refusal and truncation are cut (executed, unusable), never aliased", async () => {
    for (const [body, err] of [
      [{ ...SONNET_OK, model: "claude-opus-5-5" }, "model-mismatch: claude-opus-5-5"],
      [{ ...SONNET_OK, stop_reason: "refusal" }, "refusal"],
      [{ ...SONNET_OK, stop_reason: "max_tokens" }, "max_tokens reached"],
    ] as const) {
      const { d } = deps(() => json(body));
      const r = await createTransport(cfg({ route: "sonnet:anthropic-api" }), d).send(req, signal());
      expect([r.outcome, r.error]).toEqual(["cut", err]);
    }
  });
});

describe("one request, classified honestly (A154 §6.2-6.3)", () => {
  const cases: Array<[string, () => Response, string, string]> = [
    ["stamped none 403 (switch off)", () => json({ error: "off" }, 403, { "x-account-pool-dispatch": "none" }), "pre-upstream", "none"],
    ["stamped none 503 (credential not ready)", () => json({ error: "x" }, 503, { "x-account-pool-dispatch": "none" }), "pre-upstream", "none"],
    ["stamped none 415 (encoding)", () => json({ error: "x" }, 415, { "x-account-pool-dispatch": "none" }), "pre-upstream", "none"],
    ["stamped none 429 (no eligible account)", () => json({ error: "x" }, 429, { "x-account-pool-dispatch": "none" }), "pre-upstream", "none"],
    ["stamped none 499 (canceled before any vendor send)", () => json({ error: "x" }, 499, { "x-account-pool-dispatch": "none" }), "pre-upstream", "none"],
    ["stamped sent 503 (Pooler stopped after the vendor fetch began)", () => json({ error: "x" }, 503, { "x-account-pool-dispatch": "sent" }), "ambiguous", "sent"],
    ["stamped sent 401", () => json({ error: "x" }, 401, { "x-account-pool-dispatch": "sent" }), "rejected", "sent"],
    ["stamped sent 429", () => json({ error: "x" }, 429, { "x-account-pool-dispatch": "sent" }), "rejected", "sent"],
    ["stamped sent 529", () => json({ error: "x" }, 529, { "x-account-pool-dispatch": "sent" }), "ambiguous", "sent"],
    ["stamped sent 502", () => json({ error: "x" }, 502, { "x-account-pool-dispatch": "sent" }), "ambiguous", "sent"],
    ["stamped sent 499", () => json({ error: "x" }, 499, { "x-account-pool-dispatch": "sent" }), "cut", "sent"],
    ["unstamped BB 401 token", () => json({ ok: false, error: "missing or invalid plugin token" }, 401), "pre-upstream", "none"],
    ["unstamped BB 404 no route", () => json({ ok: false, error: 'plugin "account-pool-local" has no POST route for "/advisor/v1/messages"' }, 404), "pre-upstream", "none"],
    ["unstamped BB 503 not running", () => json({ ok: false, error: 'plugin "account-pool-local" is not running (status: error)' }, 503), "pre-upstream", "none"],
    ["unstamped BB 500 after the handler", () => json({ ok: false, error: "plugin route failed: boom" }, 500), "ambiguous", "unknown"],
    ["unstamped look-alike 503", () => json({ ok: false, error: "something else" }, 503), "ambiguous", "unknown"],
  ];
  for (const [name, respond, outcome, dispatched] of cases) {
    it(`pool: ${name} → ${outcome}`, async () => {
      const { d, calls } = deps(respond);
      const r = await createTransport(cfg({ route: "sonnet:pool" }), d).send(req, signal());
      expect([r.outcome, r.dispatched]).toEqual([outcome, dispatched]);
      expect(calls).toHaveLength(1); // never a second request, whatever the status
    });
  }
  it("direct: vendor 429 is rejected, 529 ambiguous, a reset before headers ambiguous; one call each", async () => {
    for (const [respond, outcome] of [
      [() => json({}, 429), "rejected"],
      [() => json({}, 529), "ambiguous"],
      [() => Promise.reject(new TypeError("socket hang up")), "ambiguous"],
    ] as const) {
      const { d, calls } = deps(respond as () => Response);
      const r = await createTransport(cfg({ route: "luna:openai-api" }), d).send(req, signal());
      expect(r.outcome).toBe(outcome);
      expect(calls).toHaveLength(1);
    }
  });
  it("a missing secret or Pooler token makes no request (pre-upstream)", async () => {
    const a = deps(() => json(SONNET_OK), { secret: async () => undefined });
    expect((await createTransport(cfg({ route: "sonnet:anthropic-api" }), a.d).send(req, signal())).outcome).toBe("pre-upstream");
    expect(a.calls).toHaveLength(0);
    const b = deps(() => json(SONNET_OK), { poolerToken: async () => Promise.reject(Object.assign(new Error("plugin not installed"), { status: 404 })) });
    const rb = await createTransport(cfg({ route: "sonnet:pool" }), b.d).send(req, signal());
    expect([rb.outcome, b.calls.length]).toEqual(["pre-upstream", 0]);
  });
});

describe("OpenAI Responses (luna)", () => {
  const RESP = { model: "gpt-6-luna", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"findings":[],"resolved":[]}' }] }], usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } };
  it("direct key: store false, strict json_schema, exact model, bearer key", async () => {
    const { d, calls } = deps(() => json(RESP));
    const r = await createTransport(cfg({ route: "luna:openai-api", lunaEffort: "medium" }), d).send({ body: createTransport(cfg({ route: "luna:openai-api", lunaEffort: "medium" }), d).serialize("c", "p"), cards: [] }, signal());
    expect(r.outcome).toBe("completed");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: "gpt-6-luna", store: false, stream: false, reasoning: { effort: "medium" }, max_output_tokens: 2000, text: { format: { type: "json_schema", strict: true } } });
    for (const banned of ["tools", "previous_response_id", "prompt_cache_key"]) expect(body).not.toHaveProperty(banned);
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer sk-oa-test" });
  });
  it("pool SSE: model and usage come from response.completed; no completed event is cut", () => {
    const sse = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: RESP })}\n\n`;
    expect(parseLunaSse(sse)).toMatchObject({ model: "gpt-6-luna", usage: { input: 900, output: 40 }, output: { findings: [], resolved: [] } });
    expect(parseLunaSse('data: {"type":"response.output_text.delta"}\n\n')).toMatchObject({ problem: "stream ended without response.completed" });
  });
});

describe("TypeSafe System One (jev)", () => {
  it("pins jev-1.13.0, requires every asked answer as a noul in [0, 1]", async () => {
    const good = deps(() => json({ model: "jev-1.13.0", answers: { h0: { type: "noul", noul: 0.82 } }, usage: { input_tokens: 500, output_tokens: 0 } }));
    const r = await createJevTransport(good.d).send('{"model":"jev-1.13.0"}', ["h0"], signal());
    expect(r).toMatchObject({ outcome: "completed", output: { h0: 0.82 } });
    expect(good.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    const latest = deps(() => json({ model: "jev-latest", answers: { h0: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 0 } }));
    expect((await createJevTransport(latest.d).send("{}", ["h0"], signal())).error).toBe("model-mismatch: jev-latest");
    const missing = deps(() => json({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
    expect((await createJevTransport(missing.d).send("{}", ["h0"], signal())).outcome).toBe("cut");
  });
});

describe("bounded lifetime", () => {
  afterEach(() => vi.useRealTimers());
  it("lifetime_bounded", async () => {
    // A140 fixture: 30 s to headers, 90 s in total, Stop aborts in flight; late responses are ignored.
    vi.useFakeTimers();
    const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const stalled = exchange(hang, "u", {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_001);
    const slowBody: FetchLike = async (_u, init) =>
      new Response(new ReadableStream({ start(c) { init.signal!.addEventListener("abort", () => c.error(new Error("aborted"))); } }), { status: 200 });
    const slow = exchange(slowBody, "u", {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(90_001);
    const stop = new AbortController();
    const inflight = exchange(slowBody, "u", {}, stop.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    stop.abort("stop");
    const done = exchange(async () => json({ ok: 1 }), "u", {}, new AbortController().signal);
    const outcomes = await Promise.all([stalled, slow, inflight, done]);
    expect(outcomes.map((o) => [o.kind, "reason" in o ? o.reason : null])).toEqual([
      ["aborted-before-headers", "headers-deadline"],
      ["cut-after-headers", "total-deadline"],
      ["cut-after-headers", "stop"],
      ["response", null],
    ]);
  });
});
