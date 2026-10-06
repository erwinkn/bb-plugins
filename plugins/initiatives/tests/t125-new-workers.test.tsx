// @vitest-environment jsdom
// T125: a just-delegated worker shows in the tree, the summary and the panel
// within one signal, without a reload or the 15 s poll. A read started by an
// earlier signal can still be in flight when the delegate's signal lands and
// answer without the worker; that signal must then cause one more read
// instead of joining the stale one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { appReads, SharedReads } from "../lib/dashboard-data";
import { projectFixture } from "./fake-native";

const app = await loadPluginApp(() => import("../app"));
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };

describe("T125 shared reads catch up with changes announced mid-read", () => {
  it("a scheduled refresh during an in-flight read reads once more after it", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads();
      cache.subscribe("k", vi.fn());
      const held = deferred<string>();
      const fetch = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue("after");
      void cache.refresh("k", fetch);
      for (let n = 0; n < 3; n++) cache.schedule("k", fetch);
      await vi.advanceTimersByTimeAsync(150);
      expect(fetch).toHaveBeenCalledTimes(1);
      held.resolve("before");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cache.entry("k").data).toBe("after");
    } finally { vi.useRealTimers(); }
  });

  it("a scheduled refresh during a save reads after the save ends", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedReads();
      cache.subscribe("k", vi.fn());
      await cache.refresh("k", async () => "old");
      const end = cache.begin("k");
      const fetch = vi.fn(async () => "saved");
      cache.schedule("k", fetch);
      await vi.advanceTimersByTimeAsync(150);
      expect(fetch).not.toHaveBeenCalled();
      end();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cache.entry("k").data).toBe("saved");
    } finally { vi.useRealTimers(); }
  });
});

describe("T125 a delegate announces its worker after recording it", () => {
  it("at the delegate's signal the tree and the panel already carry the new worker", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Fresh worker");
    const seen: unknown[] = [];
    const publish = f.bb.realtime.publish.bind(f.bb.realtime);
    vi.spyOn(f.bb.realtime, "publish").mockImplementation((channel, payload) => {
      if (channel === "initiatives-changed") seen.push(f.tree());
      return publish(channel, payload);
    });
    await f.perform(project.id, { action: "delegate", route: "fresh", role: "work", tasks: [task.ref] }, "coordinator", "coordinator");
    const worker = f.store.workers(project.id).at(-1)!;
    expect(worker.threadId).toBeTruthy();
    const last = seen.at(-1) as { projects: { nodes: { threadId: string | null; worker: string | null }[] }[] };
    expect(last.projects[0]!.nodes).toContainEqual(expect.objectContaining({ worker: `W${worker.num}`, threadId: worker.threadId }));
    const panel = (await f.harness.callRpc("panel", { threadId: "coordinator" })) as { summary: { workers: { current: { ref: string }[] } } };
    expect(panel.summary.workers.current.map((w) => w.ref)).toContain(`W${worker.num}`);
  });
});

describe("T125 the panel lists a just-delegated worker without a poll", () => {
  it("the delegate's signal during a stale panel read brings the worker in", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Fresh worker");
    const before = await f.harness.callRpc("panel", { threadId: "coordinator" });
    const held: ((value: unknown) => void)[] = [];
    let calls = 0;
    const panel = vi.fn(async () => {
      calls++;
      if (calls === 1) return before;
      if (calls === 2) return new Promise((resolve) => held.push(resolve));
      return f.harness.callRpc("panel", { threadId: "coordinator" });
    });
    const slot = renderSlot(app.threadPanelActions[0], { threadId: "coordinator", params: {} }, { rpc: { panel, overview: () => f.harness.callRpc("overview", { projectId: project.id, detail: "summary" }) } });
    slots.push(slot);
    await waitFor(() => expect(panel).toHaveBeenCalledTimes(1));
    // Another signal starts a read before the ledger records the worker...
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await waitFor(() => expect(panel).toHaveBeenCalledTimes(2));
    // ...then the delegate lands and announces itself while that read is in flight.
    await f.perform(project.id, { action: "delegate", route: "fresh", role: "work", tasks: [task.ref] }, "coordinator", "coordinator");
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    await act(async () => { held[0]!(before); });
    await waitFor(() => expect(panel).toHaveBeenCalledTimes(3));
    const ref = `W${f.store.workers(project.id).at(-1)!.num}`;
    await waitFor(() => {
      const summary = (appReads.entry(`overview:${project.id}`).data as { workers: { current: { ref: string }[] } } | null);
      expect(summary?.workers.current.map((w) => w.ref)).toContain(ref);
    });
  });
});
