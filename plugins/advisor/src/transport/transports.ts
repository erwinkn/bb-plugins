// Route -> transport. Each send is exactly one HTTP request, classified into
// the outcome classes of A154 §6.2–6.3. Nothing is retried or re-routed.

import type { AdvisorConfig } from "../config/settings.js";
import { ANTHROPIC_URL, OPENAI_URL, POOLER_PLUGIN_ID, ROUTES, TYPESAFE_URL, type RouteSpec } from "../config/routes.js";
import { type Deadlines, type SseRead, exchange, poolProvenance, vendorOutcome } from "./http.js";
import type { FetchLike, ReviewRequest, ReviewTransport, SendResult } from "./types.js";
import { LUNA_MODEL, SONNET_MODEL, lunaBody, parseJev, parseLunaJson, parseLunaSse, parseSonnet, sonnetBody, type WireParse } from "./wires.js";
import { fakeTransport, type FakeScript } from "./fake.js";
import type { ModelFinding } from "./output.js";
import { JEV_MODEL } from "../rules/jev.js";

export interface TransportDeps {
  fetch: FetchLike;
  /** BB's loopback base URL (bind-gated; read at send time). */
  loopbackBaseUrl: () => string;
  /** The Pooler's plugin token, fetched per review and held in memory only. */
  poolerToken: (signal: AbortSignal) => Promise<string>;
  secret: (key: "anthropicApiKey" | "openaiApiKey" | "typesafeApiKey") => Promise<string | undefined>;
  deadlines?: Deadlines;
  /** Test seam: a scripted fake reviewer. Production uses the deterministic fake. */
  fakeFindings?: FakeScript;
}

interface Post {
  route: RouteSpec;
  url: string;
  headers: Record<string, string>;
  body: string;
  pool: boolean;
  parse: (text: string) => WireParse;
  pinned: string;
  sse?: SseRead;
}

/** The Responses stream events the parser reads; deltas are dropped while streaming. */
const LUNA_KEEP = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);

async function post(deps: TransportDeps, p: Post, signal: AbortSignal): Promise<SendResult> {
  const ex = await exchange(deps.fetch, p.url, { method: "POST", headers: p.headers, body: p.body }, signal, deps.deadlines, p.sse);
  if (ex.kind === "not-sent") {
    // Aborted before fetch was called: nothing left this process.
    return { outcome: "pre-upstream", status: null, dispatched: "none", error: `canceled before the request: ${ex.reason}` };
  }
  if (ex.kind === "aborted-before-headers") {
    // The request may have reached the vendor before the abort: possibly executed.
    return { outcome: "ambiguous", status: null, dispatched: "unknown", error: `aborted before headers: ${ex.reason}` };
  }
  if (ex.kind === "failed-before-headers") {
    return { outcome: "ambiguous", status: null, dispatched: "unknown", error: `request failed before headers: ${ex.error}` };
  }
  if (ex.kind === "cut-after-headers") {
    const prov = p.pool ? poolProvenance(ex.status, ex.headers, "") : "sent";
    if (prov === "none") return { outcome: "pre-upstream", status: ex.status, dispatched: "none", error: ex.reason };
    return { outcome: "cut", status: ex.status, dispatched: prov === "sent" ? "sent" : "unknown", error: `cut after headers: ${ex.reason}` };
  }
  const brief = ex.text.slice(0, 300);
  if (p.pool) {
    const prov = poolProvenance(ex.status, ex.headers, ex.text);
    if (prov === "none" || prov === "bb-pre-handler") {
      return { outcome: "pre-upstream", status: ex.status, dispatched: "none", error: `refused before upstream (${ex.status}): ${brief}` };
    }
    if (prov === "unknown") {
      return { outcome: "ambiguous", status: ex.status, dispatched: "unknown", error: `unstamped ${ex.status}: ${brief}` };
    }
    if (ex.status === 499) return { outcome: "cut", status: 499, dispatched: "sent", error: "canceled after send" };
  }
  const v = vendorOutcome(ex.status);
  if (v !== "ok") return { outcome: v, status: ex.status, dispatched: "sent", error: `vendor ${ex.status}: ${brief}` };
  if (ex.truncated) return { outcome: "cut", status: ex.status, dispatched: "sent", error: ex.why ?? "response over the read cap" };
  const parsed = p.parse(ex.text);
  if (parsed.model !== p.pinned) {
    return { outcome: "cut", status: ex.status, dispatched: "sent", usage: parsed.usage, model: parsed.model, error: `model-mismatch: ${String(parsed.model)}` };
  }
  if (parsed.problem) {
    return { outcome: "cut", status: ex.status, dispatched: "sent", usage: parsed.usage, model: parsed.model, error: parsed.problem };
  }
  return { outcome: "completed", status: ex.status, dispatched: "sent", usage: parsed.usage, model: parsed.model, output: parsed.output };
}

