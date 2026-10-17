import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { threadsToWatch } from "../lib/overview";
import { FIRST_READ_WAIT_MS, LIVE_TTL_MS, LiveThreads } from "../lib/live-threads";
import { NESTED_REVIVE_MS, NESTED_VERIFY_BATCH } from "../lib/service";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

/** Count SDK calls by dotted path during `run`. */
async function calls(f: Fixture, run: () => Promise<unknown>) {
  const counts = new Map<string, number>();
  f.intercept((path, _args, call) => {
    counts.set(path, (counts.get(path) ?? 0) + 1);
    return call();
  });
  try {
    await run();
  } finally {
    f.intercept();
  }
  return counts;
}

/** `count` nested threads under the coordinator; the first `archived` are archived. */
function nest(f: Fixture, projectId: string, count: number, archived: number) {
  return Array.from({ length: count }, (_, i) => {
    const id = `nested-${i}`;
    f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", parentThreadId: "coordinator", title: `Nested ${i}`, archivedAt: i < archived ? 1 : null }) as never);
    f.store.associateNestedThread({ projectId, threadId: id, label: `Nested ${i}`, bbProjectId: "proj_a" });
    return id;
  });
}

const dashboard = (f: Fixture, projectId: string) =>
  f.harness.callRpc("overview", { projectId, detail: "full" }) as Promise<any>;

