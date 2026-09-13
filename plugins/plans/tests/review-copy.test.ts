import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { Plan } from "../contract";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
const title = "Refine Pulse scheduling: TaskScope, LoopBinding, single Task wait";

function setup(mode: "tool" | "cli" | "rpc" = "tool") {
  let fileText = "# Scheduling\nKeep one wait.";
  let host = createFakePluginHost({ pluginId: "plans", sdk: {
    threads: {
      get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "env-1" }),
      updatePluginMetadata: async () => ({}),
    },
    projects: { get: async () => ({ id: "project-1", name: "Test" }) },
    environments: { get: async () => ({ id: "env-1", path: "/workspace", hostId: "host-1" }) },
    files: { read: async () => ({ content: fileText, contentEncoding: "utf8" }) },
  } });
  plugin(host.bb);
  disposers.push(() => host.harness.lifecycle.dispose());
  const get = async (id: string) => await host.harness.behavior.callRpc("get", { id }) as Plan;
  const invoke = async (command: "submit" | "update" | "handoff", input: Record<string, unknown>) => {
    if (mode === "rpc") return await host.harness.behavior.callRpc(command, { ...input, ...(command === "submit" ? { threadId: "thread-1" } : {}) }) as { planId: string };
    if (mode === "tool") return JSON.parse(String(await host.harness.behavior.callAgentTool(`plans_${command}`, input, { threadId: "thread-1" }))) as { planId: string };
    fileText = String(input.markdown ?? fileText);
    const args = command === "submit" ? [command, "draft.md", String(input.title)]
      : command === "update" ? [command, String(input.planId), "draft.md", "--summary", String(input.summary)]
      : [command, String(input.planId)];
    if (input.reviewHeading !== undefined) args.push("--review-heading", String(input.reviewHeading ?? ""));
    if (input.reviewSummary !== undefined) args.push("--review-summary", String(input.reviewSummary ?? ""));
    const result = await host.harness.behavior.runCli(args, { threadId: "thread-1", cwd: "/workspace" });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout) as { planId: string };
  };
  const reload = async () => { host = await host.harness.lifecycle.reload(plugin); return host.harness; };
  return { ...host, get, invoke, reload };
}

it.each(["tool", "cli", "rpc"] as const)("persists revision copy through %s submit, update, and handoff", async (mode) => {
  const { harness, get, invoke, reload } = setup(mode);
  const { planId } = await invoke("submit", { title, markdown: "# Scheduling", reviewHeading: "Pulse scheduling", reviewSummary: "Give each task one wait." });
  const first = (await get(planId)).versions[0]!;
  expect(first).toMatchObject({ reviewHeading: "Pulse scheduling", reviewSummary: "Give each task one wait." });
  expect(harness.inspection.pendingInteractions[0]).toMatchObject({ title: "Plan: Pulse scheduling", payload: { title, reviewSummary: "Give each task one wait.", versionId: first.id } });
  await invoke("update", { planId, markdown: "# Scheduling\nRestore bindings.", summary: "Changed bindings", reviewHeading: "Restore schedules", reviewSummary: "Keep schedules after a restart." });
  let plan = await get(planId);
  expect(plan.title).toBe(title);
  expect(plan.versions).toHaveLength(2);
  expect(plan.versions[0]).toEqual(first);
  expect(plan.versions[1]).toMatchObject({ summary: "Changed bindings", reviewHeading: "Restore schedules", reviewSummary: "Keep schedules after a restart." });
  expect(harness.inspection.pendingInteractions).toHaveLength(1);
  expect(harness.inspection.pendingInteractions[0]).toMatchObject({ title: "Plan: Restore schedules", payload: { versionId: plan.versions[1]!.id, reviewSummary: "Keep schedules after a restart." } });
  await invoke("handoff", { planId, reviewHeading: "Restart recovery", reviewSummary: "Restore schedules and keep each task waiting once." });
  plan = await get(planId);
  expect(plan.versions).toHaveLength(2);
  expect(plan.versions[0]).toEqual(first);
  expect(plan.versions[1]).toMatchObject({ reviewHeading: "Restart recovery", reviewSummary: "Restore schedules and keep each task waiting once." });
  const interaction = harness.inspection.pendingInteractions[0]!;
  expect(interaction).toMatchObject({ title: "Plan: Restart recovery", payload: { title, reviewSummary: plan.versions[1]!.reviewSummary } });
  await invoke("handoff", { planId });
  expect(harness.inspection.pendingInteractions[0]!.id).toBe(interaction.id);
  const replacement = await reload();
  expect((await get(planId)).versions).toEqual(plan.versions);
  await invoke("handoff", { planId });
  expect(replacement.inspection.pendingInteractions[0]).toMatchObject({ title: "Plan: Restart recovery" });
});

