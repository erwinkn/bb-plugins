import { describe, expect, it, vi } from "vitest";
import { buildOverview } from "../lib/overview";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

const startRow = (f: Fixture, projectId: string) =>
  f.store.db.prepare("SELECT state, thread_id FROM coordinator_starts WHERE project_id=?").get(projectId) as
    { state: string; thread_id: string | null };

/** Bury `id` behind `count` older Projects-origin threads in BB's listing order. */
function bury(f: Fixture, id: string, count: number) {
  const receipt = f.threads.get(id)!;
  f.threads.delete(id);
  for (let i = 0; i < count; i++)
    f.threads.set(`filler-${i}`, makeThreadResponse({
      id: `filler-${i}`,
      createdAt: 1,
      projectId: "proj_a",
      environmentId: "env_a",
      originPluginId: "initiatives",
    }));
  f.threads.set(id, receipt);
}

/** Record every later SDK call as [path, args]. */
function record(f: Fixture) {
  const calls: [string, any][] = [];
  f.intercept((path, args, call) => {
    calls.push([path, args]);
    return call();
  });
  return calls;
}

/**
 * A confirmed switch whose predecessor refuses to archive: the replacement
 * lands checkout-pending, the predecessor gains queued messages, then the
 * sweep confirms the successor and its convergence refuses.
 */
async function stuckPredecessor() {
  const { f, project } = await projectFixture();
  f.idle("coordinator");
  const original = f.spawn.getMockImplementation()!;
  f.spawn.mockImplementationOnce(async (args) => {
    const thread = await original(args);
    f.threads.set(thread.id, { ...thread, environmentId: null });
    return { ...thread, environmentId: null };
  });
  const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
  const successor = (result as { threadId: string }).threadId;
  f.threads.set("coordinator", { ...f.threads.get("coordinator")!, queuedMessageCount: 3 });
  f.threads.set(successor, { ...f.threads.get(successor)!, environmentId: "env_a" });
  await f.service.reconcile();
  expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
  expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
  return { f, project, successor };
}

const holds = (f: Fixture, projectId: string) =>
  f.store.activity(projectId, 300).filter((a) => a.summary.includes("stays live"));

describe("T110 coordinator receipts past the first listing page", () => {
  it("confirms a retained receipt by direct lookup, wherever it sits in the listing", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await original(args);
      f.threads.set(thread.id, { ...thread, environmentId: null });
      return { ...thread, environmentId: null };
    });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    const successor = (result as { threadId: string }).threadId;
    expect(startRow(f, project.id)).toMatchObject({ state: "pending", thread_id: successor });
    bury(f, successor, 290);
    f.threads.set(successor, { ...f.threads.get(successor)!, environmentId: "env_a" });
    const calls = record(f);
    await f.service.reconcile();
    expect(startRow(f, project.id)).toMatchObject({ state: "done", thread_id: successor });
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
    // No Projects-wide scan was needed to find it.
    expect(calls.some(([path, args]) => path === "threads.list" && args?.originPluginId)).toBe(false);
  });

  it("scans every page for an unretained receipt and skips metadata for older rows", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const original = f.spawn.getMockImplementation()!;
    // The spawn landed natively but its reply was lost: no receipt retained.
    f.spawn.mockImplementationOnce(async (args) => {
      await original(args);
      throw Object.assign(new Error("socket hang up"), { status: 502 });
    });
    await expect(f.service.replaceCoordinator(project.id, { reason: "Switch model" })).rejects.toThrow();
    expect(startRow(f, project.id)).toMatchObject({ state: "uncertain", thread_id: null });
    const successor = [...f.threads.keys()].at(-1)!;
    bury(f, successor, 450);
    const calls = record(f);
    await f.service.reconcile();
    expect(startRow(f, project.id)).toMatchObject({ state: "done", thread_id: successor });
    // 453 Projects threads: three pages, the receipt on the last.
    expect(calls.filter(([path, args]) => path === "threads.list" && args?.originPluginId)).toHaveLength(3);
    expect(calls.some(([path, args]) => path === "threads.getPluginMetadata" && args.threadId.startsWith("filler-"))).toBe(false);
  });
});

