import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import plugin from "../server";
import { createStore } from "../store";
import { getOp, reconcileOp, runOp } from "../ops";
import { sdkCall } from "../codemode";
import { ToolError } from "../config";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const config = { defaultHostId: "host_linux", appUrl: "https://bb.example.com", endpointUrl: "https://mcp.example.com/mcp" };
const t = makeThreadResponse({ id: "thr_test", projectId: "proj_allowed", environmentId: "env_test", status: "idle", providerId: "codex" });
const env = { id: "env_test", projectId: "proj_allowed", hostId: "host_linux", status: "ready", baseBranch: "origin/main", mergeBaseBranch: null };
function host() {
  const h = createFakePluginHost({ pluginId: "bb-mcp", loopbackBaseUrl: "http://127.0.0.1:38886", settings: config, sdk: {
    projects: { list: async () => [{ id: "proj_allowed", name: "Allowed" }, { id: "proj_private", name: "Private" }], defaultExecutionOptions: async () => ({ permissionMode: "auto", model: "m", providerId: "codex", reasoningLevel: "low", serviceTier: "default" }) },
    system: { executionOptions: async () => ({ permissionCeiling: "full" }) },
    hosts: { list: async () => [{ id: "host_linux", name: "Linux", status: "connected" }] },
    environments: { get: async () => env },
    threads: { get: async () => t, spawn: async () => t, list: async () => [t], defaultExecutionOptions: async () => null,
      events: { list: async () => [] }, interactions: { list: async () => [] }, queuedMessages: { list: async () => [] }, send: async () => ({ delivery: "sent", ok: true }) },
  } });
  cleanup.push(() => h.harness.lifecycle.dispose()); return h;
}
function storeHost() { const h = host(); return { ...h, store: createStore(h.bb) }; }
const scope = { kind: "create", projectId: "proj_allowed", hostId: null, threadId: null };
const spawnCall = { call: "threads.spawn", args: { projectId: "proj_allowed", input: [{ type: "text", text: "Do work", mentions: [] }] } };

it("uses only the public BB SDK and declared external packages", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)), {
    allow: [/^@modelcontextprotocol\/(server|client)$/, /^vitest$/],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});

