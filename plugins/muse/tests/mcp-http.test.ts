import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BbToolServer } from "../src/mcp-http.js";

const TOOL = { name: "slow_tool", description: "Waits.", inputSchema: { properties: { ms: { type: "number" } } } };

let server: BbToolServer;

afterEach(async () => {
  await server.close();
});

async function post(entry: { url: string; headers: Record<string, string> }, body: unknown, token?: string) {
  return fetch(entry.url, {
    method: "POST",
    headers: {
      ...(token === undefined ? entry.headers : { Authorization: `Bearer ${token}` }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

describe("bb's tool server", () => {
  it("serves one session's tools behind its token", async () => {
    server = new BbToolServer(20);
    const calls: Array<{ name: string; args: unknown; callId: string | null }> = [];
    const route = await server.register({
      tools: [TOOL],
      call: async (name, args, callId) => {
        calls.push({ name, args, callId });
        await new Promise((resolve) => setTimeout(resolve, Number(args.ms)));
        return { content: [{ type: "text", text: "done" }], isError: false };
      },
    });
    const entry = route.mcpServers["bb-bridge"] as { url: string; headers: Record<string, string>; transport: string };
    expect(entry.transport).toBe("streamableHttp");

    expect((await post(entry, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);

    const init = (await (await post(entry, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json()) as { result: unknown };
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} } });
    expect((await post(entry, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list = (await (await post(entry, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: unknown[] } };
    expect(list.result.tools).toEqual([
      { name: "slow_tool", description: "Waits.", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
    ]);

    // A slow call answers as an event stream with keep-alive comments.
    const response = await post(entry, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "slow_tool", arguments: { ms: 80 }, _meta: { callId: "call_1" } },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).toContain(": ping");
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data?.slice(6) ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "done" }], isError: false },
    });
    expect(calls).toEqual([{ name: "slow_tool", args: { ms: 80 }, callId: "call_1" }]);

    const unknown = await (await post(entry, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })).text();
    expect(unknown).toContain("Unknown tool: nope");

    route.dispose();
    expect((await post(entry, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status).toBe(401);
  });

  it("stops pinging a call whose client hung up", async () => {
    server = new BbToolServer(10);
    const route = await server.register({ tools: [TOOL], call: () => new Promise(() => undefined) });
    const entry = route.mcpServers["bb-bridge"] as { url: string; headers: Record<string, string> };
    const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
    const baseline = timers();
    const controller = new AbortController();
    const response = fetch(entry.url, {
      method: "POST",
      signal: controller.signal,
      headers: { ...entry.headers, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_tool", arguments: {} } }),
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timers()).toBeGreaterThan(baseline);
    controller.abort();
    await response;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timers()).toBeLessThanOrEqual(baseline);
  });

  it("refuses a call whose session ended while its body was arriving", async () => {
    server = new BbToolServer(10);
    let called = false;
    const route = await server.register({
      tools: [TOOL],
      call: async () => {
        called = true;
        return { content: [], isError: false };
      },
    });
    const entry = route.mcpServers["bb-bridge"] as { url: string; headers: Record<string, string> };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_tool", arguments: {} } });
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(entry.url, {
        method: "POST",
        headers: { ...entry.headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.write(body.slice(0, 10));
      setTimeout(() => {
        route.dispose();
        request.end(body.slice(10));
      }, 30);
    });
    expect(status).toBe(410);
    expect(called).toBe(false);
  });
});
