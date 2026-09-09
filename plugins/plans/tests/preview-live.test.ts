import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { Plan } from "../contract";
import plugin from "../server";

// Use the production server and its tools, including the real coalescing timer.
beforeEach(() => vi.resetModules());
afterEach(() => vi.useRealTimers());
it("runs the preview's annotation, reply, version update and handoff loop", async () => {
  vi.useFakeTimers();
  const preview = await import("../preview/rpc-backend");
  try {
    const plan = await preview.handleRpc("create", { title: "Live preview", markdown: "# Plan\n\nFirst step.\n\nSecond step.\n\nThird step.", threadId: "preview-thread-1" }) as Plan;
    for (const [quote, kind, body] of [["First step.", "ask", "Why?"], ["Second step.", "comment", "Change this."], ["Third step.", "redline", ""], ["Plan", "looksGood", ""]]) {
      await preview.handleRpc("addAnnotation", { id: plan.id, quote, kind, body });
    }
    await vi.advanceTimersByTimeAsync(3_100);
    const updated = await preview.handleRpc("get", { id: plan.id }) as Plan;
    expect(updated.comments.map((item) => item.state)).toEqual(["answered", "addressed", "addressed", "addressed"]);
    expect(updated.comments.every((item) => item.deliveredAt !== null)).toBe(true);
    expect(updated.comments[0]!.replies[0]).toMatchObject({ author: "agent", body: expect.any(String) });
    expect(updated.versions.at(-1)).toMatchObject({ source: "agent", summary: "Applied #3", resolves: [updated.comments[2]!.id] });
    expect(updated.versions.at(-1)!.markdown).toContain("Second step. (updated: Change this.)");
    expect(updated.versions.at(-1)!.markdown).not.toContain("Third step.");
    expect(preview.getPreviewEvents(0)).toMatchObject({ pending: true, working: false });
  } finally { await preview.disposePreview(); }
});

it("correlates failed outbox deliveries with annotation IDs without changing deliveryStatus", async () => {
  vi.useFakeTimers();
  const { bb, harness } = createFakePluginHost({ pluginId: "plans", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_1" }), send: async () => { throw new Error("Offline"); } },
    projects: { get: async () => ({ id: "proj_1", name: "Demo" }) },
  } });
  plugin(bb);
  try {
    const plan = await harness.behavior.callRpc("create", { title: "Plan", markdown: "First step.", threadId: "thr_1" }) as Plan;
    const annotated = await harness.behavior.callRpc("addAnnotation", { id: plan.id, quote: "First step.", body: "Why?", kind: "ask" }) as Plan;
    await vi.advanceTimersByTimeAsync(1_600);
    const items = await harness.behavior.callRpc("deliveryStatus", { id: plan.id }) as Array<{ id: string }>;
    expect(items).toHaveLength(1);
    expect(await harness.behavior.callRpc("annotationDeliveryStatus", { id: plan.id })).toEqual([
      expect.objectContaining({ id: items[0]!.id, annotationId: annotated.comments[0]!.id, state: "failed", attempts: 1 }),
    ]);
  } finally { await harness.lifecycle.dispose(); }
});

