import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";

// Discovery sweeps against BB 0.43.1's real child listing: archived children are
// returned unless `archived` is passed (only deleted ones are always hidden). The
// default fake hides archived children, so these tests route listings here.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let clock = 1_000;

function realRoute(f: Fx) {
  let calls: { path: string; parent?: string; offset?: number }[] = [];
  const hooks: { list?: (args: any, run: () => Promise<any[]>) => Promise<any[]> } = {};
  const list = async (args: any) => [...f.threads.values()]
    .filter((t: any) => t.parentThreadId === args.parentThreadId && t.deletedAt == null)
    .filter((t: any) => args.archived === true ? t.archivedAt != null : args.archived === false ? t.archivedAt == null : true)
    .sort((a: any, b: any) => b.createdAt - a.createdAt)
    .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200))
    .map((t: any) => ({ ...t, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 }, hasPendingInteraction: false, queuedWork: "none" }));
  f.intercept((path, args, call) => {
    calls.push({ path, parent: args?.parentThreadId, offset: args?.offset });
    if (path === "threads.list" && args?.parentThreadId) return hooks.list ? hooks.list(args, () => list(args)) : list(args);
    return call();
  });
  return {
    hooks,
    count: () => calls.length,
    take() {
      const out = calls;
      calls = [];
      const lists = out.filter(c => c.path === "threads.list" && c.parent && !c.offset).map(c => c.parent!);
      return { lists, gets: out.filter(c => c.path === "threads.get").length, total: out.length };
    },
  };
}

const thread = (f: Fx, id: string, parent: string | null, archived = false) =>
  f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", environmentId: "env_a", title: id, parentThreadId: parent, createdAt: clock++, ...(archived ? { archivedAt: clock } : {}) }) as any);

/** Coordinator, workers (the first `retired` archived and closed), one nested child per worker, adhoc threads and archived former coordinators. */
async function graph(o: { workers: number; retired: number; adhoc?: number; adhocArchived?: number; formers?: number }) {
  const { f, project } = await projectFixture();
  const pid = project.id;
  // One transaction: hundreds of separate synchronous writes would block the test worker for seconds.
  f.store.tx(() => {
  for (let i = 1; i <= o.workers; i++) {
    const tid = `w${i}`;
    const archived = i <= o.retired;
    thread(f, tid, "coordinator", archived);
    const w = f.store.createWorker({ projectId: pid, role: "work", label: tid, area: "x", bbProjectId: "proj_a", nativeParent: true });
    f.store.openGeneration(pid, w.num, 1, tid);
    f.store.updateWorker(pid, w.num, { threadId: tid, generation: 1, state: archived ? "retired" : "idle" } as any);
    if (archived) f.store.closeGeneration(pid, w.num, "retired");
    thread(f, `n${i}`, tid, archived);
    f.store.associateNestedThread({ projectId: pid, threadId: `n${i}`, label: `n${i}`, bbProjectId: "proj_a" });
  }
  for (let i = 1; i <= (o.adhoc ?? 0); i++) {
    thread(f, `a${i}`, "coordinator", i <= (o.adhocArchived ?? 0));
    f.store.associateProjectThread({ projectId: pid, opId: `op_a${i}`, threadId: `a${i}`, label: `a${i}`, bbProjectId: "proj_a" });
  }
  for (let i = 1; i <= (o.formers ?? 0); i++) {
    thread(f, `fc${i}`, null, true);
    f.store.db.prepare("INSERT INTO generations (project_id, worker_num, generation, thread_id, started_at, ended_at, end_reason) VALUES (?, 0, ?, ?, 1, 2, 'replaced')").run(pid, 100 + i, `fc${i}`);
  }
  });
  return { f, pid, io: realRoute(f) };
}

const QUIET = { workers: 100, retired: 90, adhoc: 10, adhocArchived: 3, formers: 3 };
const member = (f: Fx, id: string) => f.store.membership(id, true)?.kind ?? null;
const emit = (f: Fx, event: any, id: string) => f.harness.emitThreadEvent(event, { thread: f.threads.get(id) as any });
const archivedSeeds = (shape: typeof QUIET) => new Set([
  ...Array.from({ length: shape.retired }, (_, i) => [`w${i + 1}`, `n${i + 1}`]).flat(),
  ...Array.from({ length: shape.adhocArchived }, (_, i) => `a${i + 1}`),
  ...Array.from({ length: shape.formers }, (_, i) => `fc${i + 1}`),
]);
/** One sweep, then a macrotask yield: the fake SDK resolves on microtasks only. */
async function sweep(f: Fx, signal?: AbortSignal) {
  await f.runtime.sweep(signal);
  await new Promise(resolve => setImmediate(resolve));
}
async function sweepUntil(f: Fx, done: () => boolean, max: number) {
  let sweeps = 0;
  while (!done() && sweeps < max) { await sweep(f); sweeps++; }
  return sweeps;
}

