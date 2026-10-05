import { createHash } from "node:crypto";
import type { ModelFamily } from "./contracts.js";
import { modelFamily } from "./quota.js";

// Anthropic prompt caching facts this module relies on (Anthropic's prompt-caching guide, as
// bundled with Claude Code 2.1.287):
// - A breakpoint is a `cache_control` object on a tools, system or messages block, or the
//   top-level automatic `cache_control`. Its `ttl` is "5m" (the default) or "1h".
// - An entry's lifetime is measured from the start of the request that writes or reads it, and a
//   read refreshes the timer at no extra cost.
// - Re-sending the previous request with `max_tokens: 0` and `stream` off refreshes the entry and
//   bills a cache read only: no output tokens. `max_tokens: 0` is rejected with `stream: true`,
//   `thinking.type: "enabled"`, `output_config.format`, or a forced `tool_choice`.

export type CacheTtl = "5m" | "1h";

export const CACHE_TTL_MS: Record<CacheTtl, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

export interface ClaudeRequestShape {
  model: string | null;
  family: ModelFamily;
  // TTL of the last breakpoint in render order (tools, system, messages, then the automatic
  // breakpoint). It governs the entry that covers the whole cached prefix. null: no breakpoint.
  tailTtl: CacheTtl | null;
  breakpoints: number;
  // Why a max_tokens: 0 re-send of this body would be rejected, or null.
  keepAliveBlocker: string | null;
  // First 12 hex digits of the exact body's SHA-256: an identity for status, never the content.
  bodyHash: string;
}

export interface CacheUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function breakpointTtl(value: unknown): CacheTtl | null {
  if (!isObject(value)) return null;
  return value.ttl === "1h" ? "1h" : "5m";
}

function blockBreakpoints(blocks: unknown, out: CacheTtl[]): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    const ttl = isObject(block) ? breakpointTtl(block.cache_control) : null;
    if (ttl !== null) out.push(ttl);
  }
}

export function bodyHash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

export function describeClaudeRequest(body: Uint8Array): ClaudeRequestShape {
  const hash = bodyHash(body);
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder().decode(body));
  } catch {
    request = null;
  }
  if (!isObject(request))
    return {
      model: null,
      family: "other",
      tailTtl: null,
      breakpoints: 0,
      keepAliveBlocker: "request body is not a JSON object",
      bodyHash: hash,
    };
  const model = typeof request.model === "string" ? request.model : null;
  const ttls: CacheTtl[] = [];
  blockBreakpoints(request.tools, ttls);
  blockBreakpoints(request.system, ttls);
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isObject(message)) blockBreakpoints(message.content, ttls);
    }
  }
  const automatic = breakpointTtl(request.cache_control);
  if (automatic !== null) ttls.push(automatic);
  const thinking = isObject(request.thinking) ? request.thinking.type : null;
  const toolChoice = isObject(request.tool_choice)
    ? request.tool_choice.type
    : null;
  const outputConfig = isObject(request.output_config)
    ? request.output_config
    : null;
  const keepAliveBlocker =
    ttls.length === 0
      ? "no cache breakpoint"
      : thinking === "enabled"
        ? "thinking.type enabled cannot be sent with max_tokens 0"
        : outputConfig?.format !== undefined && outputConfig.format !== null
          ? "output_config.format cannot be sent with max_tokens 0"
          : toolChoice === "tool" || toolChoice === "any"
            ? "a forced tool_choice cannot be sent with max_tokens 0"
            : null;
  return {
    model,
    family: modelFamily(model),
    tailTtl: ttls.at(-1) ?? null,
    breakpoints: ttls.length,
    keepAliveBlocker,
    bodyHash: hash,
  };
}

// The exact native body with only max_tokens set to 0 and stream removed. Neither field is part of
// the cached prefix, so the re-send reads the same entry.
export function keepAliveBody(body: Uint8Array): Uint8Array {
  const request = JSON.parse(new TextDecoder().decode(body)) as JsonObject;
  const { stream: _stream, ...rest } = request;
  return new TextEncoder().encode(JSON.stringify({ ...rest, max_tokens: 0 }));
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function cacheUsageFrom(value: unknown): CacheUsage | null {
  if (!isObject(value)) return null;
  const read = count(value.cache_read_input_tokens);
  const write = count(value.cache_creation_input_tokens);
  if (read === null && write === null) return null;
  const split = isObject(value.cache_creation) ? value.cache_creation : null;
  return {
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    cacheReadTokens: read ?? 0,
    cacheWriteTokens: write ?? 0,
    cacheWrite5mTokens: split ? count(split.ephemeral_5m_input_tokens) : null,
    cacheWrite1hTokens: split ? count(split.ephemeral_1h_input_tokens) : null,
  };
}

const MAX_SSE_LINE_BYTES = 64 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface UsageTap {
  push(chunk: Uint8Array): void;
  usage(): CacheUsage | null;
}

// Reads cache usage from a response body as it streams to the client, without changing it.
// SSE: the cache counts are in `message_start`; `message_delta` updates output tokens. Only lines
// that start with one of those two event payloads are parsed, and an oversized line is skipped.
// JSON: the body is parsed once at the end if it fits in 1 MiB.
export function createUsageTap(contentType: string | null): UsageTap {
  const eventStream =
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
  const decoder = new TextDecoder();
  let usage: CacheUsage | null = null;
  if (eventStream) {
    let line = "";
    let skipping = false;
    const readLine = (text: string) => {
      if (!text.startsWith("data:")) return;
      const payload = text.slice(5).trim();
      if (
        !payload.startsWith('{"type":"message_start"') &&
        !payload.startsWith('{"type":"message_delta"')
      )
        return;
      try {
        const event = JSON.parse(payload) as JsonObject;
        if (event.type === "message_start" && isObject(event.message))
          usage = cacheUsageFrom(event.message.usage);
        else if (event.type === "message_delta" && usage !== null) {
          const delta = isObject(event.usage) ? event.usage : null;
          const output = count(delta?.output_tokens);
          if (output !== null) usage = { ...usage, outputTokens: output };
        }
      } catch {}
    };
    return {
      push(chunk) {
        const text = decoder.decode(chunk, { stream: true });
        let start = 0;
        for (let index = text.indexOf("\n"); index >= 0; ) {
          if (!skipping) readLine((line + text.slice(start, index)).trimEnd());
          line = "";
          skipping = false;
          start = index + 1;
          index = text.indexOf("\n", start);
        }
        if (skipping) return;
        line += text.slice(start);
        if (line.length > MAX_SSE_LINE_BYTES) {
          line = "";
          skipping = true;
        }
      },
      usage: () => usage,
    };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    },
    usage() {
      if (overflow || chunks.length === 0) return null;
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
        return isObject(parsed) ? cacheUsageFrom(parsed.usage) : null;
      } catch {
        return null;
      }
    },
  };
}
