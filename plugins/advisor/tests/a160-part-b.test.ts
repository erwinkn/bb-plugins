// Part B of the accepted A160 reference suite: the A141 regressions and controls.

import { describe, expect, it } from "vitest";
import { parseUnified, type Hunk } from "../src/rules/diff.js";
import { Findings } from "../src/rules/findings.js";
import {
  BODY_CAP,
  CARD_ENC_CAP,
  ConfigError,
  buildBody,
  editCards,
  enc,
  referenceSerializer,
} from "../src/rules/packet.js";
import { Requests } from "../src/rules/requests.js";
import { Watch } from "../src/rules/pause.js";
import { RETAIN_CAP, retain } from "../src/rules/retain.js";
import { boundOutput, eligible } from "../src/rules/cards.js";
import { expectedUsd, reservationUsd } from "../src/config/prices.js";
import { validate, type HunkFinding } from "../src/rules/validate.js";
import { failed as readFailed, ok as readOk } from "../src/rules/snapshot.js";
import { ROOT, NativeEvents, accRow, fixture, makePatch, rejRow, reqRow } from "./helpers/a160.js";
import { A_CAN, A_REP, A_RUN, PS, SETTINGS, T_BRIEF, W_REP, W_RUN, editItems, fresh, member, work } from "./helpers/contract.js";

const LUNA = referenceSerializer("gpt-6-luna");
const SONNET = referenceSerializer("claude-sonnet-5-5");
const CHARTER = "charter ".repeat(600);
const v = (f: HunkFinding, ev: Record<string, Hunk[]>, reqs: Record<string, string> = {}) => validate(f, ev, reqs, ROOT);
const reasons = (c: any) => ("reasons" in c ? c.reasons : undefined);
const A141 = fixture("a141-probe-inputs.json");

type Side = [number, string] | [number, number, string];
function cite(eid: string, subject: string | null, b: Side | null, a: Side | null, hunk = 0): HunkFinding {
  const f: HunkFinding = { category: "test-integrity", evidence: eid, hunk, subject };
  const mk = (s: Side) => ({ lines: (s.length === 2 ? [s[0], s[0]] : [s[0], s[1]]) as [number, number], quote: s[s.length - 1] as string });
  if (b) f.before = mk(b);
  if (a) f.after = mk(a);
  return f;
}
function oneChange(path: string, before: string, after: string, n = 3): Hunk[] {
  return parseUnified(path, makePatch(path, before, after, n));
}