describe("T110 other creates past the first listing page", () => {
  /** The next spawn lands natively but its response is lost. */
  const loseNextSpawn = (f: Fixture) => {
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      await original(args);
      throw Object.assign(new Error("socket hang up"), { status: 502 });
    });
  };

  it("confirms an uncertain worker create wherever its thread sits", async () => {
    const { f, project } = await projectFixture();
    loseNextSpawn(f);
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] }).catch(() => undefined);
    expect(f.store.assignment(project.id, 1)!.opState).not.toBe("done");
    const created = [...f.threads.keys()].at(-1)!;
    bury(f, created, 250);
    await f.service.reconcile();
    expect(f.store.assignment(project.id, 1)).toMatchObject({ opState: "done", threadId: created });
  });

  it("confirms an uncertain project thread wherever it sits", async () => {
    const { f, project } = await projectFixture();
    loseNextSpawn(f);
    await f.service.createUserThread(project.id, {
      request: {
        projectId: "proj_a",
        environment: { type: "reuse", environmentId: "env_a" },
        input: [{ type: "text", text: "Look into it", mentions: [] }],
      } as never,
    });
    expect(f.store.projectThreads(project.id)[0]!.state).toBe("uncertain");
    const created = [...f.threads.keys()].at(-1)!;
    bury(f, created, 250);
    await f.service.reconcile();
    expect(f.store.projectThreads(project.id)[0]).toMatchObject({ state: "active", threadId: created });
  });
});

describe("T110 archived threads drop out of the sweep", () => {
  it("reads a former coordinator archived outside Initiatives once, then never again", async () => {
    const { f, project } = await stuckPredecessor();
    expect(holds(f, project.id)).toHaveLength(1);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, archivedAt: Date.now() });
    const calls = record(f);
    const reads = () => calls.filter(([path, args]) => path === "threads.get" && args.threadId === "coordinator").length;
    await f.service.convergeFormerCoordinators(project.id, undefined, { backoff: true });
    expect(reads()).toBe(1);
    await f.service.convergeFormerCoordinators(project.id, undefined, { backoff: true });
    await f.service.convergeFormerCoordinators(project.id);
    expect(reads()).toBe(1);
    expect(holds(f, project.id)).toHaveLength(1);
    expect(buildOverview(f.store, project.id, new Map(), Date.now()).project.formerCoordinators[0]!.holdReason).toBeNull();
  });

  it("stops re-reading a retained coordinator receipt once it is archived", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await original(args);
      f.threads.set(thread.id, { ...thread, environmentId: null });
      return { ...thread, environmentId: null };
    });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    const successor = (result as { threadId: string }).threadId;
    f.threads.set(successor, { ...f.threads.get(successor)!, archivedAt: Date.now() });
    const calls = record(f);
    const logged = f.store.activity(project.id).length;
    await f.service.reconcile();
    await f.service.reconcile();
    expect(calls.filter(([path, args]) => path === "threads.get" && args.threadId === successor)).toHaveLength(1);
    // Nothing is confirmed or logged; the start waits for an explicit settle.
    expect(startRow(f, project.id)).toMatchObject({ state: "pending", thread_id: successor });
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    expect(f.store.activity(project.id)).toHaveLength(logged);
  });
});

describe("T110 former-coordinator refusals", () => {
  it("logs an unchanged refusal once, backs off the sweep, and logs again when the reason changes", async () => {
    // The stuck incident: the predecessor is live with queued messages.
    const { f, project } = await stuckPredecessor();
    let now = 1_800_000_000_000;
    vi.spyOn(f.store, "now").mockImplementation(() => now);
    const calls = record(f);
    const tries = () => calls.filter(([path, args]) => path === "threads.get" && args.threadId === "coordinator").length;

    expect(holds(f, project.id)).toHaveLength(1);
    expect(holds(f, project.id)[0]!.summary).toContain("queued messages that would start more work");
    const overview = () => buildOverview(f.store, project.id, new Map(), now).project.formerCoordinators[0]!;
    expect(overview().holdReason).toBe("its thread has queued messages that would start more work");

    // A first refusal is retried on the very next sweep, and the same
    // refusal again stays a single log line.
    const first = tries();
    now += 30_000;
    await f.service.convergeFormerCoordinators(project.id, undefined, { backoff: true });
    expect(tries()).toBeGreaterThan(first);
    expect(holds(f, project.id)).toHaveLength(1);
    // Repeated, it backs the sweep off for a minute...
    const repeated = tries();
    now += 30_000;
    await f.service.convergeFormerCoordinators(project.id, undefined, { backoff: true });
    expect(tries()).toBe(repeated);
    now += 30_000;
    await f.service.convergeFormerCoordinators(project.id, undefined, { backoff: true });
    expect(tries()).toBeGreaterThan(repeated);
    // ...then doubles; an event-driven call still always tries.
    const doubled = tries();
    now += 60_000;
    await f.service.convergeFormerCoordinators(project.id, undefined, { backoff: true });
    expect(tries()).toBe(doubled);
    await f.service.convergeFormerCoordinators(project.id);
    expect(tries()).toBeGreaterThan(doubled);
    expect(holds(f, project.id)).toHaveLength(1);

    // A different refusal logs again.
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
    await f.service.convergeFormerCoordinators(project.id);
    expect(holds(f, project.id)).toHaveLength(2);
    expect(holds(f, project.id)[0]!.summary).toContain("still running");
    expect(overview().holdReason).toBe("its thread is still running");

    // Once it converges the hold clears.
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "idle", queuedMessageCount: 0 });
    await f.service.convergeFormerCoordinators(project.id);
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
    expect(overview().holdReason).toBeNull();
  });
});

