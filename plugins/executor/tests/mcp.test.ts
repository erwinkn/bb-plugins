import { describe, expect, it } from "vitest";
import { ExecutorAuth, type ExecutorCredentials } from "../auth";
import { ExecutorMcpClient, McpError } from "../mcp";
import { toToolResult } from "../server";

type FetchCall = { url: string; init: RequestInit };

function recordedFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): { id?: number; method: string; params?: Record<string, unknown> } {
  return JSON.parse(String(call.init.body));
}

const jsonRpc = (id: number | undefined, result: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

const sseRpc = (id: number | undefined, result: unknown, headers: Record<string, string> = {}) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });

const accepted = () => new Response(null, { status: 202 });
const initResult = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "executor", version: "1.0.0" },
};

function makeAuth(creds: Partial<ExecutorCredentials>, fetchImpl: typeof fetch) {
  const stored: Record<string, string | undefined> = {
    endpointUrl: "https://executor.test/mcp",
    tokenEndpoint: "https://access.test/token",
    ...creds,
  };
  const writes: Array<Record<string, unknown>> = [];
  const kv = new Map<string, unknown>();
  const auth = new ExecutorAuth(
    async () => stored as unknown as ExecutorCredentials,
    async (patch) => {
      writes.push(patch);
      for (const [key, value] of Object.entries(patch)) stored[key] = value === null ? undefined : value;
    },
    {
      get: async <T,>(key: string) => kv.get(key) as T | undefined,
      set: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
    },
    fetchImpl,
  );
  return { auth, stored, writes, kv };
}