describe("Part B, finding 1: per-side binding and the hunk-local scope grammar", () => {
  it("nested_suite_chain_verified", () => {
    const src = "describe('S1', () => {\n  it('handles errors', () => {\n    expect(x).toBe(1);\n  });\n});\n";
    const hs = oneChange("tests/nested.test.ts", src, src.replace("toBe(1)", "toBeTruthy()"));
    const r = v(cite("E:10", "handles errors", [3, "    expect(x).toBe(1);"], [3, "    expect(x).toBeTruthy();"]), { "E:10": hs });
    expect([r.ok, r.shown?.subject, r.shown?.subjectStatus]).toEqual([true, "S1 › handles errors", "verified"]);
  });
  it("regex_test_method_not_a_scope", () => {
    const src = "it('A', () => {\n  expect(/x/.test(s)).toBe(true);\n  expect(n).toBe(3);\n});\n";
    const hs = oneChange("tests/re.test.ts", src, src.replace("toBe(3)", "toBeGreaterThan(0)"));
    const r = v(cite("E:11", "A", [3, "  expect(n).toBe(3);"], [3, "  expect(n).toBeGreaterThan(0);"]), { "E:11": hs });
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "verified"]);
  });
  const pySrc = "def test_a():\n    assert f() == 1\n\ndef test_b():\n    assert g() == 2\n";
  const pyHs = () => oneChange("tests/test_calc.py", pySrc, pySrc.replace("g() == 2", "g() is not None"));
  it("python_indent_scope_verified", () => {
    const r = v(cite("E:12", "test_b", [5, "    assert g() == 2"], [5, "    assert g() is not None"]), { "E:12": pyHs() });
    expect([r.ok, r.shown?.subject, r.shown?.subjectStatus]).toEqual([true, "test_b", "verified"]);
  });
  it("python_closed_def_not_subject", () => {
    const r = v(cite("E:12", "test_a", [5, "    assert g() == 2"], [5, "    assert g() is not None"]), { "E:12": pyHs() });
    expect([r.ok, r.reason]).toEqual([false, "subject-mismatch"]);
  });
  it("rename_in_hunk_rename_or_replacement", () => {
    const hs = oneChange("tests/rename.test.ts", "it('old name', () => expect(x).toBe(1));\n", "it('new name', () => expect(x).toBeTruthy());\n");
    const r = v(cite("E:13", "new name", [1, "it('old name', () => expect(x).toBe(1));"], [1, "it('new name', () => expect(x).toBeTruthy());"]), { "E:13": hs });
    expect([r.ok, r.shown?.subjectStatus, r.shown?.subject, r.shown?.pairing, r.shown?.subjectVerified]).toEqual([
      true,
      "rename-or-replacement",
      "tests/rename.test.ts:L1",
      "positional",
      false,
    ]);
  });
  const rxSrc =
    "it('A', () => {\n  expect(s).toMatch(/\\(/);\n});\nfunction helper() {\n  return total(l);\n}\n" +
    "it('B', () => {\n  const r = a / b;\n  expect(r).toBe(2);\n});\n";
  const rxHs = () => oneChange("tests/rx.test.ts", rxSrc, rxSrc.replace("return total(l);", "return 42;").replace("toBe(2)", "toBeDefined()"), 12);
  it("regex_literal_brackets_do_not_extend_closed_test", () => {
    const r = v(cite("E:19", "A", [5, "  return total(l);"], [5, "  return 42;"]), { "E:19": rxHs() });
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "ambiguous"]);
  });
  it("division_is_not_a_regex_control", () => {
    const r = v(cite("E:19", "B", [9, "  expect(r).toBe(2);"], [9, "  expect(r).toBeDefined();"]), { "E:19": rxHs() });
    expect([r.ok, r.shown?.subject, r.shown?.subjectStatus]).toEqual([true, "B", "verified"]);
  });
  for (const [key, path, want] of [
    ["cross_subject_pair", "tests/pair.test.ts", [false, "subject-incompatible", undefined]],
    ["multiline_closed_scope", "tests/multiline.test.ts", [true, "ok", "ambiguous"]],
    ["moved_relation_cross_subject", "tests/moved.test.ts", [false, "subject-incompatible", undefined]],
  ] as const) {
    it(`a141_${key}`, () => {
      const p = A141[key];
      const r = v(p.finding, { [p.finding.evidence]: parseUnified(path, p.diff) });
      expect([r.ok, r.reason, r.shown?.subjectStatus]).toEqual(want);
    });
  }
  it("a141_multiline_shows_position_and_claim", () => {
    const p = A141.multiline_closed_scope;
    const r = v(p.finding, { "E:2": parseUnified("tests/multiline.test.ts", p.diff) });
    expect([r.shown?.subject, r.shown?.claimedSubject]).toEqual(["tests/multiline.test.ts:L7", "A"]);
  });
  it("mid_line_close_not_attributed_to_closed_test", () => {
    const src = "it('A', () => {\n  x();\n}); it('B', () => {\n  expect(b).toBe(42);\n});\n";
    const hs = oneChange("tests/midline.test.ts", src, src.replace("toBe(42)", "toBeNull()"));
    const r = v(cite("E:14", "A", [4, "  expect(b).toBe(42);"], [4, "  expect(b).toBeNull();"]), { "E:14": hs });
    expect([r.ok, r.shown?.subjectStatus, r.shown?.subject]).toEqual([true, "ambiguous", "tests/midline.test.ts:L4"]);
  });
  it("mid_line_close_then_hook_not_test_a", () => {
    const src = "it('A', () => {\n  x();\n}); afterAll(() => {\n  expect(cleanup()).toBe(true);\n});\n";
    const hs = oneChange("tests/hook.test.ts", src, src.replace("toBe(true)", "toBeDefined()"));
    const r = v(cite("E:22", "A", [4, "  expect(cleanup()).toBe(true);"], [4, "  expect(cleanup()).toBeDefined();"]), { "E:22": hs });
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "ambiguous"]);
  });
  it("parameterized_call_ambiguous", () => {
    const src = "it.each([1, 2])('handles %i', (n) => {\n  expect(n).toBe(1);\n});\n";
    const hs = oneChange("tests/each.test.ts", src, src.replace("toBe(1)", "toBeDefined()"));
    const r = v(cite("E:15", "handles %i", [2, "  expect(n).toBe(1);"], [2, "  expect(n).toBeDefined();"]), { "E:15": hs });
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "ambiguous"]);
  });
  it("multiline_template_ambiguous", () => {
    const src = "it('A', () => {\n  const s = `multi\nline`;\n  expect(s).toBe('x');\n});\n";
    const hs = oneChange("tests/tpl.test.ts", src, src.replace("toBe('x')", "toBeTruthy()"));
    const r = v(cite("E:16", "A", [4, "  expect(s).toBe('x');"], [4, "  expect(s).toBeTruthy();"]), { "E:16": hs });
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "ambiguous"]);
  });
  const two = "it('A', () => expect(a).toBe(1));\nit('B', () => expect(b).toBe(2));\n";
  const twoHs = () => oneChange("tests/two.test.ts", two, two.replace("toBe(1)", "toBeTruthy()").replace("toBe(2)", "toBeTruthy()"));
  it("block_edit_cross_pair_rejected", () => {
    const r = v(
      {
        category: "test-integrity",
        evidence: "E:17",
        hunk: 0,
        subject: "A",
        before: { lines: [1, 1], quote: "it('A', () => expect(a).toBe(1));" },
        after: { lines: [2, 2], quote: "it('B', () => expect(b).toBeTruthy());" },
      },
      { "E:17": twoHs() },
    );
    expect([r.ok, r.reason]).toEqual([false, "subject-incompatible"]);
  });
  it("range_spanning_two_tests_rejected", () => {
    const r = v(
      {
        category: "test-integrity",
        evidence: "E:17",
        hunk: 0,
        subject: "A",
        before: { lines: [1, 2], quote: "it('A', () => expect(a).toBe(1)); it('B', () => expect(b).toBe(2));" },
      },
      { "E:17": twoHs() },
    );
    expect([r.ok, r.reason]).toEqual([false, "before-range-spans-subjects"]);
  });
  it("block_edit_matching_pair_verified", () => {
    const r = v(
      {
        category: "test-integrity",
        evidence: "E:17",
        hunk: 0,
        subject: "B",
        before: { lines: [2, 2], quote: "it('B', () => expect(b).toBe(2));" },
        after: { lines: [2, 2], quote: "it('B', () => expect(b).toBeTruthy());" },
      },
      { "E:17": twoHs() },
    );
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "verified"]);
  });
  const pad = "pad();\n".repeat(10);
  const mvHs = () => oneChange("tests/move.test.ts", "it('A', () => expect(a).toBe(42));\n" + pad, pad + "it('A', () => expect(a).toBeTruthy());\n", 1);
  const fMv: HunkFinding = {
    category: "test-integrity",
    evidence: "E:18",
    hunk: 0,
    subject: "A",
    relation: "moved",
    before: { lines: [1, 1], quote: "it('A', () => expect(a).toBe(42));" },
    after: { hunk: 1, lines: [11, 11], quote: "it('A', () => expect(a).toBeTruthy());" },
  };
  it("moved_same_test_claimed_not_verified", () => {
    const hs = mvHs();
    const r = v(fMv, { "E:18": hs });
    expect([hs.length, r.ok, r.shown?.subjectStatus, r.shown?.pairing]).toEqual([2, true, "ambiguous", "claimed-moved"]);
  });
  it("cross_hunk_without_moved_rejected", () => {
    const { relation: _drop, ...noMoved } = fMv;
    const r = v(noMoved, { "E:18": mvHs() });
    expect([r.ok, r.reason]).toEqual([false, "after-cross-hunk-without-moved"]);
  });
});

