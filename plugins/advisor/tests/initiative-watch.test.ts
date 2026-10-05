// T103: one switch watches a whole Initiative. Membership comes from a typed
// fake of the Projects context routes (initiatives + members); no live reads,
// no model requests.

import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { unavailableInitiatives, type InitiativeMember, type InitiativeSource, type Listing } from "../src/runtime/initiatives.js";
import { projectsInitiatives } from "../src/runtime/projects.js";
import type { FetchLike } from "../src/transport/types.js";
import { overview, watchSummary } from "../src/views.js";
import { Clock, FakeWorld, rig, type Rig } from "./helpers/world.js";

const INIT = { id: "prj_1", name: "bb-plugins", paused: false, coordinatorThreadId: "thr_coord" };

/** A fake Initiative: members are edited by the test; `down` makes both routes unavailable. */
class FakeInitiative {
  members: InitiativeMember[] = [];
  archived = false;
  down: "unavailable" | "failed" | null = null;
  lists = 0;
  /** Members per page (pages in thread-id order, like Projects). */
  pageSize = 200;
  /** Make the page after this cursor fail, once. */
  failAfter: string | null | undefined = undefined;
  source(): InitiativeSource {
    const self = this;
    const gone = <T>(): Listing<T> => ({ status: self.down!, error: "Projects context route unavailable (404: no route)" });
    return {
      ...unavailableInitiatives,
      available: true,
      label: "fake Initiative source",
      async initiatives() {
        return self.down ? gone() : { status: "ok", value: [INIT, { id: "prj_2", name: "Other", paused: false, coordinatorThreadId: null }] };
      },
      async members(initiativeId, after) {
        self.lists++;
        if (self.down) return gone();
        if (self.failAfter !== undefined && self.failAfter === after) {
          self.failAfter = undefined;
          return { status: "failed", error: "Projects 500" };
        }
        const sorted = [...self.members].sort((a, b) => (a.threadId < b.threadId ? -1 : 1)).filter((m) => after === null || m.threadId > after);
        const page = sorted.slice(0, self.pageSize);
        const next = sorted.length > self.pageSize ? page.at(-1)!.threadId : null;
        return { status: "ok", value: { id: initiativeId, name: INIT.name, archived: self.archived, next, members: page.map((m) => ({ ...m })) } };
      },
    };
  }
  add(threadId: string, over: Partial<InitiativeMember> = {}) {
    this.members.push({ threadId, kind: "worker", role: "work", worker: `W${this.members.length}`, generation: 1, state: "active", ...over });
  }
  remove(threadId: string) {
    this.members = this.members.filter((m) => m.threadId !== threadId);
  }
  set(threadId: string, state: InitiativeMember["state"]) {
    this.members.find((m) => m.threadId === threadId)!.state = state;
  }
}

/** One turn with an edit and a claim. */
function work(world: FakeWorld, t: string) {
  world.turnStart(t);
  world.fileChange(t, "/repo/src/a.ts", "@@ -1,1 +1,1 @@\n-a\n+b");
  world.agentMessage(t, "Done.");
  world.turnEnd(t);
}

async function setup() {
  const clock = new Clock();
  const world = new FakeWorld(clock);
  const init = new FakeInitiative();
  world.addThread("thr_coord");
  world.addThread("thr_w1");
  world.addThread("thr_old");
  work(world, "thr_coord");
  work(world, "thr_w1");
  init.add("thr_coord", { kind: "coordinator", role: "coordinator", worker: null });
  init.add("thr_w1");
  init.add("thr_old", { state: "retired" });
  clock.advance(60_000);
  const r = await rig({}, { initiatives: init.source() }, world);
  return { r, world, clock, init };
}

const watched = (r: Rig) => Object.fromEntries(r.store.listWatches().map((w) => [w.threadId, { origin: w.origin, enabled: w.enabled, ended: w.state.initiativeEnded }]));

