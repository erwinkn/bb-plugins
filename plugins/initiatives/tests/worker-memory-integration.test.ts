import { describe, it, expect } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";

async function setup() {
  const { f, project } = await projectFixture();
  f.pluginRpc.mockClear();
  const scopes = new Map<string, string>();
  let ready = false;
  let offline = false;
  let requiredFailure: string | null = null;
  let failed = 0;
  f.pluginRpc.mockImplementation(async ({ pluginId, method, input }: any) => {
    if (pluginId === "account-pool-local") return { threads: input.threadIds.map((threadId: string) => ({ threadId, cache: { lastRequestAt: Date.now() - 3600000, coveredUntil: 0, prefixTokens: 480000, ttl: "5m" } })) };
    if (pluginId !== "chat-memory") return { ok: true };
    if (offline) throw new Error("memory offline");
    if (method === "attach") { const scope = `initiatives:${input.key}`; scopes.set(input.threadId, scope); return { scope }; }
    const id = scopes.get(input.threadId);
    return id ? { scope: { id, owner: "initiatives" }, mode: "optchat", tree: { ready, ingesting: !ready, failed, requiredFailure } } : null;
  });
  const spawn = async (label: string, providerId = "claude-code") => (await f.service.delegate(project.id, {
    route: "fresh", role: "work", label, note: "Implement it", profile: { providerId, model: providerId === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5", reasoningLevel: "high" },
  }))[0]!;
  const dispatch = async (threadId: string, extra = {}) => f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
    thread: f.threads.get(threadId)!, requestedExecution: { providerId: "claude-code" }, ...extra,
  } as never));
  return { f, project, scopes, spawn, dispatch, ready: () => { ready = true; }, offline: () => { offline = true; }, requiredFailure: (message: string | null) => { requiredFailure = message; failed = message ? 1 : 0; }, unrelatedFailure: () => { failed = 1; } };
}