describe("Part B, finding 6: issue identity", () => {
  it("a141_same_title_distinct_files", () => {
    const issues = new Findings();
    for (const [eid, path] of [
      ["E:3", "tests/cache.test.ts"],
      ["E:4", "tests/refunds.test.ts"],
    ] as const) {
      const rb = "it('handles errors', () => expect(run()).toBe(42));\n";
      const ra = rb.replace("toBe(42)", "toBeTruthy()");
      const f6 = cite(eid, "handles errors", [1, rb.trim()], [1, ra.trim()]);
      const r = v(f6, { [eid]: parseUnified(path, makePatch(path, rb, ra)) });
      issues.add("watch", "test-integrity", r.shown!, f6, eid);
    }
    expect({ issueCount: issues.issues.size, occurrenceCount: issues.occurrences.size, notificationCount: issues.notifications.length }).toEqual({
      issueCount: 2,
      occurrenceCount: 2,
      notificationCount: 2,
    });
  });
  it("repeated_title_suites_independent", () => {
    const suites =
      "describe('cache', () => {\n  it('handles errors', () => {\n    expect(c()).toBe(1);\n  });\n});\n" +
      "describe('refunds', () => {\n  it('handles errors', () => {\n    expect(r()).toBe(2);\n  });\n});\n";
    const hs = oneChange("tests/suites.test.ts", suites, suites.replace("toBe(1)", "toBeTruthy()").replace("toBe(2)", "toBeTruthy()"), 10);
    const fa = cite("E:20", "handles errors", [3, "    expect(c()).toBe(1);"], [3, "    expect(c()).toBeTruthy();"]);
    const fb = cite("E:20", "handles errors", [8, "    expect(r()).toBe(2);"], [8, "    expect(r()).toBeTruthy();"]);
    const sa = v(fa, { "E:20": hs }).shown!;
    const sb = v(fb, { "E:20": hs }).shown!;
    const I6 = new Findings();
    I6.add("w", "test-integrity", sa, fa, "rv");
    I6.setState("w", "test-integrity", sa.locator, "muted");
    I6.add("w", "test-integrity", sb, fb, "rv");
    expect({ subjects: [sa.subject, sb.subject], issues: I6.issues.size, notifiedAfterMutingFirst: I6.notifications.length }).toEqual({
      subjects: ["cache › handles errors", "refunds › handles errors"],
      issues: 2,
      notifiedAfterMutingFirst: 2,
    });
  });
  it("repeated_title_same_scope_distinct_by_declaration", () => {
    const s = "it('dup', () => {\n  expect(a).toBe(1);\n});\nit('dup', () => {\n  expect(b).toBe(2);\n});\n";
    const hs = oneChange("tests/dup.test.ts", s, s.replace("toBe(1)", "toBeNull()").replace("toBe(2)", "toBeNull()"), 6);
    const s1 = v(cite("E:21", "dup", [2, "  expect(a).toBe(1);"], [2, "  expect(a).toBeNull();"]), { "E:21": hs }).shown!;
    const s2 = v(cite("E:21", "dup", [5, "  expect(b).toBe(2);"], [5, "  expect(b).toBeNull();"]), { "E:21": hs }).shown!;
    expect([s1.locator !== s2.locator, s1.locator, s2.locator]).toEqual([true, "tests/dup.test.ts::dup@new:L1", "tests/dup.test.ts::dup@new:L4"]);
  });
});

