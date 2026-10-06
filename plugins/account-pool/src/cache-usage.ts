import { createHash } from "node:crypto";
import type { ModelFamily } from "./contracts.js";
import { carryStringCheck, JsonBytes, type Span } from "./json-scan.js";
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

// The warmer and the usage ledger both describe the same upstream body; it is parsed once.
const shapes = new WeakMap<Uint8Array, ClaudeRequestShape>();

export function describeClaudeRequest(body: Uint8Array): ClaudeRequestShape {
  const known = shapes.get(body);
  if (known !== undefined) return known;
  const shape = describeOnce(body);
  shapes.set(body, shape);
  return shape;
}

const BLOCK_LISTS = new Set(["tools", "system", "messages"]);
// A longer string cannot equal any value describeOnce compares a field with.
const MAX_COMPARED_STRING_BYTES = 256;

// What describeOnce reads of a request, in one pass over its bytes (see json-scan.ts): model, and
// of every caller object it looks into only the member it compares (cache_control.ttl,
// thinking.type, tool_choice.type, whether output_config.format is set), with each tools, system
// and messages block reduced to its cache_control. Nothing else is decoded, however large (a
// prompt, an output schema). null when the body is not a JSON object. As with JSON.parse, a
// repeated key's last value wins.
function requestSkeleton(body: Uint8Array): JsonObject | null {
  const json = new JsonBytes(body);
  const request: JsonObject = {};
  // A string short enough to compare, parsed; anything else is false, which matches nothing.
  const comparable = (span: Span): unknown =>
    json.isString(span.start) &&
    span.end - span.start <= MAX_COMPARED_STRING_BYTES
      ? json.parse(span)
      : false;
  const presence = (span: Span): unknown =>
    json.isNull(span.start) ? null : true;
  // The object at `at` reduced to one member, as read returns it; a non-object becomes null.
  const reduce = (
    at: number,
    into: JsonObject,
    key: string,
    member: string,
    read: (span: Span) => unknown,
  ) => {
    if (!json.isObject(at)) {
      into[key] = null;
      return undefined;
    }
    const kept: JsonObject = {};
    into[key] = kept;
    return json.eachMember(at, (name, value) => {
      if (name !== member) return undefined;
      const span = json.span(value);
      if (span !== null) kept[member] = read(span);
      return span?.end ?? -1;
    });
  };
  const blocks = (at: number, out: unknown[]) =>
    json.eachElement(at, (block) => {
      if (!json.isObject(block)) {
        out.push(null);
        return undefined;
      }
      const kept: JsonObject = {};
      out.push(kept);
      return json.eachMember(block, (key, value) =>
        key === "cache_control"
          ? reduce(value, kept, key, "ttl", comparable)
          : undefined,
      );
    });
  const valid = json.eachTopLevelMember((key, value) => {
    if (BLOCK_LISTS.has(key)) {
      if (!json.isArray(value)) {
        request[key] = null;
        return undefined;
      }
      const out: unknown[] = [];
      request[key] = out;
      if (key !== "messages") return blocks(value, out);
      return json.eachElement(value, (message) => {
        if (!json.isObject(message)) {
          out.push(null);
          return undefined;
        }
        const kept: JsonObject = { content: null };
        out.push(kept);
        return json.eachMember(message, (field, at) => {
          if (field !== "content") return undefined;
          const content: unknown[] = [];
          kept.content = json.isArray(at) ? content : null;
          return json.isArray(at) ? blocks(at, content) : undefined;
        });
      });
    }
    if (key === "model") {
      const span = json.span(value);
      if (span !== null)
        request.model = json.isString(value) ? json.parse(span) : null;
      return span?.end ?? -1;
    }
    if (key === "cache_control")
      return reduce(value, request, key, "ttl", comparable);
    if (key === "thinking" || key === "tool_choice")
      return reduce(value, request, key, "type", comparable);
    if (key === "output_config")
      return reduce(value, request, key, "format", presence);
    return undefined;
  });
  return valid ? request : null;
}

