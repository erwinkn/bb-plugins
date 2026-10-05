import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { planSchema } from "../contract";
import plugin from "../server";
import { createStore } from "../server/store";

const disposers: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
  vi.useRealTimers();
});
function fixture() {
  const host = createFakePluginHost({ pluginId: "plans" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const store = createStore(host.bb);
  for (let i = 0; i < 60; i++) {
    const plan = planSchema.parse({
    id: `p${i}`, title: `Plan ${i}`, threadId: i < 3 ? "target" : "other", projectId: "project", projectName: "Project",
    createdAt: 1, updatedAt: i, status: "approved",
    versions: [{ id: `v${i}-1`, number: 1, markdown: "Original", createdAt: 1 }, { id: `v${i}-2`, number: 2, markdown: "Latest", createdAt: 2 }],
    comments: [{ id: `a${i}`, versionId: `v${i}-1`, number: 1, kind: "comment", quote: "Original", body: "Keep", state: "addressed", createdAt: 1, deliveredAt: 2, replies: [] }],
    });
    store.db.prepare("INSERT INTO plans (id, body) VALUES (?, ?)").run(plan.id, JSON.stringify(plan));
  }
  return { ...host, store };
}

it("decodes three matches and applies list order/offset/limit before validation, preserving full bodies", () => {
  const { store } = fixture();
  const parse = vi.spyOn(planSchema, "parse");
  expect(store.forThread("target").map(p => p.id)).toEqual(["p2", "p1", "p0"]);
  expect(parse).toHaveBeenCalledTimes(3);
  parse.mockClear();
  expect(store.list({ threadId: "target", offset: 1, limit: 1 }).map(p => p.id)).toEqual(["p1"]);
  expect(parse).toHaveBeenCalledTimes(1);
  parse.mockClear();
  const global = store.list({ offset: 10 });
  expect(global.map(p => p.id)).toEqual(Array.from({ length: 10 }, (_, i) => `p${49 - i}`));
  expect(parse).toHaveBeenCalledTimes(10);
  expect(global.every(p => p.versions.length === 2 && p.comments.length === 1)).toBe(true);
  expect(store.list({ threadId: "target", excludeId: "p2", limit: 1 })[0]!.id).toBe("p1");
});

it("does not validate invalid plans outside the selected thread or page", () => {
  const { store } = fixture();
  store.db.prepare("INSERT INTO plans (id, body) VALUES (?, ?)")
    .run("invalid", JSON.stringify({ threadId: "other", updatedAt: 1_000 }));
  expect(store.forThread("target")).toHaveLength(3);
  expect(store.list({ threadId: "target" })).toHaveLength(3);
  expect(store.list({ offset: 1, limit: 1 })[0]!.id).toBe("p59");
  expect(() => store.list({ limit: 1 })).toThrow();
});

it("indexes scoped/global ordering, preserves ties and reopens append-only migrations", async () => {
  const { store, bb, harness } = fixture();
  const threadQuery = store.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM plans WHERE json_extract(body, '$.threadId') = ? ORDER BY json_extract(body, '$.updatedAt') DESC, rowid DESC LIMIT 10").all("target");
  const globalQuery = store.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM plans ORDER BY json_extract(body, '$.updatedAt') DESC, rowid DESC LIMIT 10").all();
  expect(JSON.stringify(threadQuery)).toContain("plans_thread_updated");
  expect(JSON.stringify(globalQuery)).toContain("plans_updated");
  vi.setSystemTime(2);
  store.save({ ...store.get("p0"), updatedAt: 2 });
  expect(store.list({ threadId: "target" }).map(p => p.id)).toEqual(["p2", "p0", "p1"]);
  plugin(bb);
  const replacement = await harness.lifecycle.reload(plugin);
  disposers.push(() => replacement.harness.lifecycle.dispose());
  expect(await replacement.harness.behavior.callRpc("list", { threadId: "target" })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "p0", versions: expect.any(Array), comments: expect.any(Array) })]));
});

it.each(["message.queued", "message.dispatched", "message.cancelled", "thread.unarchived"] as const)("%s decodes only the event thread", async (event) => {
  const { bb, harness } = fixture();
  plugin(bb);
  const parse = vi.spyOn(planSchema, "parse");
  if (event === "thread.unarchived") await harness.behavior.emitThreadEvent(event, { thread: makeThreadResponse({ id: "target" }) });
  else await harness.behavior.emitThreadEvent(event, { entry: makeQueueEntry({ id: "q", threadId: "target", waitingOn: { kind: "interaction" } }) });
  expect(parse.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(parse.mock.calls.every(([body]) => (body as { threadId: string }).threadId === "target")).toBe(true);
  parse.mockClear();
  if (event === "thread.unarchived") await harness.behavior.emitThreadEvent(event, { thread: makeThreadResponse({ id: "no-plans" }) });
  else await harness.behavior.emitThreadEvent(event, { entry: makeQueueEntry({ id: "q", threadId: "no-plans", waitingOn: { kind: "interaction" } }) });
  expect(parse).not.toHaveBeenCalled();
});

it("signals current/prior identity and deletion without complete-body decoding", () => {
  const { store, harness } = fixture();
  const prior = store.threadId("p0");
  store.save({ ...store.get("p0"), threadId: "moved" });
  const parse = vi.spyOn(planSchema, "parse");
  store.changed("p0", prior);
  expect(parse).not.toHaveBeenCalled();
  expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({ channel: "plans-changed", payload: { id: "p0", threadId: "moved", previousThreadId: "target" } });
  store.db.prepare("DELETE FROM plans WHERE id = ?").run("p0");
  store.changed("p0", "moved");
  expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({ payload: { id: "p0", previousThreadId: "moved" } });
  store.changed("unknown");
  expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({ payload: { id: "unknown" } });
});

it("create and remove RPCs publish current and prior thread identities", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "plans", sdk: {
    threads: {
      get: async () => makeThreadResponse({ id: "target", projectId: "project" }),
      updatePluginMetadata: async () => ({}),
    },
    projects: { get: async () => ({ id: "project", name: "Project" }) },
  } });
  disposers.push(() => harness.lifecycle.dispose());
  plugin(bb);
  const plan = await harness.behavior.callRpc("create", { title: "Plan", markdown: "Keep this body", threadId: "target" }) as { id: string };
  const changes = () => harness.inspection.realtimeSignals.filter(signal => signal.channel === "plans-changed");
  expect(changes().at(-1)?.payload).toEqual({ id: plan.id, threadId: "target" });
  await harness.behavior.callRpc("remove", { id: plan.id });
  expect(changes().at(-1)?.payload).toEqual({ id: plan.id, previousThreadId: "target" });
});