describe("Part B, finding 2: completion re-reads authoritative context", () => {
  const briefEdit = readOk(editItems(A_RUN, { briefText: "Implement refunds; approximate totals are acceptable." }));
  const A2_RUN = editItems(PS.readRefs_detailed_cancelled, { state: "running" }).items[0];
  it("same_generation_brief_edit_stale", () => {
    expect(reasons(fresh(work, { arefs: briefEdit }))).toEqual(["briefs-changed"]);
  });
  it("assignment_replaced_stale", () => {
    const replaced = member(W_RUN, "thr_coord", { assignments: [{ ref: "A2", state: "running", cancelled: false, tasks: ["T1"] }] });
    const arefs = readOk({ ...A_RUN, items: [{ ...A_RUN.items[0], state: "cancelled" }, A2_RUN], total: 2 });
    expect(reasons(fresh(work, { proj: replaced, arefs }))).toEqual(["A2-new-assignment", "A1-cancelled"]);
  });
  it("assignment_cancel_requested_stale", () => {
    const proj = member(W_RUN, "thr_coord", { assignments: PS.workerWork_cancel_requested.assignments });
    expect(reasons(fresh(work, { proj, arefs: readOk(A_CAN) }))).toEqual(["A1-cancel-requested"]);
  });
  it("assignment_stopped_stale", () => {
    const proj = member(W_RUN, "thr_coord", { assignments: [{ ...W_RUN.assignments[0], state: "stopped" }] });
    expect(reasons(fresh(work, { proj, arefs: readOk(editItems(A_RUN, { state: "stopped" })) }))).toEqual(["A1-stopped"]);
  });
  it("assignment_progress_not_stale", () => {
    const prog = fresh(work, { proj: member(W_REP), arefs: readOk(A_REP) });
    expect([prog.state, prog.notes]).toEqual(["current-as-of-tip", ["A1-running->reported"]]);
  });
  it("coordinator_replaced_stale", () => {
    expect(reasons(fresh(work, { proj: member(W_RUN, "thr_newcoord") }))).toEqual(["coordinator-changed"]);
  });
  it("worker_generation_replaced_stale", () => {
    expect(reasons(fresh(work, { proj: member(W_RUN, "thr_coord", { generation: 2 }) }))).toEqual(["membership-changed"]);
  });
  it("user_stopped_stale", () => {
    expect(reasons(fresh(work, { proj: member(W_RUN, "thr_coord", { userStopped: true }) }))).toEqual(["user-stopped"]);
  });
  it("parent_changed_stale", () => {
    const CHILD = fixture("thread-shapes.json").childThread;
    expect(reasons(fresh(work, { thread: { ...CHILD, parentThreadId: "thr_other" } }))).toEqual(["parent-changed"]);
  });
  it("settings_revision_changed_stale", () => {
    expect(reasons(fresh(work, { settings: { ...SETTINGS, settingsRev: 8 } }))).toEqual(["settingsRev-changed"]);
  });
  it("watch_epoch_changed_stale", () => {
    expect(reasons(fresh(work, { settings: { ...SETTINGS, epoch: 2 } }))).toEqual(["epoch-changed"]);
  });
  it("brief_read_truncated_unknown", () => {
    const byteLimited = readOk({ ...T_BRIEF, items: [], total: 1, byteLimited: true, nextOffset: 0, truncated: true });
    expect(reasons(fresh(work, { trefs: byteLimited }))).toEqual(["T1-brief-unread"]);
  });
  it("membership_read_missing_unknown", () => {
    expect(reasons(fresh(work, { proj: readFailed("projects read failed") }))).toEqual(["membership-missing"]);
  });
  it("known_change_outranks_unknown_read", () => {
    const mixed: any = fresh(work, { arefs: briefEdit, trefs: readFailed() });
    expect([mixed.state, mixed.reasons, mixed.alsoUnknown]).toEqual(["stale", ["briefs-changed"], ["T1-brief-failed"]]);
  });
  it("non_atomic_label_kept", () => {
    expect(fresh(work).reads).toBe("independent, non-atomic");
  });
});

