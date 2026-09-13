import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { Plan } from "../contract";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

it("uses a fixed short heading and preserves the full plan title in storage and the body payload", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "plans", sdk: {
    threads: {
      get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1" }),
      updatePluginMetadata: async () => ({}),
    },
    projects: { get: async () => ({ id: "project-1", name: "Test" }) },
  } });
  plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const title = "Refine Pulse scheduling: TaskScope, LoopBinding, single Task wait";
  const result = JSON.parse(String(await harness.behavior.callAgentTool("plans_submit", {
    title, markdown: "# Schedule refinement\n\nReview this plan.",
  }, { threadId: "thread-1" })));
  const plan = await harness.behavior.callRpc("get", { id: result.planId }) as Plan;
  expect(plan.title).toBe(title);
  expect(harness.inspection.pendingInteractions).toHaveLength(1);
  expect(harness.inspection.pendingInteractions[0]).toMatchObject({
    threadId: "thread-1", rendererId: "plan-review", title: "Plan ready", timeoutMs: 3_600_000,
    payload: { planId: plan.id, versionId: plan.versions[0]!.id, title, versionNumber: 1 },
  });
});
