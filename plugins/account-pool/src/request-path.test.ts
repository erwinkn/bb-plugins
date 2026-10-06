import { afterEach, describe, expect, it, vi } from "vitest";
import { describeClaudeRequest, keepAliveBody } from "./cache-usage.js";
import { parseCodexRequestBody, parseRequestBody } from "./request-body.js";
import { claudeCodeRequest } from "./testing/claude-body.js";

// The Pooler runs on BB's server event loop, and Claude Code and Codex bodies are often several
// MB. Parsing, re-serializing or decoding one whole blocked every BB request for tens of ms per
// step (measure with scripts/bench-request-path.ts). These tests pin both the results and that no
// step of the request path handles a large body whole.

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (body: Uint8Array) => new TextDecoder().decode(body);
const POOL_UUID = "11111111-1111-4111-8111-111111111111";
const SESSION = "33333333-3333-4333-8333-333333333333";
const LARGE = 64 * 1024;

afterEach(() => vi.restoreAllMocks());

// The largest input JSON.parse and TextDecoder saw, and output JSON.stringify produced, while run ran.
function largestWholeBodyWork(run: () => void): number {
  let largest = 0;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const textDecode = TextDecoder.prototype.decode;
  vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    largest = Math.max(largest, String(text).length);
    return parse(text, reviver);
  });
  vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    const out = stringify(value, replacer, space);
    largest = Math.max(largest, out?.length ?? 0);
    return out;
  });
  vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
    this: TextDecoder,
    input,
    options,
  ) {
    largest = Math.max(largest, input?.byteLength ?? 0);
    return textDecode.call(this, input, options);
  });
  try {
    run();
  } finally {
    vi.restoreAllMocks();
  }
  return largest;
}

describe("the request path on a multi-MB Claude Code body", () => {
  const request = claudeCodeRequest({ bytes: 4e6, sessionId: SESSION });
  const body = encode(request);

  it("reads it without parsing, re-serializing or decoding it whole", () => {
    let rewritten: Uint8Array = new Uint8Array();
    let shape: ReturnType<typeof describeClaudeRequest> | null = null;
    let resent: Uint8Array = new Uint8Array();
    const largest = largestWholeBodyWork(() => {
      const parsed = parseRequestBody(body);
      expect(parsed.family).toBe("opus");
      expect(parsed.affinityId).toBe(`session:${SESSION}`);
      rewritten = parsed.forAccount(POOL_UUID);
      shape = describeClaudeRequest(rewritten);
      resent = keepAliveBody(rewritten);
    });
    expect(body.byteLength).toBeGreaterThan(4e6);
    expect(largest).toBeLessThan(LARGE);
    // The same results JSON.parse gives.
    const metadata = request.metadata as { user_id: string };
    expect(JSON.parse(decode(rewritten))).toEqual({
      ...request,
      metadata: {
        user_id: JSON.stringify({
          ...JSON.parse(metadata.user_id),
          account_uuid: POOL_UUID,
        }),
      },
    });
    expect(shape).toMatchObject({
      model: "claude-opus-4-1",
      family: "opus",
      tailTtl: "1h",
      breakpoints: 2,
      keepAliveBlocker: null,
    });
    const { stream: _stream, ...rest } = JSON.parse(decode(rewritten));
    expect(JSON.parse(decode(resent))).toEqual({ ...rest, max_tokens: 0 });
  });

  it("reads only what it compares in large caller objects such as an output schema", () => {
    const huge = "x".repeat(8 * 1024 * 1024);
    const body = encode({
      model: "claude-opus-5-5",
      cache_control: { type: "ephemeral", ttl: "1h", note: huge },
      thinking: { type: "adaptive", note: huge },
      tool_choice: { type: "auto", note: huge },
      output_config: { format: { type: "json_schema", schema: { description: huge } } },
      metadata: { user_id: JSON.stringify({ session_id: SESSION }), note: huge },
    });
    let shape: ReturnType<typeof describeClaudeRequest> | null = null;
    const largest = largestWholeBodyWork(() => {
      expect(parseRequestBody(body).affinityId).toBe(`session:${SESSION}`);
      shape = describeClaudeRequest(body);
    });
    expect(largest).toBeLessThan(LARGE);
    expect(shape).toMatchObject({
      tailTtl: "1h",
      keepAliveBlocker: "output_config.format cannot be sent with max_tokens 0",
    });
  });

  it("reads a multi-MB Codex body the same way", () => {
    const codex = encode({
      model: "gpt-5",
      input: request.messages,
      prompt_cache_key: "cache-key",
      client_metadata: { session_id: "codex-session" },
    });
    const largest = largestWholeBodyWork(() => {
      const parsed = parseCodexRequestBody(codex, new Headers());
      expect(parsed.affinityId).toBe("session:codex-session");
      expect(parsed.forAccount(null as never)).toBe(codex);
    });
    expect(largest).toBeLessThan(LARGE);
  });
});