describe("Part B, finding 3: one request-state table", () => {
  const rq = () => new Requests({ parent: "thr_coord", coordinator: "thr_coord" });
  it("a141_rejected_instruction_settled", () => {
    expect(fresh(A141.rejected_instruction_held.rows, { req: rq() }).state).toBe("current-as-of-tip");
  });
  it("a141_reject_then_accept_stale", () => {
    expect(reasons(fresh(A141.rejection_masks_accepted_instruction.rows, { req: rq() }))).toEqual(["new-accepted-instruction:r2"]);
  });
  it("a141_receipt_beyond_seed_cap", async () => {
    const seedRows = [];
    for (let i = 0; i < 249; i++) seedRows.push(reqRow(i * 2 + 1, `r${i}`, "retain exact output"), accRow(i * 2 + 2, `r${i}`));
    seedRows.push(reqRow(499, "boundary", "use the updated contract"), rejRow(500, "unrelated"), accRow(501, "boundary"));
    const rqs = new Requests();
    await rqs.seed(new NativeEvents(seedRows));
    expect({
      pending: rqs.pending(),
      boundaryState: rqs.rows.get("boundary")?.state,
      coverage: rqs.coverage(),
      gaps: rqs.gaps,
      boundaryIsRequirement: rqs.requirements().some((x) => x.ref === "R:499"),
    }).toEqual({ pending: [], boundaryState: "accepted", coverage: "complete", gaps: [], boundaryIsRequirement: true });
  });
  it("stale_accepted_outranks_unrelated_pending", () => {
    const mix = [reqRow(80, "a1", "use the new rounding contract"), accRow(81, "a1"), reqRow(82, "p1", "also rename the file")];
    const r1: any = fresh(mix, { req: rq() });
    expect([r1.state, r1.reasons]).toEqual(["stale", ["new-accepted-instruction:a1"]]);
  });
  it("peer_pending_does_not_hold", () => {
    expect(fresh([reqRow(83, "peer1", "fyi", "thr_peer")], { req: rq() }).state).toBe("current-as-of-tip");
  });
  it("pending_beyond_horizon_degrades_to_partial", () => {
    const r = rq();
    r.ingest(reqRow(90, "slow", "please also cover VAT"), 0);
    expect({ pendingAt10: r.pending(10), pendingAt45: r.pending(45), coverageAt45: r.coverage(45) }).toEqual({
      pendingAt10: ["slow"],
      pendingAt45: [],
      coverageAt45: "partial",
    });
  });
  it("seed_request_settled_by_drain", async () => {
    const r = new Requests();
    await r.seed(new NativeEvents([reqRow(5, "x", "keep totals exact")]));
    r.ingest(accRow(130, "x"));
    expect([r.rows.get("x")?.state, r.pending()]).toEqual(["accepted", []]);
  });
  it("orphan_receipt_recorded_not_invented", () => {
    const r = new Requests();
    r.ingest(accRow(7, "unseen"));
    expect([r.orphanReceipts, r.pending()]).toEqual([[7], []]);
  });
});

