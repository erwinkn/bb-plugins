import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { mergeOverview } from "../lib/overview-merge";
import type { Overview } from "../lib/overview";

// W462: the Workers tab offers child threads only where the cache knows some, retired workers included.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const childOf = (f: Fx, id: string, parentThreadId: string) =>
  f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: "idle" as never, title: `Thread ${id}`, createdAt: Date.now() }) as never);
type Waiting = Record<string, { children?: number | null }>;

describe("W462 child counts in the overview", () => {
  it("current workers carry the cached count (null before a listing); retired ones only once it is known", async () => {
    const { f, project } = await projectFixture();
    const [one] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    await tool(f, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    const read = async (detail: "summary" | "history") =>
      ((await f.harness.callRpc("overview", { projectId: project.id, detail })) as { workerWaiting: Waiting }).workerWaiting;
    childOf(f, "helper", one.threadId);
    f.store.updateWorker(project.id, 2, { state: "retired" });
    expect((await read("summary")).W1).toMatchObject({ children: null });
    // Retired before any listing: left out, so its detail reads the tree on demand.
    expect((await read("history")).W2).toBeUndefined();
    await f.service.associateNativeChildren(project.id);
    expect((await read("summary")).W1).toMatchObject({ children: 1 });
    f.store.updateWorker(project.id, 1, { state: "retired" });
    const history = await read("history");
    expect(Object.keys(await read("summary"))).toEqual([]);
    expect(history.W1).toMatchObject({ children: 1 });
    expect(history.W2).toMatchObject({ children: 0 });
  });

  it("the merged dashboard keeps the history's retired counts and the summary's newer current ones", () => {
    const summary = { workerWaiting: { W2: { on: null, checked: true, children: 3 } } } as unknown as Overview;
    const past = { workers: { current: [], retired: [] }, tasks: [], decisions: [], workerWaiting: { W1: { on: null, checked: true, children: 0 }, W2: { on: null, checked: true, children: 1 } } } as unknown as Overview;
    const merged = mergeOverview({ ...summary, workers: { current: [], retired: [] }, tasks: [], decisions: [] } as Overview, past, null);
    expect(merged.workerWaiting).toEqual({ W1: { on: null, checked: true, children: 0 }, W2: { on: null, checked: true, children: 3 } });
  });
});