describe("bodies that are not JSON", () => {
  const user = JSON.stringify(
    JSON.stringify({ account_uuid: "22222222-2222-4222-8222-222222222222", session_id: SESSION }),
  );
  const valid = `"model":"claude-opus-5-5","metadata":{"user_id":${user}}`;

  it.each([
    ["a bad escape in a skipped string", `{${valid},"messages":[{"content":"bad\\q"}]}`],
    ["a raw control character in a skipped string", `{${valid},"messages":[{"content":"a\u0001b"}]}`],
    ["a bad escape in the model", '{"model":"bad\\q","messages":[]}'],
    ["a malformed number", `{${valid},"n":1.}`],
  ])("are forwarded unchanged and unrouted, as before: %s", (_name, text) => {
    expect(() => JSON.parse(text)).toThrow();
    const body = new TextEncoder().encode(text);
    const parsed = parseRequestBody(body);
    expect([parsed.family, parsed.affinityId, parsed.parentAffinityId]).toEqual(["other", null, null]);
    expect(parsed.forAccount(POOL_UUID)).toBe(body);
    expect(describeClaudeRequest(body)).toMatchObject({
      model: null,
      family: "other",
      keepAliveBlocker: "request body is not a JSON object",
    });
    expect(() => keepAliveBody(body)).toThrow();
  });
});

describe("numbers JSON.stringify would write differently", () => {
  const user = (account: string) =>
    JSON.stringify({ account_uuid: account, session_id: SESSION });

  it("are written as before by the account rewrite and the warming re-send", () => {
    const text = `{"model":"claude-opus-5-5","max_tokens":1.0,"stream":true,"n":[1e400,-0,1E2],"metadata":{"user_id":${JSON.stringify(user("22222222-2222-4222-8222-222222222222"))}}}`;
    const rewritten = decode(parseRequestBody(new TextEncoder().encode(text)).forAccount(POOL_UUID));
    expect(JSON.parse(rewritten)).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 1,
      stream: true,
      n: [null, 0, 100],
      metadata: { user_id: user(POOL_UUID) },
    });
    expect(rewritten).not.toContain("1e400");
    const resent = decode(keepAliveBody(new TextEncoder().encode(text)));
    expect(JSON.parse(resent)).toMatchObject({ max_tokens: 0, n: [null, 0, 100] });
    expect(resent).not.toContain("stream");
  });
});

describe("byte-level request edits", () => {
  const user = (account: string) =>
    JSON.stringify({ account_uuid: account, session_id: SESSION });

  it("rewrites the account in metadata.user_id and keeps every other byte", () => {
    const text = `{ "model" : "claude-opus-5-5",\n "messages":[{"role":"user","content":"caf\\u00e9 \\"q\\""}],\n "metadata" : {"user_id": ${JSON.stringify(user("22222222-2222-4222-8222-222222222222"))}, "extra": 1 } }`;
    const out = decode(parseRequestBody(new TextEncoder().encode(text)).forAccount(POOL_UUID));
    expect(out).toBe(text.replace(JSON.stringify(user("22222222-2222-4222-8222-222222222222")), JSON.stringify(user(POOL_UUID))));
  });

  it("counts only block-level breakpoints, whatever the strings contain", () => {
    const shape = describeClaudeRequest(
      encode({
        model: "claude-opus-5-5",
        system: "a string system has no blocks",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: '{"cache_control":{"type":"ephemeral","ttl":"1h"}}' },
              { type: "tool_use", id: "t", name: "x", input: { cache_control: { type: "ephemeral" } } },
              { type: "text", text: "t", cache_control: { type: "ephemeral", ttl: "1h" }, cache_control_note: 1 },
            ],
          },
          { role: "assistant", content: "plain" },
          "not an object",
        ],
      }),
    );
    expect(shape).toMatchObject({ tailTtl: "1h", breakpoints: 1 });
    // A repeated key's last value wins, as with JSON.parse.
    const repeated = new TextEncoder().encode(
      '{"model":"a","messages":[{"content":[{"cache_control":{"ttl":"1h"},"cache_control":{"type":"ephemeral"}}]}],"model":"claude-opus-5-5"}',
    );
    expect(describeClaudeRequest(repeated)).toMatchObject({
      model: "claude-opus-5-5",
      tailTtl: "5m",
      breakpoints: 1,
    });
  });

  it("re-sends a body with max_tokens 0 and no stream, other bytes unchanged", () => {
    const text = '{"model":"m","stream":true,"system":"caf\\u00e9","max_tokens":32000,"x":[1, 2]}';
    expect(decode(keepAliveBody(new TextEncoder().encode(text)))).toBe(
      '{"model":"m","system":"caf\\u00e9","max_tokens":0,"x":[1, 2]}',
    );
    expect(decode(keepAliveBody(encode({ model: "m" })))).toBe('{"model":"m","max_tokens":0}');
    expect(decode(keepAliveBody(encode({ stream: true })))).toBe('{"max_tokens":0}');
    expect(() => keepAliveBody(new TextEncoder().encode("[1]"))).toThrow(SyntaxError);
  });
});