describe("Part B, finding 4: pause reasons", () => {
  it("a141_failure_pause_survives_work_input", () => {
    const w = new Watch();
    w.pending = true;
    w.reasons.add("failure");
    w.observe(accRow(104, "ordinary-worker-input"));
    expect([w.mayDispatch(), [...w.reasons].sort()]).toEqual([false, ["failure"]]);
  });
  it("two_failures_pause", () => {
    const w = new Watch();
    w.pending = true;
    w.reviewFailed();
    w.reviewFailed();
    expect([...w.reasons].sort()).toEqual(["failure"]);
  });
  it("manual_pause_survives_work_input", () => {
    const w = new Watch();
    w.pending = true;
    w.pause("panel");
    w.observe(accRow(105, "x"));
    expect(w.mayDispatch()).toBe(false);
  });
  it("interrupt_cleared_failure_kept", () => {
    const w = new Watch();
    w.pending = true;
    w.observe({ type: "system/thread/interrupted", data: {} });
    w.reviewFailed();
    w.reviewFailed();
    w.observe(accRow(106, "resumed"));
    expect([...w.reasons].sort()).toEqual(["failure"]);
  });
  it("resume_clears_only_human_reasons", () => {
    const w = new Watch();
    w.pending = true;
    w.pause("cli");
    w.reviewFailed();
    w.reviewFailed();
    w.disable();
    w.projectsRead(true);
    w.resume("panel");
    expect([[...w.reasons].sort(), w.log.at(-1)]).toEqual([["disabled", "user-stopped"], { action: "resume", via: "panel", caller: "unverified" }]);
  });
  it("native_and_enable_clear_their_own", () => {
    const w = new Watch();
    w.pending = true;
    w.pause("cli");
    w.reviewFailed();
    w.reviewFailed();
    w.disable();
    w.projectsRead(true);
    w.resume("panel");
    w.projectsRead(false);
    w.enable();
    expect([w.mayDispatch(), w.epoch]).toEqual([true, 2]);
  });
});