describe("T110 review: unreadable lifecycle evidence and bounded scans", () => {
  /** A replacement waiting on its checkout, whose checkout is now reported. */
  async function pendingReplacement() {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await original(args);
      f.threads.set(thread.id, { ...thread, environmentId: null });
      return { ...thread, environmentId: null };
    });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Switch model" });
    const successor = (result as { threadId: string }).threadId;
    f.threads.set(successor, { ...f.threads.get(successor)!, environmentId: "env_a" });
    return { f, project, successor };
  }

  /** The first GET of `id` returns a row missing `field`. */
  function dropOnFirstRead(f: Fixture, id: string, field: "archivedAt" | "deletedAt") {
    let reads = 0;
    f.intercept((path, args, call) => {
      if (path === "threads.get" && args.threadId === id && ++reads === 1) {
        const row: any = { ...f.threads.get(id)! };
        delete row[field];
        return row;
      }
      return call();
    });
  }

  it("retries a retained receipt whose lifecycle fields were unreadable", async () => {
    const { f, project, successor } = await pendingReplacement();
    dropOnFirstRead(f, successor, "archivedAt");
    await f.service.reconcile();
    expect(startRow(f, project.id).state).toBe("pending");
    await f.service.reconcile();
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
  });

  it("keeps a former coordinator held and retried after unreadable lifecycle fields", async () => {
    const { f, project } = await stuckPredecessor();
    dropOnFirstRead(f, "coordinator", "deletedAt");
    await f.service.convergeFormerCoordinators(project.id);
    const hold = () => f.store.generations(project.id, 0).find((g) => g.threadId === "coordinator")!.holdReason;
    expect(hold()).toContain("unreadable lifecycle evidence");
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, queuedMessageCount: 0, status: "idle" });
    await f.service.convergeFormerCoordinators(project.id);
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
    expect(hold()).toBeNull();
  });

  /** An uncertain fresh worker create whose thread sits behind `count` older rows. */
  async function buriedWorkerCreate(count: number) {
    const { f, project } = await projectFixture();
    const original = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      await original(args);
      throw new Error("lost response");
    });
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] }).catch(() => undefined);
    const created = [...f.threads.keys()].at(-1)!;
    bury(f, created, count);
    return { f, project, created };
  }
  const scanPages = (calls: [string, any][]) =>
    calls.filter(([path, args]) => path === "threads.list" && args?.originPluginId).length;

  it("stops a receipt scan at the first abort", async () => {
    const { f, project } = await buriedWorkerCreate(1450);
    const abort = new AbortController();
    const calls: [string, any][] = [];
    f.intercept((path, args, call) => {
      calls.push([path, args]);
      if (path === "threads.list" && args?.originPluginId) abort.abort();
      return call();
    });
    await f.service.reconcile(abort.signal);
    expect(scanPages(calls)).toBe(1);
    expect(f.store.assignment(project.id, 1)!.opState).not.toBe("done");
  });

  it("reads a bounded number of pages per sweep and resumes to find a later receipt", async () => {
    const { f, project, created } = await buriedWorkerCreate(1450);
    const calls = record(f);
    await f.service.reconcile();
    // 1,000 rows per sweep: the receipt at ~#1452 is not reached yet.
    expect(scanPages(calls)).toBe(5);
    expect(f.store.assignment(project.id, 1)!.opState).not.toBe("done");
    calls.length = 0;
    await f.service.reconcile();
    expect(scanPages(calls)).toBe(3);
    expect(calls.find(([path, args]) => path === "threads.list" && args?.originPluginId)![1].offset).toBe(1000);
    expect(f.store.assignment(project.id, 1)).toMatchObject({ opState: "done", threadId: created });
  });
});