/** A failure before any request was made: missing secret, Pooler token unavailable. */
function notSent(error: string): SendResult {
  return { outcome: "pre-upstream", status: null, dispatched: "none", error };
}

function poolUrl(deps: TransportDeps, path: string): string {
  return `${deps.loopbackBaseUrl()}/api/v1/plugins/${POOLER_PLUGIN_ID}/http/advisor/v1/${path}`;
}

async function poolHeaders(deps: TransportDeps, signal: AbortSignal, extra: Record<string, string>): Promise<Record<string, string> | string> {
  try {
    const token = await deps.poolerToken(signal);
    return { "content-type": "application/json", "x-bb-plugin-token": token, ...extra };
  } catch (err) {
    return `Account Pooler token unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function createTransport(config: AdvisorConfig, deps: TransportDeps): ReviewTransport {
  const route = ROUTES[config.route];
  switch (route.id) {
    case "fake":
      return fakeTransport(deps.fakeFindings);
    case "sonnet:pool":
    case "sonnet:anthropic-api": {
      const opts = { maxTokens: config.maxOutputTokens, effort: config.sonnetEffort, thinking: config.sonnetThinking };
      return {
        route,
        serialize: (system, packet) => JSON.stringify(sonnetBody(system, packet, opts)),
        async send(req: ReviewRequest, signal) {
          if (route.id === "sonnet:pool") {
            const headers = await poolHeaders(deps, signal, { "anthropic-version": "2023-06-01" });
            if (typeof headers === "string") return notSent(headers);
            return post(deps, { route, url: poolUrl(deps, "messages"), headers, body: req.body, pool: true, parse: parseSonnet, pinned: SONNET_MODEL }, signal);
          }
          const key = await deps.secret("anthropicApiKey");
          if (!key) return notSent("anthropicApiKey is not set");
          const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key };
          return post(deps, { route, url: ANTHROPIC_URL, headers, body: req.body, pool: false, parse: parseSonnet, pinned: SONNET_MODEL }, signal);
        },
      };
    }
    case "luna:pool":
    case "luna:openai-api": {
      const stream = route.id === "luna:pool";
      const opts = { maxOutputTokens: config.maxOutputTokens, effort: config.lunaEffort, stream };
      return {
        route,
        serialize: (system, packet) => JSON.stringify(lunaBody(system, packet, opts)),
        async send(req: ReviewRequest, signal) {
          if (stream) {
            const headers = await poolHeaders(deps, signal, { accept: "text/event-stream" });
            if (typeof headers === "string") return notSent(headers);
            const sse = { keep: LUNA_KEEP, totalCap: config.lunaStreamCap };
            return post(deps, { route, url: poolUrl(deps, "responses"), headers, body: req.body, pool: true, parse: parseLunaSse, pinned: LUNA_MODEL, sse }, signal);
          }
          const key = await deps.secret("openaiApiKey");
          if (!key) return notSent("openaiApiKey is not set");
          const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
          return post(deps, { route, url: OPENAI_URL, headers, body: req.body, pool: false, parse: parseLunaJson, pinned: LUNA_MODEL }, signal);
        },
      };
    }
    case "jev:typesafe":
      throw new Error("jev:typesafe uses the Jev transport, not the packet transport");
  }
}

export interface JevTransport {
  send(body: string, asked: string[], signal: AbortSignal): Promise<SendResult>;
}

export function createJevTransport(deps: TransportDeps): JevTransport {
  const route = ROUTES["jev:typesafe"];
  return {
    async send(body, asked, signal) {
      const key = await deps.secret("typesafeApiKey");
      if (!key) return notSent("typesafeApiKey is not set");
      const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
      return post(deps, { route, url: TYPESAFE_URL, headers, body, pool: false, parse: (t) => parseJev(t, asked), pinned: JEV_MODEL }, signal);
    },
  };
}