describe("ExecutorMcpClient", () => {
  it("initializes, captures the session id, and reuses it with auth headers", async () => {
    const { impl, calls } = recordedFetch((call) => {
      const body = bodyOf(call);
      if (body.method === "initialize") return jsonRpc(body.id, initResult, { "mcp-session-id": "sess-1" });
      if (body.method === "notifications/initialized") return accepted();
      if (body.method === "tools/call") return sseRpc(body.id, { content: [{ type: "text", text: "ok" }] });
      throw new Error(`unexpected ${body.method}`);
    });
    const { auth } = makeAuth(
      { accessToken: "tok-1", cfAccessClientId: "cf-id", cfAccessClientSecret: "cf-secret" },
      impl,
    );
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });

    const result = await client.callTool("skills", {});

    expect(result.content?.[0]).toMatchObject({ type: "text", text: "ok" });
    expect(calls).toHaveLength(3);
    const initHeaders = headersOf(calls[0]!);
    expect(initHeaders["accept"]).toBe("application/json, text/event-stream");
    expect(initHeaders["content-type"]).toBe("application/json");
    expect(initHeaders["authorization"]).toBe("Bearer tok-1");
    expect(initHeaders["CF-Access-Client-Id"]).toBe("cf-id");
    expect(initHeaders["CF-Access-Client-Secret"]).toBe("cf-secret");
    expect(initHeaders["mcp-session-id"]).toBeUndefined();
    expect(bodyOf(calls[0]!)).toMatchObject({ method: "initialize" });
    expect(headersOf(calls[1]!)["mcp-session-id"]).toBe("sess-1");
    expect(bodyOf(calls[1]!).method).toBe("notifications/initialized");
    const toolHeaders = headersOf(calls[2]!);
    expect(toolHeaders["mcp-session-id"]).toBe("sess-1");
    expect(toolHeaders["mcp-protocol-version"]).toBe("2025-06-18");
    expect(bodyOf(calls[2]!)).toMatchObject({
      method: "tools/call",
      params: { name: "skills", arguments: {} },
    });
  });

  it("refreshes on 401 with client_secret_basic and retries with the rotated token", async () => {
    const { impl, calls } = recordedFetch((call) => {
      if (call.url === "https://access.test/token") {
        return new Response(
          JSON.stringify({ access_token: "tok-2", refresh_token: "ref-2", token_type: "bearer", expires_in: 900 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const headers = headersOf(call);
      const body = bodyOf(call);
      if (headers["authorization"] === "Bearer tok-1") return new Response("unauthorized", { status: 401 });
      expect(headers["authorization"]).toBe("Bearer tok-2");
      if (body.method === "initialize") return jsonRpc(body.id, initResult, { "mcp-session-id": "s2" });
      if (body.method === "notifications/initialized") return accepted();
      if (body.method === "tools/call") return jsonRpc(body.id, { content: [{ type: "text", text: "done" }] });
      throw new Error(`unexpected ${body.method}`);
    });
    const { auth, stored, writes, kv } = makeAuth(
      { accessToken: "tok-1", refreshToken: "ref-1", clientId: "cid", clientSecret: "csec" },
      impl,
    );
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });

    const result = await client.callTool("execute", { code: "return 1" });

    expect(result.content?.[0]).toMatchObject({ text: "done" });
    const refresh = calls.find((c) => c.url === "https://access.test/token")!;
    expect(headersOf(refresh)["authorization"]).toBe(
      `Basic ${Buffer.from("cid:csec", "utf8").toString("base64")}`,
    );
    expect(String(refresh.init.body)).toContain("grant_type=refresh_token");
    expect(String(refresh.init.body)).toContain("refresh_token=ref-1");
    expect(stored["accessToken"]).toBe("tok-2");
    expect(stored["refreshToken"]).toBe("ref-2");
    expect(writes).toEqual([{ accessToken: "tok-2", refreshToken: "ref-2" }]);
    expect(kv.get("oauth.accessTokenExpiresAt")).toEqual(expect.any(Number));
  });

  it("surfaces an auth error when 401 persists with no refresh path", async () => {
    const { impl } = recordedFetch(() => new Response("unauthorized", { status: 401 }));
    const { auth } = makeAuth({ accessToken: "dead" }, impl);
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });
    await expect(client.callTool("skills", {})).rejects.toMatchObject({
      name: "McpError",
      code: "unauthorized",
      status: 401,
    });
  });

  it("re-initializes and retries once when the session expires (404)", async () => {
    let session = 0;
    const { impl, calls } = recordedFetch((call) => {
      const body = bodyOf(call);
      const headers = headersOf(call);
      if (body.method === "initialize") {
        session += 1;
        return jsonRpc(body.id, initResult, { "mcp-session-id": `s${session}` });
      }
      if (body.method === "notifications/initialized") return accepted();
      if (body.method === "tools/call") {
        if (headers["mcp-session-id"] === "s1") return new Response("gone", { status: 404 });
        return jsonRpc(body.id, { content: [{ type: "text", text: "after-reinit" }] });
      }
      throw new Error(`unexpected ${body.method}`);
    });
    const { auth } = makeAuth({ accessToken: "tok" }, impl);
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });

    const result = await client.callTool("skills", {});

    expect(result.content?.[0]).toMatchObject({ text: "after-reinit" });
    expect(session).toBe(2);
    expect(calls.map((c) => bodyOf(c).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("skips unrelated SSE messages while waiting for the response", async () => {
    const { impl } = recordedFetch((call) => {
      const body = bodyOf(call);
      if (body.method === "initialize") return sseRpc(body.id, initResult, { "mcp-session-id": "s1" });
      if (body.method === "notifications/initialized") return accepted();
      const stream =
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "late but right" }] } })}\n\n`;
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { auth } = makeAuth({ accessToken: "tok" }, impl);
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });
    const result = await client.callTool("skills", {});
    expect(result.content?.[0]).toMatchObject({ text: "late but right" });
  });

  it("refreshes proactively when the persisted expiry has passed", async () => {
    const { impl, calls } = recordedFetch((call) => {
      if (call.url === "https://access.test/token") {
        return new Response(JSON.stringify({ access_token: "fresh", expires_in: 900 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = headersOf(call);
      const body = bodyOf(call);
      expect(headers["authorization"]).toBe("Bearer fresh");
      if (body.method === "initialize") return jsonRpc(body.id, initResult);
      if (body.method === "notifications/initialized") return accepted();
      return jsonRpc(body.id, { content: [] });
    });
    const { auth, kv } = makeAuth(
      { accessToken: "stale", refreshToken: "ref", clientId: "cid", clientSecret: "csec" },
      impl,
    );
    kv.set("oauth.accessTokenExpiresAt", Date.now() - 1000);
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });
    await client.callTool("skills", {});
    expect(calls[0]!.url).toBe("https://access.test/token");
  });

  it("maps JSON-RPC errors to McpError", async () => {
    const { impl } = recordedFetch((call) => {
      const body = bodyOf(call);
      if (body.method === "initialize") return jsonRpc(body.id, initResult);
      if (body.method === "notifications/initialized") return accepted();
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "bad args" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const { auth } = makeAuth({ accessToken: "tok" }, impl);
    const client = new ExecutorMcpClient({ endpoint: "https://executor.test/mcp", auth, fetchImpl: impl });
    await expect(client.callTool("execute", { code: "x" })).rejects.toMatchObject({
      code: "rpc_-32602",
      message: "bad args",
    });
  });
});

describe("ExecutorAuth", () => {
  it("reports configured only with a usable credential", async () => {
    const { impl } = recordedFetch(() => new Response(null, { status: 500 }));
    const empty = makeAuth({}, impl);
    expect(empty.auth.configured({ endpointUrl: "e", tokenEndpoint: "t" })).toBe(false);
    const bearer = makeAuth({ accessToken: "t" }, impl);
    expect(bearer.auth.configured({ endpointUrl: "e", tokenEndpoint: "t", accessToken: "t" })).toBe(true);
    const pair = makeAuth({ cfAccessClientId: "i" }, impl);
    expect(
      pair.auth.configured({ endpointUrl: "e", tokenEndpoint: "t", cfAccessClientId: "i" }),
    ).toBe(false);
    expect(
      pair.auth.configured({
        endpointUrl: "e",
        tokenEndpoint: "t",
        cfAccessClientId: "i",
        cfAccessClientSecret: "s",
      }),
    ).toBe(true);
  });
});

describe("toToolResult", () => {
  it("bounds oversized text output", () => {
    const big = "x".repeat(200 * 1024);
    const result = toToolResult({ content: [{ type: "text", text: big }] });
    const parts = (result as { content: Array<{ type: string; text?: string }> }).content;
    const total = parts.reduce((n, p) => n + (p.text?.length ?? 0), 0);
    expect(total).toBeLessThan(200 * 1024);
    expect(parts.at(-1)?.text).toContain("truncated");
  });

  it("passes through images and summarizes resource links", () => {
    const result = toToolResult({
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "resource_link", uri: "https://x.test/a", name: "a" },
      ],
    });
    const parts = (result as { content: Array<Record<string, unknown>> }).content;
    expect(parts[0]).toMatchObject({ type: "image", data: "QUJD" });
    expect(parts[1]).toMatchObject({ type: "text" });
    expect(String(parts[1]!.text)).toContain("https://x.test/a");
  });

  it("marks upstream errors", () => {
    const result = toToolResult({ content: [{ type: "text", text: "boom" }], isError: true });
    expect(result).toMatchObject({ isError: true });
  });
});