describe("Initiative watch", () => {
  it("watches the coordinator and every live member, not retired ones; an existing member starts at its current turn", async () => {
    const { r, world } = await setup();
    const iw = await r.advisor.watchInitiative("BB-Plugins", "test");
    expect(iw).toMatchObject({ id: "prj_1", name: "bb-plugins", enabled: true, error: null });
    expect(watched(r)).toEqual({
      thr_coord: { origin: "initiative", enabled: true, ended: null },
      thr_w1: { origin: "initiative", enabled: true, ended: null },
    });
    // The existing member's current turn (in progress) is read; earlier history is a named gap.
    world.turnStart("thr_w1");
    await r.tick();
    const w1 = r.store.getWatchByThread("thr_w1")!;
    expect(w1.startSeq).toBe(5);
    expect(r.store.listGaps(w1.id, 10).map((g) => g.reason)).toContain("before-watch");
    const s = watchSummary(r.store, r.advisor, w1);
    expect(s.initiative).toMatchObject({ id: "prj_1", name: "bb-plugins", role: "work", worker: "W1", label: "W1 work", state: "active" });
  });

  it("picks up a member that joins later, read from its first event, with no user action", async () => {
    const { r, world, clock, init } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    await r.tick();
    clock.advance(30_000);
    world.addThread("thr_new");
    work(world, "thr_new");
    // The creation event lists members at the next pass, inside the 10 s listing interval.
    init.add("thr_new", { role: "review", worker: "W7" });
    clock.advance(3_000);
    await r.harness.emitThreadEvent("thread.created", { thread: world.threads.get("thr_new") });
    await r.tick();
    const w = r.store.getWatchByThread("thr_new")!;
    expect(w).toMatchObject({ origin: "initiative", enabled: true, startSeq: 1, seeded: true });
    expect(r.store.listCards(w.id, { limit: 50 }).some((c) => c.kind === "edit")).toBe(true);
    expect(r.store.listGaps(w.id, 10).map((g) => g.reason)).not.toContain("before-watch");
    expect(w.state.fromStartIfCreatedAfter).toBeNull();
  });

  it("without a creation event, a new member is found by the bounded listing interval", async () => {
    const { r, world, clock, init } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    const lists = init.lists;
    world.addThread("thr_late");
    init.add("thr_late");
    clock.advance(2_000);
    await r.tick();
    expect(init.lists).toBe(lists); // within 10 s of the last listing: no read
    expect(r.store.getWatchByThread("thr_late")).toBeNull();
    clock.advance(10_000);
    await r.tick();
    expect(r.store.getWatchByThread("thr_late")).toMatchObject({ origin: "initiative", enabled: true });
  });

  it("a retired or replaced member stops being observed and keeps its evidence; it starts again if it comes back", async () => {
    const { r, world, clock, init } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    await r.tick();
    const w1 = r.store.getWatchByThread("thr_w1")!;
    const cards = r.store.listCards(w1.id, { limit: 50 }).length;
    expect(cards).toBeGreaterThan(0);
    init.set("thr_w1", "retired");
    init.set("thr_coord", "former");
    clock.advance(11_000);
    await r.tick();
    expect(watched(r)).toMatchObject({
      thr_w1: { enabled: false, ended: "retired from the Initiative" },
      thr_coord: { enabled: false, ended: "former Initiative member (replaced)" },
    });
    work(world, "thr_w1");
    clock.advance(11_000);
    await r.tick();
    const after = r.store.getWatchByThread("thr_w1")!;
    expect(r.store.listCards(after.id, { limit: 50 })).toHaveLength(cards); // history kept, nothing new read
    expect(after.cursor).toBe(w1.cursor);
    expect(r.advisor.dispatchHold(after, true)).toBe("watch disabled"); // so no review, not even a preview
    const o = overview(r.store, r.advisor, unavailableInitiatives, clock.now());
    expect(o.watches.find((w) => w.threadId === "thr_w1")).toMatchObject({ ended: "retired from the Initiative", initiative: { state: "retired" } });
    // A user re-enable is honored: the next listing does not stop it again.
    r.advisor.setEnabled(after.id, true, "panel");
    clock.advance(11_000);
    await r.tick();
    expect(watched(r).thr_w1).toEqual({ origin: "initiative", enabled: true, ended: null });
    // Archiving the Initiative stops its live members; the re-enabled one stays the user's choice.
    world.addThread("thr_live");
    init.add("thr_live");
    clock.advance(11_000);
    await r.tick();
    expect(watched(r).thr_live).toMatchObject({ enabled: true });
    init.archived = true;
    clock.advance(11_000);
    await r.tick();
    expect(watched(r)).toMatchObject({ thr_live: { enabled: false, ended: "Initiative archived" }, thr_w1: { enabled: true } });
  });

  it("dedupes with a thread watch: observed once, kept as yours, and never stopped by the Initiative", async () => {
    const { r, clock, init } = await setup();
    const mine = await r.advisor.watch("thr_w1", "test");
    await r.advisor.watchInitiative("prj_1", "test");
    expect(r.store.listWatches().filter((w) => w.threadId === "thr_w1")).toHaveLength(1);
    expect(r.store.getWatchByThread("thr_w1")).toMatchObject({ id: mine.id, origin: "selected" });
    expect(watchSummary(r.store, r.advisor, r.store.getWatch(mine.id)!).initiative?.label).toBe("W1 work");
    init.set("thr_w1", "retired");
    clock.advance(11_000);
    await r.tick();
    expect(r.store.getWatch(mine.id)).toMatchObject({ enabled: true });
  });

  it("a thread unwatch excludes the member until it is watched again", async () => {
    const { r, clock } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    const w1 = r.store.getWatchByThread("thr_w1")!;
    expect(r.advisor.unwatch(w1.id, "test")).toEqual({ excludedFrom: ["bb-plugins"] });
    clock.advance(11_000);
    await r.tick();
    expect(r.store.getWatchByThread("thr_w1")).toBeNull();
    expect(overview(r.store, r.advisor, unavailableInitiatives, clock.now()).initiativeWatches[0]!.members).toMatchObject({ excluded: 1 });
    await r.advisor.watch("thr_w1", "test");
    expect(r.store.memberOf("thr_w1")).toMatchObject({ excluded: false });
  });

  it("A250 #3: a member a complete walk no longer lists stops (moved or removed); a failed or partial walk stops nothing", async () => {
    const { r, world, clock, init } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    await r.tick();
    const w1 = r.store.getWatchByThread("thr_w1")!;
    const cards = r.store.listCards(w1.id, { limit: 50 }).length;
    init.remove("thr_w1");
    init.pageSize = 1;
    init.failAfter = "thr_coord"; // the walk breaks after its first page
    clock.advance(11_000);
    await r.tick();
    expect(watched(r).thr_w1).toMatchObject({ enabled: true });
    await r.tick(); // the walk goes on and completes
    await r.tick();
    expect(watched(r).thr_w1).toEqual({ origin: "initiative", enabled: false, ended: "no longer listed in the Initiative" });
    expect(r.store.memberOf("thr_w1")).toMatchObject({ state: "removed" });
    expect(r.store.listCards(w1.id, { limit: 50 })).toHaveLength(cards);
    // Listed again: it starts again.
    init.add("thr_w1");
    clock.advance(11_000);
    await r.tick();
    await r.tick();
    await r.tick();
    expect(watched(r).thr_w1).toMatchObject({ enabled: true, ended: null });
    void world;
  });

  it("A250 #5: walks more members than one page across bounded passes, and a live member past the first pages is watched", async () => {
    const { r, world, init } = await setup();
    for (let i = 0; i < 1200; i++) init.add(`thr_old_${String(i).padStart(4, "0")}`, { state: "retired" });
    world.addThread("thr_zz_live");
    init.add("thr_zz_live");
    const lists = init.lists;
    await r.advisor.watchInitiative("prj_1", "test");
    expect(init.lists - lists).toBe(5); // one pass reads at most 5 pages
    expect(r.store.getWatchByThread("thr_zz_live")).toBeNull();
    await r.tick();
    expect(r.store.getWatchByThread("thr_zz_live")).toMatchObject({ origin: "initiative", enabled: true });
  });

  it("A250 #4: an explicit thread watch after the Initiative watch is yours and survives off and removal", async () => {
    const { r } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    const before = r.store.getWatchByThread("thr_w1")!;
    const mine = await r.advisor.watch("thr_w1", "test");
    expect(mine).toMatchObject({ id: before.id, origin: "selected" });
    r.advisor.unwatchInitiative("prj_1", "test");
    expect(watched(r).thr_w1).toMatchObject({ origin: "selected", enabled: true });
    expect(r.advisor.unwatchInitiative("prj_1", "test", true).deleted).toBe(1); // the coordinator only
    expect(r.store.getWatch(before.id)).toMatchObject({ enabled: true, origin: "selected" });
  });

  it("survives a reload: the watch stays on, ended members stay stopped, and new members are still added", async () => {
    const { r, world, clock, init } = await setup();
    await r.advisor.watchInitiative("prj_1", "test");
    init.set("thr_w1", "retired");
    clock.advance(11_000);
    await r.tick();
    await r.reload();
    expect(r.store.listInitiativeWatches()).toMatchObject([{ id: "prj_1", enabled: true }]);
    world.addThread("thr_after");
    init.add("thr_after");
    await r.tick(); // a reload lists at once
    expect(watched(r)).toMatchObject({ thr_after: { enabled: true }, thr_w1: { enabled: false, ended: "retired from the Initiative" } });
  });

  it("off keeps member history; on resumes them; --delete removes only the Initiative's own watches", async () => {
    const { r, world, clock } = await setup();
    world.addThread("thr_mine");
    await r.advisor.watch("thr_mine", "test");
    await r.advisor.watchInitiative("prj_1", "test");
    await r.tick();
    const off = r.advisor.unwatchInitiative("bb-plugins", "test");
    expect(off.stopped).toBe(2);
    expect(watched(r)).toMatchObject({ thr_coord: { enabled: false, ended: "Initiative watch off" }, thr_w1: { enabled: false }, thr_mine: { enabled: true } });
    expect(r.store.listCards(r.store.getWatchByThread("thr_w1")!.id, { limit: 5 }).length).toBeGreaterThan(0);
    clock.advance(11_000);
    await r.tick();
    expect(watched(r).thr_w1!.enabled).toBe(false); // off means no listing and no restart
    await r.advisor.watchInitiative("prj_1", "test");
    expect(watched(r)).toMatchObject({ thr_coord: { enabled: true, ended: null }, thr_w1: { enabled: true } });
    expect(r.advisor.unwatchInitiative("prj_1", "test", true).deleted).toBe(2);
    expect(Object.keys(watched(r))).toEqual(["thr_mine"]);
    expect(r.store.listInitiativeWatches()).toEqual([]);
  });

  it("says plainly when the Projects routes are unavailable and never watches nothing silently", async () => {
    const { r, clock, init } = await setup();
    init.down = "unavailable";
    await expect(r.advisor.watchInitiative("bb-plugins", "test")).rejects.toThrow(/Projects context routes are unavailable .*nothing is watched/u);
    expect(r.store.listInitiativeWatches()).toEqual([]);
    init.down = null;
    await r.advisor.watchInitiative("bb-plugins", "test");
    init.down = "unavailable";
    clock.advance(11_000);
    await r.tick();
    const o = overview(r.store, r.advisor, unavailableInitiatives, clock.now());
    expect(o.initiativeWatches[0]).toMatchObject({ enabled: true, error: expect.stringMatching(/^Projects context routes unavailable .*new members are not added/u) });
    expect(watched(r)).toMatchObject({ thr_w1: { enabled: true } }); // existing member watches go on
    const cli = await runCli(["status"], { store: r.store, advisor: r.advisor, initiatives: unavailableInitiatives, now: clock.now });
    expect(cli.stdout).toMatch(/initiative watches \(1\):\n {2}bb-plugins \(prj_1\) on · 2 live members, 2 observed, 1 retired, former or archived · Projects context routes unavailable/u);
  });

  it("CLI: watch and unwatch --initiative, and findings name the Initiative and role", async () => {
    const { r, clock } = await setup();
    const deps = { store: r.store, advisor: r.advisor, initiatives: unavailableInitiatives, now: clock.now };
    const on = await runCli(["watch", "--initiative", "bb-plugins"], deps);
    expect(on).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^watching Initiative bb-plugins \(prj_1\) on · 2 live members, 2 observed/u) });
    expect((await runCli(["watch", "--initiative=zzz"], deps)).stderr).toMatch(/no open Initiative matches zzz/u);
    expect((await runCli(["findings", "thr_w1"], deps)).stdout).toMatch(/^thr_w1 · Initiative bb-plugins · W1 work \(active\)/u);
    expect((await runCli(["unwatch", "--initiative", "prj_1"], deps)).stdout).toMatch(/is off; 2 member watches stopped/u);
    expect((await runCli(["unwatch", "--initiative", "prj_1", "--delete"], deps)).stdout).toMatch(/2 member watches and their evidence were deleted/u);
  });
});

