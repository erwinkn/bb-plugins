import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";

// v9 round 5 (W454's review A639): a regression for its discovery finding, failing on the r4 patch.

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const childOf = (f: Fx, id: string, parentThreadId: string, status = "active", extra: Record<string, unknown> = {}) =>
  f.threads.set(id, { ...makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: status as never, title: `Thread ${id}`, createdAt: Date.now() }), ...extra } as never);
/** BB's real child listing: archived children too (the fake hides them). */
const realChildListing = (f: Fx) => f.intercept((path, args, call) => {
  if (path !== "threads.list" || !args?.parentThreadId) return call();
  return Promise.resolve([...f.threads.values()]
    .filter((t: any) => t.parentThreadId === args.parentThreadId && t.deletedAt == null)
    .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200))
    .map((t: any) => ({ ...t, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, hasPendingInteraction: false, queuedWork: "none" })));
});

describe("F1 an unclaimed archived helper gets its share of a cap the members fill", () => {
  it("with 300 live member threads besides W1, the restored grandchild is found within four sweeps", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    f.store.tx(() => {
      for (let i = 1; i <= 300; i++) {
        childOf(f, `b${i}`, "coordinator", "idle");
        f.store.associateProjectThread({ projectId: project.id, opId: `op_b${i}`, threadId: `b${i}`, label: `b${i}`, bbProjectId: "proj_a" });
      }
    });
    childOf(f, "helper", w.threadId, "idle", { archivedAt: Date.now() - 1000 });
    childOf(f, "grandchild", "helper", "active");
    realChildListing(f);
    const waiting = async () => ((await f.harness.callRpc("overview", { projectId: project.id })) as { workerWaiting: Record<string, unknown> }).workerWaiting.W1;
    let sweeps = 0;
    while (sweeps < 4 && (await waiting() as { checked: boolean }).checked !== true) {
      await f.service.associateNativeChildren(project.id);
      sweeps++;
    }
    expect(await waiting()).toMatchObject({ on: { threadId: "grandchild", running: "active" }, checked: true });
    expect(f.store.membership("helper", true)).toBeNull();
    expect(f.store.membership("grandchild", true)).toBeNull();
  });
});
