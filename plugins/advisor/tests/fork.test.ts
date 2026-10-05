// A170 mandatory fixture: a fork copies its source's request and receipt rows
// with their original createdAt and does not copy the parent-change history.
// Copied rows are inherited context, never fresh instructions to the fork; the
// fork's own brief and new messages keep their authority. Also: the initial
// parent anchor is trusted only after a drain reaches the tip.

import { describe, expect, it } from "vitest";
import { Requests } from "../src/rules/requests.js";
import { buildBody, referenceSerializer } from "../src/rules/packet.js";
import { inclusionOrder } from "../src/rules/requests.js";
import { ok } from "../src/rules/snapshot.js";
import type { InitiativeSource } from "../src/runtime/initiatives.js";
import { watchDetail } from "../src/views.js";
import { Clock, FakeWorld, rig } from "./helpers/world.js";
import { fixture } from "./helpers/a160.js";

const PS = fixture("projects-shapes.json");
const OLD_BRIEF = "Initiative · bb-plugins · W3 Fix totals — A3: keep refund coverage.";
const NEW_BRIEF = "Initiative · bb-plugins · W9 Fix totals (fork) — A9: continue from W3, keep refund coverage.";

/** A typed Initiative fake from the installed Projects shapes: W9 member of thr_coord with A9 running. */
function initiatives(): InitiativeSource {
  const worker = { ...PS.workers_view_running.items[0], ref: "W9", threadId: "thr_fork", assignments: [{ ref: "A9", state: "running", cancelled: false, tasks: ["T1"] }] };
  const a9 = { ...PS.readRefs_detailed_running.items[0], ref: "A9", workerNum: 9, briefText: NEW_BRIEF };
  return {
    available: true,
    label: "test Initiative source",
    membership: async (threadId) => ok(threadId === "thr_fork" ? { coordinatorThreadId: "thr_coord", worker, former: false } : null),
    assignments: async () => ok({ ...PS.readRefs_detailed_running, items: [a9] }),
    tasks: async () => ok(PS.readRefs_task_brief),
  };
}

function forkWorld(clock: Clock, opts: { forkCreatedAt?: number | null } = {}) {
  const world = new FakeWorld(clock);
  const t0 = clock.now();
  // The source thread's history happened before the fork.
  const F = t0 + 60 * 60_000;
  world.addThread("thr_fork", {
    sourceThreadId: "thr_src",
    parentThreadId: "thr_coord",
    originPluginId: "projects",
    createdAt: opts.forkCreatedAt === undefined ? F : opts.forkCreatedAt,
  });
  // Rows BB copied from thr_src: original createdAt values, new seqs, no ownership history.
  world.emit("thr_fork", "client/turn/requested", { requestId: "s1", senderThreadId: null, initiator: "user", source: "spawn", input: [{ type: "text", text: OLD_BRIEF }] }, t0 + 1000);
  world.emit("thr_fork", "turn/input/accepted", { clientRequestId: "s1" }, t0 + 1100);
  world.emit("thr_fork", "client/turn/requested", { requestId: "s2", senderThreadId: "thr_coord", initiator: "agent", source: "tell", input: [{ type: "text", text: "Copied: relax the totals test." }] }, t0 + 2000);
  world.emit("thr_fork", "turn/input/accepted", { clientRequestId: "s2" }, t0 + 2100);
  // The fork's own history.
  clock.t = F + 10;
  world.ownership("thr_fork", null, "thr_coord");
  world.emit("thr_fork", "client/turn/requested", { requestId: "f1", senderThreadId: null, initiator: "user", source: "spawn", input: [{ type: "text", text: NEW_BRIEF }] });
  world.accept("thr_fork", "f1");
  world.request("thr_fork", "f2", "New for W9: keep exact totals.", "thr_coord");
  world.accept("thr_fork", "f2");
  return world;
}

