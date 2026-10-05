// End-to-end runtime on the SDK's fake plugin host: watch, seed, drain,
// immutable cards, the fake reviewer, validated findings, recurrence.

import { describe, expect, it } from "vitest";
import { rig, oneLineDiff, type Rig } from "./helpers/world.js";
import type { ReviewRequest } from "../src/transport/types.js";
import type { ModelFinding } from "../src/transport/output.js";

const T = "thr_w";
const PATH = "/repo/tests/totals.test.ts";
const EXACT = "it('computes totals with refunds', () => expect(total(l)).toBe(42));";
const LOOSE = "it('computes totals with refunds', () => expect(total(l)).toBeGreaterThan(0));";
const weaken = oneLineDiff(3, EXACT, LOOSE, ["import { total } from '../src';", "const l = ledger();"], ["it('formats dates', () => expect(date()).toBe(99));"]);
const restore = oneLineDiff(3, LOOSE, EXACT, ["import { total } from '../src';", "const l = ledger();"], ["it('formats dates', () => expect(date()).toBe(99));"]);

function workTurn(r: Rig, diff: string, claim = "Done. All tests pass.") {
  r.world.turnStart(T);
  r.world.fileChange(T, PATH, diff);
  r.world.command(T, "npm test", 0, "1 passed\n");
  r.world.agentMessage(T, claim);
  r.world.turnEnd(T);
}

async function started(settings: Record<string, any> = {}, opts: Parameters<typeof rig>[1] = {}) {
  const r = await rig({ reviewEnabled: true, ...settings }, opts);
  r.world.addThread(T);
  r.world.request(T, "r1", "Keep refund coverage: totals must equal the ledger sum including refunds.");
  r.world.accept(T, "r1");
  return r;
}

describe("scope and triggers", () => {
  it("project scope watches every non-archived thread of the chosen project", async () => {
    const r = await rig({ watchScope: "selected-and-project", watchProject: "proj_scope" });
    r.world.addThread("thr_a", { projectId: "proj_scope" });
    r.world.addThread("thr_b", { projectId: "proj_scope", archivedAt: 1 });
    r.world.addThread("thr_c", { projectId: "proj_other" });
    await r.tick();
    expect(r.store.listWatches().map((w) => [w.threadId, w.origin])).toEqual([["thr_a", "project"]]);
  });

  it("a project scope without a project is an observation error, shown and not guessed", async () => {
    const r = await rig({ watchScope: "selected-and-project" });
    expect(r.advisor.resolved.observationErrors).toEqual(["Watch scope includes a project, but no project is selected."]);
  });

  it("without a trigger nothing is reviewed: a passing command alone waits", async () => {
    const r = await rig({ reviewEnabled: true, triggerTurnEnd: false, triggerClaim: false });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    r.world.command(T, "npm test", 0, "ok");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(r.store.listReviews(w.id)).toEqual([]);
    r.world.command(T, "npm test", 1, "1 failed");
    r.clock.advance(5 * 60_000);
    await r.tick();
    expect(r.store.listReviews(w.id)).toHaveLength(1); // a failed command is a trigger
  });

  it("the cadence bucket bounds reviews: the minimum gap holds a second review", async () => {
    const r = await rig({ reviewEnabled: true, minGapMinutes: 10 });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    r.world.command(T, "npm test", 1, "1 failed");
    await r.tick();
    r.world.command(T, "npm test", 1, "1 failed");
    r.clock.advance(60_000);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(r.store.listReviews(w.id)).toHaveLength(1);
    r.clock.advance(10 * 60_000);
    await r.tick();
    expect(r.store.listReviews(w.id)).toHaveLength(2);
  });
});

describe("concurrent updates", () => {
  it("a pause made while an observation pass is reading is not overwritten by that pass", async () => {
    const r = await rig({ reviewEnabled: true });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    r.world.command(T, "npm test", 1, "1 failed");
    let once = true;
    r.harness.sdk.stub("threads.events.list", async (args: any) => {
      if (once) {
        once = false;
        r.advisor.pause(w.id, "panel"); // the user presses Pause mid-pass
      }
      return r.world.sdk().threads.events.list(args);
    });
    await r.tick();
    const after = r.store.getWatchByThread(T)!;
    expect(after.state.pause).toEqual(["manual"]);
    expect(after.cursor).toBeGreaterThan(w.cursor!); // the pass's own progress was kept
    expect(r.store.listReviews(w.id)).toEqual([]); // and nothing was dispatched while paused
  });

  it("a pass whose watch was disabled and re-enabled meanwhile is dropped (the new epoch re-seeds)", async () => {
    const r = await rig({});
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    r.world.command(T, "echo", 0, "x");
    let once = true;
    r.harness.sdk.stub("threads.events.list", async (args: any) => {
      if (once) {
        once = false;
        r.advisor.setEnabled(w.id, false, "panel");
        r.advisor.setEnabled(w.id, true, "panel");
      }
      return r.world.sdk().threads.events.list(args);
    });
    await r.tick();
    const after = r.store.getWatchByThread(T)!;
    expect(after.epoch).toBe(w.epoch + 1);
    expect(after.seeded).toBe(false);
    await r.tick();
    expect(r.store.getWatchByThread(T)!.seeded).toBe(true);
  });
});

