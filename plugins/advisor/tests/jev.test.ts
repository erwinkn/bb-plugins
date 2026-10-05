// Jev (A154 §8, A161 F3): one candidate per changed test hunk, encoded-size
// caps, a named candidate-cap gap, no call for windows with nothing to judge,
// the same FIFO frontier as every route.

import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_GLOBS } from "../src/rules/checkpoint.js";
import { makeHunk, type Hunk } from "../src/rules/diff.js";
import { MAX_QUESTIONS, planJevReview, type JevCard } from "../src/rules/jev.js";
import { rig, oneLineDiff } from "./helpers/world.js";

const G = DEFAULT_TEST_GLOBS;
const lineHunk = (path: string, minus: string, plus: string): Hunk =>
  makeHunk(path, 1, 1, 1, 1, [
    { kind: "-", text: minus, old: 1, new: null },
    { kind: "+", text: plus, old: null, new: 1 },
  ]);
const testHunk = (i: number) => ({ path: `src/a${i}.test.ts`, subject: `test ${i} (proven)`, truncated: false, hunk: lineHunk(`src/a${i}.test.ts`, `  expect(x).toBe(${i})`, "  expect(x).toBeTruthy()") });
const srcHunk = (i: number) => ({ path: `src/a${i}.ts`, subject: "-", truncated: false, hunk: lineHunk(`src/a${i}.ts`, `const a = ${i}`, `const a = ${i + 1}`) });
const binHunk = (i: number) => ({ path: `t/b${i}.test.ts`, subject: "-", truncated: false, hunk: null });
const hugeHunk = () => ({ path: "t/x.test.ts", subject: "ambiguous", truncated: true, hunk: makeHunk("t/x.test.ts", 1, 1, 1, 1, [{ kind: "+", text: '"'.repeat(9000), old: null, new: 1 }]) });
const REQ = "R1. Totals include refunds.";

function drain(fifo: JevCard[], req: string) {
  const plans = [];
  let rest = fifo;
  while (rest.length > 0) {
    const p = planJevReview(rest, req, G)!;
    if (p.window.window.length === 0) throw new Error("stall");
    plans.push(p);
    rest = rest.slice(p.window.window.length);
  }
  return plans;
}

