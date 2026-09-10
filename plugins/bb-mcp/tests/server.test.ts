import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeQueueEntry, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import plugin from "../server";
import { createAdapter } from "../adapter";
import { defineSettings, executionPermission } from "../config";
import { createStore } from "../store";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const config = { projectIds: "proj_allowed", hostIds: "host_linux", defaultHostId: "host_linux", appUrl: "https://bb.example.com", endpointUrl: "https://mcp.example.com/mcp" };
const t = makeThreadResponse({ id: "thr_test", projectId: "proj_allowed", environmentId: "env_test", status: "idle", providerId: "codex" });
const env = { id: "env_test", projectId: "proj_allowed", hostId: "host_linux", status: "ready", baseBranch: "origin/main", mergeBaseBranch: null };
const model = { id: "test-model", model: "test-model", isDefault: true, displayName: "Test", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] };
function host() {
  const h = createFakePluginHost({ pluginId: "bb-mcp", loopbackBaseUrl: "http://127.0.0.1:38886", settings: config, sdk: {
    projects: { list: async () => [{ id: "proj_allowed", name: "Allowed" }, { id: "proj_private", name: "Private" }], defaultExecutionOptions: async () => null },
    hosts: { list: async () => [{ id: "host_linux", name: "Linux", status: "connected" }] },
    environments: { get: async () => env },
    providers: { list: async () => [{ id: "codex", available: true, displayName: "Codex", capabilities: { permissionModes: ["auto"] } }], models: async () => ({ models: [model], modelLoadError: null }) },
    threads: { get: async () => t, spawn: async () => t, list: async () => [t], defaultExecutionOptions: async () => null,
      events: { list: async () => [] }, interactions: { list: async () => [] }, queuedMessages: { list: async () => [] }, send: async () => ({ delivery: "sent", ok: true }) },
  } });
  cleanup.push(() => h.harness.lifecycle.dispose()); return h;
}
function adapterHost() { const h = host(); const settings = defineSettings(h.bb); const store = createStore(h.bb); return { ...h, store, adapter: createAdapter(h.bb, settings, store) }; }
const create = { projectId: "proj_allowed", prompt: "Implement a small task", idempotencyKey: "instruction-one" };
const scope = { kind: "create" as const, projectId: "proj_allowed", hostId: "host_linux", threadId: null };

it("uses only the public BB SDK and declared external packages", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)), {
    allow: [/^@modelcontextprotocol\/(server|client)$/, /^vitest$/],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});

