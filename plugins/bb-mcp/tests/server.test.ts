import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeQueueEntry, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import plugin from "../server";
import { createAdapter } from "../adapter";
import { defineSettings } from "../config";
import { createStore } from "../store";
import { createThreadManager } from "../thread-management";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const config = { permissionMode: "accept-edits", providerIds: "claude-code", createsPerHour: 1, maxPendingOperations: 1, requestsPerMinute: 1, projectIds: "proj_allowed", hostIds: "host_linux", defaultHostId: "host_linux", appUrl: "https://bb.example.com", endpointUrl: "https://mcp.example.com/mcp" };
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
function adapterHost() { const h = host(); const settings = defineSettings(h.bb); const store = createStore(h.bb); return { ...h, settings, store, adapter: createAdapter(h.bb, settings, store) }; }
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
    const a = store.run(scope, "same-key", create, dispatch);
    const b = store.run(scope, "same-key", { ...create }, dispatch);
    release(); const [one, two] = await Promise.all([a, b]);
    expect(one).toEqual(two); expect(one.state).toBe("accepted"); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await store.run(scope, "same-key", create, dispatch)).toEqual(one);
  });
  it("rejects the same key with another payload", async () => {
    const { store } = adapterHost(); await store.run(scope, "key", create, async () => ({}));
    await expect(store.run(scope, "key", { ...create, prompt: "Changed" }, async () => ({}))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("keeps a lost response unknown without redispatch", async () => {
    const { store } = adapterHost(); const dispatch = vi.fn(async () => { throw new Error("secret provider URL"); });
    const first = await store.run(scope, "key", create, dispatch);
    expect(first.state).toBe("outcome_unknown");
    expect(await store.run(scope, "key", create, dispatch)).toEqual(first); expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first.error?.message).toBe("secret provider URL");
  });
  it("recovers a persisted in-flight request on reload without repeating it", async () => {
    const { bb, harness, store } = adapterHost();
    const first = await store.run(scope, "key", create, async () => ({ threadId: "thr_test" }));
    bb.storage.database().prepare("UPDATE operations SET body = json_set(body, '$.state', 'pending')").run();
    let recovered!: ReturnType<typeof createStore>;
    await harness.lifecycle.reload(next => { recovered = createStore(next); });
    expect(recovered.get(first.id)?.state).toBe("outcome_unknown");
    const dispatch = vi.fn(async () => ({})); await recovered.run(scope, "key", create, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("has no hourly, pending or ledger-count admission caps", async () => {
    const { store, bb } = adapterHost();
    const db = bb.storage.database();
    db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO operations(id,key_hash,body) SELECT 'old_'||x,'old_'||x,json_object('id','old_'||x,'state','accepted','kind','create','createdAt',?) FROM n").run(Date.now());
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const jobs = Array.from({ length: 25 }, (_, i) => store.run(scope, "new-" + i, create, async () => { await gate; return {}; }));
    release();
    expect((await Promise.all(jobs)).every(op => op.state === "accepted")).toBe(true);
    expect(store.list()).toHaveLength(10026);
  });
});

describe("BB boundary", () => {
  it("retires stored allowlists and ceilings rather than silently retaining them", async () => {
    const { settings, adapter, harness } = adapterHost();
    expect(Object.keys(await settings.get())).not.toContain("permissionMode");
    const op = await adapter.createThread({ ...create, projectId: "proj_private", permissionMode: "full", model: "custom-model", providerId: "acp-grok" });
    expect(op.state).toBe("accepted");
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ permissionMode: "full", model: "custom-model", providerId: "acp-grok", executionInputSources: { model: "explicit", providerId: "explicit", permissionMode: "explicit" } });
  });
  it("only reconciles an unknown request with a thread in its recorded scope", async () => {
    const { adapter, store, harness } = adapterHost();
    const op = await store.run(scope, "unknown", create, async () => { throw new Error("lost"); });
    harness.inspection.sdk.stub("environments.get", async () => ({ ...env, hostId: "host_private" }));
    await expect(adapter.reconcileOperation(op.id, t.id)).rejects.toMatchObject({ code: "conflict" });
    harness.inspection.sdk.stub("environments.get", async () => env);
    expect(await adapter.reconcileOperation(op.id, t.id)).toMatchObject({ state: "accepted", response: { reconciliation: "operator_confirmed", threadId: t.id } });
    await expect(adapter.reconcileOperation(op.id, t.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("creates a visible worktree on the configured host without opening a pane", async () => {
    const { adapter, harness } = adapterHost(); const response = await adapter.createThread(create);
    expect(response.state).toBe("accepted");
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ environment: { type: "host", hostId: "host_linux", workspace: { type: "managed-worktree" } }, visibility: "visible" });
    expect(harness.inspection.sdk.callsTo("threads.open")).toHaveLength(0);
  });
  it("treats empty project and host scopes as unrestricted and selects a connected host", async () => {
    const { adapter, harness } = adapterHost();
    await harness.behavior.setSettings({ defaultHostId: "" });
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
  it("reads any project's threads, including threads without environments", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ ...t, projectId: "proj_private", environmentId: null }));
    expect(await adapter.getThread({ threadId: t.id })).toMatchObject({ projectId: "proj_private", hostId: null, environmentId: null });
    const result = await adapter.listThreads({ offset: 0, limit: 1000 });
    expect(result.threads).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).toMatchObject({ limit: 1000, includeHidden: true });
    expect(harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).not.toHaveProperty("projectId");
  });
  it("creates Personal threads in native Personal workspaces and continues through short native pages", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("projects.list", async () => [{ id: "proj_personal", kind: "personal", name: "Personal" }]);
    await adapter.createThread({ ...create, projectId: "proj_personal" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ projectId: "proj_personal", environment: { type: "host", workspace: { type: "personal" } } });
    expect(await adapter.listThreads({ offset: 0, limit: 1000 })).toMatchObject({ nextOffset: 1 });
    harness.inspection.sdk.stub("threads.list", async () => []);
    expect(await adapter.listThreads({ offset: 1, limit: 1000 })).toMatchObject({ nextOffset: null });
  });
  it("keeps receipts readable despite retired scope settings", async () => {
    const { adapter, harness } = adapterHost(); const op = await adapter.createThread(create);
    expect((await adapter.getOperation({ operationId: op.id })).id).toBe(op.id);
  });
  it("lets BB validate explicit hosts/models and reports native dispatch errors", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Host unavailable: host_offline"); });
    const result = await adapter.createThread({ ...create, model: "custom" });
    expect(result).toMatchObject({ state: "outcome_unknown", error: { message: "Host unavailable: host_offline" } });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
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
  it("returns full event pages without clipping content or tool payloads", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.events.list", async () => Array.from({ length: 50 }, (_, n) => ({ id: String(n), seq: n + 1, type: "item/completed", scope: { kind: "thread" }, createdAt: 1, data: { item: { id: String(n), type: "agentMessage", text: "x".repeat(10000) } } })));
    const result = await adapter.getEvents({ threadId: "thr_test", afterSeq: 0, limit: 50 });
    expect(result.events).toHaveLength(50); expect(result.events[0].item?.content).toMatchObject({ text: "x".repeat(10000), truncated: false }); expect(result.nextAfterSeq).toBe(result.events.length); expect(result.mayHaveMore).toBe(true);
  });
  it("continues through short native event pages until empty", async () => {
    const { adapter, harness } = adapterHost();
    const request = { id: "request", type: "client/turn/requested", seq: 1, createdAt: 1, scope: { kind: "thread" }, data: {} };
    const out = { id: "out", type: "item/completed", seq: 2, createdAt: 2, scope: { kind: "turn", turnId: "one" }, data: { item: { id: "text", type: "agentMessage", text: "Answer" } } };
    harness.inspection.sdk.stub("threads.events.list", async (args: { types?: string[]; beforeSeq?: string; afterSeq?: string; order?: string }) => {
      if (args.types?.[0] === "turn/completed") return [];
      if (args.order === "asc") return args.afterSeq === "0" ? [request] : [];
      return !args.beforeSeq ? [out] : args.beforeSeq === "2" ? [request] : [];
    });
    expect(await adapter.getEvents({ threadId: t.id, afterSeq: 0, limit: 1000 })).toMatchObject({ nextAfterSeq: 1, mayHaveMore: true });
    expect(await adapter.getEvents({ threadId: t.id, afterSeq: 1, limit: 1000 })).toMatchObject({ nextAfterSeq: 1, mayHaveMore: false });
    expect(await adapter.getResult({ threadId: t.id, afterSeq: 0 })).toMatchObject({ result: { seq: 2 }, lastRequestSeq: 1 });
  });
});