describe("T87 quiet discovery reads", { timeout: 60_000 }, () => {
  it("lists every visited parent once per sweep", async () => {
    const { f, io } = await graph(QUIET);
    await sweep(f);
    const { lists } = io.take();
    expect(lists.length).toBe(new Set(lists).size);
  });

  it("stops re-listing parents an earlier sweep saw archived, except a bounded rotating re-check", async () => {
    const { f, io } = await graph(QUIET);
    await sweep(f);
    const first = io.take();
    const cold = archivedSeeds(QUIET);
    const rechecked = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await sweep(f);
      const pass = io.take();
      const coldLists = pass.lists.filter(id => cold.has(id));
      expect(coldLists.length).toBeLessThanOrEqual(20);
      for (const id of coldLists) rechecked.add(id);
      expect(pass.lists.length).toBeLessThan(first.lists.length / 2);
      expect(pass.gets).toBeLessThan(first.gets);
    }
    // The re-check rotates instead of repeating the same 20.
    expect(rechecked.size).toBeGreaterThan(20);
  });

  it("native create/unarchive events only invalidate memory: no SDK calls, no ledger writes", async () => {
    const { f, pid, io } = await graph(QUIET);
    await sweep(f); io.take();
    const before = JSON.stringify([f.store.projectThreads(pid), f.store.nestedProjectThreads(pid), f.store.activity(pid)]);
    thread(f, "ev-new", "w2");
    await emit(f, "thread.created", "ev-new");
    f.threads.set("w3", { ...(f.threads.get("w3") as any), archivedAt: null });
    await emit(f, "thread.unarchived", "w3");
    expect(io.take().total).toBe(0);
    expect(JSON.stringify([f.store.projectThreads(pid), f.store.nestedProjectThreads(pid), f.store.activity(pid)])).toBe(before);
  });
});

describe("T87 discovery stays live under the parent cap", { timeout: 60_000 }, () => {
  it("reaches the newest live nested thread past 300 seeds within two sweeps", async () => {
    const { f, pid } = await graph({ workers: 160, retired: 155 });
    thread(f, "late", "w160");
    f.store.associateNestedThread({ projectId: pid, threadId: "late", label: "late", bbProjectId: "proj_a" });
    thread(f, "late-child", "late");
    expect(await sweepUntil(f, () => member(f, "late-child") === "adhoc", 2)).toBeLessThanOrEqual(2);
    expect(member(f, "late-child")).toBe("adhoc");
  });

  it("rotates more than 300 live parents so none is permanently starved", async () => {
    const { f, io } = await graph({ workers: 155, retired: 0 });
    await sweep(f); await sweep(f); io.take();
    // Steady state: 311 live parents, about 279 listed per sweep, so every one within two sweeps.
    const listed = new Set<string>();
    for (let i = 0; i < 2; i++) { await sweep(f); for (const id of io.take().lists) listed.add(id); }
    for (let i = 1; i <= 155; i++) { expect(listed.has(`w${i}`), `w${i}`).toBe(true); expect(listed.has(`n${i}`), `n${i}`).toBe(true); }
    thread(f, "tail-child", "n155");
    thread(f, "head-child", "w1");
    expect(await sweepUntil(f, () => member(f, "tail-child") === "adhoc" && member(f, "head-child") === "adhoc", 4)).toBeLessThanOrEqual(4);
  });

  it("keeps the archived re-check reachable when live parents fill the cap", async () => {
    const { f } = await graph({ workers: 175, retired: 20 });
    await sweep(f); await sweep(f);
    thread(f, "cold-child", "w17");
    // 311 live parents fill the cap; 40 cold seeds / 20 per sweep: at most two re-check sweeps.
    expect(await sweepUntil(f, () => member(f, "cold-child") === "adhoc", 5)).toBeLessThanOrEqual(5);
    expect(member(f, "cold-child")).toBe("adhoc");
  });
});