describe("durable dispatch", () => {
  it("concurrent retries dispatch once and replay an acceptance", async () => {
    const { store } = adapterHost(); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const dispatch = vi.fn(async () => { await gate; return { threadId: "thr_test" }; });
    const a = store.run(scope, "same-key", create, 4, 20, dispatch);
    const b = store.run(scope, "same-key", { ...create }, 4, 20, dispatch);
    release(); const [one, two] = await Promise.all([a, b]);
    expect(one).toEqual(two); expect(one.state).toBe("accepted"); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await store.run(scope, "same-key", create, 4, 20, dispatch)).toEqual(one);
  });
  it("rejects the same key with another payload", async () => {
    const { store } = adapterHost(); await store.run(scope, "key", create, 4, 20, async () => ({}));
    await expect(store.run(scope, "key", { ...create, prompt: "Changed" }, 4, 20, async () => ({}))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("keeps a lost response unknown without redispatch", async () => {
    const { store } = adapterHost(); const dispatch = vi.fn(async () => { throw new Error("secret provider URL"); });
    const first = await store.run(scope, "key", create, 4, 20, dispatch);
    expect(first.state).toBe("outcome_unknown");
    expect(await store.run(scope, "key", create, 4, 20, dispatch)).toEqual(first); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("secret provider");
  });
  it("recovers a persisted in-flight request on reload without repeating it", async () => {
    const { bb, harness, store } = adapterHost();
    const first = await store.run(scope, "key", create, 4, 20, async () => ({ threadId: "thr_test" }));
    bb.storage.database().prepare("UPDATE operations SET body = json_set(body, '$.state', 'pending')").run();
    let recovered!: ReturnType<typeof createStore>;
    await harness.lifecycle.reload(next => { recovered = createStore(next); });
    expect(recovered.get(first.id)?.state).toBe("outcome_unknown");
    const dispatch = vi.fn(async () => ({})); await recovered.run(scope, "key", create, 4, 20, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("caps new task admission", async () => {
    const { store } = adapterHost(); await store.run(scope, "one", create, 4, 1, async () => ({}));
    await expect(store.run(scope, "two", create, 4, 1, async () => ({}))).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("BB boundary", () => {
  it("uses a supported permission mode without exceeding either ceiling", () => {
    expect(executionPermission(["accept-edits", "full"], "auto")).toBe("accept-edits");
    expect(executionPermission(["auto", "full"], "full", "auto")).toBe("auto");
    expect(() => executionPermission(["full"], "auto")).toThrow();
  });
  it("only reconciles an unknown request with a thread in its recorded scope", async () => {
    const { adapter, store, harness } = adapterHost();
    const op = await store.run(scope, "unknown", create, 4, 20, async () => { throw new Error("lost"); });
    harness.inspection.sdk.stub("environments.get", async () => ({ ...env, hostId: "host_private" }));
    await expect(adapter.reconcileOperation(op.id, t.id)).rejects.toMatchObject({ code: "not_found" });
    harness.inspection.sdk.stub("environments.get", async () => env);
    expect(await adapter.reconcileOperation(op.id, t.id)).toMatchObject({ state: "accepted", response: { reconciliation: "operator_confirmed", threadId: t.id } });
    await expect(adapter.reconcileOperation(op.id, t.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("creates a visible worktree on the configured host without opening a pane", async () => {
    const { adapter, harness } = adapterHost(); const response = await adapter.createThread(create);
    expect(response.state).toBe("accepted");
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ environment: { type: "host", hostId: "host_linux", workspace: { type: "managed-worktree" } }, visibility: "visible", model: "test-model", permissionMode: "auto" });
    expect(harness.inspection.sdk.callsTo("threads.open")).toHaveLength(0);
  });
  it("denies projects, foreign environments and direct thread IDs", async () => {
    const { adapter, harness } = adapterHost();
    await expect(adapter.createThread({ ...create, projectId: "proj_private" })).rejects.toMatchObject({ code: "not_found" });
    harness.inspection.sdk.stub("environments.get", async () => ({ ...env, hostId: "host_private" }));
    await expect(adapter.getThread({ threadId: "thr_test" })).rejects.toMatchObject({ code: "not_found" });
    await expect(adapter.createThread({ ...create, environmentId: "env_test" })).rejects.toMatchObject({ code: "not_found" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("denies reading old operation responses after scope revocation", async () => {
    const { adapter, harness } = adapterHost(); const op = await adapter.createThread(create);
    await harness.behavior.setSettings({ projectIds: "proj_other" });
    await expect(adapter.getOperation({ operationId: op.id })).rejects.toMatchObject({ code: "not_found" });
  });
  it("rejects offline hosts and unknown models before dispatch", async () => {
    const { adapter, harness } = adapterHost();
    await expect(adapter.createThread({ ...create, model: "invented" })).rejects.toMatchObject({ code: "invalid_model" });
    harness.inspection.sdk.stub("hosts.list", async () => [{ id: "host_linux", status: "disconnected" }]);
    await expect(adapter.createThread(create)).rejects.toMatchObject({ code: "host_offline" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("returns BB queue delivery and wait reason", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.send", async () => ({ ok: true, delivery: "queued", queuedMessage: makeQueueEntry({ id: "q_one", waitingOn: { kind: "interaction" } }) }));
    const op = await adapter.sendMessage({ threadId: "thr_test", message: "Follow up", mode: "queue", idempotencyKey: "follow-up" });
    expect(op.response).toMatchObject({ delivery: "queued", afterSeq: 0, queuedMessage: { id: "q_one", waitingOn: { kind: "interaction" } } });
  });
  it("observes a plugin prompt even without a lifecycle event", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "prompt", createdAt: 1, payload: { kind: "plugin" } }]);
    expect(await adapter.getThread({ threadId: "thr_test" })).toMatchObject({ activity: "waiting_for_input", interactionCount: 1, taskCompletion: "not_inferred" });
  });
  it("reports a failed provider turn even after the runtime becomes idle", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.events.list", async () => [{ id: "end", type: "turn/completed", seq: 11, createdAt: 11, scope: { kind: "turn", turnId: "failed" }, data: { status: "failed" } }]);
    expect(await adapter.getThread({ threadId: "thr_test" })).toMatchObject({ status: "idle", activity: "failed", lastTurn: { status: "failed" } });
  });
  it("does not label old output as the current instruction's result", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.events.list", async (args: { types?: string[] }) => args.types?.[0] === "turn/completed" ? [{ id: "end", type: "turn/completed", seq: 11, createdAt: 11, scope: { kind: "turn", turnId: "old" }, data: { status: "completed" } }] : [
      { id: "request", type: "client/turn/requested", seq: 12, createdAt: 12, scope: { kind: "thread" }, data: {} },
      { id: "out", type: "item/completed", seq: 10, createdAt: 10, scope: { kind: "turn", turnId: "old" }, data: { item: { id: "text", type: "agentMessage", text: "Old answer" } } },
    ]);
    expect(await adapter.getResult({ threadId: "thr_test", afterSeq: 0 })).toMatchObject({ resultPredatesLatestRequest: true, isCurrentTurnResult: false });
  });
  it("advances event cursors only through the bounded page", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.events.list", async () => Array.from({ length: 50 }, (_, n) => ({ id: String(n), seq: n + 1, type: "item/completed", scope: { kind: "thread" }, createdAt: 1, data: { item: { id: String(n), type: "agentMessage", text: "x".repeat(10000) } } })));
    const result = await adapter.getEvents({ threadId: "thr_test", afterSeq: 0, limit: 50 });
    expect(result.events.length).toBeLessThan(50); expect(result.nextAfterSeq).toBe(result.events.length); expect(result.mayHaveMore).toBe(true);
  });
});

describe("MCP transport", () => {
  for (const mode of ["legacy", "auto"] as const) it(`discovers and calls tools using ${mode} negotiation`, async () => {
    const { bb, harness } = host(); plugin(bb);
    const client = new Client({ name: "bb-mcp-test", version: "1" }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:38886/mcp"), {
      requestInit: { headers: { "x-bb-plugin-token": "test-token", host: "127.0.0.1:38886" } },
      fetch: async (_url, init) => harness.behavior.fetchHttp(init?.method ?? "GET", "/mcp", init),
    });
    cleanup.push(() => client.close()); await client.connect(transport);
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(12);
    const result = await client.callTool({ name: "bb_list_projects", arguments: {} });
    expect(result.isError).toBeFalsy(); expect(result.structuredContent).toEqual({ data: { projects: [{ id: "proj_allowed", name: "Allowed" }], defaultHostId: "host_linux" } });
    const invalid = await client.callTool({ name: "bb_create_thread", arguments: { ...create, permissionMode: "full" } });
    expect(invalid.isError).toBe(true);
  });
  it("requires header auth and rejects foreign origins, hosts, and oversized bodies", async () => {
    const { bb, harness } = host(); plugin(bb);
    const fetch = (headers: Record<string, string>, body = "{}") => harness.behavior.fetchHttp("POST", "/mcp", { headers: { host: "127.0.0.1:38886", "content-type": "application/json", ...headers }, body });
    expect((await fetch({})).status).toBe(401);
    expect((await fetch({ "x-bb-plugin-token": "test", origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch({ "x-bb-plugin-token": "test", host: "evil.example" })).status).toBe(403);
    expect((await fetch({ "x-bb-plugin-token": "test" }, "x".repeat(65537))).status).toBe(413);
  });
});