describe("observation and the fake reviewer", () => {
  it("watches, seeds from the current turn, records cards and stores a validated fake finding", async () => {
    const r = await started();
    workTurn(r, weaken);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(w.seeded).toBe(true);
    expect(w.atTip).toBe(true);
    expect(w.startSeq).toBe(3); // the current turn's turn/started
    const cards = r.store.listCards(w.id, { limit: 50 }).map((c) => [c.id, c.kind]);
    expect(cards).toEqual([
      ["T:7", "turn"],
      ["M:6", "claim"],
      ["C:5", "command"],
      ["E:4:0#0", "edit"],
    ]);
    const occ = r.store.listOccurrences(w.id);
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ category: "test-integrity", severity: "note", route: "fake", evidence: "E:4:0#0" });
    expect(occ[0]!.shown).toMatchObject({ subject: "computes totals with refunds", subjectStatus: "verified" });
    expect(occ[0]!.locator).toBe("tests/totals.test.ts::computes totals with refunds@new:L3");
    expect(r.store.backlog(w.id)).toBe(0); // frontier advanced after a current-as-of-tip result
    const gaps = r.store.listGaps(w.id).map((g) => g.reason);
    expect(gaps).toContain("before-watch");
  });

  it("never writes to the watched thread: only read SDK calls are made", async () => {
    const r = await started();
    workTurn(r, weaken);
    await r.advisor.watch(T, "test");
    await r.tick();
    const paths = new Set(r.harness.inspection.sdk.calls.map((c: any) => c.path));
    for (const p of paths) expect(["threads.get", "threads.events.list", "environments.get", "environments.status", "environments.diffFiles", "environments.diffPatch"]).toContain(p);
  });

  it("every event read is one page of at most 100 rows with a strict digit cursor", async () => {
    const r = await started();
    for (let i = 0; i < 260; i++) r.world.command(T, `echo ${i}`, 0, "x");
    workTurn(r, weaken);
    await r.advisor.watch(T, "test");
    for (let i = 0; i < 4; i++) await r.tick();
    expect(r.world.queries.length).toBeGreaterThan(5);
    for (const q of r.world.queries) {
      expect(Number(q.limit ?? "100")).toBeLessThanOrEqual(100);
      for (const k of ["afterSeq", "beforeSeq", "limit"] as const) if (q[k] !== undefined) expect(q[k]).toMatch(/^\d+$/u);
    }
    expect(r.store.getWatchByThread(T)!.atTip).toBe(true);
  });

  it("restore-before-repeat produces a new alert; a passing test run closes nothing", async () => {
    const r = await started({}, { fakeFindings: weakeningsOnly });
    await r.advisor.watch(T, "test");
    await r.tick();
    workTurn(r, weaken);
    r.clock.advance(60 * 60_000);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const first = r.store.listOccurrences(w.id);
    expect(first).toHaveLength(1);
    r.store.acknowledge(first[0]!.id, r.clock.now());
    workTurn(r, restore);
    r.clock.advance(60 * 60_000);
    await r.tick();
    expect(r.store.listOccurrences(w.id)).toHaveLength(1); // the restoration is not a finding, and closes nothing
    workTurn(r, weaken);
    r.clock.advance(60 * 60_000);
    await r.tick();
    const all = r.store.listOccurrences(w.id).filter((o) => o.locator === first[0]!.locator);
    expect(all.length).toBe(2); // byte-identical weakening at a later sequence: a new occurrence
    expect(all.filter((o) => o.acknowledgedAt === null)).toHaveLength(1); // the repeat is a new, unacknowledged alert
    expect(r.store.issueState(w.id, "test-integrity", first[0]!.locator)).toBe("open"); // passing `npm test` runs did not close it
  });

  it("an instruction accepted while a review is in flight makes it stale; the frontier stays", async () => {
    let inject: (() => void) | null = null;
    const r = await started({}, {
      fakeFindings: (req) => {
        inject?.();
        return weakeningsOnly(req);
      },
    });
    workTurn(r, weaken);
    inject = () => {
      r.world.request(T, "r2", "Loosened assertions are fine now.");
      r.world.accept(T, "r2");
      inject = null;
    };
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const rv = r.store.listReviews(w.id)[0]!;
    expect([rv.state, rv.error]).toEqual(["stale", "new-accepted-instruction:r2"]);
    expect(r.store.listOccurrences(w.id)).toHaveLength(0);
    expect(r.store.backlog(w.id)).toBe(4); // nothing was marked reviewed
    // Next pass re-reviews the same cards under the new requirement.
    r.clock.advance(60 * 60_000);
    await r.tick();
    expect(r.store.listReviews(w.id)[0]!.state).toBe("current");
    expect(r.store.listReviews(w.id)[0]!.cardIds).toContain("E:4:0#0");
  });
});

/** A scripted stand-in judgment for tests: flags exact-to-looser assertion edits only. */
export function weakeningsOnly(req: ReviewRequest): ModelFinding[] {
  const out: ModelFinding[] = [];
  for (const c of req.cards) {
    (c.hunks ?? []).forEach((h, hi) => {
      const rm = h.lines.find((l) => l.kind === "-" && l.text.includes(".toBe("));
      const add = h.lines.find((l) => l.kind === "+" && /toBeGreaterThan|toBeTruthy|toBeDefined/u.test(l.text));
      if (!rm || !add) return;
      out.push({
        category: "test-integrity",
        severity: "concern",
        evidence: c.id,
        hunk: hi,
        subject: null,
        relation: null,
        before: { hunk: null, lines: [rm.old!, rm.old!], quote: rm.text },
        after: { hunk: null, lines: [add.new!, add.new!], quote: add.text },
        requirement: null,
        claim: null,
        command: null,
        summary: "An exact assertion became a looser one.",
      });
    });
  }
  return out;
}