describe("T87 association still follows native changes", { timeout: 60_000 }, () => {
  it("a new child under the live coordinator is associated on the next sweep", async () => {
    const { f } = await graph(QUIET);
    await sweep(f); await sweep(f);
    thread(f, "x-new", "coordinator");
    await sweep(f);
    expect(member(f, "x-new")).toBe("adhoc");
  });

  it("a child created under an archived worker is associated after its thread.created event", async () => {
    const { f } = await graph(QUIET);
    await sweep(f); await sweep(f);
    thread(f, "y-new", "w45");
    await emit(f, "thread.created", "y-new");
    await sweep(f);
    expect(member(f, "y-new")).toBe("adhoc");
  });

  it("missed event: a child under an archived worker is found within ceil(cold/20) sweeps; a reload rescans everything", async () => {
    const { f } = await graph(QUIET);
    await sweep(f); await sweep(f);
    thread(f, "z-new", "w45");
    const bound = Math.ceil(archivedSeeds(QUIET).size / 20) + 1;
    expect(await sweepUntil(f, () => member(f, "z-new") === "adhoc", bound)).toBeLessThanOrEqual(bound);
    expect(member(f, "z-new")).toBe("adhoc");
    // A reload builds a fresh service, whose discovery memory starts empty.
    thread(f, "z-reload", "w46");
    const service = f.service as unknown as { discovery?: object };
    if (service.discovery) service.discovery = new (service.discovery.constructor as new () => object)();
    await sweep(f);
    expect(member(f, "z-reload")).toBe("adhoc");
  });

  it("an archived worker unarchived with an event, or silently, is listed again", async () => {
    const { f } = await graph(QUIET);
    await sweep(f); await sweep(f);
    f.threads.set("w3", { ...(f.threads.get("w3") as any), archivedAt: null });
    await emit(f, "thread.unarchived", "w3");
    thread(f, "u-new", "w3");
    f.threads.set("w7", { ...(f.threads.get("w7") as any), archivedAt: null });
    thread(f, "s-new", "w7");
    await sweep(f);
    expect(member(f, "u-new")).toBe("adhoc");
    // Silent unarchive: the coordinator's listing shows w7 live this sweep.
    if (member(f, "s-new") !== "adhoc") await sweep(f);
    expect(member(f, "s-new")).toBe("adhoc");
  });

  it("an unarchive landing while a listing is in flight leaves no stale archived mark", async () => {
    const { f, io } = await graph(QUIET);
    let fired = false;
    io.hooks.list = async (args, run) => {
      const rows = await run();
      if (args.parentThreadId === "coordinator" && !fired) {
        fired = true;
        f.threads.set("w4", { ...(f.threads.get("w4") as any), archivedAt: null });
        await emit(f, "thread.unarchived", "w4");
      }
      return rows;
    };
    await sweep(f);
    io.hooks.list = undefined;
    thread(f, "r-new", "w4");
    await sweep(f);
    expect(member(f, "r-new")).toBe("adhoc");
  });

  it("a former coordinator's child is associated and converges; after it is archived, later children still arrive", async () => {
    const { f, pid } = await graph(QUIET);
    thread(f, "fc-live", null);
    f.store.db.prepare("INSERT INTO generations (project_id, worker_num, generation, thread_id, started_at, ended_at, end_reason) VALUES (?, 0, 200, 'fc-live', 1, 2, 'replaced')").run(pid);
    thread(f, "fc-child", "fc-live");
    await sweep(f); await sweep(f);
    expect(member(f, "fc-child")).toBe("adhoc");
    expect((f.threads.get("fc-child") as any).parentThreadId).toBe("coordinator");
    // Convergence archived the former generation; its archived state is now known.
    expect((f.threads.get("fc-live") as any).archivedAt).not.toBeNull();
    thread(f, "fc-late", "fc-live");
    await emit(f, "thread.created", "fc-late");
    await sweep(f);
    expect(member(f, "fc-late")).toBe("adhoc");
    thread(f, "fc-silent", "fc-live");
    const bound = Math.ceil((archivedSeeds(QUIET).size + 1) / 20) + 1;
    expect(await sweepUntil(f, () => member(f, "fc-silent") === "adhoc", bound)).toBeLessThanOrEqual(bound);
  });

  it("a natively retired worker is listed once more, then skipped", async () => {
    const { f, io } = await graph(QUIET);
    await sweep(f); await sweep(f); io.take();
    f.threads.set("w99", { ...(f.threads.get("w99") as any), archivedAt: clock++ });
    f.threads.set("n99", { ...(f.threads.get("n99") as any), archivedAt: clock++ });
    await emit(f, "thread.archived", "w99");
    await sweep(f); io.take();
    await sweep(f);
    const later = io.take().lists;
    // Only the rotating re-check may list it again.
    expect(later.filter(id => id === "w99").length).toBeLessThanOrEqual(1);
  });

  it("makes no SDK call after the sweep is aborted", async () => {
    const { f, io } = await graph(QUIET);
    await sweep(f); io.take();
    const controller = new AbortController();
    let atAbort = -1;
    io.hooks.list = async (_args, run) => {
      const rows = await run();
      if (atAbort < 0) { controller.abort(); atAbort = io.count(); }
      return rows;
    };
    await sweep(f, controller.signal);
    expect(atAbort).toBeGreaterThan(0);
    expect(io.count()).toBe(atAbort);
  });
});