it("uses legacy fallbacks, supports clearing, and does not carry stale copy to a new revision", async () => {
  const context = setup();
  const { bb, get, invoke, reload } = context;
  let { harness } = context;
  const plan = await harness.behavior.callRpc("create", { title, markdown: "Legacy content", threadId: "thread-1" }) as Plan;
  const legacy = JSON.parse(JSON.stringify(plan));
  delete legacy.versions[0].reviewHeading; delete legacy.versions[0].reviewSummary;
  bb.storage.database().prepare("UPDATE plans SET body = ? WHERE id = ?").run(JSON.stringify(legacy), plan.id);
  harness = await reload();
  expect((await get(plan.id)).versions[0]).toMatchObject({ reviewHeading: null, reviewSummary: null });
  await invoke("handoff", { planId: plan.id });
  expect(harness.inspection.pendingInteractions[0]).toMatchObject({ title: `Plan: ${title}`, payload: { title, reviewSummary: null } });
  await invoke("handoff", { planId: plan.id, reviewHeading: "New heading", reviewSummary: "New description." });
  await invoke("handoff", { planId: plan.id, reviewHeading: null, reviewSummary: null });
  expect(harness.inspection.pendingInteractions[0]).toMatchObject({ title: `Plan: ${title}`, payload: { reviewSummary: null } });
  await invoke("handoff", { planId: plan.id, reviewHeading: "New heading", reviewSummary: "Old revision description." });
  await invoke("update", { planId: plan.id, markdown: "New revision", summary: "Change log only" });
  expect((await get(plan.id)).versions[1]).toMatchObject({ reviewHeading: null, reviewSummary: null, summary: "Change log only" });
});

it("preserves previously saved 40-character headings after reload and revision updates", async () => {
  const { bb, harness, get, invoke, reload } = setup();
  const plan = await harness.behavior.callRpc("create", { title, markdown: "Previous content", threadId: "thread-1" }) as Plan;
  const legacyHeading = "x".repeat(40);
  plan.versions[0]!.reviewHeading = legacyHeading;
  bb.storage.database().prepare("UPDATE plans SET body = ? WHERE id = ?").run(JSON.stringify(plan), plan.id);
  const replacement = await reload();
  await invoke("handoff", { planId: plan.id });
  expect(replacement.inspection.pendingInteractions[0]).toMatchObject({ title: `Plan: ${legacyHeading}` });
  await invoke("update", { planId: plan.id, markdown: "New content", summary: "Updated content" });
  expect((await get(plan.id)).versions[0]!.reviewHeading).toBe(legacyHeading);
});

it.each(["tool", "cli", "rpc"] as const)("validates %s review copy before changing saved history", async (mode) => {
  const { get, invoke } = setup(mode);
  const { planId } = await invoke("submit", { title, markdown: "Scheduling", reviewHeading: "  Pulse\n scheduling ", reviewSummary: " One\n sentence. " });
  const plan = await get(planId);
  expect(plan.versions[0]).toMatchObject({ reviewHeading: "Pulse scheduling", reviewSummary: "One sentence." });
  await expect(invoke("update", { planId, markdown: "Changed", summary: "Edit", reviewHeading: "x".repeat(35) })).rejects.toThrow();
  await expect(invoke("handoff", { planId, reviewSummary: "x".repeat(241) })).rejects.toThrow();
  await expect(invoke("handoff", { planId, reviewHeading: "   " })).rejects.toThrow();
  expect(await get(planId)).toEqual(plan);
  await invoke("handoff", { planId, reviewHeading: "x".repeat(34) });
  expect((await get(planId)).versions[0]!.reviewHeading).toBe("x".repeat(34));
});
