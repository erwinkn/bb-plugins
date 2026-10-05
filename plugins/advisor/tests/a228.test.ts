// A228 regressions (observer, storage, authority and evidence lifecycle). Each
// case reproduces a reviewed finding through the runtime on the SDK's fake
// host; Projects is a fake fetch serving contract v1.1 shapes. No network.

import { describe, expect, it } from "vitest";
import { rig, oneLineDiff, type Rig } from "./helpers/world.js";
import { projectsInitiatives } from "../src/runtime/projects.js";
import { readContext } from "../src/runtime/context.js";
import { fakeFindings } from "../src/transport/fake.js";
import { overview } from "../src/views.js";
import type { ReviewRequest } from "../src/transport/types.js";
import type { InitiativeSource } from "../src/runtime/initiatives.js";

const T = "thr_w";
const PATH = "/repo/tests/a.test.ts";
const EX = "expect(a).toBe(42);";
const LO = "expect(a).toBeGreaterThan(0);";
const weaken = oneLineDiff(3, EX, LO, ["x", "y"], ["z"]);
const restore = oneLineDiff(3, LO, EX, ["x", "y"], ["z"]);
const MIN = 60_000;

function turn(r: Rig, diff: string | null, extra?: () => void) {
  r.world.turnStart(T);
  if (diff !== null) r.world.fileChange(T, PATH, diff);
  extra?.();
  r.world.agentMessage(T, "Done.");
  r.world.turnEnd(T);
}

// ------------------------------------------------------------------ Projects fake (contract v1.1)

interface ProjectsState {
  membership: Record<string, unknown> | null;
  thread?: { status: number; body: unknown };
  records: Record<string, { text: string; meta: Record<string, unknown> }>;
  calls: string[];
}

const assignment = (ref: string, phase: string, state: string) => ({
  ref, tasks: ["T5"], role: "work", access: "write", route: "fresh", phase, state, cancelRequested: false,
  outcome: null, reportVersion: null, reportedAt: null, updatedAt: 1, briefChars: 10, handoff: false,
});

const worker = (over: Record<string, unknown> = {}) => ({
  initiativeId: "prj_1", initiativeName: "bb-plugins", archived: false, paused: false,
  coordinator: { threadId: "thr_c", generation: 1 }, kind: "worker", role: "work", worker: "W3",
  generation: 1, currentGeneration: 1, state: "active", former: false, retired: false, stopped: false,
  parent: { forkedFrom: null, nativeParent: true }, assignment: null, next: null, ...over,
});

function projects(s: ProjectsState): InitiativeSource {
  const fetch = async (u: string) => {
    const url = new URL(u);
    s.calls.push(`${url.pathname.split("/").pop()}?${url.searchParams.toString()}`);
    if (url.pathname.endsWith("/thread")) {
      if (s.thread) return new Response(JSON.stringify(s.thread.body), { status: s.thread.status });
      return new Response(JSON.stringify({ version: 1, threadId: url.searchParams.get("threadId"), observedAt: 1, membership: s.membership }));
    }
    const ref = url.searchParams.get("ref")!;
    const rec = s.records[ref];
    if (!rec) return new Response(JSON.stringify({ version: 1, observedAt: 1, error: { code: "not-found", message: `no ${ref}` } }), { status: 404 });
    return new Response(
      JSON.stringify({ version: 1, observedAt: 1, initiativeId: "prj_1", ref, part: "brief", updatedAt: 1, reportVersion: null, meta: rec.meta, textVersion: "tv1", totalChars: rec.text.length, offset: 0, nextOffset: null, text: rec.text }),
    );
  };
  return projectsInitiatives({ fetch: fetch as any, loopbackBaseUrl: () => "http://127.0.0.1:1", token: async () => "tok" });
}

const BRIEF = "Brief A9: keep refund coverage exact.";
const briefRecords = (phase: string) => ({
  A9: { text: BRIEF, meta: { phase, tasks: ["T5"], worker: "W3" } },
  T5: { text: "Task T5 brief: refund totals.", meta: { status: "in_progress" } },
});