it("queues and appends feedback during preview work, dispatches it and answers user replies", async () => {
  vi.useFakeTimers();
  const preview = await import("../preview/rpc-backend");
  const create = async (title: string) => await preview.handleRpc("create", {
    title, markdown: "First step.\n\nSecond step.", threadId: "preview-thread-1",
  }) as Plan;
  const ask = async (plan: Plan) => await preview.handleRpc("addAnnotation", { id: plan.id, quote: "First step.", kind: "ask", body: "Why?" }) as Plan;
  const get = async (plan: Plan) => await preview.handleRpc("get", { id: plan.id }) as Plan;
  try {
    const active = await create("Active");
    await ask(active);
    await vi.advanceTimersByTimeAsync(1_000);
    const target = await create("Queued");
    const annotated = await ask(target);
    await vi.advanceTimersByTimeAsync(400);
    const steer = await create("Steer");
    await preview.handleRpc("setDeliveryMode", { id: steer.id, mode: "steer-if-active" });
    await ask(steer);
    // The first turn starts at 1500. Target feedback queues at 2500.
    await vi.advanceTimersByTimeAsync(1_200);
    expect(preview.getPreviewEvents(0).working).toBe(true);
    const queued = await get(target);
    expect(queued.delivery.queuedMessageId).not.toBeNull();
    expect(queued.comments[0]!.deliveredAt).toBeNull();
    await preview.handleRpc("replyToAnnotation", { id: target.id, annotationId: annotated.comments[0]!.id, body: "Please explain the order too." });
    // The steer message starts another turn at 2900, so the reply appends
    // at 4100 while the same queued message still awaits dispatch.
    await vi.advanceTimersByTimeAsync(1_600);
    const appended = await get(target);
    expect(appended.delivery.queuedMessageId).toBe(queued.delivery.queuedMessageId);
    expect(appended.delivery.itemIds).toHaveLength(2);
    expect(preview.getPreviewMessages()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    const dispatched = await get(target);
    expect(dispatched.delivery.queuedMessageId).toBeNull();
    expect(dispatched.comments[0]!.deliveredAt).not.toBeNull();
    expect(dispatched.comments[0]!.replies[0]!.deliveredAt).not.toBeNull();
    expect(preview.getPreviewMessages()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_600);
    const answered = await get(target);
    expect(answered.comments[0]!.replies.map((reply) => reply.author)).toEqual(["user", "agent", "agent"]);
    expect(answered.comments[0]!.replies.at(-1)!.body).toBe("Thanks, I will use this in the next change.");
  } finally { await preview.disposePreview(); }
  expect(vi.getTimerCount()).toBe(0);
});

it("removes only the selected part of a preview line", async () => {
  vi.useFakeTimers();
  const preview = await import("../preview/rpc-backend");
  try {
    const plan = await preview.handleRpc("create", { title: "Partial redline", markdown: "Keep this. Remove this. Keep that.", threadId: "preview-thread-1" }) as Plan;
    await preview.handleRpc("addAnnotation", { id: plan.id, quote: "Remove this. ", kind: "redline" });
    await vi.advanceTimersByTimeAsync(3_100);
    const updated = await preview.handleRpc("get", { id: plan.id }) as Plan;
    expect(updated.versions.at(-1)!.markdown).toBe("Keep this.  Keep that.");
    expect(updated.comments[0]!.state).toBe("addressed");
  } finally { await preview.disposePreview(); }
});

it("reapplies an edited preview comment with the corrected body", async () => {
  vi.useFakeTimers();
  const preview = await import("../preview/rpc-backend");
  try {
    const plan = await preview.handleRpc("create", { title: "Correction", markdown: "First step.", threadId: "preview-thread-1" }) as Plan;
    await preview.handleRpc("addAnnotation", { id: plan.id, quote: "First step.", kind: "comment", body: "Old request" });
    await vi.advanceTimersByTimeAsync(3_100);
    let updated = await preview.handleRpc("get", { id: plan.id }) as Plan;
    expect(updated.versions.at(-1)!.markdown).toBe("First step. (updated: Old request)");
    await preview.simulateAgent({ threadId: "preview-thread-1", input: [{ type: "text", text:
      `Plan "Correction" (plan ${plan.id}, v2) — 1 new item\n\nedited #1\n> First step.\nNew request` }] });
    updated = await preview.handleRpc("get", { id: plan.id }) as Plan;
    expect(updated.versions.at(-1)!.markdown).toBe("First step. (updated: New request)");
    expect(updated.versions).toHaveLength(3);
    expect(updated.comments[0]!.state).toBe("addressed");
  } finally { await preview.disposePreview(); }
});
