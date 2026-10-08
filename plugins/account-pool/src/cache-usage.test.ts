import { describe, expect, it } from "vitest";
import {
  cacheUsageFrom,
  createCodexUsageTap,
  createUsageTap,
  describeClaudeRequest,
  keepAliveBody,
} from "./cache-usage.js";

const encode = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );

describe("describeClaudeRequest", () => {
  it("reads breakpoints in render order and takes the last one's TTL", () => {
    const shape = describeClaudeRequest(
      encode({
        model: "claude-opus-5-5",
        tools: [{ name: "a", cache_control: { type: "ephemeral", ttl: "1h" } }],
        system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [
          { role: "user", content: "plain string content" },
          { role: "user", content: [{ type: "text", text: "t", cache_control: { type: "ephemeral" } }] },
        ],
      }),
    );
    expect(shape).toMatchObject({
      model: "claude-opus-5-5",
      family: "opus",
      tailTtl: "5m",
      breakpoints: 3,
      keepAliveBlocker: null,
    });
    expect(shape.bodyHash).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("reports why a body cannot be re-sent with max_tokens 0", () => {
    const base = {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "t", cache_control: { type: "ephemeral" } }] }],
    };
    expect(describeClaudeRequest(encode({ ...base, messages: [{ role: "user", content: "t" }] })).keepAliveBlocker).toBe("no cache breakpoint");
    expect(describeClaudeRequest(encode({ ...base, thinking: { type: "enabled", budget_tokens: 1024 } })).keepAliveBlocker).toContain("thinking.type enabled");
    expect(describeClaudeRequest(encode({ ...base, thinking: { type: "adaptive" } })).keepAliveBlocker).toBeNull();
    expect(describeClaudeRequest(encode({ ...base, tool_choice: { type: "tool", name: "x" } })).keepAliveBlocker).toContain("forced tool_choice");
    expect(describeClaudeRequest(encode({ ...base, tool_choice: { type: "auto" } })).keepAliveBlocker).toBeNull();
    expect(describeClaudeRequest(encode({ ...base, output_config: { effort: "high" } })).keepAliveBlocker).toBeNull();
    expect(describeClaudeRequest(encode({ ...base, output_config: { format: { type: "json_schema" } } })).keepAliveBlocker).toContain("output_config.format");
    expect(describeClaudeRequest(encode("not json")).keepAliveBlocker).toBe("request body is not a JSON object");
  });

  it("builds a keep-alive body that changes only max_tokens and stream", () => {
    const original = {
      model: "claude-opus-5-5",
      max_tokens: 64_000,
      stream: true,
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "t" }],
      metadata: { user_id: "u" },
    };
    const resent = JSON.parse(new TextDecoder().decode(keepAliveBody(encode(original)))) as Record<string, unknown>;
    const { stream: _stream, max_tokens: _max, ...rest } = original;
    expect(resent).toEqual({ ...rest, max_tokens: 0 });
    // Key order is unchanged apart from the removed stream field.
    expect(Object.keys(resent)).toEqual(
      Object.keys(original).filter((key) => key !== "stream"),
    );
  });
});

