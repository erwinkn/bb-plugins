import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { RunningChildren } from "../lib/context";
import { settledChildPage } from "./helpers";

// v9 round 4 (W440's review A625): one regression per finding, each failing on the r3 patch.

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const childOf = (f: Fx, id: string, parentThreadId: string, status = "active", extra: Record<string, unknown> = {}) => {
  const t = { ...makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: status as never, title: `Thread ${id}`, createdAt: Date.now() }), ...extra };
  f.threads.set(id, t as never);
  return t;
};
const stopped = (f: Fx) => f.stop.mock.calls.map((call) => (call as unknown as [{ threadId: string }])[0].threadId);
/** BB's real child listing: archived children too, unless `archived` picks a side (the fake hides them). */
const realChildListing = (f: Fx) => f.intercept((path, args, call) => {
  if (path !== "threads.list" || !args?.parentThreadId) return call();
  return Promise.resolve([...f.threads.values()]
    .filter((t: any) => t.parentThreadId === args.parentThreadId && t.deletedAt == null)
    .filter((t: any) => args.archived === true ? t.archivedAt != null : args.archived === false ? t.archivedAt == null : true)
    .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200))
    .map((t: any) => ({ ...t, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, hasPendingInteraction: false, queuedWork: "none" })));
});
const within = <T,>(promise: Promise<T>, ms = 1000) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

/** An idle native thread adopted as W1, whose adoption message then starts running: A1 stays idle_no_report. */
async function adoptedAndRunning() {
  const { f, project } = await projectFixture();
  const t = f.task(project.id);
  childOf(f, "adopted", "coordinator", "idle");
  await f.service.adoptWorker(project.id, { threadId: "adopted", role: "work", label: "Adopted", tasks: [t.ref] } as never);
  f.threads.set("adopted", { ...f.threads.get("adopted")!, status: "active" });
  const a = f.store.assignments(project.id).at(-1)!;
  if (a.state !== "idle_no_report") f.store.updateAssignment(project.id, a.num, { state: "idle_no_report" });
  childOf(f, "reviewer", "adopted", "active");
  f.stop.mockClear();
  return { f, project, task: t, ref: a.ref };
}

describe("F1 Stop stops the work's own thread whatever its assignment state says", () => {
  it("worker Stop, Stop all work, Cancel task and the older assignment Stop each stop an adopted idle_no_report thread", async () => {
    const operations = [
      (x: Awaited<ReturnType<typeof adoptedAndRunning>>) => x.f.perform(x.project.id, { action: "worker-stop", worker: "W1", reason: "Dropped." }, "user", null),
      (x: Awaited<ReturnType<typeof adoptedAndRunning>>) => x.f.perform(x.project.id, { action: "stop-work" }, "user", null),
      (x: Awaited<ReturnType<typeof adoptedAndRunning>>) => x.f.perform(x.project.id, { action: "task-status", task: x.task.ref, status: "cancelled", reason: "Dropped." }, "user", null),
      (x: Awaited<ReturnType<typeof adoptedAndRunning>>) => x.f.perform(x.project.id, { action: "assignment-stop", assignment: x.ref, reason: "Dropped." }, "user", null),
    ];
    for (const operation of operations) {
      const x = await adoptedAndRunning();
      await operation(x);
      expect(stopped(x.f)).toEqual(expect.arrayContaining(["adopted", "reviewer"]));
      expect(x.f.store.assignment(x.project.id, Number(x.ref.slice(1)))!.state).toBe("cancelled");
    }
  });

  it("a Stop BB refuses for that thread is reported, not hidden", async () => {
    const x = await adoptedAndRunning();
    x.f.stop.mockImplementation((async ({ threadId }: { threadId: string }) => {
      if (threadId === "adopted") throw Object.assign(new Error("host offline"), { status: 503 });
      return {};
    }) as never);
    const result = await x.f.perform(x.project.id, { action: "worker-stop", worker: "W1", reason: "Dropped." }, "user", null);
    expect(result).toMatchObject({ worker: "W1", state: "cancelled", stoppedChildren: 1, notStopped: ["W1's thread (host offline)"] });
  });
});

