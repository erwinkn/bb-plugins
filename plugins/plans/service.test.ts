import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server";
import { addAnnotationSchema, planSchema, type Plan } from "./contract";
import { MIGRATIONS } from "./server/store";

const disposers: Array<() => Promise<void>> = [];
const sent = () => ({ ok: true as const, delivery: "sent" as const });
const entry = (id = "queue-1") => makeQueueEntry({ id, threadId: "thread-1", updatedAt: 10 });
type Send = BbPluginApi["sdk"]["threads"]["send"];
async function setup(send = vi.fn<Send>(async () => sent()), options: Parameters<typeof plugin>[1] = {}) {
  const update = vi.fn<BbPluginApi["sdk"]["threads"]["queuedMessages"]["update"]>(async () => entry());
  const listQueue = vi.fn(async () => [entry()]);
  const deleteQueue = vi.fn(async () => ({ ok: true as const }));
  /** Thread plugin metadata by thread ID, as the server would keep it for the plans namespace. */
  const metadata: Record<string, Record<string, unknown>> = {};
  const getPluginMetadata = async ({ threadId }: { threadId: string }) => ({ ...(metadata[threadId] ?? {}) });
  const updatePluginMetadata = async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
    const namespace = (metadata[threadId] ??= {});
    Object.assign(namespace, set ?? {});
    for (const key of remove ?? []) delete namespace[key];
    if (!Object.keys(namespace).length) delete metadata[threadId];
    return { ...namespace };
  };
  const host = createFakePluginHost({ pluginId: "plans", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "env-1" }), send, queuedMessages: { update, list: listQueue, delete: deleteQueue }, getPluginMetadata, updatePluginMetadata },
    projects: { get: async () => ({ id: "project-1", name: "Test project" }) },
    environments: { get: async () => ({ id: "env-1", path: "/workspace", hostId: "host-1" }) },
    files: { read: async () => ({ content: "# File plan\nKeep schedules.", contentEncoding: "utf8" }) },
  } });
  plugin(host.bb, options);
  disposers.push(() => host.harness.lifecycle.dispose());
  const rpc = async (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<Plan>;
  const plan = await rpc("create", { title: "A plan", markdown: "# A plan\n\nKeep the existing data.", threadId: "thread-1" });
  const annotate = (body = "Keep schedules too.", kind = "comment") => rpc("addAnnotation", { id: plan.id, quote: "existing data", body, kind });
  const tool = (name: string, input: unknown, threadId = "thread-1") => host.harness.behavior.callAgentTool(name, input, { threadId });
  return { ...host, rpc, plan, send, update, listQueue, deleteQueue, annotate, tool, metadata };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.useRealTimers();
});

async function tick(ms = 1_500) { await vi.advanceTimersByTimeAsync(ms); }