describe("Part B, finding 5: complete builder", () => {
  const card1 = { id: "E:1:0#0", text: "x", encBytes: 1 };
  it("a141_encoded_fixed_sections_overflow", () => {
    const ctrl = "\x01".repeat(12 * 1024);
    const { body, meta } = buildBody(LUNA, CHARTER, "", [{ ref: "R:1", class: "unattributed", proof: "none", text: ctrl }], [], [
      { id: "E:1:0#0", text: "new evidence", encBytes: enc("new evidence") },
    ]);
    expect({
      underCap: Buffer.byteLength(body) <= BODY_CAP,
      cards: meta.cards,
      partial: meta.partialRequirements,
      coverage: meta.coverage,
      missedRequirementEnabled: meta.categories.includes("missed-requirement"),
    }).toEqual({ underCap: true, cards: ["E:1:0#0"], partial: ["R:1"], coverage: "partial", missedRequirementEnabled: false });
  });
  const escLine = "\x02".repeat(3000);
  const escDiff = "@@ -1,3 +1,3 @@\n-" + escLine + "\n+" + escLine + "y\n " + escLine;
  const escCards = () => editCards(600, 0, "tests/esc.test.ts", escDiff);
  it("single_escaped_oversized_card", () => {
    const cards = escCards();
    const { body, meta } = buildBody(SONNET, CHARTER, "", [], [], cards);
    expect({
      rawBytes: Buffer.byteLength(escDiff),
      cardEncWithinCap: cards[0]!.encBytes <= CARD_ENC_CAP,
      inclusion: cards[0]!.inclusion,
      keptLines: cards[0]!.hunks[0]!.lines.length,
      sent: meta.cards,
      underCap: Buffer.byteLength(body) <= BODY_CAP,
    }).toEqual({ rawBytes: 9022, cardEncWithinCap: true, inclusion: "truncated", keptLines: 0, sent: ["E:600:0#0"], underCap: true });
  });
  it("truncated_away_line_cannot_be_cited", () => {
    const cards = escCards();
    const r = v(cite("E:600:0#0", null, [1, escLine], null), { "E:600:0#0": cards[0]!.hunks });
    expect([r.ok, r.reason]).toEqual([false, "before-lines-outside-hunk"]);
  });
  it("oversized_policy_visible_error", () => {
    let got = "sent";
    try {
      buildBody(LUNA, CHARTER, '"'.repeat(3000), [], [], [card1]);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      got = e.message;
    }
    expect(got).toBe("priorities are 6000 serialized bytes; cap 4096");
  });
  it("requirements_trimmed_with_named_omissions", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ref: `R:${i}`, class: "unattributed" as const, proof: "none" as const, text: "r".repeat(9000) }));
    const { meta } = buildBody(LUNA, CHARTER, "", many, ["open: tests/x.test.ts::a@new:L1"], [card1]);
    expect({
      partial: meta.partialRequirements.length,
      omittedNamed: meta.omittedRequirements.length > 0,
      allAccounted: Object.keys(meta.packetRequirements).length + meta.omittedRequirements.length === 8,
      card: meta.cards,
    }).toEqual({ partial: 1, omittedNamed: true, allAccounted: true, card: ["E:1:0#0"] });
  });
});

describe("Part B, finding 7: retained excerpts", () => {
  it("a141_retained_citation_complete_after_prune_rule", () => {
    // The excerpt rule half of a141_retained_citation_complete_after_prune; the
    // prune-then-open half runs against the real store (store.test.ts).
    const bq = "it('large', () => expect('" + "x".repeat(2400) + "').toBe(42));";
    const aq = bq.replace("toBe(42)", "toBeTruthy()");
    const cards7 = editCards(5, 0, "tests/large.test.ts", makePatch("tests/large.test.ts", bq, aq));
    const r = v(cite(cards7[0]!.id, "large", [1, bq], [1, aq]), { [cards7[0]!.id]: cards7[0]!.hunks });
    const ret = retain(r.shown!);
    expect({ accepted: r.ok, retainedStatus: ret.status, retainedBytes: ret.bytes }).toEqual({ accepted: true, retainedStatus: "complete", retainedBytes: 4882 });
  });
  it("retained_citation_clipped_exactly_rule", () => {
    const lb = "it('big', () => expect('" + "é".repeat(2600) + "').toBe(1));";
    const la = lb.replace("toBe(1)", "toBeTruthy()");
    const mvb = lb + "\n" + "pad();\n".repeat(6);
    const mva = "pad();\n".repeat(6) + la + "\n";
    const hs7 = parseUnified("tests/big.test.ts", makePatch("tests/big.test.ts", mvb, mva, 1));
    const r = v(
      { category: "test-integrity", evidence: "E:7", hunk: 0, subject: "big", relation: "moved", before: { lines: [1, 1], quote: lb }, after: { hunk: 1, lines: [7, 7], quote: la } },
      { "E:7": hs7 },
    );
    const ret = retain(r.shown!);
    const full = Buffer.byteLength(lb) + Buffer.byteLength(la);
    const sides = Object.values(ret.sides) as Array<{ head: string; tail: string; omittedBytes: number }>;
    const kept = sides.reduce((n, x) => n + Buffer.byteLength(x.head) + Buffer.byteLength(x.tail), 0);
    const lost = sides.reduce((n, x) => n + x.omittedBytes, 0);
    expect({
      accepted: r.ok,
      status: ret.status,
      withinCap: ret.bytes <= RETAIN_CAP,
      exactAccounting: kept + lost === full,
      validUtf8: sides.every((x) => !(x.head + x.tail).includes("�")),
    }).toEqual({ accepted: true, status: "clipped", withinCap: true, exactAccounting: true, validUtf8: true });
  });
});

