import { describe, expect, it } from "vitest";
import {
  cacheUsageFrom,
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