describe("product parity", () => {
  it("creates real children with inherited visibility and explicit execution choices", async () => {
    const { adapter, harness } = adapterHost();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ ...t, id: "thr_parent", visibility: "hidden" }));
    await adapter.createThread({ ...create, parentThreadId: "thr_parent", permissionMode: "full" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ parentThreadId: "thr_parent", visibility: "hidden", permissionMode: "full" });
  });
  it("forwards execution choices, leaving provider validation to BB", async () => {
    const { adapter, harness } = adapterHost();
    await adapter.createThread({ ...create, model: model.model, reasoningLevel: "low", permissionMode: "full", serviceTier: "fast" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ model: model.model, reasoningLevel: "low", permissionMode: "full", serviceTier: "fast" });
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
  it("deduplicates handoffs without enforcing retired quotas", async () => {
    const { adapter, harness } = adapterHost();
    const args = { sourceThreadId: t.id, prompt: "Continue", idempotencyKey: "handoff-retry" };
    const [one, two] = await Promise.all([adapter.handoffThread(args), adapter.handoffThread(args)]);
    expect(one.id).toBe(two.id); expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect((await adapter.handoffThread(args)).id).toBe(one.id);
    await expect(adapter.handoffThread({ ...args, prompt: "Different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await adapter.createThread(create)).state).toBe("accepted");
  });
  it("updates sticky model/reasoning and metadata without dispatching work", async () => {
    const { adapter, harness } = adapterHost();
    const args = { threadId: t.id, title: "Updated", model: model.model, reasoningLevel: "low" as const, parentThreadId: null, visibility: "hidden" as const };
    expect(await adapter.updateThread(args)).toMatchObject({ executionApplies: "next_and_later_turns", activeTurnRestarted: false });
    expect(harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toEqual(args);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("forwards custom models/reasoning without requiring a cached catalog", async () => {
    const { adapter, harness } = adapterHost();
    await adapter.updateThread({ threadId: t.id, model: "custom", reasoningLevel: "max" });
    expect(harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toMatchObject({ model: "custom", reasoningLevel: "max" });
    expect(harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
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
  it("leaves omitted permissions to BB and forwards explicit full access", async () => {
    const { adapter, harness } = adapterHost();
    await adapter.sendMessage({ threadId: t.id, message: "Continue", mode: "queue" });
    expect(harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).not.toHaveProperty("permissionMode");
    await adapter.sendMessage({ threadId: t.id, message: "Continue", mode: "queue", permissionMode: "full" });
    expect(harness.inspection.sdk.callsTo("threads.send")[1]?.[0]).toMatchObject({ permissionMode: "full" });
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
  it("accepts large input/output and more than 120 calls without plugin throttling", async () => {
    const { bb, harness } = host(); plugin(bb);
    const client = new Client({ name: "uncapped", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:38886/mcp"), {
      requestInit: { headers: { "x-bb-plugin-token": "test-token", host: "127.0.0.1:38886" } },
      fetch: async (_url, init) => harness.behavior.fetchHttp(init?.method ?? "GET", "/mcp", init),
    });
    cleanup.push(() => client.close()); await client.connect(transport);
    const long = "x".repeat(1048577);
    harness.inspection.sdk.stub("threads.events.list", async () => [{ id: "large", seq: 1, type: "item/completed", scope: { kind: "thread" }, data: { item: { type: "agentMessage", text: long } } }]);
    const result = await client.callTool({ name: "bb_get_events", arguments: { threadId: t.id, limit: 1000 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ data: { events: [{ data: { item: { text: long } } }] } });
    const results = await Promise.all(Array.from({ length: 130 }, () => client.callTool({ name: "bb_list_projects", arguments: {} })));
    expect(results.every(r => !r.isError)).toBe(true);
    const noKey = await client.callTool({ name: "bb_send_message", arguments: { threadId: t.id, message: long } });
    expect(noKey.isError).toBeFalsy();
    expect(harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ input: [{ text: long }] });
  });
  for (const mode of ["legacy", "auto"] as const) it(`discovers and calls tools using ${mode} negotiation`, async () => {
    const { bb, harness } = host(); plugin(bb);
    const client = new Client({ name: "bb-mcp-test", version: "1" }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:38886/mcp"), {
      requestInit: { headers: { "x-bb-plugin-token": "test-token", host: "127.0.0.1:38886" } },
      fetch: async (_url, init) => harness.behavior.fetchHttp(init?.method ?? "GET", "/mcp", init),
    });
    cleanup.push(() => client.close()); await client.connect(transport);
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(35);
    for (const forbidden of ["bb_cli", "bb_call_api", "bb_search_api", "bb_describe_api", "bb_delete_thread"]) {
      expect(tools.tools.map(t => t.name)).not.toContain(forbidden);
      await expect(client.callTool({ name: forbidden, arguments: {} })).rejects.toThrow("not found");
    }
    const injected = await client.callTool({ name: "bb_stop_thread", arguments: { threadId: t.id, method: "plugins.remove", args: { pluginId: "bb-mcp" } } });
    expect(injected.isError).toBe(true);
    const result = await client.callTool({ name: "bb_list_projects", arguments: {} });
    expect(result.isError).toBeFalsy(); expect(result.structuredContent).toEqual({ data: { projects: [{ id: "proj_allowed", name: "Allowed" }, { id: "proj_private", name: "Private" }], defaultHostId: "host_linux" } });
    const invalid = await client.callTool({ name: "bb_create_thread", arguments: { ...create, permissionMode: "full" } });
    expect(invalid.isError).toBeFalsy();
    const unsupportedUpdate = await client.callTool({ name: "bb_update_thread", arguments: { threadId: t.id, permissionMode: "auto" } });
    expect(unsupportedUpdate.isError).toBe(true);
    const capabilities = await client.callTool({ name: "bb_get_capabilities", arguments: {} });
    expect(capabilities.structuredContent).toMatchObject({ data: { version: "0.3.1", access: "thread-management-with-permission-approvals", pluginLimits: null } });
  });
  it("requires header auth and rejects foreign origins and hosts", async () => {
    const { bb, harness } = host(); plugin(bb);
    const fetch = (headers: Record<string, string>, body = "{}") => harness.behavior.fetchHttp("POST", "/mcp", { headers: { host: "127.0.0.1:38886", "content-type": "application/json", ...headers }, body });
    expect((await fetch({})).status).toBe(401);
    expect((await fetch({ "x-bb-plugin-token": "test", origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch({ "x-bb-plugin-token": "test", host: "evil.example" })).status).toBe(403);
  });
});

describe("thread management and approvals", () => {
  function managerHost() { const h = adapterHost(); return { ...h, manager: createThreadManager(h.bb, h.store) }; }
  const target = { threadId: t.id, interactionId: "approval_one" };
  const permissions = { fileSystem: { read: ["/tmp/requested"], write: [] }, network: { enabled: false } };
  const approval = () => ({ ...target, id: target.interactionId, createdAt: 1, status: "pending", expiresAt: null, payload: { kind: "approval", availableDecisions: ["allow_once", "allow_for_session", "deny"], subject: { kind: "permission_grant", permissions } } });
  it.each(["allow_once", "allow_for_session", "deny"] as const)("resolves a specific pending permission using %s", async decision => {
    const { manager, harness } = managerHost();
    harness.inspection.sdk.stub("threads.interactions.get", async () => approval());
    harness.inspection.sdk.stub("threads.interactions.resolve", async (args: unknown) => args);
    await manager.approve({ ...target, decision });
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")[0]?.[0]).toEqual({ ...target, resolution: decision === "deny" ? { decision } : { decision, grantedPermissions: permissions } });
    expect(harness.inspection.sdk.callsTo("hosts.update")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });
  it("uses a command's session grant only for a session decision and accepts an explicit narrower grant", async () => {
    const { manager, harness } = managerHost();
    harness.inspection.sdk.stub("threads.interactions.get", async () => ({ ...approval(), payload: { ...approval().payload, subject: { kind: "command", command: "true", sessionGrant: permissions } } }));
    harness.inspection.sdk.stub("threads.interactions.resolve", async (args: unknown) => args);
    await manager.approve({ ...target, decision: "allow_once" });
    await manager.approve({ ...target, decision: "allow_for_session" });
    await manager.approve({ ...target, decision: "allow_for_session", grantedPermissions: { fileSystem: null, network: null } });
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve").map(c => c[0])).toEqual([
      { ...target, resolution: { decision: "allow_once", grantedPermissions: null } },
      { ...target, resolution: { decision: "allow_for_session", grantedPermissions: permissions } },
      { ...target, resolution: { decision: "allow_for_session", grantedPermissions: { fileSystem: null, network: null } } },
    ]);
  });
  it("rejects mismatched, expired, settled and unsupported approval requests before resolving", async () => {
    const { manager, harness } = managerHost();
    for (const [request, code] of [
      [{ ...approval(), threadId: "other" }, "interaction_mismatch"],
      [{ ...approval(), id: "other" }, "interaction_mismatch"],
      [{ ...approval(), status: "resolved" }, "interaction_not_pending"],
      [{ ...approval(), expiresAt: 1 }, "interaction_not_pending"],
      [{ ...approval(), payload: { ...approval().payload, availableDecisions: ["deny"] } }, "unsupported_decision"],
      [{ ...approval(), payload: { kind: "user_question", questions: [] } }, "not_approval"],
    ] as const) {
      harness.inspection.sdk.stub("threads.interactions.get", async () => request);
      await expect(manager.approve({ ...target, decision: "allow_once" })).rejects.toMatchObject({ code });
    }
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(0);
  });
  it("replays keyed approval receipts after the interaction has already resolved", async () => {
    const { manager, harness } = managerHost();
    harness.inspection.sdk.stub("threads.interactions.get", async () => approval());
    harness.inspection.sdk.stub("threads.interactions.resolve", async () => ({ status: "resolved" }));
    const args = { ...target, decision: "allow_once" as const, idempotencyKey: "approval-once" };
    const first = await manager.approve(args);
    harness.inspection.sdk.stub("threads.interactions.get", async () => { throw new Error("already resolved"); });
    expect(await manager.approve(args)).toEqual(first);
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(1);
    await expect(manager.approve({ ...args, decision: "deny" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("answers provider questions and plugin forms through their native interaction endpoint", async () => {
    const { manager, harness } = managerHost();
    harness.inspection.sdk.stub("threads.interactions.get", async () => ({ ...approval(), payload: { kind: "user_question", questions: [] } }));
    harness.inspection.sdk.stub("threads.interactions.resolve", async (args: unknown) => args);
    const answers = { Q1: { selected: ["existing"], freeText: "Use this worktree" } };
    await manager.answer({ ...target, answers });
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")[0]?.[0]).toEqual({ ...target, resolution: { kind: "user_answer", answers } });
    harness.inspection.sdk.stub("threads.interactions.get", async () => ({ ...approval(), payload: { kind: "plugin", data: { schema: {} } } }));
    harness.inspection.sdk.stub("threads.interactions.respond", async (args: unknown) => args);
    await manager.answer({ ...target, value: { answer: "Yes" } });
    expect(harness.inspection.sdk.callsTo("threads.interactions.respond")[0]?.[0]).toEqual({ ...target, value: { answer: "Yes" } });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });
  it("cannot smuggle an approval through the question/form tool", async () => {
    const { manager, harness } = managerHost();
    harness.inspection.sdk.stub("threads.interactions.get", async () => approval());
    await expect(manager.answer({ ...target, value: { decision: "allow_for_session" } })).rejects.toMatchObject({ code: "approval_required" });
    expect(harness.inspection.sdk.callsTo("threads.interactions.respond")).toHaveLength(0);
  });
  it("preserves native queue versions, target IDs, ordering and explicit send-now semantics", async () => {
    const { manager, harness } = managerHost();
    const q = { threadId: t.id, queuedMessageId: "q_one" };
    for (const method of ["threads.queue.list", "threads.queuedMessages.update", "threads.queuedMessages.reorder", "threads.queuedMessages.delete", "threads.queuedMessages.send"]) harness.inspection.sdk.stub(method, async (args: unknown) => args);
    await manager.listQueue({});
    await manager.updateQueued({ ...q, message: "Revised", expectedUpdatedAt: 123 });
    const order = { ...q, previousQueuedMessageId: null, nextQueuedMessageId: "q_two" };
    await manager.reorderQueued(order);
    await manager.cancelQueued(q);
    await manager.sendQueued({ ...q, mode: "steer", idempotencyKey: "send-queued" });
    await manager.sendQueued({ ...q, mode: "steer", idempotencyKey: "send-queued" });
    expect(harness.inspection.sdk.callsTo("threads.queue.list")[0]?.[0]).toEqual({});
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.update")[0]?.[0]).toEqual({ ...q, expectedUpdatedAt: 123, input: [{ type: "text", text: "Revised", mentions: [] }] });
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.reorder")[0]?.[0]).toEqual(order);
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.delete")[0]?.[0]).toEqual(q);
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.send")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.send")[0]?.[0]).toEqual({ ...q, mode: "steer" });
  });
  it("offers explicit lifecycle and organization operations but no permanent deletion", async () => {
    const { manager, adapter, harness } = managerHost();
    for (const method of ["threads.fork", "threads.retry", "threads.archive", "threads.unarchive", "threads.pin", "threads.unpin", "threads.markRead", "threads.markUnread", "threads.reorderPinned", "threadSections.list", "threadSections.create", "threadSections.update"]) harness.inspection.sdk.stub(method, async (args: unknown) => args);
    await manager.fork({ sourceThreadId: t.id, sourceSeqEnd: 50, environmentId: env.id });
    await manager.retry({ threadId: t.id, turnRequestId: "request", reason: "Retry" });
    await manager.archive({ threadId: t.id }); await manager.unarchive({ threadId: t.id });
    for (const pinned of [true, false]) await manager.setPinned({ threadId: t.id, pinned });
    for (const read of [true, false]) await manager.setRead({ threadId: t.id, read });
    await manager.reorderPinned({ threadId: t.id, previousThreadId: null, nextThreadId: null });
    await manager.listSections(); await manager.createSection({ name: "Work" }); await manager.renameSection({ sectionId: "s_one", name: "Review" });
    await adapter.updateThread({ threadId: t.id, sectionId: "s_one" });
    expect(harness.inspection.sdk.callsTo("threads.fork")[0]?.[0]).toEqual({ sourceThreadId: t.id, sourceSeqEnd: 50, environment: { type: "reuse", environmentId: env.id } });
    expect(harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toEqual({ threadId: t.id, sectionId: "s_one" });
    expect(harness.inspection.sdk.callsTo("threadSections.update")[0]?.[0]).toEqual({ id: "s_one", name: "Review" });
    expect(harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("projects.delete")).toHaveLength(0);
  });
  it("cancels native waits when the MCP request or plugin lifetime ends", async () => {
    const { manager, harness } = managerHost();
    harness.inspection.sdk.stub("threads.wait", async ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const cancel = new AbortController();
    const first = manager.wait({ threadId: t.id, status: "idle", timeoutMs: 1234 }, cancel.signal);
    cancel.abort(new Error("Cancelled")); await expect(first).rejects.toThrow("Cancelled");
    const second = manager.wait({ threadId: t.id });
    const observed = expect(second).rejects.toThrow("reloading");
    await harness.lifecycle.dispose(); await observed;
  });
  it("preserves but hides old general API/CLI receipt payloads from MCP", async () => {
    const { store, adapter } = managerHost();
    const old = await store.run({ ...scope, kind: "sdk:plugins.token" }, "old-admin", {}, async () => ({ token: "old-sensitive-result" }));
    await expect(adapter.getOperation({ operationId: old.id })).rejects.toMatchObject({ code: "not_found" });
    expect(store.get(old.id)?.response).toEqual({ token: "old-sensitive-result" });
  });
});
