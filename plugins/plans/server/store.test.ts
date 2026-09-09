import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { planSchema, type Plan } from "../contract";
import plugin from "../server";
import { createStore, MIGRATIONS, PLAN_CONTENT_LIMIT, planContentBytes } from "./store";

const disposers: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.useRealTimers();
});
const oldPlan = () => ({
  id: "legacy", title: "Legacy", status: "review", threadId: "thread-1", projectId: "project-1", projectName: "Project", createdAt: 1, updatedAt: 1,
  versions: [{ id: "v1", number: 1, markdown: "Legacy text", createdAt: 1 }],
  comments: [
    { id: "a1", versionId: "v1", quote: "Legacy", body: "First unsent", createdAt: 2, sentAt: null },
    { id: "a2", versionId: "v1", quote: "text", body: "Second unsent", createdAt: 2, sentAt: null },
  ],
});
function legacyHost() {
  const send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const host = createFakePluginHost({ pluginId: "plans", sdk: { threads: {
    get: async () => makeThreadResponse({ id: "thread-1" }), send,
  } } });
  disposers.push(() => host.harness.lifecycle.dispose());
  const db = host.bb.storage.database(); host.bb.storage.migrate(db, MIGRATIONS.slice(0, 4));
  return { ...host, db, send };
}

it("migrates unsent annotations before dropping named pending deliveries and coalesces once", async () => {
  const { bb, db, harness, send } = legacyHost();
  const old = oldPlan();
  for (const plan of [old, { ...old, id: "approved", status: "approved" }, { ...old, id: "sample", threadId: null }]) {
    db.prepare("INSERT INTO plans VALUES (?, ?)").run(plan.id, JSON.stringify(plan));
  }
  for (const id of ["pending-a", "pending-b"]) db.prepare("INSERT INTO deliveries (id, plan_id, payload, state) VALUES (?, 'legacy', '{}', 'pending')").run(id);
  const migrate = bb.storage.migrate.bind(bb.storage);
  const migrateSpy = vi.spyOn(bb.storage, "migrate").mockImplementation((database, statements) => {
    if (statements.some((sql) => sql.startsWith("DROP TABLE"))) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'deliveries'").get()).toBeDefined();
      expect(db.prepare("SELECT plan_id FROM outbox").all()).toEqual([{ plan_id: "legacy" }, { plan_id: "legacy" }]);
      const persisted = JSON.parse((db.prepare("SELECT body FROM plans WHERE id = 'legacy'").get() as { body: string }).body);
      expect(persisted.comments.map((item: { number: number }) => item.number)).toEqual([1, 2]);
    }
    migrate(database, statements);
  });
  plugin(bb); migrateSpy.mockRestore();
  const warnings = harness.inspection.logEntries.filter((entry) => JSON.stringify(entry).includes("Dropping old pending deliveries"));
  expect(warnings).toHaveLength(1); expect(JSON.stringify(warnings)).toContain("pending-a, pending-b");
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('waits', 'deliveries')").all()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(send).toHaveBeenCalledTimes(1);
  const call = harness.inspection.sdk.callsTo("threads.send")[0];
  expect(JSON.stringify(call)).toContain("2 new items");
  expect(JSON.stringify(call)).toContain("First unsent"); expect(JSON.stringify(call)).toContain("Second unsent");
  const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
  await vi.advanceTimersByTimeAsync(300_000); expect(send).toHaveBeenCalledTimes(1);
});

it.each(["near", "above"])("starts with %s-limit legacy content and preserves it before DROP", async (size) => {
  const { bb, db, harness, send } = legacyHost();
  const old = oldPlan();
  old.versions = Array.from({ length: size === "above" ? 21 : 20 }, (_, index) => ({ id: `v${index + 1}`, number: index + 1, markdown: "x".repeat(index === 19 && size === "near" ? 90_000 : 100_000), createdAt: 1 }));
  if (size === "near") old.versions[19]!.markdown += "x".repeat(1_999_999 - Buffer.byteLength(JSON.stringify(old)));
  db.prepare("INSERT INTO plans VALUES (?, ?)").run(old.id, JSON.stringify(old));
  const migrate = bb.storage.migrate.bind(bb.storage);
  const spy = vi.spyOn(bb.storage, "migrate").mockImplementation((database, statements) => {
    if (statements.some((sql) => sql.startsWith("DROP TABLE"))) {
      const rewritten = JSON.parse((db.prepare("SELECT body FROM plans").get() as { body: string }).body);
      expect(rewritten.status).toBe("open");
      expect(rewritten.versions.map((item: { markdown: string }) => item.markdown)).toEqual(old.versions.map((item) => item.markdown));
    }
    migrate(database, statements);
  });
  expect(() => plugin(bb)).not.toThrow(); spy.mockRestore();
  const saved = await harness.behavior.callRpc("get", { id: old.id }) as Plan;
  expect(saved.versions).toHaveLength(old.versions.length);
  if (size === "above") expect(JSON.stringify(harness.inspection.logEntries)).toContain("Plan legacy exceeds the history limit");
  await vi.advanceTimersByTimeAsync(301_500);
  expect(send).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT state, attempts FROM outbox").all()).toEqual([{ state: "delivered", attempts: 0 }, { state: "delivered", attempts: 0 }]);
  if (size === "above") expect(JSON.stringify(harness.inspection.logEntries)).toContain("delivery receipt saved; document metadata update failed");
});

it("caps explicit content bytes and permits delivery metadata at exactly 2 MB", () => {
  const host = createFakePluginHost({ pluginId: "plans" }); disposers.push(() => host.harness.lifecycle.dispose());
  const store = createStore(host.bb);
  const plan = planSchema.parse(oldPlan());
  plan.versions = Array.from({ length: 20 }, (_, index) => ({ ...plan.versions[0]!, id: `v${index + 1}`, number: index + 1, markdown: "x".repeat(100_000) }));
  plan.versions[19]!.markdown = plan.versions[19]!.markdown.slice(0, 100_000 - (planContentBytes(plan) - PLAN_CONTENT_LIMIT));
  expect(planContentBytes(plan)).toBe(PLAN_CONTENT_LIMIT); store.save(plan);
  plan.comments[0]!.deliveredAt = Date.now(); plan.comments[0]!.state = "addressed"; plan.comments[0]!.number = 123456;
  plan.delivery = { queuedMessageId: "queue-1", queuedUpdatedAt: Date.now(), itemIds: ["event-1"], itemRevisions: { "event-1": 2 }, notice: "Delivery metadata" };
  expect(planContentBytes(plan)).toBe(PLAN_CONTENT_LIMIT); expect(() => store.save(plan)).not.toThrow();
  plan.comments[0]!.body += "é";
  expect(planContentBytes(plan)).toBe(PLAN_CONTENT_LIMIT + 2); expect(() => store.save(plan)).toThrow("history limit");
  expect(store.get(plan.id).comments[0]!.body).toBe("First unsent");
});