describe("W496 archived and deleted nested threads are not watched", () => {
  it("watches only the nested threads not seen archived or deleted, and shows the others as before", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 60, 50);
    f.threads.delete("nested-59"); // deleted: BB answers 404
    expect(threadsToWatch(f.store, project.id)).toHaveLength(61);
    let before: any;
    expect((await calls(f, async () => { before = await f.overview(project.id); })).get("threads.get")).toBe(61);
    // The coordinator and the 9 live nested threads: nothing grows with the archived ones.
    const watched = threadsToWatch(f.store, project.id);
    expect(watched).toHaveLength(10);
    expect(watched).not.toContain("nested-0");
    expect(watched).not.toContain("nested-59");
    let after: any;
    expect((await calls(f, async () => { after = await f.overview(project.id); })).get("threads.get")).toBe(10);
    expect(after.memberThreads).toEqual(before.memberThreads);
    expect(after.usage.threads).toEqual(before.usage.threads);
    expect(after.memberThreads.find((t: any) => t.threadId === "nested-0")).toMatchObject({ nativeStatus: "archived", parentThreadId: "coordinator", parentKnown: true });
    expect(after.memberThreads.find((t: any) => t.threadId === "nested-59")).toMatchObject({ nativeStatus: "deleted" });
    // A dashboard read past the TTL re-reads only those ten too.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + LIVE_TTL_MS + 1);
    try {
      await dashboard(f, project.id);
      expect((await calls(f, async () => {
        await dashboard(f, project.id);
        await new Promise((resolve) => setTimeout(resolve, 0));
      })).get("threads.get") ?? 0).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("an archive or delete event stops reading a nested thread; an unarchive reads it again", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 3, 0);
    await dashboard(f, project.id);
    const archived = { ...f.threads.get("nested-0")!, archivedAt: 5 };
    f.threads.set("nested-0", archived);
    await f.harness.emitThreadEvent("thread.archived", { thread: archived });
    const deleted = { ...f.threads.get("nested-1")!, deletedAt: 6 };
    f.threads.delete("nested-1");
    await f.harness.emitThreadEvent("thread.deleted", { thread: deleted });
    expect(threadsToWatch(f.store, project.id).sort()).toEqual(["coordinator", "nested-2"]);
    const shown = await dashboard(f, project.id);
    expect(shown.memberThreads.find((t: any) => t.threadId === "nested-0").nativeStatus).toBe("archived");
    expect(shown.memberThreads.find((t: any) => t.threadId === "nested-1").nativeStatus).toBe("deleted");
    const unarchived = { ...archived, archivedAt: null, status: "active" as const };
    f.threads.set("nested-0", unarchived);
    await f.harness.emitThreadEvent("thread.unarchived", { thread: unarchived });
    expect(threadsToWatch(f.store, project.id)).toContain("nested-0");
    expect((await dashboard(f, project.id)).memberThreads.find((t: any) => t.threadId === "nested-0").nativeStatus).toBe("active");
    // Review r5: an archived thread later deleted shows deleted; a stray archive event never undoes a deletion.
    const gone = { ...archived, deletedAt: 8 };
    f.threads.delete("nested-2");
    await f.harness.emitThreadEvent("thread.archived", { thread: { ...f.threads.get("nested-0")!, archivedAt: 9 } });
    await f.harness.emitThreadEvent("thread.deleted", { thread: { ...gone, id: "nested-0" } });
    await f.harness.emitThreadEvent("thread.archived", { thread: { ...archived, id: "nested-0", archivedAt: 10 } });
    expect((await f.overview(project.id)).memberThreads.find((t: any) => t.threadId === "nested-0")?.nativeStatus).toBe("deleted");
    // An event about a thread that is no nested claim changes nothing.
    await f.harness.emitThreadEvent("thread.archived", { thread: { ...f.threads.get("coordinator")!, archivedAt: 7 } });
    expect(f.store.nestedProjectThreads(project.id).filter((t) => t.ended).map((t) => t.threadId)).toEqual(["nested-0", "nested-1", "nested-2"]);
  });

  it("a nested thread unarchived while the plugin heard no event is revived from BB's unarchived list, at most hourly", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 3, 3);
    await f.overview(project.id);
    expect(threadsToWatch(f.store, project.id)).toEqual(["coordinator"]);
    // No list read while no nested thread is ended… (a fresh service would have read once at start)
    f.threads.set("nested-1", { ...f.threads.get("nested-1")!, archivedAt: null });
    const start = Date.now();
    const clock = vi.spyOn(f.store, "now").mockReturnValue(start);
    try {
      const first = await calls(f, () => f.service.reviveUnarchivedNested());
      expect(first.get("threads.list")).toBe(1);
      expect(threadsToWatch(f.store, project.id).sort()).toEqual(["coordinator", "nested-1"]);
      // Review r5: the dashboard's cached archived fact predates the revival and must not end it again.
      const shown = await dashboard(f, project.id);
      expect(shown.memberThreads.find((t: any) => t.threadId === "nested-1").nativeStatus).toBe("idle");
      expect(threadsToWatch(f.store, project.id).sort()).toEqual(["coordinator", "nested-1"]);
      // Within the hour another unarchive waits; after it, the next sweep finds it.
      f.threads.set("nested-2", { ...f.threads.get("nested-2")!, archivedAt: null });
      expect((await calls(f, () => f.service.reviveUnarchivedNested())).get("threads.list") ?? 0).toBe(0);
      clock.mockReturnValue(start + NESTED_REVIVE_MS);
      await f.service.reviveUnarchivedNested();
      expect(threadsToWatch(f.store, project.id).sort()).toEqual(["coordinator", "nested-1", "nested-2"]);
    } finally {
      clock.mockRestore();
    }
  });

  it("deleted nested threads never come back, so they alone read no list (review r5)", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 2, 0);
    for (const id of ["nested-0", "nested-1"]) f.threads.delete(id);
    await f.overview(project.id);
    expect(threadsToWatch(f.store, project.id)).toEqual(["coordinator"]);
    expect((await calls(f, () => f.service.reviveUnarchivedNested())).get("threads.list") ?? 0).toBe(0);
  });

  it("a nested thread is revived on the first sweep pass and a failed list is retried on the next", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 2, 2);
    await f.overview(project.id);
    f.threads.set("nested-0", { ...f.threads.get("nested-0")!, archivedAt: null });
    f.intercept((path, _args, call) => {
      if (path === "threads.list") throw Object.assign(new Error("BB down"), { status: 503 });
      return call();
    });
    await expect(f.service.reviveUnarchivedNested()).rejects.toThrow("BB down");
    f.intercept();
    await f.service.reviveUnarchivedNested();
    expect(threadsToWatch(f.store, project.id)).toContain("nested-0");
  });
});