describe("T87 A183/A185: an event-driven listing obligation is kept until it is honoured", { timeout: 60_000 }, () => {
  /**
   * Archived nested member P (with `kids` archived children) under a live project thread G,
   * or directly under the coordinator, observed for three sweeps. Under the coordinator, every
   * sweep's first listing re-marks P archived before P's own turn comes.
   */
  async function archivedUnder(parent: "G" | "coordinator", kids = 0) {
    const { f, pid, io } = await graph(QUIET);
    f.store.tx(() => {
      if (parent === "G") {
        thread(f, "G", "coordinator");
        f.store.associateProjectThread({ projectId: pid, opId: "op_G", threadId: "G", label: "G", bbProjectId: "proj_a" });
      }
      thread(f, "P", parent, true);
      f.store.associateNestedThread({ projectId: pid, threadId: "P", label: "P", bbProjectId: "proj_a" });
      for (let i = 0; i < kids; i++) thread(f, `k${i}`, "P", true);
    });
    await sweep(f); await sweep(f); await sweep(f); io.take();
    return { f, pid, io };
  }
  const transient = () => Object.assign(new Error("transient"), { status: 503 });

  // A183 P1 (exact): the created event lands while the coordinator listing is in flight,
  // and P's live parent G is listed later in the same sweep, observing P archived again.
  it("a created event mid-sweep is honoured in that same sweep despite a later archived observation", async () => {
    const { f, io } = await archivedUnder("G");
    let fired = false;
    io.hooks.list = async (args, run) => {
      const rows = await run();
      if (args.parentThreadId === "coordinator" && !fired) {
        fired = true;
        thread(f, "C", "P");
        await emit(f, "thread.created", "C");
      }
      return rows;
    };
    await sweep(f);
    expect(fired).toBe(true);
    expect(member(f, "C")).toBe("adhoc");
  });

  it("an obligated parent is listed in the first sweep even when 300 never-listed members would fill the cap", async () => {
    const { f, pid, io } = await graph(QUIET);
    await sweep(f); await sweep(f); io.take();
    thread(f, "c45", "w45");
    await emit(f, "thread.created", "c45");
    f.store.tx(() => {
      for (let i = 1; i <= 300; i++) {
        thread(f, `b${i}`, "coordinator");
        f.store.associateProjectThread({ projectId: pid, opId: `op_b${i}`, threadId: `b${i}`, label: `b${i}`, bbProjectId: "proj_a" });
      }
    });
    await sweep(f);
    const lists = io.take().lists;
    expect(lists.slice(0, 2)).toEqual(["coordinator", "w45"]);
    expect(member(f, "c45")).toBe("adhoc");
  });

  // A185 Q5: more obligations than the cap; the cut ones and a newer event under a cut parent carry over.
  it("obligations beyond the cap, and a newer event under a cut parent, are all honoured the next sweep", async () => {
    const { f, pid, io } = await graph(QUIET);
    f.store.tx(() => {
      for (let i = 1; i <= 305; i++) {
        thread(f, `X${i}`, "coordinator", true);
        f.store.associateNestedThread({ projectId: pid, threadId: `X${i}`, label: `X${i}`, bbProjectId: "proj_a" });
      }
    });
    for (let i = 0; i < 4; i++) await sweep(f);
    io.take();
    for (let i = 1; i <= 305; i++) { thread(f, `Y${i}`, `X${i}`); await emit(f, "thread.created", `Y${i}`); }
    let fired = false;
    io.hooks.list = async (args, run) => {
      const rows = await run();
      if (args.parentThreadId === "X10" && !fired) { fired = true; thread(f, "Z", "X305"); await emit(f, "thread.created", "Z"); }
      return rows;
    };
    await sweep(f);
    io.hooks.list = undefined;
    expect(fired).toBe(true);
    const ys = Array.from({ length: 305 }, (_, i) => `Y${i + 1}`);
    // The coordinator plus 299 obligations fit; six are cut by the cap.
    expect(ys.filter(id => member(f, id) !== "adhoc")).toHaveLength(6);
    await sweep(f);
    expect(ys.filter(id => member(f, id) !== "adhoc")).toEqual([]);
    expect(member(f, "Z")).toBe("adhoc");
  });

  it("a new event during the parent's own listing is not discharged by that older read", async () => {
    const { f, io } = await archivedUnder("G");
    thread(f, "C1", "P");
    await emit(f, "thread.created", "C1");
    let fired = false;
    io.hooks.list = async (args, run) => {
      const rows = await run();
      if (args.parentThreadId === "P" && !fired) {
        fired = true;
        // Created after the page was read: this listing cannot have seen it.
        thread(f, "C2", "P");
        await emit(f, "thread.created", "C2");
      }
      return rows;
    };
    await sweep(f);
    io.hooks.list = undefined;
    expect(member(f, "C1")).toBe("adhoc");
    expect(member(f, "C2")).toBeNull();
    await sweep(f);
    expect(member(f, "C2")).toBe("adhoc");
  });

  // A185 Q1: the same, while a 60-child parent is on its second page.
  it("a new event during page 2 of the parent's listing is not discharged by that read", async () => {
    const { f, io } = await archivedUnder("G", 60);
    thread(f, "C1", "P");
    await emit(f, "thread.created", "C1");
    let fired = false;
    io.hooks.list = async (args, run) => {
      const rows = await run();
      if (args.parentThreadId === "P" && args.offset === 50 && !fired) { fired = true; thread(f, "C2", "P"); await emit(f, "thread.created", "C2"); }
      return rows;
    };
    await sweep(f);
    io.hooks.list = undefined;
    expect(fired).toBe(true);
    expect(member(f, "C1")).toBe("adhoc");
    await sweep(f);
    expect(member(f, "C2")).toBe("adhoc");
  });

  // A185 Q3b: the coordinator listing re-marks P archived before P's failed read, so only
  // an obligation that survives the failure gets P listed again.
  it("a listing that fails on its first page keeps the obligation, though P was re-marked archived", async () => {
    const { f, io } = await archivedUnder("coordinator");
    thread(f, "C", "P");
    await emit(f, "thread.created", "C");
    let failed = false;
    io.hooks.list = async (args, run) => {
      if (args.parentThreadId === "P" && !failed) { failed = true; throw transient(); }
      return run();
    };
    await sweep(f);
    io.hooks.list = undefined;
    expect(failed).toBe(true);
    expect(member(f, "C")).toBeNull();
    await sweep(f);
    expect(member(f, "C")).toBe("adhoc");
  });

  // A185 Q2: same shape, aborted between pages.
  it("a listing aborted before its second page keeps the obligation, though P was re-marked archived", async () => {
    const { f, io } = await archivedUnder("coordinator", 60);
    thread(f, "C", "P");
    await emit(f, "thread.created", "C");
    const controller = new AbortController();
    io.hooks.list = async (args, run) => {
      if (args.parentThreadId === "P" && args.offset === 50) controller.abort();
      return run();
    };
    await sweep(f, controller.signal);
    io.hooks.list = undefined;
    expect(controller.signal.aborted).toBe(true);
    io.take();
    await sweep(f);
    expect(io.take().lists).toContain("P");
  });

  it("events about non-member threads leave no obligation behind", async () => {
    const { f, io } = await graph(QUIET);
    await sweep(f); await sweep(f); io.take();
    thread(f, "stranger", null);
    thread(f, "stranger-child", "stranger");
    await emit(f, "thread.created", "stranger-child");
    await sweep(f);
    expect(io.take().lists).not.toContain("stranger");
    expect(member(f, "stranger-child")).toBeNull();
  });
});