describe("Part B, finding 8: workload and cost attribution", () => {
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  it("s4_call_attribution", () => {
    const calls = 40 * 3;
    const s4: any = {};
    for (const m of ["gpt-6-luna", "claude-sonnet-5-5"]) {
      s4[m] = { callsPerModel: calls, reserved16KiB: r5(calls * reservationUsd(m, 16 * 1024, 2000)), expected4kIn1kOut: r5(calls * expectedUsd(m, 4000, 1000)) };
    }
    s4.total = {
      calls: 2 * calls,
      reserved16KiB: r5(s4["gpt-6-luna"].reserved16KiB + s4["claude-sonnet-5-5"].reserved16KiB),
      expected4kIn1kOut: r5(s4["gpt-6-luna"].expected4kIn1kOut + s4["claude-sonnet-5-5"].expected4kIn1kOut),
    };
    expect(s4).toEqual({
      "gpt-6-luna": { callsPerModel: 120, reserved16KiB: 0.38112, expected4kIn1kOut: 0.108 },
      "claude-sonnet-5-5": { callsPerModel: 120, reserved16KiB: 7.6224, expected4kIn1kOut: 2.16 },
      total: { calls: 240, reserved16KiB: 8.00352, expected4kIn1kOut: 2.268 },
    });
  });
  it("per_watch_cost_rows", () => {
    const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
    const cost: any = {};
    for (const m of ["gpt-6-luna", "claude-sonnet-5-5"]) {
      cost[m] = {
        reservationAtCap: r5(reservationUsd(m, BODY_CAP, 2000)),
        "expectedPerReview(6k in,1k out)": r5(expectedUsd(m, 6000, 1000)),
        "8hWorker49ReviewsExpected": r3(49 * expectedUsd(m, 6000, 1000)),
        "8hWorker49ReviewsReservedBound": r3(49 * reservationUsd(m, BODY_CAP, 2000)),
      };
    }
    expect(cost).toEqual({
      "gpt-6-luna": { reservationAtCap: 0.00932, "expectedPerReview(6k in,1k out)": 0.0011, "8hWorker49ReviewsExpected": 0.054, "8hWorker49ReviewsReservedBound": 0.457 },
      "claude-sonnet-5-5": { reservationAtCap: 0.1864, "expectedPerReview(6k in,1k out)": 0.022, "8hWorker49ReviewsExpected": 1.078, "8hWorker49ReviewsReservedBound": 9.134 },
    });
  });
  it("confirmation_effect_not_guaranteed", () => {
    const pr = (tp: number, fp: number, pos: number) => [Math.round((tp / (tp + fp)) * 1000) / 1000, Math.round((tp / pos) * 1000) / 1000];
    expect({ primary: pr(8, 2, 10), confirmKeeps4TP2FP: pr(4, 2, 10), confirmKeeps8TP0FP: pr(8, 0, 10) }).toEqual({
      primary: [0.8, 0.8],
      confirmKeeps4TP2FP: [0.667, 0.4],
      confirmKeeps8TP0FP: [1.0, 0.8],
    });
  });
});

describe("Part B: output limits and eligibility", () => {
  it("command_output_bounded", () => {
    const cc = boundOutput("ok\n".repeat(5000));
    if (!cc.outputTruncated) throw new Error("expected truncation");
    expect({ truncated: cc.outputTruncated, kept: cc.head.length + cc.tail.length, omitted: cc.omittedBytes }).toEqual({ truncated: true, kept: 2048, omitted: 12952 });
  });
  it("watch_eligibility", () => {
    expect([eligible({ hidden: true } as any)[0], eligible({ pluginMetadata: { advisorOwned: true } })]).toEqual([true, [false, "advisor-owned"]]);
  });
});