describe("W497 review r6: nested threads ended before this run", () => {
  const status = async (f: Fixture, projectId: string, threadId: string) =>
    (await dashboard(f, projectId)).memberThreads.find((t: any) => t.threadId === threadId)?.nativeStatus;

  it("one deleted while the plugin heard no event shows deleted after the sweep reads it once, and stops the hourly list", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 3, 3);
    await f.overview(project.id);
    expect(threadsToWatch(f.store, project.id)).toEqual(["coordinator"]);
    // While the plugin was down: nested-0 deleted (BB answers 404), nested-1 deleted (still readable), nested-2 unarchived.
    f.threads.delete("nested-0");
    f.threads.set("nested-1", { ...f.threads.get("nested-1")!, deletedAt: 9 });
    f.threads.set("nested-2", { ...f.threads.get("nested-2")!, archivedAt: null });
    expect((await calls(f, () => f.service.verifyEndedNested())).get("threads.get")).toBe(3);
    expect(await status(f, project.id, "nested-0")).toBe("deleted");
    expect(await status(f, project.id, "nested-1")).toBe("deleted");
    expect(await status(f, project.id, "nested-2")).toBe("idle");
    expect(threadsToWatch(f.store, project.id).sort()).toEqual(["coordinator", "nested-2"]);
    // Each is read once per run, and only deleted claims are left, so no list either.
    expect((await calls(f, () => f.service.verifyEndedNested())).get("threads.get") ?? 0).toBe(0);
    expect((await calls(f, () => f.service.reviveUnarchivedNested())).get("threads.list") ?? 0).toBe(0);
  });

  it("reads at most NESTED_VERIFY_BATCH a sweep, and retries a failed read after the others", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, NESTED_VERIFY_BATCH + 5, NESTED_VERIFY_BATCH + 5);
    await f.overview(project.id);
    f.intercept((path, args, call) => {
      if (path === "threads.get" && (args as any).threadId === "nested-0") throw Object.assign(new Error("BB down"), { status: 503 });
      return call();
    });
    await expect(f.service.verifyEndedNested()).rejects.toThrow("BB down");
    f.intercept();
    expect((await calls(f, () => f.service.verifyEndedNested())).get("threads.get")).toBe(NESTED_VERIFY_BATCH);
    // The 5 left: 4 never read, then nested-0 again.
    expect((await calls(f, () => f.service.verifyEndedNested())).get("threads.get")).toBe(5);
    expect((await calls(f, () => f.service.verifyEndedNested())).get("threads.get") ?? 0).toBe(0);
  });

  it("a verifying read cancelled with the sweep keeps its thread for the next sweep (review r7)", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 1, 1);
    await f.overview(project.id);
    f.threads.delete("nested-0");
    const sweep = new AbortController();
    f.intercept((path, _args, call) => {
      if (path !== "threads.get") return call();
      sweep.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(f.service.verifyEndedNested(sweep.signal)).rejects.toThrow("aborted");
    f.intercept();
    expect((await calls(f, () => f.service.verifyEndedNested())).get("threads.get")).toBe(1);
    expect(await status(f, project.id, "nested-0")).toBe("deleted");
  });

  it("a deletion event during the unarchived list wins over the list's older row", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 1, 1);
    await f.overview(project.id);
    f.threads.set("nested-0", { ...f.threads.get("nested-0")!, archivedAt: null });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let listed!: () => void;
    const started = new Promise<void>((resolve) => { listed = resolve; });
    f.intercept(async (path, _args, call) => {
      const answer = await call();
      if (path === "threads.list") { listed(); await held; }
      return answer;
    });
    const listing = f.service.reviveUnarchivedNested();
    await started;
    const deleted = { ...f.threads.get("nested-0")!, deletedAt: 9 };
    f.threads.delete("nested-0");
    await f.harness.emitThreadEvent("thread.deleted", { thread: deleted });
    release();
    await listing;
    f.intercept();
    expect(threadsToWatch(f.store, project.id)).toEqual(["coordinator"]);
    expect(await status(f, project.id, "nested-0")).toBe("deleted");
  });

  it("an archive event during the verifying read wins over its older unarchived answer", async () => {
    const { f, project } = await projectFixture();
    nest(f, project.id, 1, 1);
    await f.overview(project.id);
    // Unarchived and re-archived while the read is in flight: the same stored fact, but a newer one.
    f.threads.set("nested-0", { ...f.threads.get("nested-0")!, archivedAt: null });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    f.intercept(async (path, _args, call) => {
      const answer = await call();
      if (path === "threads.get") { reading(); await held; }
      return answer;
    });
    const verifying = f.service.verifyEndedNested();
    await started;
    const unarchived = f.threads.get("nested-0")!;
    await f.harness.emitThreadEvent("thread.unarchived", { thread: unarchived });
    const archived = { ...unarchived, archivedAt: 10 };
    f.threads.set("nested-0", archived);
    await f.harness.emitThreadEvent("thread.archived", { thread: archived });
    release();
    await verifying;
    f.intercept();
    expect(threadsToWatch(f.store, project.id)).toEqual(["coordinator"]);
    expect(await status(f, project.id, "nested-0")).toBe("archived");
  });
});