describe("durable dispatch", () => {
  it("concurrent retries dispatch once and replay an acceptance", async () => {
    const { store } = storeHost(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const dispatch = vi.fn(async () => { await gate; return { threadId: "thr_test" }; });
    const a = store.run(scope, "same-key", spawnCall, dispatch);
    const b = store.run(scope, "same-key", { ...spawnCall }, dispatch);
    release(); const [one, two] = await Promise.all([a, b]);
    expect(one).toEqual(two); expect(one.state).toBe("accepted"); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await store.run(scope, "same-key", spawnCall, dispatch)).toEqual(one);
  });
  it("rejects the same key with another payload", async () => {
    const { store } = storeHost(); await store.run(scope, "key", spawnCall, async () => ({}));
    await expect(store.run(scope, "key", { ...spawnCall, args: { projectId: "proj_other" } }, async () => ({}))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("keeps a lost response unknown without redispatch", async () => {
    const { store } = storeHost(); const dispatch = vi.fn(async () => { throw new Error("secret provider URL"); });
    const first = await store.run(scope, "key", spawnCall, dispatch);
    expect(first.state).toBe("outcome_unknown");
    expect(await store.run(scope, "key", spawnCall, dispatch)).toEqual(first); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first.error?.message).toBe("secret provider URL");
  });
  it("records definitive rejections as failed and lets the key be retried", async () => {
    const { store } = storeHost();
    const dispatch = vi.fn(async () => { throw new ToolError("not_found", "Unknown BB method."); });
    const first = await store.run(scope, "key", spawnCall, dispatch);
    expect(first.state).toBe("failed");
    expect(first.error?.code).toBe("not_found");
    const second = await store.run(scope, "key", spawnCall, async () => ({ threadId: "thr_test" }));
    expect(second.state).toBe("accepted");
    expect(second.threadId).toBe("thr_test");
  });
  it("treats HTTP 4xx rejections as definitive failures", async () => {
    const { store } = storeHost();
    const err = Object.assign(new Error("HTTP 400: Required"), { status: 400 });
    const first = await store.run(scope, "key", spawnCall, async () => { throw err; });
    expect(first.state).toBe("failed");
  });
  it("lets a retry with corrected args replace a failed receipt", async () => {
    const { store } = storeHost();
    await store.run(scope, "key", spawnCall, async () => { throw new ToolError("invalid_arguments", "bad"); });
    const fixed = { ...spawnCall, args: { projectId: "proj_allowed", input: [{ type: "text", text: "Fixed", mentions: [] }] } };
    const second = await store.run(scope, "key", fixed, async () => ({ threadId: "thr_test" }));
    expect(second.state).toBe("accepted");
  });
  it("fingerprints binary args instead of collapsing them", async () => {
    const { store } = storeHost();
    const upload = (bytes: number[]) => ({ call: "projects.attachments.upload", args: { data: new Uint8Array(bytes).buffer } });
    await store.run(scope, "key", upload([1, 2, 3]), async () => ({}));
    await expect(store.run(scope, "key", upload([4, 5, 6]), async () => ({}))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("joins a same-key retry to the in-flight dispatch rather than replaying pending", async () => {
    const { store } = storeHost(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const call = vi.fn(async () => { await gate; return { id: "thr_test" }; });
    const a = runOp(store, { key: "k", call: "threads.spawn", args: {} }, call);
    const b = runOp(store, { key: "k", call: "threads.spawn", args: {} }, call);
    release();
    const [one, two] = await Promise.all([a, b]);
    expect(one.state).toBe("accepted");
    expect(two).toMatchObject({ id: one.id, state: "accepted" });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("recovers a persisted in-flight request on reload without repeating it", async () => {
    const { bb, harness, store } = storeHost();
    const first = await store.run(scope, "key", spawnCall, async () => ({ threadId: "thr_test" }));
    bb.storage.database().prepare("UPDATE operations SET body = json_set(body, '$.state', 'pending')").run();
    let recovered!: ReturnType<typeof createStore>;
    await harness.lifecycle.reload(next => { recovered = createStore(next); });
    expect(recovered.get(first.id)?.state).toBe("outcome_unknown");
    const dispatch = vi.fn(async () => ({})); await recovered.run(scope, "key", spawnCall, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("ops", () => {
  it("ops.run dedupes and records the SDK call receipt", async () => {
    const { bb, store, harness } = storeHost();
    const call = (p: string, a: unknown) => sdkCall(bb.sdk, p, a);
    const args = { kind: "create", key: "k1", ...spawnCall };
    const [one, two] = await Promise.all([runOp(store, args, call), runOp(store, { ...args }, call)]);
    expect(one.id).toBe(two.id);
    const spawnArgs = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]?.[0]).toMatchObject({ permissionMode: "auto", executionInputSources: { permissionMode: "client-preference" } });
    expect(one).toMatchObject({ state: "accepted", kind: "create", threadId: t.id, response: { projectId: "proj_allowed" } });
    expect(getOp(store, { operationId: one.id })).toMatchObject({ id: one.id, state: "accepted" });
    await expect(runOp(store, { ...args, args: { projectId: "proj_other" } }, call)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("reconcileOp verifies the thread before accepting an unknown op", async () => {
    const { bb, store, harness } = storeHost();
    const call = (p: string, a: unknown) => sdkCall(bb.sdk, p, a);
    const recorded = { ...scope, threadId: "thr_recorded" };
    const op = await store.run(recorded, "unknown", spawnCall, async () => { throw new Error("lost"); });
    await expect(reconcileOp(store, call, op.id, "thr_other")).rejects.toMatchObject({ code: "conflict" });
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
    await expect(reconcileOp(store, call, op.id, "thr_recorded")).resolves.toMatchObject({ state: "accepted", response: { reconciliation: "operator_confirmed", threadId: "thr_recorded" } });
    await expect(reconcileOp(store, call, op.id, "thr_recorded")).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("MCP transport", () => {
  for (const mode of ["legacy", "auto"] as const) it(`discovers the code-mode tool and executes with ${mode} negotiation`, async () => {
    const { bb, harness } = host(); plugin(bb);
    const client = new Client({ name: "bb-mcp-test", version: "1" }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:38886/mcp"), {
      requestInit: { headers: { "x-bb-plugin-token": "test-token", host: "127.0.0.1:38886" } },
      fetch: async (_url, init) => harness.behavior.fetchHttp(init?.method ?? "GET", "/mcp", init),
    });
    cleanup.push(() => client.close()); await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(["bb_execute", "bb_read"]);
    await expect(client.callTool({ name: "bb_list_projects", arguments: {} })).rejects.toThrow("not found");
    const readOnly = await client.callTool({ name: "bb_read", arguments: { code: `async () => bb.projects.list()` } });
    expect(readOnly.isError).toBeFalsy();
    const blocked = await client.callTool({ name: "bb_read", arguments: { code: `async () => bb.threads.spawn({})` } });
    expect(blocked.isError).toBe(true); expect(JSON.stringify(blocked.content)).toContain("read methods");
    const result = await client.callTool({ name: "bb_execute", arguments: { code: `async () => { const p = await bb.projects.list(); return p.map(x => x.id); }` } });
    expect(result.isError).toBeFalsy(); expect(result.structuredContent).toEqual({ data: { result: ["proj_allowed", "proj_private"], logs: [] } });
    expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(2);
    const badCall = await client.callTool({ name: "bb_execute", arguments: { code: `async () => bb.threads.get({})` } });
    expect(badCall.isError).toBeFalsy(); // the sandbox function resolved; its result shape is BB's
  });
  it("runs durable dispatch through bb.ops.run in the sandbox", async () => {
    const { bb, harness } = host(); plugin(bb);
    const client = new Client({ name: "bb-mcp-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:38886/mcp"), {
      requestInit: { headers: { "x-bb-plugin-token": "test-token", host: "127.0.0.1:38886" } },
      fetch: async (_url, init) => harness.behavior.fetchHttp(init?.method ?? "GET", "/mcp", init),
    });
    cleanup.push(() => client.close()); await client.connect(transport);
    const code = `async () => bb.ops.run({ kind: "create", key: "op-key-1", call: "threads.spawn", args: { projectId: "proj_allowed", input: [] } })`;
    const first = await client.callTool({ name: "bb_execute", arguments: { code } });
    const second = await client.callTool({ name: "bb_execute", arguments: { code } });
    expect(first.structuredContent).toMatchObject({ data: { result: { state: "accepted", kind: "create", threadId: "thr_test" } } });
    expect(second.structuredContent).toMatchObject({ data: { result: { id: (first.structuredContent as { data: { result: { id: string } } }).data.result.id } } });
    const spawnArgs = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]?.[0]).toMatchObject({ permissionMode: "auto", executionInputSources: { permissionMode: "client-preference" } });
  });
  it("requires header auth and rejects foreign origins and hosts", async () => {
    const { bb, harness } = host(); plugin(bb);
    const fetch = (headers: Record<string, string>, body = "{}") => harness.behavior.fetchHttp("POST", "/mcp", { headers: { host: "127.0.0.1:38886", "content-type": "application/json", ...headers }, body });
    expect((await fetch({})).status).toBe(401);
    expect((await fetch({ "x-bb-plugin-token": "test", origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch({ "x-bb-plugin-token": "test", host: "evil.example" })).status).toBe(403);
  });
});