function describeOnce(body: Uint8Array): ClaudeRequestShape {
  const hash = bodyHash(body);
  let request: JsonObject | null;
  try {
    request = requestSkeleton(body);
  } catch {
    request = null;
  }
  if (request === null)
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
// the cached prefix, so the re-send reads the same entry. Every other top-level member keeps its
// bytes; nothing is parsed or re-serialized, unless a number would not survive JSON.parse and
// JSON.stringify unchanged (1.0, 1e400): that rare body is re-serialized whole, as it always was.
export function keepAliveBody(body: Uint8Array): Uint8Array {
  const json = new JsonBytes(body);
  const parts: Uint8Array[] = [];
  let maxTokens = false;
  const valid = json.eachTopLevelMember((key, value, keyStart) => {
    const end = json.skip(value);
    if (end === -1 || key === "stream") return end;
    if (parts.length > 0) parts.push(COMMA);
    if (key === "max_tokens") {
      maxTokens = true;
      parts.push(body.subarray(keyStart, value), ZERO);
    } else parts.push(body.subarray(keyStart, end));
    return end;
  });
  if (!valid) throw new SyntaxError("request body is not a JSON object");
  if (!json.canonicalNumbers) {
    const { stream: _stream, ...rest } = JSON.parse(
      new TextDecoder().decode(body),
    ) as JsonObject;
    return new TextEncoder().encode(JSON.stringify({ ...rest, max_tokens: 0 }));
  }
  if (!maxTokens) {
    if (parts.length > 0) parts.push(COMMA);
    parts.push(MAX_TOKENS_ZERO);
  }
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 2),
  );
  out[0] = 0x7b;
  let offset = 1;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  out[offset] = 0x7d;
  carryStringCheck(body, out);
  return out;
}

const COMMA = new Uint8Array([0x2c]);
const ZERO = new Uint8Array([0x30]);
const MAX_TOKENS_ZERO = new TextEncoder().encode('"max_tokens":0');

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
  return jsonBodyTap((parsed) => cacheUsageFrom(parsed.usage));
}

// A non-streamed body, buffered up to 1 MiB and parsed once at the end.
function jsonBodyTap(read: (body: JsonObject) => CacheUsage | null): UsageTap {
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
        return isObject(parsed) ? read(parsed) : null;
      } catch {
        return null;
      }
    },
  };
}

// Codex (OpenAI Responses) usage in the same shape. input_tokens includes cached_tokens, so the
// uncached part becomes inputTokens and cached_tokens cacheReadTokens. OpenAI reports no cache
// writes: cacheWriteTokens is 0 and its TTL split unknown.
export function codexUsageFrom(value: unknown): CacheUsage | null {
  if (!isObject(value)) return null;
  const input = count(value.input_tokens);
  const details = isObject(value.input_tokens_details)
    ? value.input_tokens_details
    : null;
  const cached = count(details?.cached_tokens) ?? 0;
  if (input === null) return null;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: count(value.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
  };
}

// The usage of a Codex response as it streams: SSE carries it in the final response.completed
// (or response.incomplete) event, whose line holds the whole response, so only that line is kept,
// up to 4 MiB. A JSON body is parsed once at the end if it fits in 1 MiB.
const MAX_CODEX_EVENT_BYTES = 4 * 1024 * 1024;

export function createCodexUsageTap(contentType: string | null): UsageTap {
  const eventStream =
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
  if (!eventStream)
    return jsonBodyTap((parsed) => codexUsageFrom(parsed.usage));
  const decoder = new TextDecoder();
  let usage: CacheUsage | null = null;
  let line = "";
  let keeping: boolean | null = null;
  const readLine = (text: string) => {
    try {
      const event = JSON.parse(text.slice(5).trim()) as JsonObject;
      if (isObject(event.response))
        usage = codexUsageFrom(event.response.usage) ?? usage;
    } catch {}
  };
  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let index = text.indexOf("\n"); index >= 0; ) {
        if (keeping !== false) {
          const full = line + text.slice(start, index);
          if (isFinalCodexEvent(full)) readLine(full.trimEnd());
        }
        line = "";
        keeping = null;
        start = index + 1;
        index = text.indexOf("\n", start);
      }
      if (keeping === false) return;
      line += text.slice(start);
      // Decide once the line's event type is visible; drop every other line at once.
      if (keeping === null && line.length >= 48) {
        keeping = isFinalCodexEvent(line);
        if (!keeping) line = "";
      }
      if (line.length > MAX_CODEX_EVENT_BYTES) {
        line = "";
        keeping = false;
      }
    },
    usage: () => usage,
  };
}

function isFinalCodexEvent(line: string): boolean {
  return /^data:\s*\{"type":"response\.(completed|incomplete|failed)"/u.test(
    line,
  );
}