describe("W496 a dashboard read waits at most ~200 ms for threads it has never read", () => {
  async function withWorker() {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "First");
    const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    return { f, project, worker: a.threadId! };
  }

  it("BB slow: answers within ~250 ms with loading rows, then the realtime update fills them", async () => {
    const { f, project, worker } = await withWorker();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    // BB takes 5 s (here: until released) to answer each thread read.
    f.intercept(async (path, _args, call) => {
      if (path === "threads.get") await slow;
      return call();
    });
    const signals = f.harness.inspection.realtimeSignals.length;
    const started = performance.now();
    const first = await dashboard(f, project.id);
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(FIRST_READ_WAIT_MS - 5);
    expect(took).toBeLessThan(250);
    expect(first.project.coordinatorStatus).toBe("loading");
    expect(first.workers.current.find((w: any) => w.threadId === worker).runtime).toBe("loading");
    expect(first.memberThreads.find((t: any) => t.threadId === worker).nativeStatus).toBe("loading");
    expect(first.usage.threads.find((t: any) => t.threadId === worker).runtime).toBe("loading");
    release();
    await vi.waitFor(() =>
      expect(f.harness.inspection.realtimeSignals.slice(signals)).toContainEqual({ channel: "initiatives-changed", payload: { projectId: project.id } }));
    f.intercept();
    const filled = await dashboard(f, project.id);
    expect(filled.project.coordinatorStatus).toBe("idle");
    expect(JSON.stringify(filled)).not.toMatch(/"(loading|unreadable)"/);
  });

  it("BB fast: no placeholders, and the cold answer equals the warm one", async () => {
    const { f, project } = await withWorker();
    const signals = f.harness.inspection.realtimeSignals.length;
    const cold = await dashboard(f, project.id);
    expect(JSON.stringify(cold)).not.toMatch(/"(loading|unreadable)"/);
    const warm = await dashboard(f, project.id);
    // workerWaiting fills from W473's child listings, which no thread read waits on.
    const { workerWaiting: _cold, ...coldRest } = cold;
    const { workerWaiting: _warm, ...warmRest } = warm;
    expect(JSON.stringify(warmRest)).toBe(JSON.stringify(coldRest));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.harness.inspection.realtimeSignals.slice(signals)).toEqual([]);
  });

  it("BB failing: rows show unreadable, BB is asked again only after the TTL, and a recovery fills them in", async () => {
    const { f, project, worker } = await withWorker();
    let reads = 0;
    let failing = true;
    f.intercept(async (path, _args, call) => {
      if (path !== "threads.get") return call();
      reads++;
      if (failing) throw Object.assign(new Error("BB answered 503"), { status: 503 });
      return call();
    });
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const failed = await dashboard(f, project.id);
      expect(failed.project.coordinatorStatus).toBe("unreadable");
      expect(failed.workers.current.find((w: any) => w.threadId === worker).runtime).toBe("unreadable");
      expect(f.harness.inspection.logEntries.some((entry: any) => JSON.stringify(entry).includes("Could not read thread coordinator for the dashboard: BB answered 503"))).toBe(true);
      // Within the TTL: no read, still unreadable, nothing announced (no refetch loop).
      const signals = f.harness.inspection.realtimeSignals.length;
      reads = 0;
      expect((await dashboard(f, project.id)).project.coordinatorStatus).toBe("unreadable");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reads).toBe(0);
      expect(f.harness.inspection.realtimeSignals.slice(signals)).toEqual([]);
      // Past the TTL BB is asked again; recovered, the rows fill in.
      failing = false;
      clock.mockReturnValue(start + LIVE_TTL_MS);
      const recovered = await dashboard(f, project.id);
      expect(reads).toBeGreaterThan(0);
      expect(recovered.project.coordinatorStatus).toBe("idle");
      expect(JSON.stringify(recovered)).not.toMatch(/"(loading|unreadable)"/);
    } finally {
      clock.mockRestore();
      f.intercept();
    }
  });

  it("agent and CLI reads still wait for every thread", async () => {
    const { f, project } = await withWorker();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    f.intercept(async (path, _args, call) => {
      if (path === "threads.get") await slow;
      return call();
    });
    let settled = false;
    const read = f.overview(project.id).then((o) => { settled = true; return o; });
    await new Promise((resolve) => setTimeout(resolve, FIRST_READ_WAIT_MS + 50));
    expect(settled).toBe(false);
    release();
    expect((await read).project.coordinatorStatus).toBe("idle");
    f.intercept();
  });
});

