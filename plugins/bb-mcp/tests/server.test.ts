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
    providers: { list: async () => [{ id: "codex", available: true, displayName: "Codex", capabilities: { permissionModes: ["accept-edits", "auto", "full"], supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }] }], models: async () => ({ models: [model], modelLoadError: null }) },
    threads: { get: async () => t, spawn: async () => t, update: async () => t, list: async () => [t], defaultExecutionOptions: async () => null,
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
  it("treats empty project and host scopes as unrestricted and selects a connected host", async () => {
    const { adapter, harness } = adapterHost();
    await harness.behavior.setSettings({ projectIds: "", hostIds: "", defaultHostId: "" });
    expect(await adapter.listProjects()).toMatchObject({
      projects: [{ id: "proj_allowed", name: "Allowed" }, { id: "proj_private", name: "Private" }],
      defaultHostId: "host_linux",
    });
    const response = await adapter.createThread({ ...create, projectId: "proj_private", idempotencyKey: "unrestricted-scope" });
    expect(response.state).toBe("accepted");
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ environment: { type: "host", hostId: "host_linux" } });
    harness.inspection.sdk.stub("environments.get", async () => ({ ...env, hostId: "host_other" }));
    expect(await adapter.getThread({ threadId: t.id })).toMatchObject({ hostId: "host_other" });
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

describe("product parity", () => {
  it("creates a real child and inherits parent visibility and execution limits", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ ...t, id: "thr_parent", visibility: "hidden" }));
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: model.model, reasoningLevel: "low", permissionMode: "accept-edits", serviceTier: "default" }));
    await adapter.createThread({ ...create, parentThreadId: "thr_parent" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ parentThreadId: "thr_parent", permissionMode: "accept-edits", visibility: "hidden" });
    await expect(adapter.createThread({ ...create, idempotencyKey: "excessive-child", parentThreadId: "thr_parent", permissionMode: "auto" })).rejects.toMatchObject({ code: "unsupported_permissions" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("checks a parent independently from the target project and environment", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ ...t, projectId: "proj_private" }));
    await expect(adapter.createThread({ ...create, parentThreadId: "thr_private" })).rejects.toMatchObject({ code: "not_found" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("enforces operator and host permission ceilings before creation", async () => {
    const { adapter, harness } = adapterHost();
    await expect(adapter.createThread({ ...create, permissionMode: "full" })).rejects.toMatchObject({ code: "unsupported_permissions" });
    await harness.behavior.setSettings({ permissionMode: "full" });
    harness.inspection.sdk.stub("hosts.list", async () => [{ id: "host_linux", status: "connected", maxPermissionMode: "accept-edits" }]);
    await expect(adapter.createThread({ ...create, permissionMode: "auto" })).rejects.toMatchObject({ code: "unsupported_permissions" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("passes create-time execution options and rejects unsupported service tiers", async () => {
    const { adapter, harness } = adapterHost();
    await adapter.createThread({ ...create, model: model.model, reasoningLevel: "low", permissionMode: "accept-edits", serviceTier: "fast" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ model: model.model, reasoningLevel: "low", permissionMode: "accept-edits", serviceTier: "fast" });
    harness.inspection.sdk.stub("providers.list", async () => [{ id: "codex", available: true, capabilities: { permissionModes: ["auto"], supportsServiceTier: false } }]);
    await expect(adapter.createThread({ ...create, idempotencyKey: "no-fast-tier", serviceTier: "fast" })).rejects.toMatchObject({ code: "invalid_service_tier" });
  });
  it("implements handoff with BB's rich source mention and environment reuse", async () => {
    const { adapter, harness } = adapterHost();
    const op = await adapter.handoffThread({ sourceThreadId: t.id, prompt: "Continue the task", idempotencyKey: "handoff-one" });
    const call = harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0];
    expect(call).toMatchObject({ projectId: t.projectId, environment: { type: "reuse", environmentId: env.id }, input: [{ type: "text", text: "Continue from @thread:thr_test\n\nContinue the task", mentions: [{ start: 14, end: 30, resource: { kind: "thread", threadId: t.id, projectId: t.projectId } }] }] });
    expect(call).not.toHaveProperty("sourceThreadId");
    expect(call).not.toHaveProperty("originKind", "fork");
    expect(op).toMatchObject({ kind: "handoff", related: [{ threadId: t.id }], response: { handoff: { sourceThreadId: t.id, contextTransfer: "bb_thread_mention", reusedSourceEnvironment: true } } });
  });
  it("can hand off into a fresh worktree and choose a new harness", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("providers.list", async () => [{ id: "claude-code", available: true, capabilities: { permissionModes: ["auto"], supportsServiceTier: false } }]);
    await adapter.handoffThread({ sourceThreadId: t.id, prompt: "Continue", idempotencyKey: "handoff-new", reuseSourceEnvironment: false, providerId: "claude-code" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ providerId: "claude-code", environment: { type: "host", workspace: { type: "managed-worktree" } } });
  });
  it("deduplicates handoffs and applies the shared new-thread limit", async () => {
    const { adapter, harness } = adapterHost();
    const args = { sourceThreadId: t.id, prompt: "Continue", idempotencyKey: "handoff-retry" };
    const [one, two] = await Promise.all([adapter.handoffThread(args), adapter.handoffThread(args)]);
    expect(one.id).toBe(two.id); expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect((await adapter.handoffThread(args)).id).toBe(one.id);
    await expect(adapter.handoffThread({ ...args, prompt: "Different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await harness.behavior.setSettings({ createsPerHour: 1 });
    await expect(adapter.createThread(create)).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("denies handoff source scope and hides receipts after source-scope revocation", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ ...t, projectId: "proj_source" }));
    harness.inspection.sdk.stub("environments.get", async () => ({ ...env, projectId: "proj_source" }));
    const args = { sourceThreadId: t.id, projectId: "proj_allowed", reuseSourceEnvironment: false, prompt: "Continue", idempotencyKey: "handoff-scopes" };
    await expect(adapter.handoffThread(args)).rejects.toMatchObject({ code: "not_found" });
    await harness.behavior.setSettings({ projectIds: "proj_source,proj_allowed" });
    const op = await adapter.handoffThread(args);
    await harness.behavior.setSettings({ projectIds: "proj_allowed" });
    await expect(adapter.getOperation({ operationId: op.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(adapter.handoffThread(args)).rejects.toMatchObject({ code: "not_found" });
  });
  it("updates sticky model/reasoning and metadata without dispatching work", async () => {
    const { adapter, harness } = adapterHost();
    const args = { threadId: t.id, title: "Updated", model: model.model, reasoningLevel: "low" as const, parentThreadId: null, visibility: "hidden" as const };
    expect(await adapter.updateThread(args)).toMatchObject({ executionApplies: "next_and_later_turns", activeTurnRestarted: false });
    expect(harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toEqual(args);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("rejects invalid updates before changing any metadata", async () => {
    const { adapter, harness } = adapterHost();
    await expect(adapter.updateThread({ threadId: t.id, title: "Should not change", model: "unknown" })).rejects.toMatchObject({ code: "invalid_model" });
    await expect(adapter.updateThread({ threadId: t.id, reasoningLevel: "max" })).rejects.toMatchObject({ code: "invalid_reasoning" });
    await expect(adapter.updateThread({ threadId: t.id, parentThreadId: t.id })).rejects.toMatchObject({ code: "invalid_parent" });
    await expect(adapter.updateThread({ threadId: t.id })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });
  it("sends requested execution settings and replays schedules after their time passes", async () => {
    const { adapter, harness } = adapterHost();
    const args = { threadId: t.id, message: "Next turn", mode: "queue" as const, idempotencyKey: "scheduled-send", permissionMode: "accept-edits" as const, serviceTier: "fast" as const, sendAt: Date.now() + 60000 };
    const first = await adapter.sendMessage(args);
    expect(harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ permissionMode: "accept-edits", serviceTier: "fast", sendAt: args.sendAt });
    const now = vi.spyOn(Date, "now").mockReturnValue(args.sendAt + 1);
    try { expect((await adapter.sendMessage(args)).id).toBe(first.id); }
    finally { now.mockRestore(); }
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
  it("keeps inherited permissions on follow-ups and refuses excessive requests", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: model.model, permissionMode: "accept-edits", serviceTier: "default", reasoningLevel: "low" }));
    await adapter.sendMessage({ threadId: t.id, message: "Continue", mode: "queue", idempotencyKey: "inherit-mode" });
    expect(harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ permissionMode: "accept-edits" });
    await expect(adapter.sendMessage({ threadId: t.id, message: "Continue", mode: "queue", idempotencyKey: "raise-mode", permissionMode: "full" })).rejects.toMatchObject({ code: "unsupported_permissions" });
  });
  it("keeps ordinary offline-host queue delivery independent of model catalog loading", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("hosts.list", async () => [{ id: "host_linux", status: "disconnected", maxPermissionMode: "auto" }]);
    harness.inspection.sdk.stub("providers.models", async () => { throw new Error("offline catalog"); });
    harness.inspection.sdk.stub("threads.send", async () => ({ ok: true, delivery: "queued", queuedMessage: makeQueueEntry({ waitingOn: { kind: "host-offline", hostName: "Linux" } }) }));
    const op = await adapter.sendMessage({ threadId: t.id, message: "Continue later", mode: "queue", idempotencyKey: "offline-send" });
    expect(op.response).toMatchObject({ delivery: "queued", queuedMessage: { waitingOn: { kind: "host-offline" } } });
    expect(harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
  });
  it("keeps an uncertain handoff unknown without spawning it again", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("lost response"); });
    const args = { sourceThreadId: t.id, prompt: "Continue", idempotencyKey: "lost-handoff" };
    const op = await adapter.handoffThread(args);
    expect(op.state).toBe("outcome_unknown");
    expect((await adapter.handoffThread(args)).id).toBe(op.id);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("passes tree and visibility filters to BB and reports relationships", async () => {
    const { adapter, harness } = adapterHost();
    const args = { projectId: t.projectId, parentThreadId: t.id, includeHidden: true, archived: true, offset: 0, limit: 20 };
    const result = await adapter.listThreads(args);
    expect(harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).toEqual(args);
    expect(result.threads[0]).toHaveProperty("parentThreadId", null);
    expect(result.threads[0]).toHaveProperty("visibility", "visible");
  });
  it("includes hidden threads when no visibility filter is supplied", async () => {
    const { adapter, harness } = adapterHost();
    await adapter.listThreads({ projectId: t.projectId, offset: 0, limit: 20 });
    expect(harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).toMatchObject({ includeHidden: true });
    await adapter.listThreads({ projectId: t.projectId, includeHidden: false, offset: 0, limit: 20 });
    expect(harness.inspection.sdk.callsTo("threads.list")[1]?.[0]).toMatchObject({ includeHidden: false });
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
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(15);
    const result = await client.callTool({ name: "bb_list_projects", arguments: {} });
    expect(result.isError).toBeFalsy(); expect(result.structuredContent).toEqual({ data: { projects: [{ id: "proj_allowed", name: "Allowed" }], defaultHostId: "host_linux" } });
    const invalid = await client.callTool({ name: "bb_create_thread", arguments: { ...create, permissionMode: "full" } });
    expect(invalid.isError).toBe(true);
    const unsupportedUpdate = await client.callTool({ name: "bb_update_thread", arguments: { threadId: t.id, permissionMode: "auto" } });
    expect(unsupportedUpdate.isError).toBe(true);
    const capabilities = await client.callTool({ name: "bb_get_capabilities", arguments: {} });
    expect(capabilities.structuredContent).toMatchObject({ data: { version: "0.2.1", updateExecutionFields: ["model", "reasoningLevel"] } });
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