describe("Jev planning (A161 N2–N6)", () => {
  it("N2: a source-only window makes no call; skips are named; the frontier passes both cards", () => {
    const p = planJevReview([{ id: "1", hunks: [srcHunk(0), srcHunk(1)] }, { id: "2", hunks: [srcHunk(2)] }], REQ, G)!;
    expect(p.kind).toBe("no-call");
    expect(p.kind === "no-call" && p.reason).toBe("no-eligible-candidates");
    expect(p.window.skipped.map((s) => `${s.ref}:${s.reason}`)).toEqual(["1/h0:non-test path", "1/h1:non-test path", "2/h0:non-test path"]);
    expect(p.window.window).toEqual(["1", "2"]);
  });
  it("N3: an unfittable first candidate is a no-call candidate-cap window; the next review sends", () => {
    const plans = drain([{ id: "600", hunks: [hugeHunk(), testHunk(1)] }, { id: "601", hunks: [testHunk(2)] }], "R".repeat(20000));
    expect(plans[0]!.kind).toBe("no-call");
    expect(plans[0]!.kind === "no-call" && plans[0]!.reason).toBe("candidate-cap");
    expect(plans[0]!.window.gaps[0]!.refs).toEqual(["600/h0", "600/h1"]);
    expect(plans[0]!.window.partialCoverage).toBe(true);
    expect([plans[1]!.kind, plans[1]!.window.window, Object.keys(plans[1]!.window.body.questions).length]).toEqual(["call", ["601"], 1]);
  });
  it("N4: a source card and a test card share one window and one call with only the test hunk", () => {
    const p = planJevReview([{ id: "10", hunks: [srcHunk(0)] }, { id: "11", hunks: [testHunk(0), binHunk(0)] }], REQ, G)!;
    expect([p.kind, p.window.window, Object.keys(p.window.body.questions).length, p.window.skipped.length]).toEqual(["call", ["10", "11"], 1, 2]);
  });
  it("N5: every card covered once in order, no empty-questions request, one send", () => {
    const fifo = [{ id: "20", hunks: [srcHunk(0)] }, { id: "21", hunks: [binHunk(0)] }, { id: "22", hunks: [hugeHunk()] }, { id: "23", hunks: [testHunk(0), testHunk(1)] }, { id: "24", hunks: [srcHunk(1)] }];
    const plans = drain(fifo, "R".repeat(20000));
    expect(plans.flatMap((p) => p.window.window)).toEqual(["20", "21", "22", "23", "24"]);
    expect(plans.every((p) => p.kind === "no-call" || Object.keys(p.window.body.questions).length > 0)).toBe(true);
    expect(plans.filter((p) => p.kind === "call")).toHaveLength(1);
  });
  it("N6: an empty FIFO is not a review; planning is deterministic", () => {
    expect(planJevReview([], REQ, G)).toBeNull();
    const a = JSON.stringify(planJevReview([{ id: "1", hunks: [srcHunk(0)] }], REQ, G));
    expect(JSON.stringify(planJevReview([{ id: "1", hunks: [srcHunk(0)] }], REQ, G))).toBe(a);
  });
  it("caps one card at 16 questions with exact refs in the gap, and that card ends the review", () => {
    const p = planJevReview([{ id: "200", hunks: Array.from({ length: 30 }, (_, i) => testHunk(i)) }, { id: "201", hunks: [testHunk(99)] }], REQ, G)!;
    expect(p.window.judged).toHaveLength(MAX_QUESTIONS);
    expect(p.window.gaps[0]).toMatchObject({ reason: "candidate-cap", limit: "16 questions", refs: Array.from({ length: 14 }, (_, i) => `200/h${i + 16}`) });
    expect(p.window.window).toEqual(["200"]);
    expect(p.window.bytes.body).toBeLessThanOrEqual(60 * 1024);
  });
});

describe("Jev through the runtime (fake fetch)", () => {
  it("one request, a probability finding at or above the threshold, route-scope gaps, frontier advanced", async () => {
    const calls: string[] = [];
    const r = await rig(
      { reviewEnabled: true, providerRequestsEnabled: true, route: "jev:typesafe", typesafeApiKey: "ts", usdPerDay: 1, apiRequestsPerDay: 5, budgetTimeZone: "UTC" },
      {
        fetch: async (url, init) => {
          calls.push(url);
          const body = JSON.parse(String(init.body));
          const answers = Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { type: "noul", noul: i === 0 ? 0.82 : 0.2 }]));
          return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 700, output_tokens: 0 } }), { status: 200 });
        },
      },
    );
    r.world.addThread("thr_j");
    await r.advisor.watch("thr_j", "test");
    await r.tick();
    r.world.turnStart("thr_j");
    r.world.fileChange("thr_j", "/repo/tests/a.test.ts", oneLineDiff(1, "  expect(x).toBe(1)", "  expect(x).toBeTruthy()"));
    r.world.fileChange("thr_j", "/repo/tests/b.test.ts", oneLineDiff(1, "  expect(y).toBe(2)", "  expect(y).toBe(2) // same"));
    r.world.fileChange("thr_j", "/repo/src/c.ts", oneLineDiff(1, "a", "b"));
    r.world.turnEnd("thr_j");
    r.clock.advance(5 * 60_000);
    await r.tick();
    const w = r.store.getWatchByThread("thr_j")!;
    expect(calls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
    const occ = r.store.listOccurrences(w.id);
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ severity: "unrated", score: 0.82, route: "jev:typesafe", model: "jev-1.13.0" });
    expect(r.store.backlog(w.id)).toBe(0);
    const reasons = r.store.listGaps(w.id).map((g) => g.reason);
    expect(reasons).toContain("not-judged-by-route");
    expect(reasons).toContain("jev-skipped");
    expect(r.store.listLedger()[0]).toMatchObject({ state: "reconciled", billing: "usd" });
  });
});
