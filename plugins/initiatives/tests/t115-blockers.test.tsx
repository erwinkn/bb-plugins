import { describe, expect, it } from "vitest";
import { openBlockers, type BlockerFacts } from "../lib/blockers";

// T115 / D386: which blocked reports still wait on the coordinator (W555: never on the user directly).
describe("T115 the open-blocker rule", () => {
  const a = (num: number, over: Partial<BlockerFacts> = {}): BlockerFacts =>
    ({ num, workerNum: 1, role: "work", taskNums: [1], reviewOf: null, state: "reported", outcome: "blocked", ...over });
  const open = (rows: BlockerFacts[], closed: number[] = [], retired: number[] = []) => openBlockers(rows, (n) => closed.includes(n), (n) => retired.includes(n)).map((r) => r.num);

  it("keeps an unsettled blocked report", () => expect(open([a(1)])).toEqual([1]));
  it("W482: drops a retired worker's blocker and keeps the others'", () =>
    expect(open([a(1), a(2, { workerNum: 2, taskNums: [2] })], [], [1])).toEqual([2]));
  it("drops accepted, rejected and non-blocked reports", () =>
    expect(open([a(1, { state: "accepted" }), a(2, { state: "rejected", taskNums: [2] }), a(3, { outcome: "succeeded", taskNums: [3] })])).toEqual([]));
  it("clears on a newer assignment for the same worker or the same task, but not on a failed dispatch", () => {
    expect(open([a(1), a(2, { state: "running", taskNums: [9] })])).toEqual([]);
    expect(open([a(1), a(2, { workerNum: 2, state: "running" })])).toEqual([]);
    expect(open([a(1), a(2, { state: "failed" })])).toEqual([1]);
    expect(open([a(1), a(2, { workerNum: 2, taskNums: [9], state: "running" })])).toEqual([1]);
  });
  it("a review clears on a newer review of the same task, not on new work", () => {
    const review = a(1, { role: "review", taskNums: [], reviewOf: [1] });
    expect(open([review, a(2, { workerNum: 2, state: "running" })])).toEqual([1]);
    expect(open([review, a(2, { workerNum: 3, role: "review", taskNums: [], reviewOf: [1], state: "running" })])).toEqual([]);
  });
  it("clears once every task it is about is closed", () => {
    expect(open([a(1, { taskNums: [1, 2] })], [1])).toEqual([1]);
    expect(open([a(1, { taskNums: [1, 2] })], [1, 2])).toEqual([]);
  });
});