async function memberRig(s: ProjectsState, settings: Record<string, unknown> = {}) {
  const sent: ReviewRequest[] = [];
  const r = await rig({ reviewEnabled: true, ...settings }, { initiatives: projects(s), fakeFindings: (q) => (sent.push(q), fakeFindings(q)) });
  r.world.addThread(T, { parentThreadId: "thr_c", originPluginId: "projects" });
  return { r, sent };
}

// ------------------------------------------------------------------ P1 preview

describe("A228 #1 preview isolation", () => {
  it("a fake preview never takes a real finding's identity, issue state or notification", async () => {
    const r = await rig({ reviewEnabled: false });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    turn(r, weaken);
    await r.tick();
    const pv = await r.advisor.start(r.store.getWatch(w.id)!, true);
    expect(pv.state).toBe("current");
    const previews = r.store.listOccurrences(w.id);
    expect(previews.map((o) => o.preview)).toEqual([true]); // still visible, labeled
    expect(r.store.listIssues(w.id)).toEqual([]); // no issue state from a fake
    expect(r.store.listNotifications()).toEqual([]);
    expect(r.store.backlog(w.id)).toBeGreaterThan(0); // the frontier did not move

    r.advisor.applySettings({ reviewEnabled: true });
    r.clock.advance(30 * MIN);
    await r.tick();
    const real = r.store.listOccurrences(w.id).filter((o) => !o.preview);
    expect(real).toHaveLength(1);
    expect(real[0]!.id).not.toBe(previews[0]!.id);
    expect(r.store.getOccurrence(previews[0]!.id)!.reconfirmed).toEqual([]);
    expect(r.store.listNotifications().map((n) => [n.occurrenceId, n.reason])).toEqual([[real[0]!.id, "new"]]);
    expect(r.store.listIssues(w.id).map((i) => i.state)).toEqual(["open"]);
  });
});

// ------------------------------------------------------------------ P1 former members

describe("A228 #2 former Initiative members", () => {
  it("a former coordinator thread is observed but never dispatched, with the reason shown", async () => {
    const s: ProjectsState = {
      membership: worker({ kind: "coordinator", role: "coordinator", worker: null, generation: 1, currentGeneration: 2, state: "former", former: true, parent: null }),
      records: {},
      calls: [],
    };
    const { r, sent } = await memberRig(s);
    await r.advisor.watch(T, "test");
    await r.tick();
    turn(r, weaken);
    for (let i = 0; i < 4; i++) {
      r.clock.advance(20 * MIN);
      await r.tick();
    }
    const w = r.store.getWatchByThread(T)!;
    expect(sent).toHaveLength(0);
    expect(r.store.listReviews(w.id)).toEqual([]);
    expect(r.advisor.dispatchHold(w)).toMatch(/former Initiative member/u);
    expect(r.store.backlog(w.id)).toBeGreaterThan(0); // evidence is still recorded
  });
});

// ------------------------------------------------------------------ P2 failed reads at dispatch