describe("live plan review backend", () => {
  it("migrates old statuses, kinds, delivery timestamps, versions and stable numbers", async () => {
    const host = createFakePluginHost({ pluginId: "plans" });
    const db = host.bb.storage.database(); host.bb.storage.migrate(db, MIGRATIONS.slice(0, 4));
    const old = { id: "old", title: "Old", threadId: null, projectId: null, projectName: null, status: "revising", sample: true, createdAt: 1, updatedAt: 2,
      versions: [{ id: "v1", number: 1, markdown: "Old", createdAt: 1 }], comments: [
        { id: "later", versionId: "v1", quote: "Old", body: "", kind: "looksGood", createdAt: 5, sentAt: 8 },
        { id: "first", versionId: "v1", quote: "Old", body: "Change", createdAt: 3, sentAt: null },
      ] };
    db.prepare("INSERT INTO plans VALUES (?, ?)").run(old.id, JSON.stringify(old));
    plugin(host.bb); disposers.push(() => host.harness.lifecycle.dispose());
    const plan = await host.harness.behavior.callRpc("get", { id: old.id }) as Plan;
    expect(plan).toMatchObject({ status: "open", deliveryMode: "queue-if-active" });
    expect(plan.versions[0]).toMatchObject({ source: "user", summary: "", resolves: [] });
    expect(plan.comments[0]).toMatchObject({ number: 2, state: "addressed", deliveredAt: 8, replies: [] });
    expect(plan.comments[1]).toMatchObject({ number: 1, state: "open", kind: "comment", deliveredAt: null });
    expect(plan.comments[0]).not.toHaveProperty("sentAt");
    expect(planSchema.parse({ ...old, status: "review" }).status).toBe("open");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'waits'").get()).toBeUndefined();
    expect(JSON.parse((db.prepare("SELECT body FROM plans").get() as { body: string }).body).comments[0].number).toBe(2);
  });
  it("coalesces two quick annotations into one message", async () => {
    const { annotate, send, rpc, plan } = await setup();
    await annotate(); await tick(500); await annotate("Why keep it?", "ask");
    await tick(1_499); expect(send).not.toHaveBeenCalled(); await tick(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ threadId: "thread-1", mode: "queue-if-active", input: [{ type: "text", mentions: [], text: expect.stringMatching(/#1 comment[\s\S]*#2 ask/) }] });
    expect((await rpc("get", { id: plan.id })).comments.every((item) => item.deliveredAt !== null)).toBe(true);
  });
  it("flushes a continuous burst within five seconds", async () => {
    const { annotate, send } = await setup();
    for (let i = 0; i < 5; i++) { await annotate(`Item ${i}`); await tick(1_000); }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toEqual([{ type: "text", mentions: [], text: expect.stringMatching(/#1 comment[\s\S]*#5 comment/) }]);
  });
  it("appends to a queued row and records delivery only on dispatch", async () => {
    const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
    const { annotate, update, rpc, plan, harness } = await setup(send);
    await annotate(); await tick(); await annotate("Second"); await tick();
    expect(send).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({ threadId: "thread-1", queuedMessageId: "queue-1", expectedUpdatedAt: 10, input: [{ text: expect.stringMatching(/#1 comment[\s\S]*#2 comment/) }] });
    expect((await rpc("get", { id: plan.id })).comments[0]!.deliveredAt).toBeNull();
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: entry() });
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: entry() });
    expect((await rpc("get", { id: plan.id })).delivery.queuedMessageId).toBeNull();
    expect((await rpc("get", { id: plan.id })).comments.every((item) => item.deliveredAt !== null)).toBe(true);
    await annotate("Third"); await tick(); expect(send).toHaveBeenCalledTimes(2);
  });
  it("sends only the new batch if the old queued row is gone", async () => {
    const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
    const { annotate, update } = await setup(send);
    await annotate("First"); await tick(); update.mockRejectedValueOnce(new Error("Queue row not found"));
    await annotate("Second"); await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls[1])).toContain("Second");
    expect(JSON.stringify(send.mock.calls[1])).not.toContain("First");
  });
  it("returns immediately, holds review, and releases for a composer queue event", async () => {
    const { tool, harness } = await setup();
    const result = JSON.parse(await tool("plans_submit", { title: "New", markdown: "New plan" }) as string);
    expect(result.status).toBe("submitted"); expect(result.instruction).toContain("End your turn");
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    expect(harness.inspection.pendingInteractions[0]).toMatchObject({ rendererId: "plan-review", title: "Review plan: New", timeoutMs: 3_600_000 });
    await harness.behavior.emitThreadEvent("message.queued", { entry: makeQueueEntry({ threadId: "thread-1", waitingOn: { kind: "interaction" } }) });
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    const handoff = JSON.parse(String(await tool("plans_handoff", { planId: result.planId })));
    expect(handoff).toMatchObject({ status: "waiting" }); expect(harness.inspection.pendingInteractions).toHaveLength(1);
  });
  it("renews timeouts and stops after Skip", async () => {
    const { tool, harness, plan } = await setup(undefined, { interactionChunkMs: 1_000 });
    await tool("plans_handoff", { planId: plan.id });
    const first = harness.inspection.pendingInteractions[0]!.id;
    await tick(1_000); expect(harness.inspection.pendingInteractions[0]!.id).not.toBe(first);
    harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
    await tick(2_000); expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
  it("releases its own hold before sending and stops on prompt submission", async () => {
    const { tool, plan, annotate, harness, send } = await setup();
    await tool("plans_handoff", { planId: plan.id });
    await annotate(); await tick(); expect(send).toHaveBeenCalledTimes(1);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    await tool("plans_handoff", { planId: plan.id });
    harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, {});
    await tick(3_600_000); expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
  it("retries failed sends with backoff and publishes failure status", async () => {
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(sent());
    const { annotate, harness, plan } = await setup(send);
    await annotate(); await tick();
    const status = await harness.behavior.callRpc("deliveryStatus", { id: plan.id });
    expect(status).toEqual([expect.objectContaining({ state: "failed", attempts: 1 })]);
    expect(harness.inspection.realtimeSignals.some((signal) => signal.channel === "plans-changed")).toBe(true);
    await tick(4_999); expect(send).toHaveBeenCalledTimes(1); await tick(1); expect(send).toHaveBeenCalledTimes(2);
    await tick(300_000); expect(send).toHaveBeenCalledTimes(2);
    expect(await harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual([]);
  });
  it("uses the complete retry schedule", async () => {
    const send = vi.fn<Send>(async () => { throw new Error("offline"); });
    const { annotate } = await setup(send); await annotate(); await tick();
    for (const [index, delay] of [5_000, 30_000, 120_000, 300_000, 300_000].entries()) {
      await tick(delay - 1); expect(send).toHaveBeenCalledTimes(index + 1);
      await tick(1); expect(send).toHaveBeenCalledTimes(index + 2);
    }
  });
  it("approves idempotently and releases the hold with open annotations", async () => {
    const { rpc, tool, plan, annotate, send, harness } = await setup();
    await tool("plans_handoff", { planId: plan.id }); await annotate();
    const input = { id: plan.id, requestId: "approval-1", versionId: plan.versions[0]!.id };
    await rpc("approve", input); await rpc("approve", input);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    await tick(); expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).toContain("approved v1");
    await expect(rpc("approve", { ...input, requestId: "another" })).rejects.toThrow("already approved");
  });
  it("rejects non-unique edits without saving a version", async () => {
    const { rpc, tool } = await setup();
    const plan = await rpc("create", { title: "Repeated", markdown: "same same", threadId: "thread-1" });
    await expect(tool("plans_update", { planId: plan.id, edits: [{ old: "same", new: "new" }, { old: "missing", new: "new" }], summary: "Change" })).rejects.toThrow(/#1.*multiple matches.*#2.*no match/);
    expect((await rpc("get", { id: plan.id })).versions).toHaveLength(1);
  });
  it("updates exact text and resolves annotation numbers and IDs", async () => {
    const { annotate, plan, tool, rpc } = await setup();
    await annotate("Why?", "ask"); const annotated = await annotate();
    const result = JSON.parse(await tool("plans_update", { planId: plan.id, edits: [{ old: "existing data", new: "data and schedules" }], summary: "Include schedules", resolves: ["#1", annotated.comments[1]!.id] }) as string);
    expect(result).not.toHaveProperty("openAnnotations");
    const updated = await rpc("get", { id: plan.id });
    expect(updated.versions.at(-1)).toMatchObject({ source: "agent", summary: "Include schedules", resolves: annotated.comments.map((item) => item.id) });
    expect(updated.comments.map((item) => item.state)).toEqual(["addressed", "addressed"]);
    expect(updated.comments[0]!.replies).toEqual([]);
  });
  it("agent replies answer asks by default and can leave them open", async () => {
    const { annotate, plan, tool, rpc } = await setup(); await annotate("Why?", "ask");
    await tool("plans_reply", { planId: plan.id, annotation: "#1", body: "Looking into it.", resolve: false });
    expect((await rpc("get", { id: plan.id })).comments[0]!.state).toBe("open");
    await tool("plans_reply", { planId: plan.id, annotation: "#1", body: "To keep history." });
    const item = (await rpc("get", { id: plan.id })).comments[0]!;
    expect(item.state).toBe("answered"); expect(item.replies[1]).toMatchObject({ author: "agent", body: "To keep history." });
  });
  it("resumes pending retries after reload without restoring a hold", async () => {
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(sent());
    const { annotate, harness, plan, tool } = await setup(send);
    await tool("plans_handoff", { planId: plan.id }); await annotate(); await tick();
    const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
    expect(replacement.harness.inspection.pendingInteractions).toHaveLength(0);
    await tick(4_999); expect(send).toHaveBeenCalledTimes(1); await tick(1); expect(send).toHaveBeenCalledTimes(2);
    expect(await replacement.harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual([]);
  });
  it("resumes a coalescing batch after reload", async () => {
    const { annotate, harness, send } = await setup(); await annotate();
    const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
    await tick(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("reconciles a queued row that dispatched during reload without replay", async () => {
    const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
    const { annotate, harness, listQueue, plan } = await setup(send); await annotate(); await tick();
    listQueue.mockResolvedValue([]);
    const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
    await tick(); expect(send).toHaveBeenCalledTimes(1);
    const reloaded = await replacement.harness.behavior.callRpc("get", { id: plan.id }) as Plan;
    expect(reloaded.delivery.queuedMessageId).toBeNull(); expect(reloaded.comments[0]!.deliveredAt).not.toBeNull();
  });
  it("allows reviewer-thread CLI annotations and approval but rejects self-review", async () => {
    const { harness, plan, send, tool } = await setup();
    await tool("plans_update", { planId: plan.id, markdown: "Keep the existing data. Updated plan.", summary: "Second version" });
    const args = ["review", plan.id, "--comment", "data::Keep it", "--ask", "data::Why?", "--redline", "existing", "--looks-good", "Keep", "--approve"];
    expect((await harness.behavior.runCli(args, { threadId: "thread-1" })).exitCode).toBe(1);
    const reviewed = await harness.behavior.runCli(args, { threadId: "reviewer" });
    expect(reviewed.exitCode).toBe(0);
    const approved = JSON.parse(reviewed.stdout) as Plan;
    expect(approved.comments.map((item) => item.kind)).toEqual(["comment", "ask", "redline", "looksGood"]);
    await tick(); expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0])).toContain("approved v2");
    expect(JSON.stringify(send.mock.calls[0])).toContain(`--version-id ${approved.versions.at(-1)!.id}`);
  });
  it("reads CLI files through the SDK and removes old commands and settings", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.runCli(["submit", "plan.md", "From file"], { threadId: "thread-1", cwd: "/workspace" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("submitted");
    expect(harness.inspection.sdk.callsTo("files.read")[0]![0]).toMatchObject({ path: "/workspace/plan.md", rootPath: "/workspace", hostId: "host-1" });
    expect(harness.inspection.registrations.settingsDescriptors).toEqual({});
    expect((await harness.behavior.runCli(["wait", "id"])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["delivery", "id"])).exitCode).toBe(1);
  });
  it("edits pending annotations, drops withdrawals and delivers later replies", async () => {
    const { annotate, rpc, plan, send } = await setup();
    const added = await annotate(); const annotationId = added.comments[0]!.id;
    await rpc("updateAnnotation", { id: plan.id, annotationId, body: "Changed" });
    await tick(); expect(JSON.stringify(send.mock.calls[0])).toContain("Changed");
    await expect(rpc("updateAnnotation", { id: plan.id, annotationId, body: "Too late" })).rejects.toThrow(/cannot be edited/);
    await rpc("replyToAnnotation", { id: plan.id, annotationId, body: "User answer" }); await tick();
    expect(JSON.stringify(send.mock.calls[1])).toContain("reply on #1"); expect(JSON.stringify(send.mock.calls[1])).toContain("existing data");
    await rpc("withdrawAnnotation", { id: plan.id, annotationId }); await tick();
    expect(JSON.stringify(send.mock.calls[2])).toContain("withdrawn #1");
    const pending = await annotate("Drop this");
    await rpc("withdrawAnnotation", { id: plan.id, annotationId: pending.comments[1]!.id }); await tick();
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("removes a queued annotation from the queued row before dispatch", async () => {
    const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
    const { annotate, rpc, plan, deleteQueue } = await setup(send); const added = await annotate(); await tick();
    await rpc("withdrawAnnotation", { id: plan.id, annotationId: added.comments[0]!.id }); await tick();
    expect(deleteQueue).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    expect((await rpc("get", { id: plan.id })).delivery.queuedMessageId).toBeNull();
  });
  it("drops a queued annotation from the row once the agent resolves it", async () => {
    const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
    const { annotate, rpc, plan, tool, deleteQueue } = await setup(send); await annotate(); await tick();
    await tool("plans_update", { planId: plan.id, edits: [{ old: "existing data", new: "existing data and schedules" }], summary: "Applied #1", resolves: ["#1"] }); await tick();
    expect(deleteQueue).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    const saved = await rpc("get", { id: plan.id });
    expect(saved.delivery.queuedMessageId).toBeNull(); expect(saved.comments[0]!.state).toBe("addressed");
  });
  it("changes delivery mode for the next batch", async () => {
    const { annotate, rpc, plan, send } = await setup();
    await annotate(); await rpc("setDeliveryMode", { id: plan.id, mode: "steer-if-active" }); await tick();
    expect(send.mock.calls[0]![0].mode).toBe("steer-if-active");
    expect(JSON.stringify(send.mock.calls[0])).toContain("delivery mode: steer-if-active");
    await rpc("setDeliveryMode", { id: plan.id, mode: "queue-if-active" }); await tick();
    expect(send.mock.calls[1]![0].mode).toBe("queue-if-active");
  });
  it("deletes the plan, hold and pending outbox", async () => {
    const { tool, plan, annotate, rpc, harness, send } = await setup();
    await tool("plans_handoff", { planId: plan.id }); await annotate();
    await rpc("remove", { id: plan.id }); await tick(10_000);
    expect(harness.inspection.pendingInteractions).toHaveLength(0); expect(send).not.toHaveBeenCalled();
    await expect(rpc("get", { id: plan.id })).rejects.toThrow("Plan not found");
  });
});

it("persists a receipt when reload starts during a send", async () => {
  let finish!: (result: Awaited<ReturnType<Send>>) => void;
  const send = vi.fn<Send>(() => new Promise((resolve) => { finish = resolve; }));
  const { annotate, harness, plan } = await setup(send); await annotate(); await tick();
  const reloading = harness.lifecycle.reload(plugin);
  finish(sent());
  const replacement = await reloading; disposers.push(() => replacement.harness.lifecycle.dispose());
  await tick(30_000); expect(send).toHaveBeenCalledTimes(1);
  expect(await replacement.harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual([]);
});

it("handles dispatch before a queued send returns", async () => {
  const { annotate, harness, plan, send } = await setup();
  send.mockImplementationOnce(async () => {
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: entry() });
    return { ok: true, delivery: "queued", queuedMessage: entry() };
  });
  await annotate(); await tick();
  const planNow = await harness.behavior.callRpc("get", { id: plan.id }) as Plan;
  expect(planNow.delivery.queuedMessageId).toBeNull(); expect(planNow.comments[0]!.deliveredAt).not.toBeNull();
});

it("retries a failed queue append without resending its original items", async () => {
  const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
  const { annotate, update, harness, plan } = await setup(send); await annotate("Original"); await tick();
  update.mockRejectedValueOnce(new Error("CAS conflict"));
  await annotate("New"); await tick(); await tick(5_000);
  expect(send).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(update.mock.calls[1])).toContain("Original"); expect(JSON.stringify(update.mock.calls[1])).toContain("New");
  expect(await harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual([
    expect.objectContaining({ state: "pending", attempts: 0 }), expect.objectContaining({ state: "pending", attempts: 0 }),
  ]);
});

it("updates a queued annotation and drops just one item from a larger batch", async () => {
  const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
  const { annotate, update, rpc, plan } = await setup(send); await annotate("First"); const added = await annotate("Second"); await tick();
  await rpc("updateAnnotation", { id: plan.id, annotationId: added.comments[0]!.id, body: "Changed" }); await tick();
  expect(JSON.stringify(update.mock.calls[0])).toContain("Changed"); expect(JSON.stringify(update.mock.calls[0])).not.toContain("First");
  await rpc("withdrawAnnotation", { id: plan.id, annotationId: added.comments[1]!.id }); await tick();
  expect(JSON.stringify(update.mock.calls[1])).not.toContain("Second"); expect(JSON.stringify(update.mock.calls[1])).toContain("Changed");
  expect(send).toHaveBeenCalledTimes(1);
});

it("notifies withdrawal if dispatch wins the queue-edit race", async () => {
  const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
  const { annotate, rpc, plan, harness } = await setup(send); const added = await annotate(); await tick();
  await rpc("withdrawAnnotation", { id: plan.id, annotationId: added.comments[0]!.id });
  const input = send.mock.calls[0]![0].input;
  await harness.behavior.emitThreadEvent("message.dispatched", { entry: makeQueueEntry({ ...entry(), content: input }) });
  await tick(); expect(send).toHaveBeenCalledTimes(2); expect(JSON.stringify(send.mock.calls[1])).toContain("withdrawn #1");
});

it("keeps mutations atomic at body, version and plan size limits", async () => {
  const { rpc, tool, plan } = await setup();
  await expect(rpc("addAnnotation", { id: plan.id, quote: "data", body: "x".repeat(10_001) })).rejects.toThrow();
  await expect(tool("plans_update", { planId: plan.id, markdown: "x".repeat(100_001), summary: "Too large" })).rejects.toThrow();
  const maxVersion = "x".repeat(100_000);
  for (let index = 0; index < 19; index++) await tool("plans_update", { planId: plan.id, markdown: maxVersion, summary: "Stored" });
  await expect(tool("plans_update", { planId: plan.id, markdown: maxVersion, summary: "Too much history" })).rejects.toThrow("history limit");
  expect((await rpc("get", { id: plan.id })).versions).toHaveLength(20);
});

it("falls back to queue mode only when the provider explicitly rejects steering", async () => {
  const send = vi.fn<Send>().mockRejectedValueOnce(new Error("steer-if-active is not supported by this provider")).mockResolvedValue(sent());
  const { rpc, plan } = await setup(send);
  await rpc("setDeliveryMode", { id: plan.id, mode: "steer-if-active" }); await tick();
  expect(send.mock.calls.map(([input]) => input.mode)).toEqual(["steer-if-active", "queue-if-active"]);
  const saved = await rpc("get", { id: plan.id });
  expect(saved.deliveryMode).toBe("steer-if-active"); expect(saved.delivery.notice).toContain("does not support steering");
});

it("never resends after an accepted send when document receipt storage fails", async () => {
  const { bb, annotate, send, rpc, plan, harness } = await setup();
  await annotate();
  const db = bb.storage.database();
  db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON plans
    WHEN json_extract(NEW.body, '$.comments[0].deliveredAt') IS NOT NULL
    BEGIN SELECT RAISE(FAIL, 'receipt write failed'); END`);
  await tick(); await tick(300_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT state, attempts FROM outbox").all()).toEqual([{ state: "delivered", attempts: 0 }]);
  const repaired = await rpc("get", { id: plan.id });
  expect(repaired.comments[0]!.deliveredAt).toBeTypeOf("number");
  await expect(rpc("updateAnnotation", { id: plan.id, annotationId: repaired.comments[0]!.id, body: "Too late" })).rejects.toThrow("Delivered or withdrawn annotations cannot be edited.");
  expect(JSON.stringify(harness.inspection.logEntries)).toContain("delivery receipt saved; document metadata update failed");
  db.exec("DROP TRIGGER fail_receipt");
  const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
  await tick(300_000); expect(send).toHaveBeenCalledTimes(1);
});

it.each([false, true])("sends one correction when an edit loses dispatch, reload=%s", async (reload) => {
  const send = vi.fn<Send>().mockResolvedValueOnce({ ok: true, delivery: "queued", queuedMessage: entry() }).mockResolvedValue(sent());
  const { annotate, rpc, plan, harness, listQueue, bb, update } = await setup(send);
  const added = await annotate("OLD"); await tick();
  const annotationId = added.comments[0]!.id;
  await rpc("updateAnnotation", { id: plan.id, annotationId, body: "NEW" });
  await rpc("updateAnnotation", { id: plan.id, annotationId, body: "NEWEST" });
  const edited = await rpc("get", { id: plan.id });
  expect(edited.comments[0]!.revision).toBe(2);
  expect(Object.values(edited.delivery.itemRevisions!)).toEqual([0]);
  expect(JSON.parse((bb.storage.database().prepare("SELECT payload FROM outbox").get() as { payload: string }).payload).event.revision).toBe(2);
  if (reload) {
    listQueue.mockResolvedValue([]);
    const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
  } else {
    const dispatched = makeQueueEntry({ ...entry(), content: send.mock.calls[0]![0].input });
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: dispatched });
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: dispatched });
  }
  await tick(3_000);
  expect(send).toHaveBeenCalledTimes(2); expect(update).not.toHaveBeenCalled();
  expect(JSON.stringify(send.mock.calls[1])).toContain("edited #1\\n> existing data\\nNEWEST");
  await tick(300_000); expect(send).toHaveBeenCalledTimes(2);
});

it("recovers a withdrawal when its original queue row dispatched during downtime", async () => {
  const send = vi.fn<Send>().mockResolvedValueOnce({ ok: true, delivery: "queued", queuedMessage: entry() }).mockResolvedValue(sent());
  const { annotate, rpc, plan, harness, listQueue } = await setup(send);
  const added = await annotate(); await tick();
  await rpc("withdrawAnnotation", { id: plan.id, annotationId: added.comments[0]!.id });
  listQueue.mockResolvedValue([]);
  const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
  await tick(3_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(send.mock.calls[1])).toContain("withdrawn #1");
  expect(JSON.stringify(send.mock.calls[1])).not.toContain("#1 comment");
  await tick(300_000); expect(send).toHaveBeenCalledTimes(2);
});

it("creates delivery work when editing an undelivered annotation without an event", async () => {
  const { bb, annotate, rpc, plan, send } = await setup();
  const added = await annotate("Old");
  bb.storage.database().prepare("DELETE FROM outbox WHERE plan_id = ?").run(plan.id);
  await rpc("updateAnnotation", { id: plan.id, annotationId: added.comments[0]!.id, body: "New" });
  await tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(send.mock.calls[0])).toContain("New");
  expect((await rpc("get", { id: plan.id })).comments[0]!.deliveredAt).not.toBeNull();
});

it.each(["archivedAt", "deletedAt"] as const)("drops feedback for %s and waits for a new event", async (field) => {
  const { annotate, harness, bb, rpc, plan, send } = await setup();
  const getThread = vi.fn(async () => makeThreadResponse({ id: "thread-1", [field]: 1 }));
  harness.inspection.sdk.stub("threads.get", getThread);
  await annotate(); await annotate("Second"); await tick();
  expect(send).not.toHaveBeenCalled();
  expect((await rpc("get", { id: plan.id })).delivery.notice).toBe("The linked thread is archived or deleted. Feedback was not delivered.");
  expect(bb.storage.database().prepare("SELECT state FROM outbox").all()).toEqual([{ state: "dropped" }, { state: "dropped" }]);
  await tick(600_000); expect(getThread).toHaveBeenCalledTimes(1);
  getThread.mockResolvedValue(makeThreadResponse({ id: "thread-1" }));
  await annotate("New event"); await tick();
  expect(getThread).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(send.mock.calls[0])).toContain("New event");
  expect(JSON.stringify(send.mock.calls[0])).not.toContain("Second");
});

it.each(["queue", "database"])("keeps a session usable after remove fails at %s", async (failure) => {
  const send = vi.fn<Send>().mockResolvedValueOnce({ ok: true, delivery: "queued", queuedMessage: entry() }).mockResolvedValue(sent());
  const { annotate, rpc, plan, deleteQueue, listQueue, bb, update } = await setup(send);
  await annotate("First"); await tick();
  const db = bb.storage.database();
  if (failure === "queue") deleteQueue.mockRejectedValueOnce(new Error("Delete offline"));
  else db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON plans BEGIN SELECT RAISE(FAIL, 'Delete offline'); END");
  await expect(rpc("remove", { id: plan.id })).rejects.toThrow("Delete offline");
  expect((await rpc("get", { id: plan.id })).id).toBe(plan.id);
  if (failure === "database") { db.exec("DROP TRIGGER fail_delete"); listQueue.mockResolvedValue([]); }
  await annotate("After failed remove"); await tick(3_000);
  if (failure === "queue") {
    expect(update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(update.mock.calls[0])).toContain("After failed remove");
  } else {
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls[1])).toContain("After failed remove");
  }
});

it("uses the displayed annotation version, defaults to latest, and rejects foreign versions", async () => {
  const { rpc, tool, plan, bb } = await setup();
  const oldId = plan.versions[0]!.id;
  await tool("plans_update", { planId: plan.id, markdown: "New version", summary: "Changed" });
  const added = await rpc("addAnnotation", { id: plan.id, versionId: oldId, quote: "existing data", body: "From v1" });
  expect(added.comments[0]!.versionId).toBe(oldId);
  const latest = await rpc("addAnnotation", { id: plan.id, quote: "New version", body: "From v2" });
  expect(latest.comments[1]!.versionId).toBe(latest.versions[1]!.id);
  const other = await rpc("create", { title: "Other", markdown: "Other", threadId: "thread-1" });
  await expect(rpc("addAnnotation", { id: plan.id, versionId: other.versions[0]!.id, quote: "Other", body: "Wrong" })).rejects.toThrow("Version not found on this plan");
  expect((await rpc("get", { id: plan.id })).comments).toHaveLength(2);
  expect(bb.storage.database().prepare("SELECT id FROM outbox WHERE plan_id = ?").all(plan.id)).toHaveLength(2);
});

it.each([true, false])("handles dispatch during an outstanding queue update, success=%s", async (success) => {
  const send = vi.fn<Send>().mockResolvedValueOnce({ ok: true, delivery: "queued", queuedMessage: entry() }).mockResolvedValue(sent());
  const { annotate, rpc, plan, harness, update } = await setup(send);
  const added = await annotate("OLD"); await tick();
  await rpc("updateAnnotation", { id: plan.id, annotationId: added.comments[0]!.id, body: "NEW" });
  await annotate("Appended");
  let finish!: () => void;
  update.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = () => success ? resolve(entry()) : reject(new Error("Queue row not found")); }));
  await tick(); expect(update).toHaveBeenCalledTimes(1);
  await expect(rpc("updateAnnotation", { id: plan.id, annotationId: added.comments[0]!.id, body: "Too late" })).rejects.toThrow("Feedback is being delivered");
  const content = success ? update.mock.calls[0]![0].input : send.mock.calls[0]![0].input;
  await harness.behavior.emitThreadEvent("message.dispatched", { entry: makeQueueEntry({ ...entry(), content }) });
  finish(); await tick(3_000);
  const saved = await rpc("get", { id: plan.id });
  expect(saved.delivery.queuedMessageId).toBeNull();
  expect(saved.comments.every((item) => item.deliveredAt !== null)).toBe(true);
  if (success) expect(send).toHaveBeenCalledTimes(1);
  else {
    const subsequent = JSON.stringify(send.mock.calls.slice(1));
    expect(subsequent).toContain("edited #1\\n> existing data\\nNEW");
    expect(subsequent).toContain("Appended");
    expect(subsequent).not.toContain("OLD");
  }
  const count = send.mock.calls.length; await tick(300_000); expect(send).toHaveBeenCalledTimes(count);
});

it("coalesces new arrivals while a send remains in flight and rejects edits", async () => {
  let finish!: (result: Awaited<ReturnType<Send>>) => void;
  const send = vi.fn<Send>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(sent());
  const { annotate, rpc, plan } = await setup(send);
  const added = await annotate("First"); await tick();
  await expect(rpc("updateAnnotation", { id: plan.id, annotationId: added.comments[0]!.id, body: "Changed" })).rejects.toThrow("Feedback is being delivered");
  await annotate("Second"); await tick(); await annotate("Third"); await tick();
  expect(send).toHaveBeenCalledTimes(1);
  finish(sent()); await tick(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(send.mock.calls[1])).toContain("Second");
  expect(JSON.stringify(send.mock.calls[1])).toContain("Third");
  expect(JSON.stringify(send.mock.calls[1])).not.toContain("First");
  await tick(300_000); expect(send).toHaveBeenCalledTimes(2);
});

it("does not request an interaction on handoff with an existing queued row", async () => {
  const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
  const { annotate, tool, plan, harness } = await setup(send);
  await annotate(); await tick();
  const result = JSON.parse(String(await tool("plans_handoff", { planId: plan.id })));
  expect(harness.inspection.pendingInteractions).toHaveLength(0);
  expect(result).toMatchObject({ status: "queued" }); expect(result).not.toHaveProperty("openCount");
});

it("isolates message.queued events from unrelated threads", async () => {
  const { tool, plan, harness } = await setup();
  await tool("plans_handoff", { planId: plan.id });
  const interactionId = harness.inspection.pendingInteractions[0]!.id;
  await harness.behavior.emitThreadEvent("message.queued", { entry: makeQueueEntry({ threadId: "other-thread", waitingOn: { kind: "interaction" } }) });
  expect(harness.inspection.pendingInteractions.map((item) => item.id)).toEqual([interactionId]);
});

it("saves nothing when a successful exact edit is followed by a failing edit", async () => {
  const { rpc, tool, plan, annotate } = await setup();
  await annotate("Why?", "ask");
  const before = await rpc("get", { id: plan.id });
  await expect(tool("plans_update", { planId: plan.id, edits: [{ old: "existing data", new: "new data" }, { old: "absent", new: "fail" }], resolves: ["#1"], summary: "Atomic" })).rejects.toThrow("No changes saved");
  expect(await rpc("get", { id: plan.id })).toEqual(before);
});

it("rejects wrong-thread ownership for update, reply and handoff tools and CLI", async () => {
  const { rpc, tool, plan, annotate, harness } = await setup();
  await annotate("Why?", "ask");
  const before = await rpc("get", { id: plan.id });
  for (const [name, input] of [
    ["plans_update", { planId: plan.id, markdown: "Wrong", summary: "Wrong" }],
    ["plans_reply", { planId: plan.id, annotation: "#1", body: "Wrong" }],
    ["plans_handoff", { planId: plan.id }],
  ] as const) await expect(tool(name, input, "other-thread")).rejects.toThrow("belongs to another thread");
  for (const args of [["update", plan.id, "plan.md", "--summary", "Wrong"], ["reply", plan.id, "#1", "Wrong"], ["handoff", plan.id]]) {
    const result = await harness.behavior.runCli(args, { threadId: "other-thread", cwd: "/workspace" });
    expect(result).toMatchObject({ exitCode: 1, stderr: "This plan belongs to another thread." });
  }
  expect(await rpc("get", { id: plan.id })).toEqual(before);
  expect(harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
  expect(harness.inspection.pendingInteractions).toHaveLength(0);
});

it("clears removed item IDs when an updated queue row dispatches before the response", async () => {
  const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
  const { annotate, rpc, plan, harness, update, deleteQueue } = await setup(send);
  await annotate("Keep"); const added = await annotate("Remove"); await tick();
  await rpc("withdrawAnnotation", { id: plan.id, annotationId: added.comments[1]!.id });
  let finish!: () => void;
  update.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(entry()); }));
  await tick();
  await harness.behavior.emitThreadEvent("message.dispatched", { entry: makeQueueEntry({ ...entry(), content: update.mock.calls[0]![0].input }) });
  finish(); await tick(1);
  const saved = await rpc("get", { id: plan.id });
  expect(saved.delivery.queuedMessageId).toBeNull(); expect(saved.delivery.itemIds).toEqual([]);
  expect(saved.comments[0]!.deliveredAt).not.toBeNull(); expect(saved.comments[1]!.deliveredAt).toBeNull();
  await tick(10_000); expect(send).toHaveBeenCalledTimes(1); expect(deleteQueue).not.toHaveBeenCalled();
});

it("backs off when removing a withdrawn annotation from the queue fails", async () => {
  const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
  const { annotate, rpc, plan, deleteQueue } = await setup(send);
  const added = await annotate(); await tick();
  await rpc("withdrawAnnotation", { id: plan.id, annotationId: added.comments[0]!.id });
  deleteQueue.mockRejectedValueOnce(new Error("Offline"));
  await tick(); expect(deleteQueue).toHaveBeenCalledTimes(1);
  await tick(4_999); expect(deleteQueue).toHaveBeenCalledTimes(1);
  await tick(1); expect(deleteQueue).toHaveBeenCalledTimes(2);
  expect((await rpc("get", { id: plan.id })).delivery.queuedMessageId).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});

it("rejects stale approval and binds one idempotent event to the latest version", async () => {
  const { rpc, tool, plan, bb, harness } = await setup();
  await tool("plans_update", { planId: plan.id, markdown: "New plan.", summary: "Updated" });
  const input = { id: plan.id, requestId: "approval", versionId: plan.versions[0]!.id };
  await expect(rpc("approve", input)).rejects.toThrow("The plan changed. Review the latest version before approving.");
  expect((await rpc("get", { id: plan.id })).status).toBe("open");
  expect(bb.storage.database().prepare("SELECT id FROM outbox").all()).toEqual([]);
  input.versionId = (await rpc("get", { id: plan.id })).versions.at(-1)!.id;
  const approved = await rpc("approve", input);
  expect(await rpc("approve", input)).toEqual(approved);
  const rows = bb.storage.database().prepare("SELECT payload FROM outbox").all() as { payload: string }[];
  expect(rows.map((row) => JSON.parse(row.payload).event)).toEqual([{ kind: "approved", versionId: input.versionId, versionNumber: 2 }]);
  await tick();
  expect(await harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual([
    expect.objectContaining({ kind: "approved", state: "delivered" }),
  ]);
});

it.each(["archivedAt", "deletedAt"] as const)("reports dropped approval for %s after reload", async (field) => {
  const { rpc, plan, harness, send } = await setup();
  harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread-1", [field]: 1 }));
  await rpc("approve", { id: plan.id, requestId: "approval", versionId: plan.versions[0]!.id });
  await tick();
  const dropped = [expect.objectContaining({ kind: "approved", state: "dropped" })];
  expect(await harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual(dropped);
  const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
  expect(await replacement.harness.behavior.callRpc("deliveryStatus", { id: plan.id })).toEqual(dropped);
  expect(send).not.toHaveBeenCalled();
});

it.each([false, true])("repairs delivery timestamps and enforces edit and withdrawal rules, startup=%s", async (startup) => {
  const { rpc, annotate, plan, bb, harness, send } = await setup();
  const added = await annotate();
  await tick();
  let db = bb.storage.database();
  const receipt = JSON.parse((db.prepare("SELECT payload FROM outbox").get() as { payload: string }).payload).deliveredAt;
  expect(receipt).toBeTypeOf("number");
  db.prepare("UPDATE plans SET body = json_set(body, '$.comments[0].deliveredAt', NULL)").run();
  let active = harness;
  if (startup) {
    // Older receipts need a stable recovery timestamp too.
    db.prepare("UPDATE outbox SET payload = json_remove(payload, '$.deliveredAt')").run();
    const replacement = await harness.lifecycle.reload(plugin); disposers.push(() => replacement.harness.lifecycle.dispose());
    active = replacement.harness;
    db = replacement.bb.storage.database();
    const stored = JSON.parse((db.prepare("SELECT body FROM plans").get() as { body: string }).body);
    expect(stored.comments[0].deliveredAt).toBeTypeOf("number");
  }
  const call = (method: string, input: unknown) => active.behavior.callRpc(method, input);
  const target = { id: plan.id, annotationId: added.comments[0]!.id };
  await expect(call("updateAnnotation", { ...target, body: "Too late" })).rejects.toThrow("Delivered or withdrawn annotations cannot be edited.");
  const repaired = await call("get", { id: plan.id }) as Plan;
  const timestamp = JSON.parse((db.prepare("SELECT payload FROM outbox").get() as { payload: string }).payload).deliveredAt;
  expect(repaired.comments[0]!.deliveredAt).toBe(timestamp);
  if (!startup) expect(timestamp).toBe(receipt);
  await call("withdrawAnnotation", target); await tick();
  expect(JSON.stringify(send.mock.calls.at(-1))).toContain("withdrawn #1");
});

it("increments plan revisions for changes within the same clock tick", async () => {
  const { rpc, plan, annotate } = await setup();
  const added = await annotate();
  const edited = await rpc("updateAnnotation", { id: plan.id, annotationId: added.comments[0]!.id, body: "Changed" });
  expect([plan.updatedAt, added.updatedAt, edited.updatedAt]).toEqual([plan.updatedAt, plan.updatedAt, plan.updatedAt]);
  expect([plan.revision, added.revision, edited.revision]).toEqual([1, 2, 3]);
  const { revision: _revision, ...legacy } = plan;
  expect(planSchema.parse(legacy).revision).toBe(0);
});

it("requires a comment or question body with the contract message", () => {
  for (const kind of ["comment", "ask"]) {
    expect(() => addAnnotationSchema.parse({ id: "plan", quote: "data", kind, body: " " })).toThrow("Write a comment or question before saving.");
  }
});

describe("bb 0.43 capabilities", () => {
  it("points thread metadata at the plan on submit, update and approval, and moves it on remove", async () => {
    const { tool, rpc, plan: first, metadata, harness } = await setup();
    await tick(0);
    expect(metadata["thread-1"]).toEqual({ activePlanId: first.id, status: "open", version: 1 });
    const submitted = JSON.parse(await tool("plans_submit", { title: "New", markdown: "New plan" }) as string);
    await tick(0);
    expect(metadata["thread-1"]).toEqual({ activePlanId: submitted.planId, status: "open", version: 1 });
    await tool("plans_update", { planId: submitted.planId, markdown: "Second draft", summary: "Edit" }); await tick(0);
    expect(metadata["thread-1"]).toEqual({ activePlanId: submitted.planId, status: "open", version: 2 });
    const plan = await rpc("get", { id: submitted.planId });
    await rpc("approve", { id: plan.id, requestId: "approval", versionId: plan.versions.at(-1)!.id }); await tick();
    expect(metadata["thread-1"]).toEqual({ activePlanId: plan.id, status: "approved", version: 2 });
    expect(harness.inspection.sdk.callsTo("threads.updatePluginMetadata").at(-1)![0]).toMatchObject({ threadId: "thread-1", pluginId: "plans" });
    await rpc("remove", { id: plan.id }); await tick(0);
    expect(metadata["thread-1"]).toEqual({ activePlanId: first.id, status: "open", version: 1 });
    await rpc("remove", { id: first.id }); await tick(0);
    expect(metadata["thread-1"]).toBeUndefined();
    expect(harness.inspection.sdk.callsTo("threads.updatePluginMetadata").at(-1)![0]).toMatchObject({ remove: ["activePlanId", "status", "version"] });
  });
  it("keeps the plan document when a metadata write fails", async () => {
    const { tool, rpc, harness } = await setup();
    harness.inspection.sdk.stub("threads.updatePluginMetadata", async () => { throw new Error("metadata offline"); });
    const submitted = JSON.parse(await tool("plans_submit", { title: "New", markdown: "New plan" }) as string);
    await tick(0);
    expect((await rpc("get", { id: submitted.planId })).title).toBe("New");
    expect(harness.inspection.logEntries.some((entry) => /metadata.*not updated/.test(entry.message))).toBe(true);
  });
  it("resolves bb plans get without an ID through the pointer and verifies ownership in the database", async () => {
    const { harness, plan, metadata } = await setup(); await tick(0);
    const result = await harness.behavior.runCli(["get"], { threadId: "thread-1" });
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout).id).toBe(plan.id);
    // A pointer another client wrote for a plan that belongs to a different thread is ignored.
    metadata["thread-2"] = { activePlanId: plan.id, status: "open", version: 1 };
    const foreign = await harness.behavior.runCli(["get"], { threadId: "thread-2" });
    expect(foreign.exitCode).toBe(1); expect(foreign.stderr).toContain("No active plan");
    metadata["thread-1"] = { activePlanId: 42 };
    expect((await harness.behavior.runCli(["get"], { threadId: "thread-1" })).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["get"], {})).stderr).toContain("Pass a plan ID");
  });
  it("marks a cancelled queued batch as not delivered, resends nothing, and restores the review prompt", async () => {
    const send = vi.fn<Send>(async () => ({ ok: true, delivery: "queued", queuedMessage: entry() }));
    const { annotate, harness, rpc, plan, tool, bb } = await setup(send);
    await tool("plans_handoff", { planId: plan.id });
    await annotate(); await tick();
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    await harness.behavior.emitThreadEvent("message.cancelled", { entry: entry("other-row") });
    expect((await rpc("get", { id: plan.id })).delivery.queuedMessageId).toBe("queue-1");
    await harness.behavior.emitThreadEvent("message.cancelled", { entry: entry() });
    const cancelled = await rpc("get", { id: plan.id });
    expect(cancelled.delivery).toMatchObject({ queuedMessageId: null, itemIds: [] });
    expect(cancelled.comments[0]!.deliveredAt).toBeNull();
    expect(bb.storage.database().prepare("SELECT state FROM outbox").all()).toEqual([{ state: "cancelled" }]);
    expect(await harness.behavior.callRpc("annotationDeliveryStatus", { id: plan.id })).toEqual([expect.objectContaining({ state: "cancelled", annotationId: cancelled.comments[0]!.id })]);
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    await tick(600_000); expect(send).toHaveBeenCalledTimes(1);
    await annotate("Later"); await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls[1])).toContain("Later");
    expect(JSON.stringify(send.mock.calls[1])).not.toContain("Keep schedules too.");
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
  it("treats a row cancelled during an append as not delivered and sends only the new batch", async () => {
    const send = vi.fn<Send>().mockResolvedValueOnce({ ok: true, delivery: "queued", queuedMessage: entry() }).mockResolvedValue({ ok: true, delivery: "queued", queuedMessage: entry("queue-2") });
    const { annotate, harness, update, bb, rpc, plan } = await setup(send);
    await annotate("First"); await tick();
    let fail!: () => void;
    update.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("Queue row not found")); }));
    await annotate("Second"); await tick();
    expect(update).toHaveBeenCalledTimes(1);
    await harness.behavior.emitThreadEvent("message.cancelled", { entry: entry() });
    fail(); await tick();
    expect(bb.storage.database().prepare("SELECT state FROM outbox ORDER BY rowid").all()).toEqual([{ state: "cancelled" }, { state: "queued" }]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls[1])).toContain("Second");
    expect(JSON.stringify(send.mock.calls[1])).not.toContain("First");
    const after = await rpc("get", { id: plan.id });
    expect(after.comments.map((item) => item.deliveredAt)).toEqual([null, null]);
    expect(after.delivery.queuedMessageId).toBe("queue-2");
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
  it("marks a batch cancelled when its queue row is deleted before the pointer is saved", async () => {
    const send = vi.fn<Send>();
    const { annotate, harness, rpc, plan, bb } = await setup(send);
    send.mockImplementationOnce(async () => {
      // The row exists server-side while send() is in flight; deleting it emits
      // message.cancelled before deliver() can persist the pointer.
      await harness.behavior.emitThreadEvent("message.cancelled", { entry: entry() });
      return { ok: true, delivery: "queued", queuedMessage: entry() };
    });
    await annotate(); await tick();
    const saved = await rpc("get", { id: plan.id });
    expect(saved.delivery).toMatchObject({ queuedMessageId: null, itemIds: [] });
    expect(saved.comments[0]!.deliveredAt).toBeNull();
    expect(bb.storage.database().prepare("SELECT state FROM outbox").all()).toEqual([{ state: "cancelled" }]);
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    await tick(600_000); expect(send).toHaveBeenCalledTimes(1);
  });
  it("ignores a cancellation for an unrelated row while a send is in flight", async () => {
    const send = vi.fn<Send>();
    const { annotate, harness, rpc, plan, bb } = await setup(send);
    send.mockImplementationOnce(async () => {
      await harness.behavior.emitThreadEvent("message.cancelled", { entry: entry("other-row") });
      return { ok: true, delivery: "queued", queuedMessage: entry() };
    });
    await annotate(); await tick();
    const saved = await rpc("get", { id: plan.id });
    expect(saved.delivery.queuedMessageId).toBe("queue-1");
    expect(bb.storage.database().prepare("SELECT state FROM outbox").all()).toEqual([{ state: "queued" }]);
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
  it("clears the unavailable notice and restores the prompt on unarchive without replaying dropped feedback", async () => {
    const { annotate, harness, rpc, plan, send, tool } = await setup();
    const getThread = vi.fn(async () => makeThreadResponse({ id: "thread-1", archivedAt: 1 }));
    harness.inspection.sdk.stub("threads.get", getThread);
    await tool("plans_handoff", { planId: plan.id });
    await annotate(); await tick();
    expect((await rpc("get", { id: plan.id })).delivery.notice).toContain("archived or deleted");
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    getThread.mockResolvedValue(makeThreadResponse({ id: "thread-1" }));
    await harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "other" }) });
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    await harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "thread-1" }) });
    const restored = await rpc("get", { id: plan.id });
    expect(restored.delivery.notice).toBeNull();
    expect(restored.comments[0]!.deliveredAt).toBeNull();
    expect(harness.inspection.pendingInteractions).toHaveLength(1);
    await tick(600_000); expect(send).not.toHaveBeenCalled();
    await rpc("approve", { id: plan.id, requestId: "approval", versionId: plan.versions[0]!.id }); await tick();
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
    await harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "thread-1" }) });
    expect(harness.inspection.pendingInteractions).toHaveLength(0);
  });
});