describe("usage taps", () => {
  const start = {
    type: "message_start",
    message: {
      id: "m",
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
        output_tokens: 1,
      },
    },
  };
  const stream =
    `event: message_start\r\ndata: ${JSON.stringify(start)}\r\n\r\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"message_start"}}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":42}}\n\n`;

  it("reads SSE usage across arbitrary chunk splits", () => {
    for (const size of [1, 3, 17, stream.length]) {
      const tap = createUsageTap("text/event-stream; charset=utf-8");
      const bytes = encode(stream);
      for (let offset = 0; offset < bytes.length; offset += size)
        tap.push(bytes.subarray(offset, offset + size));
      expect(tap.usage()).toEqual({
        inputTokens: 5,
        outputTokens: 42,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 200,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 200,
      });
    }
  });

  it("skips oversized SSE lines and reports unknown usage without message_start", () => {
    const tap = createUsageTap("text/event-stream");
    tap.push(encode(`data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":${"1".repeat(70_000)}}}}\n\n`));
    tap.push(encode(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n`));
    expect(tap.usage()).toBeNull();
  });

  it("reads JSON usage once the body ends, up to 1 MiB", () => {
    const tap = createUsageTap("application/json");
    const body = encode({ id: "m", content: [], usage: { input_tokens: 1, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 } });
    tap.push(body.subarray(0, 10));
    tap.push(body.subarray(10));
    expect(tap.usage()).toMatchObject({ cacheReadTokens: 9, cacheWriteTokens: 0, cacheWrite5mTokens: null });
    const large = createUsageTap("application/json");
    large.push(new Uint8Array(1024 * 1024 + 1));
    expect(large.usage()).toBeNull();
  });

  it("treats a usage object without cache counts as unknown", () => {
    expect(cacheUsageFrom({ input_tokens: 10, output_tokens: 2 })).toBeNull();
    expect(cacheUsageFrom({ cache_read_input_tokens: -1 })).toBeNull();
    expect(cacheUsageFrom({ cache_read_input_tokens: 4 })).toMatchObject({ cacheReadTokens: 4, cacheWriteTokens: 0 });
  });
});

describe("createCodexUsageTap", () => {
  // The ChatGPT Codex backend's stream as captured on 8 Oct 2026 (Codex CLI 0.160.1), content
  // replaced: no content-type header, an `event:` line per event, `type` first in every payload.
  const response = (status: string, usage: unknown) => ({
    id: "resp_1", object: "response", created_at: 1791458656, status, model: "gpt-6-astra",
    output: [], tools: [{ type: "namespace", name: "tools", description: "d".repeat(50_000), tools: [] }],
    prompt_cache_key: "019a", usage,
  });
  const event = (payload: { type: string } & Record<string, unknown>) =>
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const realUsage = {
    input_tokens: 35_774,
    input_tokens_details: { cached_tokens: 25_088, cache_write_tokens: 0 },
    output_tokens: 529,
    output_tokens_details: { reasoning_tokens: 294 },
    total_tokens: 36_303,
    attribution: { items: { at_1: { input_tokens: 5_624, cached_tokens: 5_624, cache_write_tokens: 0, output_tokens: 0 } } },
  };
  const stream =
    event({ type: "response.created", sequence_number: 0, safety_buffering: false, response: response("in_progress", null) }) +
    event({ type: "response.in_progress", sequence_number: 1, safety_buffering: false, response: response("in_progress", null) }) +
    event({ type: "keepalive" }) +
    event({ type: "response.output_text.delta", sequence_number: 4, item_id: "msg_1", output_index: 0, content_index: 0, delta: "y".repeat(200_000), logprobs: [], obfuscation: "x" }) +
    event({ type: "response.completed", sequence_number: 9, safety_buffering: false, response: response("completed", realUsage) });

  it("reads response.completed from a stream with no content-type, across any chunking", () => {
    const body = new TextEncoder().encode(stream);
    for (const size of [1, 7, 64, body.byteLength]) {
      const tap = createCodexUsageTap();
      for (let offset = 0; offset < body.byteLength; offset += size) tap.push(body.subarray(offset, offset + size));
      // Uncached input is input minus cached; output includes the reasoning tokens.
      expect(tap.usage()).toEqual({ inputTokens: 10_686, outputTokens: 529, cacheReadTokens: 25_088, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null });
    }
  });

  it("reads response.incomplete, and nothing from a stream without a final event", () => {
    const incomplete = createCodexUsageTap();
    incomplete.push(new TextEncoder().encode(event({ type: "response.incomplete", sequence_number: 3, response: response("incomplete", { input_tokens: 10, output_tokens: 2 }) })));
    expect(incomplete.usage()).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });
    const cut = createCodexUsageTap();
    cut.push(new TextEncoder().encode(stream.slice(0, stream.indexOf("event: response.completed"))));
    expect(cut.usage()).toBeNull();
  });

  it("skips a final event over 4 MiB however it is chunked, and reads the next one", () => {
    const sized = (size: number, usage: { input_tokens: number; output_tokens: number }) => {
      const line = event({ type: "response.completed", response: { usage, pad: "" } });
      return event({ type: "response.completed", response: { usage, pad: "p".repeat(size - line.length) } });
    };
    const MiB = 1024 * 1024;
    const atCap = sized(4 * MiB, { input_tokens: 7, output_tokens: 1 });
    const overCap = sized(4 * MiB + 64, { input_tokens: 99, output_tokens: 9 });
    for (const [body, input] of [
      [atCap, 7],
      [overCap, null],
      [overCap + atCap, 7],
    ] as const) {
      const bytes = new TextEncoder().encode(body);
      for (const size of [64 * 1024, bytes.byteLength]) {
        const tap = createCodexUsageTap();
        for (let offset = 0; offset < bytes.byteLength; offset += size) tap.push(bytes.subarray(offset, offset + size));
        expect(tap.usage()?.inputTokens ?? null).toBe(input);
      }
    }
  });

  it("reads a JSON body's usage, leading whitespace and all", () => {
    const tap = createCodexUsageTap();
    tap.push(new TextEncoder().encode("\n "));
    tap.push(new TextEncoder().encode(JSON.stringify(response("completed", { input_tokens: 10, output_tokens: 1 }))));
    expect(tap.usage()).toMatchObject({ inputTokens: 10, cacheReadTokens: 0 });
  });
});