describe("A228 #3 failed context reads gate dispatch", () => {
  it("a failed thread read sends nothing; the next healthy pass sends once with real authority", async () => {
    const sent: ReviewRequest[] = [];
    const r = await rig({ reviewEnabled: true }, { fakeFindings: (q) => (sent.push(q), []) });
    r.world.addThread(T, { parentThreadId: "thr_parent" });
    r.world.request(T, "r1", "REQ: totals must equal the ledger sum", "thr_parent");
    r.world.accept(T, "r1");
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    turn(r, weaken);
    r.world.failGet.add(T);
    await r.tick();
    expect(sent).toHaveLength(0);
    expect(r.store.listReviews(w.id)).toEqual([]);
    expect(r.advisor.dispatchHold(r.store.getWatch(w.id)!)).toMatch(/thread-missing/u);
    r.world.failGet.delete(T);
    for (let i = 0; i < 4; i++) {
      r.clock.advance(20 * MIN);
      await r.tick();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("[R:1 parent] REQ: totals must equal the ledger sum");
    expect(r.store.listReviews(w.id).map((x) => x.state)).toEqual(["current"]);
  });

  it("a failed Projects membership read sends nothing (never reviewed as standalone)", async () => {
    const s: ProjectsState = { membership: worker({ assignment: assignment("A9", "active", "running") }), records: briefRecords("active"), calls: [] };
    const { r, sent } = await memberRig(s);
    await r.advisor.watch(T, "test");
    await r.tick();
    turn(r, weaken);
    s.thread = { status: 500, body: { version: 1, observedAt: 1, error: { code: "store-unreadable", message: "x" } } };
    r.clock.advance(20 * MIN);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(sent).toHaveLength(0);
    expect(r.advisor.dispatchHold(w)).toMatch(/membership-missing/u);
  });
});

// ------------------------------------------------------------------ P2 held reviews

/** Completion reads are the only ascending reads with limit 100 after seeding. */
function failCompletionReads(r: Rig, flag: { on: boolean; failed?: number }) {
  r.harness.sdk.stub("threads.events.list", async (args: any) => {
    if (flag.on && args.order === "asc" && args.limit === "100") {
      flag.failed = (flag.failed ?? 0) + 1;
      throw Object.assign(new Error("read failed"), { status: 503 });
    }
    return r.world.sdk().threads.events.list(args);
  });
}

describe("A228 #4 held reviews", () => {
  it("a held result blocks re-sending its packet and is revalidated from the paid result", async () => {
    const sent: ReviewRequest[] = [];
    const r = await rig({ reviewEnabled: true, minGapMinutes: 0 }, { fakeFindings: (q) => (sent.push(q), fakeFindings(q)) });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const flag = { on: true };
    failCompletionReads(r, flag);
    turn(r, weaken);
    await r.tick();
    const [held] = r.store.listReviews(w.id);
    expect(held!.state).toBe("held");
    const heldAt = held!.heldAt;
    expect(heldAt).toBeTypeOf("number");
    r.world.command(T, "npm test", 1, "1 failed"); // new trigger evidence
    for (let i = 0; i < 3; i++) {
      r.clock.advance(5 * MIN);
      await r.tick();
    }
    expect(sent).toHaveLength(1); // never re-sent while held
    expect(r.store.listReviews(w.id)).toHaveLength(1);
    expect(r.store.getReview(held!.id)!.heldAt).toBe(heldAt); // first-held time is stable
    expect(r.advisor.dispatchHold(r.store.getWatch(w.id)!)).toMatch(/held review/u);
    flag.on = false;
    r.clock.advance(5 * MIN);
    await r.tick();
    expect(r.store.getReview(held!.id)!.state).toBe("current");
    expect(r.store.listOccurrences(w.id).filter((o) => o.reviewId === held!.id)).toHaveLength(1);
    expect(sent.length).toBeLessThanOrEqual(2); // at most one new review, for the new cards only
    if (sent.length === 2) expect(sent[1]!.body).not.toContain("E:");
  });

  it("a held result expires after the configured time; its cards become a named gap, not a re-send", async () => {
    const sent: ReviewRequest[] = [];
    const r = await rig({ reviewEnabled: true, heldExpiryMinutes: 30 }, { fakeFindings: (q) => (sent.push(q), fakeFindings(q)) });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    failCompletionReads(r, { on: true });
    turn(r, weaken);
    await r.tick();
    for (let i = 0; i < 4; i++) {
      r.clock.advance(10 * MIN);
      await r.tick();
    }
    const [rv] = r.store.listReviews(w.id);
    expect(rv!.state).toBe("expired");
    expect(r.store.listGaps(w.id).map((g) => g.reason)).toContain("held-expired");
    expect(r.store.backlog(w.id)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("held reviews are never pruned while held, and rechecks per pass are bounded", async () => {
    const r = await rig({ reviewEnabled: true, heldExpiryMinutes: 10080, heldRechecksPerPass: 1, findingsRetentionDays: 1 });
    const flag: { on: boolean; failed?: number } = { on: true };
    for (const t of ["thr_a", "thr_b"]) {
      r.world.addThread(t);
      await r.advisor.watch(t, "test");
    }
    await r.tick();
    failCompletionReads(r, flag);
    for (const t of ["thr_a", "thr_b"]) {
      r.world.turnStart(t);
      r.world.fileChange(t, PATH, weaken);
      r.world.turnEnd(t);
    }
    await r.tick();
    expect(r.store.listReviews(null).map((x) => x.state)).toEqual(["held", "held"]);
    const heldIds = r.store.listReviews(null).map((x) => x.id).sort();
    const before = flag.failed!;
    r.clock.advance(MIN);
    await r.advisor.tick(new AbortController().signal);
    expect(flag.failed! - before).toBe(1); // one held review rechecked this pass, one read each
    for (let d = 0; d < 3; d++) {
      r.clock.advance(86_400_000);
      await r.tick();
    }
    // The same two reviews, still held: not pruned, and nothing re-dispatched in their place.
    expect(r.store.listReviews(null).map((x) => [x.id, x.state]).sort()).toEqual(heldIds.map((id) => [id, "held"]));
  });

  it("completion reads only the relevant row types, so a busy thread cannot trap a review behind 800 rows", async () => {
    const r = await rig({ reviewEnabled: true }, {
      fakeFindings: (q) => {
        for (let i = 0; i < 900; i++) r.world.agentMessage(T, `progress ${i}`);
        return fakeFindings(q);
      },
    });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const before = r.world.queries.length;
    turn(r, weaken);
    await r.tick();
    expect(r.store.listReviews(w.id).map((x) => [x.state, x.error])).toEqual([["current", null]]);
    const completion = r.world.queries.slice(before).filter((q) => q.order === "asc" && q.limit !== "25");
    expect(completion.length).toBeGreaterThan(0);
    for (const q of completion) {
      expect(Number(q.limit)).toBeLessThanOrEqual(100);
      expect(q.types).toBeDefined();
    }
  });
});

// ------------------------------------------------------------------ P2 Projects reader

describe("A228 #5 the delivered assignment stays canonical", () => {
  for (const [phase, state, label] of [
    ["active", "running", "[R:1 assignment brief A9]"],
    ["reported", "reported", "[R:1 assignment brief A9]"],
    ["accepted", "accepted", "[R:1 assignment brief A9]"],
    ["cancelled", "cancelled", "[R:1 former assignment brief A9]"],
  ] as const) {
    it(`a ${phase} assignment keeps its exact brief label and the live task brief`, async () => {
      const s: ProjectsState = { membership: worker({ assignment: assignment("A9", phase, state) }), records: briefRecords(phase), calls: [] };
      const { r, sent } = await memberRig(s);
      r.world.request(T, "r1", BRIEF, null);
      r.world.accept(T, "r1");
      await r.advisor.watch(T, "test");
      await r.tick();
      turn(r, weaken);
      r.clock.advance(20 * MIN);
      await r.tick();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toContain(`${label} ${BRIEF}`);
      expect(sent[0]!.body).not.toContain("UNATTRIBUTED");
      expect(s.calls.some((c) => c.includes("ref=T5"))).toBe(true);
      if (phase === "cancelled") expect(sent[0]!.body).toMatch(/Historic requirements[^#]*former assignment brief A9/u);
    });
  }

  it("a queued next assignment is separate: never in the delivered row, shown as a note", async () => {
    const s: ProjectsState = {
      membership: worker({ assignment: assignment("A9", "reported", "reported"), next: assignment("A10", "pending", "queued") }),
      records: { ...briefRecords("reported"), A10: { text: "Brief A10", meta: { phase: "pending", tasks: ["T5"], worker: "W3" } } },
      calls: [],
    };
    const ctx = await readContext({ getThread: async () => ({ id: T, parentThreadId: "thr_c", archivedAt: null, createdAt: 1, sourceThreadId: null }) } as any, projects(s), T, { epoch: 1, settingsRev: 1 }, [], new AbortController().signal);
    expect(ctx.snapshot.activeRow).toEqual({ refs: { A9: false }, truncated: false });
    expect(ctx.snapshot.assignments!.A9).toMatchObject({ read: "ok", state: "reported" });
    expect(ctx.notes.join(" ")).toMatch(/A10 queued/u);
  });
});

// ------------------------------------------------------------------ P2 restore -> repeat

describe("A228 #6 restore before repeat", () => {
  const onlyWeakening = (q: ReviewRequest) => fakeFindings({ ...q, cards: q.cards.filter((c: any) => c.text.includes("+" + LO)) });

  it("weaken, an observed reversing edit, then the identical weakening raises a new notice", async () => {
    const r = await rig({ reviewEnabled: true }, { fakeFindings: onlyWeakening });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    for (const d of [weaken, restore, weaken]) {
      turn(r, d);
      r.clock.advance(20 * MIN);
      await r.tick();
    }
    expect(r.store.listOccurrences(w.id)).toHaveLength(2);
    expect(r.store.listNotifications().map((n) => n.reason).reverse()).toEqual(["new", "recurred-after-cited-lines-removed"]);
    expect(r.store.listIssues(w.id).map((i) => [i.state, i.reversedBy])).toEqual([["open", null]]);
  });

  it("a passing test run marks nothing: the issue stays open with no reversal", async () => {
    const r = await rig({ reviewEnabled: true }, { fakeFindings: onlyWeakening });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    turn(r, weaken);
    r.clock.advance(20 * MIN);
    await r.tick();
    turn(r, null, () => r.world.command(T, "npm test", 0, "12 passed"));
    r.clock.advance(20 * MIN);
    await r.tick();
    expect(r.store.listIssues(w.id).map((i) => [i.state, i.reversedBy])).toEqual([["open", null]]);
  });

  it("a shell restore seen by a checkpoint counts as an observed reversal", async () => {
    // The fake cites the first hunk it is given; give it only provider edits, never the vanished checkpoint hunk.
    const r = await rig({ reviewEnabled: true }, { fakeFindings: (q) => onlyWeakening({ ...q, cards: q.cards.filter((c) => c.id.startsWith("E:")) }) });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const env = r.world.envs.get(`env_${T}`)!;
    env.files = [{ path: "tests/a.test.ts" }];
    env.patches["tests/a.test.ts"] = weaken;
    turn(r, weaken);
    r.clock.advance(20 * MIN);
    await r.tick();
    expect(r.store.listIssues(w.id).map((i) => i.state)).toEqual(["open"]);
    env.files = [];
    env.patches = {};
    turn(r, null, () => r.world.command(T, "git checkout tests/a.test.ts", 0));
    r.clock.advance(20 * MIN);
    await r.tick();
    expect(r.store.listIssues(w.id)[0]!.reversedBy).toMatch(/^S:/u);
  });
});

// ------------------------------------------------------------------ P2 resolved notes

describe("A228 #7 model resolved notes need newer proven evidence", () => {
  const scripted = (resolvedFor: (q: ReviewRequest) => Array<{ locator: string; evidence: string; note: string }>) => (q: ReviewRequest) => ({
    findings: fakeFindings({ ...q, cards: q.cards.filter((c: any) => c.text.includes("+" + LO)) }),
    resolved: resolvedFor(q),
  });
  const LOC = "tests/a.test.ts@new:L3";

  async function flow(resolvedFor: (q: ReviewRequest) => Array<{ locator: string; evidence: string; note: string }>, second: (r: Rig) => void) {
    const r = await rig({ reviewEnabled: true }, { fakeFindings: scripted(resolvedFor) as any });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    turn(r, weaken);
    r.clock.advance(20 * MIN);
    await r.tick();
    second(r);
    r.clock.advance(20 * MIN);
    await r.tick();
    return r;
  }
  const state = (r: Rig) => r.store.listIssues(r.store.getWatchByThread(T)!.id).map((i) => i.state);

  it("a passing command card does not resolve a weakening", async () => {
    const r = await flow((q) => q.cards.filter((c) => c.id.startsWith("C:")).map((c) => ({ locator: LOC, evidence: c.id, note: "tests pass" })), (r) =>
      turn(r, null, () => r.world.command(T, "npm test", 0, "ok")),
    );
    expect(state(r)).toEqual(["open"]);
  });

  it("the weakening card itself does not resolve its own issue", async () => {
    const r = await flow((q) => q.cards.filter((c) => c.id.startsWith("E:")).map((c) => ({ locator: LOC, evidence: c.id, note: "fine" })), () => {});
    expect(state(r)).toEqual(["open"]);
  });

  it("a newer edit that removes the cited lines is accepted as a model-reported resolution", async () => {
    const r = await flow((q) => q.cards.filter((c) => c.id.startsWith("E:") && c.text.includes("-" + LO)).map((c) => ({ locator: LOC, evidence: c.id, note: "restored" })), (r) =>
      turn(r, restore),
    );
    expect(state(r)).toEqual(["model-reported-resolved"]);
  });
});

// ------------------------------------------------------------------ P3

describe("A228 #8 Projects 503 is unknown context, not absence", () => {
  it("BB's 'is not running' 503 is a failed membership read; only an absent route means standalone", async () => {
    const s: ProjectsState = { membership: null, thread: { status: 503, body: { ok: false, error: 'plugin "projects" is not running (status: error)' } }, records: {}, calls: [] };
    const src = projects(s);
    const m = await src.membership(T, new AbortController().signal);
    expect(m.ok).toBe(false);
    expect(src.available).toBe(true);
    s.thread = { status: 404, body: { ok: false, error: 'plugin "projects" has no GET route for "/context/v1/thread"' } };
    const absent = await src.membership(T, new AbortController().signal);
    expect(absent).toEqual({ ok: true, value: null });
    expect(src.available).toBe(false);
  });
});

describe("A228 #9 environment root path", () => {
  it("a failed root read is retried on later passes", async () => {
    const r = await rig({});
    r.world.addThread(T);
    let fail = true;
    r.harness.sdk.stub("environments.get", async (a: any) => {
      if (fail) throw Object.assign(new Error("env read failed"), { status: 503 });
      return r.world.sdk().environments.get(a);
    });
    await r.advisor.watch(T, "test");
    await r.tick();
    expect(r.store.getWatchByThread(T)!.rootPath).toBeNull();
    fail = false;
    await r.tick();
    expect(r.store.getWatchByThread(T)!.rootPath).toBe("/repo");
  });

  it("while the root is unknown a checkpoint never claims there was no edit event", async () => {
    const r = await rig({});
    r.world.addThread(T);
    r.harness.sdk.stub("environments.get", async () => {
      throw Object.assign(new Error("env read failed"), { status: 503 });
    });
    await r.advisor.watch(T, "test");
    await r.tick();
    const env = r.world.envs.get(`env_${T}`)!;
    env.files = [{ path: "tests/a.test.ts" }];
    env.patches["tests/a.test.ts"] = weaken;
    turn(r, weaken);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const states = r.store.listCards(w.id, { limit: 50 }).filter((c) => c.kind === "state");
    expect(states).toHaveLength(1);
    expect(states[0]!.text).not.toContain("none (shell or another writer)");
    expect(states[0]!.text).toContain("unknown");
    expect(r.store.listGaps(w.id).map((g) => g.reason)).toContain("root-path-unknown");
  });
});

describe("A228 #10 failures are surfaced, reads are bounded", () => {
  it("a failed project-scope listing is shown as an observation error", async () => {
    const r = await rig({ watchScope: "selected-and-project", watchProject: "proj_x" });
    r.harness.sdk.stub("threads.list", async () => {
      throw new Error("list failed");
    });
    await r.tick();
    const o = overview(r.store, r.advisor, r.advisor["d"].initiatives, r.clock.now());
    expect(o.errors.observation.join(" ")).toMatch(/project scope.*list failed/u);
  });

  it("a hung completion read ends at its deadline instead of hanging the tick", async () => {
    const r = await rig({ reviewEnabled: true }, { readDeadlineMs: 50 });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    r.harness.sdk.stub("threads.events.list", async (args: any) => {
      if (args.order === "asc" && args.limit === "100") {
        return new Promise((_, reject) => args.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return r.world.sdk().threads.events.list(args);
    });
    turn(r, weaken);
    await r.tick();
    expect(r.store.listReviews(w.id).map((x) => x.state)).toEqual(["held"]);
  });
});

describe("A228 #11 user-stopped pause", () => {
  it("Projects' user Stop pauses dispatch; a later read showing false clears it", async () => {
    const s: ProjectsState = { membership: worker({ stopped: true, state: "stopped", assignment: assignment("A9", "active", "running") }), records: briefRecords("active"), calls: [] };
    const { r, sent } = await memberRig(s);
    await r.advisor.watch(T, "test");
    await r.tick();
    turn(r, weaken);
    r.clock.advance(20 * MIN);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(w.state.pause).toContain("user-stopped");
    expect(sent).toHaveLength(0);
    s.membership = worker({ assignment: assignment("A9", "active", "running") });
    r.clock.advance(20 * MIN);
    await r.tick();
    expect(r.store.getWatchByThread(T)!.state.pause).not.toContain("user-stopped");
    expect(sent).toHaveLength(1);
  });
});

describe("A228 #12 reload keeps paid results", () => {
  it("a review interrupted while completing is revalidated from its stored result, without a new request", async () => {
    const sent: ReviewRequest[] = [];
    const r = await rig({ reviewEnabled: true }, { fakeFindings: (q) => (sent.push(q), fakeFindings(q)) });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    turn(r, weaken);
    await r.tick();
    const [rv] = r.store.listReviews(w.id);
    // Rewind to the moment after the paid result was stored, before validation.
    const finished = rv!.finishedAt;
    r.store.db.prepare("UPDATE reviews SET state = 'completing' WHERE id = ?").run(rv!.id);
    r.store.db.prepare("UPDATE cards SET reviewed = 0 WHERE watch_id = ?").run(w.id);
    r.store.db.prepare("DELETE FROM occurrences").run();
    r.store.db.prepare("DELETE FROM issues").run();
    r.store.db.prepare("DELETE FROM notifications").run();
    await r.reload({ fakeFindings: (q) => (sent.push(q), fakeFindings(q)) });
    r.advisor.recover();
    expect(r.store.getReview(rv!.id)!.state).toBe("held");
    await r.tick();
    const after = r.store.getReview(rv!.id)!;
    expect(after.state).toBe("current");
    expect(after.createdAt).toBe(rv!.createdAt);
    expect(after.heldAt).toBe(finished);
    expect(sent).toHaveLength(1);
    expect(r.store.listOccurrences(w.id)).toHaveLength(1);
  });

  it("a completing review without a readable result is marked interrupted, visibly", async () => {
    const r = await rig({ reviewEnabled: true });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    turn(r, weaken);
    await r.tick();
    const [rv] = r.store.listReviews(w.id);
    r.store.db.prepare("UPDATE reviews SET state = 'completing', result = NULL WHERE id = ?").run(rv!.id);
    await r.reload();
    r.advisor.recover();
    const after = r.store.getReview(rv!.id)!;
    expect(after.state).toBe("interrupted");
    expect(after.error).toMatch(/result/u);
  });
});
