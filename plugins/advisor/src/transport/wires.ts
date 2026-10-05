// Request builders and response parsers per wire (A154 routes.json, A161 F2,
// A168). Raw fetch, no SDK: SDK clients retry on their own, and the reviewed
// contract is exactly one request per review.

import { FINDINGS_JSON_SCHEMA } from "./output.js";
import type { Usage } from "./types.js";

export const SONNET_MODEL = "claude-sonnet-5-5";
export const LUNA_MODEL = "gpt-6-luna";

// ------------------------------------------------------------------ Anthropic Messages

export interface SonnetOptions {
  maxTokens: number;
  effort: string;
  thinking: "adaptive" | "between_tools";
}

/**
 * The allow-listed Sonnet body. No tools, metadata, fallbacks, cache_control
 * (so no 1-hour cache writes) and no inference_geo: the reservation's
 * 5-minute-write price basis holds only without them (A168).
 */
export function sonnetBody(system: string, packet: string, o: SonnetOptions): Record<string, unknown> {
  return {
    model: SONNET_MODEL,
    max_tokens: o.maxTokens,
    system,
    messages: [{ role: "user", content: packet }],
    thinking: { type: o.thinking },
    output_config: { effort: o.effort, format: { type: "json_schema", schema: FINDINGS_JSON_SCHEMA } },
    stream: false,
  };
}

export const SONNET_BODY_KEYS = ["model", "max_tokens", "system", "messages", "thinking", "output_config", "stream"] as const;

export interface WireParse {
  model: string | null;
  output?: unknown;
  usage: Usage | null;
  /** Why an executed response is unusable (refusal, truncation, bad JSON). */
  problem?: string;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function parseSonnet(text: string): WireParse {
  let body: any;
  try {
    body = parseJson(text);
  } catch {
    return { model: null, usage: null, problem: "response is not JSON" };
  }
  const u = body?.usage;
  const usage: Usage | null =
    u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
      ? {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheWrite: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
          cacheRead: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
        }
      : null;
  const model = typeof body?.model === "string" ? body.model : null;
  if (body?.stop_reason === "refusal") return { model, usage, problem: "refusal" };
  if (body?.stop_reason === "max_tokens") return { model, usage, problem: "max_tokens reached" };
  const textOut = Array.isArray(body?.content)
    ? body.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("")
    : "";
  try {
    return { model, usage, output: parseJson(textOut) };
  } catch {
    return { model, usage, problem: "output text is not JSON" };
  }
}

// ------------------------------------------------------------------ OpenAI Responses

export interface LunaOptions {
  maxOutputTokens: number;
  effort: string;
  stream: boolean;
}

export function lunaBody(system: string, packet: string, o: LunaOptions): Record<string, unknown> {
  return {
    model: LUNA_MODEL,
    instructions: system,
    input: [{ role: "user", content: [{ type: "input_text", text: packet }] }],
    store: false,
    stream: o.stream,
    reasoning: { effort: o.effort },
    max_output_tokens: o.maxOutputTokens,
    text: { format: { type: "json_schema", name: "advisor_findings", strict: true, schema: FINDINGS_JSON_SCHEMA } },
  };
}

function parseResponseObject(r: any): WireParse {
  const u = r?.usage;
  const usage: Usage | null =
    u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
      ? { input: u.input_tokens, output: u.output_tokens, cacheRead: Number(u.input_tokens_details?.cached_tokens ?? 0) || 0 }
      : null;
  // Cached tokens are part of input_tokens on OpenAI; keep them out of the input count once.
  if (usage && usage.cacheRead) usage.input = Math.max(0, usage.input - usage.cacheRead);
  const model = typeof r?.model === "string" ? r.model : null;
  if (r?.status !== "completed") return { model, usage, problem: `response status ${String(r?.status)}` };
  const textOut = Array.isArray(r?.output)
    ? r.output
        .filter((o: any) => o?.type === "message")
        .flatMap((o: any) => (Array.isArray(o.content) ? o.content : []))
        .filter((c: any) => c?.type === "output_text")
        .map((c: any) => String(c.text ?? ""))
        .join("")
    : "";
  try {
    return { model, usage, output: JSON.parse(textOut) };
  } catch {
    return { model, usage, problem: "output text is not JSON" };
  }
}

export function parseLunaJson(text: string): WireParse {
  try {
    return parseResponseObject(JSON.parse(text));
  } catch {
    return { model: null, usage: null, problem: "response is not JSON" };
  }
}

/** Codex backend SSE: the model and usage live in `response.completed.response`. No completed event: cut. */
export function parseLunaSse(text: string): WireParse {
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev?.type === "response.completed") return parseResponseObject(ev.response);
  }
  return { model: null, usage: null, problem: "stream ended without response.completed" };
}

// ------------------------------------------------------------------ TypeSafe System One (Jev)

export function parseJev(text: string, asked: string[]): WireParse {
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return { model: null, usage: null, problem: "response is not JSON" };
  }
  const u = body?.usage;
  const usage: Usage | null =
    u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number" ? { input: u.input_tokens, output: u.output_tokens } : null;
  const model = typeof body?.model === "string" ? body.model : null;
  const answers: Record<string, number> = {};
  for (const id of asked) {
    const a = body?.answers?.[id];
    if (!a || a.type !== "noul" || typeof a.noul !== "number" || a.noul < 0 || a.noul > 1) {
      return { model, usage, problem: `answer ${id} missing or not a noul in [0, 1]` };
    }
    answers[id] = a.noul;
  }
  return { model, usage, output: answers };
}