describe("Projects listing routes (contract v1 additions)", () => {
  function server(routes: (url: URL) => { status: number; body: unknown }) {
    const fetch: FetchLike = async (u) => {
      const r = routes(new URL(u));
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return projectsInitiatives({ fetch, loopbackBaseUrl: () => "http://127.0.0.1:1", token: async () => "tok" });
  }
  const signal = () => new AbortController().signal;

  it("maps initiatives and members", async () => {
    const src = server((url) =>
      url.pathname.endsWith("/initiatives")
        ? { status: 200, body: { version: 1, observedAt: 1, initiatives: [{ initiativeId: "prj_1", name: "bb-plugins", paused: false, coordinator: { threadId: "thr_c", generation: 2 } }] } }
        : {
            status: 200,
            body: {
              version: 1,
              observedAt: 1,
              initiativeId: "prj_1",
              name: "bb-plugins",
              archived: false,
              paused: false,
              coordinator: { threadId: "thr_c", generation: 2 },
              truncated: false,
              next: null,
              members: [{ threadId: "thr_w", kind: "worker", role: "review", worker: "W4", generation: 1, state: "retired", former: false, retired: true, stopped: false }],
            },
          },
    );
    expect(await src.initiatives(signal())).toEqual({ status: "ok", value: [{ id: "prj_1", name: "bb-plugins", paused: false, coordinatorThreadId: "thr_c" }] });
    expect(await src.members("prj_1", null, signal())).toEqual({
      status: "ok",
      value: { id: "prj_1", name: "bb-plugins", archived: false, next: null, members: [{ threadId: "thr_w", kind: "worker", role: "review", worker: "W4", generation: 1, state: "retired" }] },
    });
  });

  it("a Projects build without the listing routes is unavailable for listings only; thread context stays available", async () => {
    const src = server((url) => (url.pathname.endsWith("/thread") ? { status: 200, body: { version: 1, threadId: "t", membership: null } } : { status: 404, body: { error: "Not found" } }));
    expect(await src.members("prj_1", null, signal())).toMatchObject({ status: "unavailable" });
    expect(src.available).toBe(true);
    expect((await src.membership("t", signal())).ok).toBe(true);
    const broken = server(() => ({ status: 500, body: { version: 1, error: { code: "store-unreadable", message: "x" } } }));
    expect(await broken.members("prj_1", null, signal())).toMatchObject({ status: "failed" });
  });
});

// T107: a natively archived member is ended like a retired one. Modelled on the live
// Coffre and bb-plugins watches: a coordinator, workers, and user threads of which
// most are archived, some already watched before archive state was read.
describe("Initiative watch: archived member threads", () => {
  async function coffre() {
    const { r, world, clock, init } = await setup();
    for (const t of ["thr_u1", "thr_u2", "thr_u3", "thr_u4"]) {
      world.addThread(t);
      work(world, t);
      init.add(t, { kind: "adhoc", role: "user", worker: null, generation: null });
    }
    world.addThread("thr_u_old", { archivedAt: clock.now() });
    init.add("thr_u_old", { kind: "adhoc", role: "user", worker: null, generation: null });
    return { r, world, clock, init };
  }
  const archive = (world: FakeWorld, t: string, at: number | null) => {
    world.threads.get(t).archivedAt = at;
  };
  const status = async (r: Rig, clock: Clock) => (await runCli(["status"], { store: r.store, advisor: r.advisor, initiatives: unavailableInitiatives, now: clock.now })).stdout!;

  it("never watches an already archived member, and shows it ended as archived", async () => {
    const { r, clock } = await coffre();
    await r.advisor.watchInitiative("prj_1", "test");
    expect(r.store.getWatchByThread("thr_u_old")).toBeNull();
    expect(r.store.memberOf("thr_u_old")).toMatchObject({ state: "archived" });
    expect(Object.keys(watched(r)).sort()).toEqual(["thr_coord", "thr_u1", "thr_u2", "thr_u3", "thr_u4", "thr_w1"]);
    expect(await status(r, clock)).toMatch(/bb-plugins \(prj_1\) on · 6 live members, 6 observed, 2 retired, former or archived/u);
  });

  it("stops existing Initiative watches of archived threads at the next sync, keeps their history, and leaves explicit watches alone", async () => {
    const { r, world, clock } = await coffre();
    const mine = await r.advisor.watch("thr_u4", "test");
    await r.advisor.watchInitiative("prj_1", "test");
    await r.tick();
    const u1 = r.store.getWatchByThread("thr_u1")!;
    const cards = r.store.listCards(u1.id, { limit: 50 }).length;
    expect(cards).toBeGreaterThan(0);
    for (const t of ["thr_u1", "thr_u2", "thr_u4"]) archive(world, t, clock.now());
    const gets = world.gets.length;
    await r.tick(); // each enabled watch's own pass reads its thread
    clock.advance(11_000);
    await r.tick();
    // Enabled watches needed no extra thread read: one read per watch per pass, as before.
    expect(world.gets.length - gets).toBe(2 * 6 - 2);
    expect(watched(r)).toMatchObject({
      thr_u1: { origin: "initiative", enabled: false, ended: "thread archived" },
      thr_u2: { origin: "initiative", enabled: false, ended: "thread archived" },
      thr_u3: { enabled: true, ended: null },
      thr_u4: { origin: "selected", enabled: true },
    });
    expect(r.store.listCards(u1.id, { limit: 50 })).toHaveLength(cards);
    const o = overview(r.store, r.advisor, unavailableInitiatives, clock.now());
    expect(o.watches.find((w) => w.threadId === "thr_u1")).toMatchObject({ ended: "thread archived", initiative: { state: "archived" } });
    const on = (await status(r, clock)).split("\n").filter((l) => / on /u.test(l) && l.startsWith("  thr_")).map((l) => l.trim().split(" ")[0]);
    expect(on.sort()).toEqual(["thr_coord", "thr_u3", "thr_u4", "thr_w1"]);
    // Off and on again does not restart them.
    r.advisor.unwatchInitiative("prj_1", "test");
    await r.advisor.watchInitiative("prj_1", "test");
    expect(watched(r)).toMatchObject({ thr_u1: { enabled: false, ended: "thread archived" }, thr_u3: { enabled: true } });
  });

  it("an unarchived member that is still live is watched again: at once on the event, else at the periodic re-read", async () => {
    const { r, world, clock } = await coffre();
    await r.advisor.watchInitiative("prj_1", "test");
    archive(world, "thr_u1", clock.now());
    await r.tick();
    clock.advance(11_000);
    await r.tick();
    expect(watched(r).thr_u1).toMatchObject({ enabled: false, ended: "thread archived" });
    clock.advance(11_000);
    const gets = world.gets.length;
    await r.tick();
    expect(world.gets.filter((t, i) => i >= gets && (t === "thr_u1" || t === "thr_u_old"))).toEqual([]); // archived members are not re-read every pass
    archive(world, "thr_u1", null);
    await r.harness.emitThreadEvent("thread.unarchived", { thread: world.threads.get("thr_u1") });
    await r.tick();
    expect(watched(r).thr_u1).toEqual({ origin: "initiative", enabled: true, ended: null });
    expect(r.store.memberOf("thr_u1")).toMatchObject({ state: "active" });
    // No event: the archived member is read again within ARCHIVE_RECHECK_MS.
    archive(world, "thr_u_old", null);
    clock.advance(11_000);
    await r.tick();
    expect(r.store.getWatchByThread("thr_u_old")).toBeNull();
    clock.advance(5 * 60_000);
    await r.tick();
    expect(watched(r).thr_u_old).toMatchObject({ origin: "initiative", enabled: true });
  });

  it("reads at most 20 unknown members a pass; the rest wait a pass rather than being watched unread", async () => {
    const { r, world, clock, init } = await setup();
    for (let i = 0; i < 30; i++) {
      const t = `thr_u${String(i).padStart(2, "0")}`;
      world.addThread(t, i % 2 ? { archivedAt: clock.now() } : {});
      init.add(t, { kind: "adhoc", role: "user", worker: null, generation: null });
    }
    const gets = world.gets.length;
    await r.advisor.watchInitiative("prj_1", "test");
    expect(world.gets.length - gets).toBe(20);
    const users = () => Object.keys(watched(r)).filter((t) => t.startsWith("thr_u")).length;
    expect(users()).toBeLessThan(15);
    clock.advance(11_000);
    await r.tick();
    expect(users()).toBe(15);
    expect(r.store.listMembers("prj_1").filter((m) => m.state === "archived")).toHaveLength(15);
  });
});