describe("F2 waiting discovery reaches through an archived helper nobody claimed", () => {
  it("a cold sweep lists the archived helper without claiming it and finds the restored grandchild", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    // Archived before any sweep saw it; BB then restored its child.
    childOf(f, "helper", w.threadId, "idle", { archivedAt: Date.now() - 1000 });
    childOf(f, "grandchild", "helper", "active");
    realChildListing(f);
    const waiting = async () => ((await f.harness.callRpc("overview", { projectId: project.id })) as { workerWaiting: Record<string, unknown> }).workerWaiting.W1;
    expect(await waiting()).toEqual({ on: null, checked: false, children: null });
    await f.service.associateNativeChildren(project.id);
    expect(await waiting()).toMatchObject({ on: { threadId: "grandchild", running: "active" }, checked: true });
    expect(f.store.membership("helper", true)).toBeNull();
    expect(f.store.membership("grandchild", true)).toBeNull();
  });

  it("an archived child the cache has not listed leaves the tree unchecked", () => {
    const cache = new RunningChildren();
    const row = (id: string, parentThreadId: string, archivedAt: number | null) =>
      ({ id, parentThreadId, status: "idle" as never, archivedAt, deletedAt: null, title: id });
    cache.listed("W", [row("helper", "W", 1)], cache.begin());
    expect(cache.waitingOn("W")).toEqual({ on: null, checked: false });
    cache.listed("helper", [], cache.begin());
    expect(cache.waitingOn("W")).toEqual({ on: null, checked: true });
  });
});

describe("F4 childPage never waits on BB", () => {
  it("answers loading while the listing is held, then announces the page and serves it from cache", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    childOf(f, "helper", w.threadId, "idle");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.intercept((path, args, call) => path === "threads.list" && args?.parentThreadId === w.threadId ? held.then(call) : call());
    const input = { projectId: project.id, threadId: w.threadId };
    expect(await within(f.harness.callRpc("childPage", input))).toEqual({ status: "loading" });
    const signals = f.harness.realtimeSignals.length;
    release();
    const page = await settledChildPage(f.harness, input);
    expect(page).toMatchObject({ status: "ready", value: { rows: [{ threadId: "helper" }], next: null } });
    expect(f.harness.realtimeSignals.slice(signals)).toContainEqual({ channel: "initiatives-changed", payload: { projectId: project.id } });
  });
});

describe("F5 the verification budget holds per page", () => {
  it("5,001 direct children are refused after six listings, not after listing every page", async () => {
    const { f } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    for (let n = 1; n <= 5001; n++) childOf(f, `c${n}`, w.threadId, "idle");
    let listings = 0;
    f.intercept((path, _args, call) => {
      if (path === "threads.list") listings++;
      return call();
    });
    expect(await f.service.liveDescendants(w.threadId)).toEqual(["it has more than 500 descendant threads, too many to verify safely"]);
    expect(listings).toBeLessThanOrEqual(6);
  });
});

describe("F6 a lead tab BB could not check is named, not silently skipped", () => {
  it("a 503 on a discussion's read makes it notReached; a 404 leaves it out", async () => {
    const { f, project } = await projectFixture();
    const { threadId: down } = (await f.harness.callRpc("discussionCreate", { projectId: project.id })) as { threadId: string };
    const { threadId: gone } = (await f.harness.callRpc("discussionCreate", { projectId: project.id })) as { threadId: string };
    f.intercept((path, args, call) =>
      path === "threads.get" && args?.threadId === down ? Promise.reject(Object.assign(new Error("BB unavailable"), { status: 503 }))
        : path === "threads.get" && args?.threadId === gone ? Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 }))
          : call());
    f.send.mockClear();
    const result = await tool(f, "initiative_rule", { action: "add", text: "Every PR targets dev." });
    expect(result.notReached).toEqual([expect.stringMatching(/could not say whether it is open: BB unavailable/)]);
    expect(f.send.mock.calls.map(([a]) => a.threadId)).not.toContain(down);
  });
});
