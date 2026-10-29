import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Manager } from "../src/manager";
import { Store } from "../src/store";
import { computeSurface } from "../src/surface";
import type { ListResult } from "../src/contract";
import { legacySessionServer, modernServer, sseServer, type FixtureTool } from "./fixtures";

const search: FixtureTool = {
  name: "search",
  description: "Search the docs.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};
const fetchDoc: FixtureTool = { name: "fetch.doc", description: "Fetch one doc.", inputSchema: { type: "object" } };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-servers-test-"));
  const store = new Store(dir);
  const published: ListResult[] = [];
  const reloads: number[] = [];
  const manager = new Manager({
    store,
    pluginId: "mcp-servers",
    fetchImpl: fetch,
    log: () => {},
    publish: (list) => published.push(list),
    requestReload: () => reloads.push(Date.now()),
    registered: { surface: computeSurface([]), names: new Set() },
  });
  cleanups.push(() => manager.close(), () => rmSync(dir, { recursive: true, force: true }));
  return { store, manager, published, reloads, dir };
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const signal = () => AbortSignal.timeout(10_000);

describe("connections", () => {
  it("negotiates the 2026-07-28 era with a modern server and passes tools through", async () => {
    const server = await modernServer({ tools: [search, fetchDoc], instructions: "Call search first." });
    cleanups.push(() => server.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Docs", prefix: "docs", url: server.url, auth: { kind: "none" } });
    const view = await until(() => manager.list().servers.find((s) => s.id === id && s.state === "connected"));
    expect(view.server).toMatchObject({ protocolVersion: "2026-07-28", transport: "streamable-http", name: "modern-fixture" });
    expect(view.tools.map((tool) => tool.name)).toEqual(["docs_search", "docs_fetch_doc"]);
    expect(store.get(id)?.cache?.instructions).toBe("Call search first.");

    const result = await manager.callTool(id, "search", { q: "hello" }, signal());
    expect(result).toEqual({ content: [{ type: "text", text: 'search:{"q":"hello"}' }], isError: false });
  });

  it("falls back to the 2025 handshake for a sessionful legacy server and survives session expiry", async () => {
    const server = await legacySessionServer({ tools: [search] });
    cleanups.push(() => server.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Legacy", prefix: "legacy", url: server.url, auth: { kind: "none" } });
    const view = await until(() => manager.list().servers.find((s) => s.state === "connected"));
    expect(view.server?.protocolVersion).toMatch(/^2025-/);

    server.expireSessions();
    const result = await manager.callTool(id, "search", { q: "again" }, signal());
    expect(result).toMatchObject({ isError: false, content: [{ text: 'search:{"q":"again"}' }] });
    expect(server.sessions.size).toBe(1);
  });

  it("uses the legacy HTTP+SSE transport when Streamable HTTP is refused", async () => {
    const server = await sseServer({ tools: [search] });
    cleanups.push(() => server.close());
    const { manager, store } = harness();
    const { id } = manager.add({ name: "Old", prefix: "old", url: server.url, auth: { kind: "none" } });
    const view = await until(() => manager.list().servers.find((s) => s.state === "connected"));
    expect(view.server?.transport).toBe("sse");
    expect(store.get(id)?.cache?.transport).toBe("sse");
    const result = await manager.callTool(id, "search", { q: "sse" }, signal());
    expect(result).toMatchObject({ isError: false, content: [{ text: 'search:{"q":"sse"}' }] });
  });

  it("follows tools/list_changed and asks for one reload", async () => {
    for (const make of [modernServer, legacySessionServer] as const) {
      const server = await make({ tools: [search] });
      cleanups.push(() => server.close());
      const { manager, store, reloads } = harness();
      const { id } = manager.add({ name: "Docs", prefix: "docs", url: server.url, auth: { kind: "none" } });
      await until(() => manager.list().servers.find((s) => s.state === "connected"));
      await until(() => manager.list().reloadPending);
      await server.setTools([search, fetchDoc]);
      await until(() => store.get(id)?.cache?.tools.length === 2);
      await until(() => reloads.length >= 1, 5_000);
      expect(reloads.length).toBe(1);
    }
  });

  it("reports an unreachable server and retries in the background", async () => {
    const { manager } = harness();
    manager.add({ name: "Gone", prefix: "gone", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } });
    const view = await until(() => manager.list().servers.find((s) => s.state === "error"));
    expect(view.error).toBeTruthy();
  });

  it("sends a static header on every request", async () => {
    const server = await modernServer({ tools: [search] });
    cleanups.push(() => server.close());
    const { manager, store } = harness();
    const { id } = manager.add({
      name: "Keyed",
      prefix: "keyed",
      url: server.url,
      auth: { kind: "header", headerName: "Authorization", headerValue: "Bearer sk-test-123" },
    });
    await until(() => manager.list().servers.find((s) => s.state === "connected"));
    expect(server.requests.every((request) => request.authorization === "Bearer sk-test-123")).toBe(true);
    expect(store.secretsFor(id).headerValue).toBe("Bearer sk-test-123");
    expect(JSON.stringify(manager.list())).not.toContain("sk-test-123");
  });
});