describe("W496 LiveThreads", () => {
  const dto = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, status: "idle", archivedAt: null, deletedAt: null, title: id, ...over });

  it("a retried failure stays unreadable while the retry runs, and announces only what changed", async () => {
    let now = 0;
    let answer: () => Promise<any> = async () => { throw new Error("down"); };
    const failed = vi.fn();
    const live = new LiveThreads(() => answer(), () => now, failed);
    const revalidated = vi.fn();
    expect((await live.get(["t"], { wait: 50, revalidated })).unread?.get("t")).toBe("unreadable");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(revalidated).not.toHaveBeenCalled();
    // A slow retry that fails again: shown unreadable (not loading), nothing announced, logged once.
    now = LIVE_TTL_MS;
    let fail!: () => void;
    answer = () => new Promise((_, reject) => { fail = () => reject(new Error("still down")); });
    expect((await live.get(["t"], { wait: 10, revalidated })).unread?.get("t")).toBe("unreadable");
    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revalidated).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    // A slow retry that succeeds announces once.
    now = 2 * LIVE_TTL_MS;
    let succeed!: () => void;
    answer = () => new Promise((resolve) => { succeed = () => resolve(dto("t")); });
    expect((await live.get(["t"], { wait: 10, revalidated })).unread?.get("t")).toBe("unreadable");
    succeed();
    await vi.waitFor(() => expect(revalidated).toHaveBeenCalledTimes(1));
    expect((await live.get(["t"], { wait: 10, revalidated })).get("t")?.status).toBe("idle");
  });

  it("an event during a fresh read of a thread it never knew wins over the read's older answer", async () => {
    let release!: (value: unknown) => void;
    const live = new LiveThreads(() => new Promise((resolve) => { release = resolve; }) as never);
    const read = live.get(["t"], { fresh: true });
    await Promise.resolve();
    live.observe(dto("t", { status: "active" }) as never);
    release(dto("t", { archivedAt: 1 }));
    await read;
    expect(live.current("t")).toMatchObject({ status: "active", archived: false });
  });
});