describe("A170 fork fixture", () => {
  it("separates copied inherited requests from the fork's own brief and messages", async () => {
    const clock = new Clock();
    const world = forkWorld(clock);
    const r = await rig({}, { initiatives: initiatives() }, world);
    await r.advisor.watch("thr_fork", "test");
    await r.tick();
    const w = r.store.getWatchByThread("thr_fork")!;
    const ctx = { parent: "thr_coord", coordinator: "thr_coord", member: true, briefs: { A9: { text: NEW_BRIEF, state: "running" } } };
    const rq = r.store.loadRequests(w.id, { parent: "thr_coord", fork: { sourceThreadId: "thr_src", createdAt: w.thread!.createdAt! } });
    rq.setContext(ctx);
    rq.drained(true);
    expect(rq.requirements().map((x) => [x.ref, x.class, x.proof])).toEqual([
      ["R:1", "inherited", "fork-copy"], // the copied W3 brief is not W9's instruction
      ["R:3", "inherited", "fork-copy"], // a copied coordinator message claims no acceptance-time authority here
      ["R:6", "assignment-brief", "assignment:A9"], // the fork's own brief, exact briefText match
      ["R:8", "coordinator", "native-parent-at-acceptance"], // a genuinely new message, proven by the fork's own parent history
    ]);
    expect(rq.pending()).toEqual([]);
    expect(rq.coverage()).toBe("complete");
    const body = buildBody(referenceSerializer("claude-sonnet-5-5"), "charter", "", inclusionOrder([], rq.requirements()), [], [{ id: "E:1:0#0", text: "x", encBytes: 1 }]).body;
    const historic = body.indexOf("## Historic requirements");
    expect(historic).toBeGreaterThan(body.indexOf("[R:8 coordinator]"));
    expect(body.indexOf("[R:1 inherited from fork source, not an instruction to this thread]")).toBeGreaterThan(historic);
  });

  it("copied rows never gate dispatch or make a review stale", () => {
    const fork = { sourceThreadId: "thr_src", createdAt: 5000 };
    const rq = new Requests({ parent: "thr_coord", coordinator: "thr_coord", fork });
    rq.ingest({ seq: 1, type: "client/turn/requested", createdAt: 1000, data: { requestId: "c", senderThreadId: "thr_coord", initiator: "agent", input: [{ type: "text", text: "copied" }] } });
    expect(rq.pending()).toEqual([]); // a copied, never-settled request does not hold review
    expect(rq.authorityNow(rq.rows.get("c")!)).toBe("inherited");
  });

  it("missing or ambiguous fork metadata is unknown, never guessed", () => {
    const unknown = new Requests({ parent: "thr_coord", fork: "unknown" });
    const same = new Requests({ parent: "thr_coord", fork: { sourceThreadId: "thr_src", createdAt: 1000 } });
    for (const rq of [unknown, same]) {
      rq.ingest({ seq: 1, type: "client/turn/requested", createdAt: 1000, data: { requestId: "x", senderThreadId: null, initiator: "user", input: [{ type: "text", text: "t" }] } });
      rq.ingest({ seq: 2, type: "turn/input/accepted", createdAt: 1000, data: { clientRequestId: "x" } });
      expect(rq.requirements().map((x) => [x.class, x.proof])).toEqual([["inherited", "fork-origin-unknown"]]);
      expect(rq.coverage()).toBe("partial");
      expect(rq.forkGaps()).toEqual(["fork-origin-unknown"]);
    }
  });

  it("a thread that is not a fork keeps its own sender-less instructions as UNATTRIBUTED requirements", () => {
    const rq = new Requests({ parent: null, fork: null });
    rq.ingest({ seq: 1, type: "client/turn/requested", createdAt: 1, data: { requestId: "u", senderThreadId: null, initiator: "user", input: [{ type: "text", text: "keep totals exact" }] } });
    rq.ingest({ seq: 2, type: "turn/input/accepted", createdAt: 2, data: { clientRequestId: "u" } });
    expect(rq.requirements().map((x) => [x.class, x.proof])).toEqual([["unattributed", "none"]]);
  });
});

describe("initial-parent anchor", () => {
  it("a parent message is 'authority unverified' until a drain reaches the tip after the context read", async () => {
    const clock = new Clock();
    const world = new FakeWorld(clock);
    world.addThread("thr_child", { parentThreadId: "thr_parent" });
    world.request("thr_child", "p1", "Cover VAT too.", "thr_parent");
    world.accept("thr_child", "p1");
    world.turnStart("thr_child");
    for (let i = 0; i < 260; i++) world.command("thr_child", `echo ${i}`, 0, "x"); // more than one drain pass (8 x 25 rows)
    const r = await rig({}, {}, world);
    await r.advisor.watch("thr_child", "test");
    await r.tick();
    let w = r.store.getWatchByThread("thr_child")!;
    expect(w.atTip).toBe(false);
    const before = watchDetail(r.store, r.advisor, w, clock.now()).requirements.map((x) => x.label);
    expect(before).toEqual(["parent; authority when accepted unverified"]);
    await r.tick();
    w = r.store.getWatchByThread("thr_child")!;
    expect(w.atTip).toBe(true);
    expect(watchDetail(r.store, r.advisor, w, clock.now()).requirements.map((x) => x.label)).toEqual(["parent"]);
  });
});