describe("UniiChat native worker dispatch", () => {
  it("names private scopes before the first prompt and isolates two durable workers", async () => {
    const t = await setup();
    const a = await t.spawn("One"), b = await t.spawn("Two");
    expect(t.f.spawn.mock.calls.slice(-2).map(([args]) => args.pluginMetadata.memoryScope)).toEqual([`${t.project.id}:worker:1`, `${t.project.id}:worker:2`]);
    expect(await t.dispatch(a.threadId!)).toMatchObject({ action: "wait", reason: expect.stringContaining("preparing history") });
    expect(await t.dispatch(b.threadId!)).toMatchObject({ action: "wait" });
    expect(new Set(t.scopes.values()).size).toBe(2);
    t.ready();
    expect(await t.dispatch(a.threadId!)).toEqual({ action: "proceed" });
    expect(t.f.pluginRpc.mock.calls.filter(([args]) => args.method === "attach")).toHaveLength(2);
  });
  it.each(["reviewer return", "question return", "retry"])("migrates an existing worker on %s and admits the same input only after readiness", async () => {
    const t = await setup(); const a = await t.spawn("Legacy");
    t.f.metadata.delete(a.threadId!);
    const hook = () => t.dispatch(a.threadId!, { input: { text: "Return evidence", blocks: [{ type: "text", text: "Return evidence" }] } });
    // Chat memory may have run first, finding no scope. Initiatives still holds this pass.
    const beforeRecheck = t.f.harness.inspection.recheckCount;
    expect(await hook()).toMatchObject({ action: "wait" });
    // Repeated/restarted dispatch rechecks the existing persisted attachment, never reattaches.
    expect(await hook()).toMatchObject({ action: "wait" });
    expect(t.f.harness.inspection.recheckCount - beforeRecheck).toBe(1);
    t.ready(); expect(await hook()).toEqual({ action: "proceed" });
    expect(t.f.pluginRpc.mock.calls.filter(([args]) => args.method === "attach")).toHaveLength(1);
  });
  it.each(["memory-first", "initiatives-first"])("keeps preparation safe with %s hook order", async order => {
    const t = await setup(); const a = await t.spawn("Legacy");
    const memoryGate = async () => t.scopes.has(a.threadId!) && !t.f.service.workerMemory.ready(t.f.store.worker(t.project.id, 1)!)
      ? { action: "wait" } : { action: "proceed" };
    const pass = async () => {
      const hooks = order === "memory-first" ? [memoryGate, () => t.dispatch(a.threadId!)] : [() => t.dispatch(a.threadId!), memoryGate];
      for (const hook of hooks) { const decision = await hook(); if (decision.action !== "proceed") return decision; }
      return { action: "proceed" };
    };
    expect(await pass()).toMatchObject({ action: "wait" });
    t.ready();
    // The real Chat memory gate observes its own ready transition immediately.
    await t.dispatch(a.threadId!);
    expect(await pass()).toEqual({ action: "proceed" });
  });
  it.each(["memory-first", "initiatives-first"])("surfaces required-history failure rather than endless waits with %s hook order", async order => {
    const t = await setup(); const a = await t.spawn("Failed summaries");
    expect(await t.dispatch(a.threadId!)).toMatchObject({ action: "wait" });
    t.requiredFailure("UniiChat required historical summary 0+1 failed: summarizer unavailable");
    const memoryDecision = { action: "reject", message: "UniiChat required historical summary 0+1 failed: summarizer unavailable" };
    const pass = async () => {
      const hooks = order === "memory-first" ? [async () => memoryDecision, () => t.dispatch(a.threadId!)] : [() => t.dispatch(a.threadId!), async () => memoryDecision];
      // Core evaluates every hook, and terminal rejection takes precedence over waits.
      const decisions = await Promise.all(hooks.map(h => h()));
      expect(decisions.every(d => d.action === "reject")).toBe(true);
    };
    const sends = t.f.send.mock.calls.length;
    await pass(); await pass();
    expect(t.f.send.mock.calls.length).toBe(sends);
    expect(t.f.service.workerMemory.state(t.f.store.worker(t.project.id, 1)!)).toContain("summary 0+1 failed");
    t.requiredFailure(null); t.ready();
    expect(await t.dispatch(a.threadId!)).toEqual({ action: "proceed" });
  });
  it("does not reject a healthy bounded view for unrelated failed ancestors", async () => {
    const t = await setup(); const a = await t.spawn("Healthy view");
    t.unrelatedFailure(); t.ready();
    expect(await t.dispatch(a.threadId!)).toEqual({ action: "proceed" });
  });
  it("holds attach/status failures in the native queue instead of sending a resident session", async () => {
    const t = await setup(); const a = await t.spawn("Legacy"); t.offline();
    expect(await t.dispatch(a.threadId!)).toMatchObject({ action: "wait", reason: expect.stringContaining("offline"), sendAt: expect.any(Number) });
  });
  it("bypasses the shared PR-watch/work-message cold check only for proven private optchat", async () => {
    const t = await setup(); const a = await t.spawn("One");
    t.f.threads.set(a.threadId!, { ...t.f.threads.get(a.threadId!)!, status: "idle" });
    const worker = t.f.store.worker(t.project.id, 1)!;
    expect(await t.f.service.coldCache.check(worker)).toBeNull();
    expect(t.scopes.get(a.threadId!)).toBe(`initiatives:${t.project.id}:worker:1`);
    // Preparation still gates the native turn despite bypassing the history cost guard.
    expect(await t.dispatch(a.threadId!)).toMatchObject({ action: "wait" });
    const before = t.f.pluginRpc.mock.calls.length;
    expect(await t.f.service.workerMemory.ensure({ ...worker, providerId: "codex" })).toBe(false);
    expect(t.f.pluginRpc.mock.calls).toHaveLength(before);
  });
  it("bounds background migration and never enrolls native reviewer internals", async () => {
    const t = await setup(); const a = await t.spawn("One"); await t.spawn("Two");
    const third = await t.spawn("Retired");
    t.f.store.updateWorker(t.project.id, 3, { state: "retired" });
    await t.f.service.migrateWorkerMemory();
    expect(t.scopes.size).toBe(1);
    await t.f.service.migrateWorkerMemory(); await t.f.service.migrateWorkerMemory();
    expect(t.scopes.size).toBe(2); expect(t.scopes.has(third.threadId!)).toBe(false);
    const reviewerId = "native-reviewer";
    t.f.threads.set(reviewerId, { ...t.f.threads.get(a.threadId!)!, id: reviewerId, parentThreadId: a.threadId! });
    const before = t.f.pluginRpc.mock.calls.length;
    expect(await t.dispatch(reviewerId)).toEqual({ action: "proceed" });
    expect(t.f.pluginRpc.mock.calls).toHaveLength(before);
  });
});
