import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { Plan } from "../contract";
import { reviewPromptTitle } from "../lib/review-prompt";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

it.each([
  ["Short plan", "Short plan"],
  ["  Refine\n Pulse\t scheduling  ", "Refine Pulse scheduling"],
  ["x".repeat(56), "x".repeat(56)],
  ["x".repeat(57), `${"x".repeat(55)}…`],
  ["Refine Pulse scheduling: TaskScope, LoopBinding, single Task wait", "Refine Pulse scheduling: TaskScope, LoopBinding, single…"],
  [`${"a".repeat(55)} next`, `${"a".repeat(55)}…`],
  ["👩🏽‍💻".repeat(57), `${"👩🏽‍💻".repeat(55)}…`],
])("keeps a compact, readable heading for %s", (title, expected) => {
  expect(reviewPromptTitle(title)).toBe(expected);
});

it("shortens only the interaction heading and preserves the full stored title and payload", async () => {
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
    threadId: "thread-1", rendererId: "plan-review", title: reviewPromptTitle(title), timeoutMs: 3_600_000,
    payload: { planId: plan.id, versionId: plan.versions[0]!.id, title, versionNumber: 1 },
  });
});
