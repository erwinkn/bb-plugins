// Part C of the accepted A160 reference suite: the A148 counterexamples (A152).

import { describe, expect, it } from "vitest";
import { parseUnified, type Hunk } from "../src/rules/diff.js";
import { Findings } from "../src/rules/findings.js";
import { BODY_CAP, CARD_ENC_CAP, IngestError, OMIT_NAMED, REF_MAX, buildBody, editCards, enc, omittedLine, referenceSerializer } from "../src/rules/packet.js";
import { Requests } from "../src/rules/requests.js";
import { RETAIN_CAP, retain } from "../src/rules/retain.js";
import { eligible } from "../src/rules/cards.js";
import { validate, type HunkFinding } from "../src/rules/validate.js";
import { classifyCompletion, failed as readFailed, ok as readOk, snapshot } from "../src/rules/snapshot.js";
import { ROOT, NativeEvents, accRow, makePatch, reqRow } from "./helpers/a160.js";
import { A_REP, A_RUN, CHILD, PS, SETTINGS, SNAP, TS, W_REP, W_RUN, editItems, fresh, member, snap, textCard, work } from "./helpers/contract.js";

const LUNA = referenceSerializer("gpt-6-luna");
const SONNET = referenceSerializer("claude-sonnet-5-5");
const v = (f: HunkFinding, ev: Record<string, Hunk[]>) => validate(f, ev, {}, ROOT);
const rs = (c: any) => ("reasons" in c ? c.reasons : undefined);

type C148 = [number, string] | [number, string, number];
function cite148(eid: string, subject: string, b: C148 | null, a: C148 | null, hunk = 0, extra: Partial<HunkFinding> = {}): HunkFinding {
  const f: HunkFinding = { category: "test-integrity", evidence: eid, hunk, subject, ...extra };
  if (b) f.before = { lines: [b[0], b[0]], quote: b[1], ...(b.length > 2 ? { hunk: b[2] } : {}) };
  if (a) f.after = { lines: [a[0], a[0]], quote: a[1], ...(a.length > 2 ? { hunk: a[2] } : {}) };
  return f;
}

const standalone = (t: any) => snapshot(readOk(t), SETTINGS, readOk(null));

describe("Part C, P1a: explicit read outcomes; null parentThreadId and archivedAt are values", () => {
  const ROOT_T = TS.rootThread;
  const ARCH_T = TS.archivedChild;
  it("p1a_root_thread_contract_current", () => {
    const r = classifyCompletion(standalone(ROOT_T), standalone(ROOT_T), work, true, new Requests());
    expect([r.state, rs(r)]).toEqual(["current-as-of-tip", undefined]);
  });
  it("p1a_child_thread_contract_current", () => {
    expect(classifyCompletion(standalone(CHILD), standalone(CHILD), work, true, new Requests()).state).toBe("current-as-of-tip");
  });
  it("p1a_thread_read_failed_unknown", () => {
    const r = classifyCompletion(standalone(CHILD), snapshot(readFailed("threads.get rejected"), SETTINGS, readOk(null)), work, true, new Requests());
    expect([r.state, rs(r)]).toEqual(["unknown", ["thread-missing"]]);
  });
  it("p1a_archived_between_reads_stale", () => {
    expect(rs(classifyCompletion(standalone(CHILD), standalone(ARCH_T), work, true, new Requests()))).toEqual(["archived-changed"]);
  });
  it("p1a_eligibility_reads_archivedAt", () => {
    expect([eligible(ROOT_T), eligible(CHILD), eligible(ARCH_T)]).toEqual([
      [true, "ok"],
      [true, "ok"],
      [false, "archived"],
    ]);
  });
  it("p1a_membership_read_failed_is_not_none", () => {
    const r = classifyCompletion(standalone(ROOT_T), snapshot(readOk(ROOT_T), SETTINGS, readFailed("projects unavailable")), work, true, new Requests());
    expect([r.state, rs(r)]).toEqual(["unknown", ["membership-missing"]]);
  });
});

describe("Part C, P3: joining or leaving an Initiative mid-review", () => {
  it("p3_joined_initiative_mid_review_stale", () => {
    const r = classifyCompletion(standalone(CHILD), SNAP, work, true, new Requests());
    expect([r.state, rs(r)]).toEqual(["stale", ["membership-joined"]]);
  });
  it("p3_left_initiative_mid_review_stale", () => {
    expect(rs(classifyCompletion(SNAP, standalone(CHILD), work, true, new Requests()))).toEqual(["membership-left"]);
  });
});

describe("Part C, P1b: dispatch-time refs re-read by exact ref", () => {
  const A2_RUN = editItems(PS.readRefs_detailed_cancelled, { state: "running" }).items[0];
  it("p1b_installed_row_drops_reported", () => {
    expect([PS.workerWork_running.assignments[0].ref, PS.workerWork_after_report.assignments, A_REP.items[0].state]).toEqual(["A1", [], "reported"]);
  });
  it("p1b_accepted_via_ref_current", () => {
    const acc = fresh(work, { proj: member(W_REP), arefs: readOk(editItems(A_REP, { state: "accepted" })) });
    expect([acc.state, acc.notes]).toEqual(["current-as-of-tip", ["A1-running->accepted"]]);
  });
  it("p1b_missing_ref_unknown_not_cancelled", () => {
    const gone = { ...A_REP, items: [], total: 0, missingRefs: ["A1"] };
    const r = fresh(work, { proj: member(W_REP), arefs: readOk(gone) });
    expect([r.state, rs(r)]).toEqual(["unknown", ["A1-missing", "T1-brief-unread"]]);
  });
  it("p1b_failed_ref_read_unknown", () => {
    const r = fresh(work, { proj: member(W_REP), arefs: readFailed("readRefs exceeds the 65536-byte read budget") });
    expect([r.state, rs(r)]).toEqual(["unknown", ["A1-failed", "T1-brief-unread"]]);
  });
  it("p1b_paged_ref_unread_unknown", () => {
    const twoRow = member(W_RUN, "thr_coord", { assignments: [...W_RUN.assignments, { ref: "A2", state: "running", cancelled: false, tasks: ["T1"] }] });
    const base2 = snap({ proj: twoRow, arefs: readOk({ ...A_RUN, items: [...A_RUN.items, A2_RUN], total: 2 }) });
    const paged = { ...PS.readRefs_paged, items: [{ ...PS.readRefs_paged.items[0], state: "reported" }] };
    const r = fresh(work, { base: base2, proj: member(W_REP), arefs: readOk(paged) });
    expect([r.state, rs(r), r.notes]).toEqual(["unknown", ["A2-unread"], ["A1-running->reported"]]);
  });
  for (const [name, over, want] of [
    ["owner_changed", { generation: 1 }, ["A1-owner-changed"]],
    ["cancel_after_report", { cancelRequested: true }, ["A1-cancel-requested"]],
    ["brief_edited_after_report", { briefText: "Approximate totals are fine." }, ["briefs-changed"]],
    ["rejected_report", { state: "rejected" }, ["A1-rejected"]],
  ] as const) {
    it(`p1b_reported_but_${name}_stale`, () => {
      expect(rs(fresh(work, { proj: member(W_REP), arefs: readOk(editItems(A_REP, over)) }))).toEqual(want);
    });
  }
});

describe("Part C, P1c: cross-hunk pairs are claimed, never verified", () => {
  const filler = Array.from({ length: 12 }, (_, i) => `  it('t${i}', () => {\n    expect(${i}).toBe(${i});\n  });\n`).join("");
  const before =
    "describe('cache', () => {\n" + filler + "  it('handles errors', () => {\n    expect(c()).toBe(42);\n  });\n" + filler + "});\n" +
    "describe('refunds', () => {\n" + filler + filler + "});\n";
  const after =
    "describe('cache', () => {\n" + filler + filler + "});\n" +
    "describe('refunds', () => {\n" + filler + "  it('handles errors', () => {\n    expect(r()).toBeGreaterThan(0);\n  });\n" + filler + "});\n";
  const hs = parseUnified("tests/suites.test.ts", makePatch("tests/suites.test.ts", before, after));
  const lines = hs.flatMap((h) => h.lines);
  const bl = lines.find((l) => l.kind === "-" && l.text.includes("toBe(42)"))!.old!;
  const al = lines.find((l) => l.kind === "+" && l.text.includes("toBeGreaterThan"))!.new!;
  const bh = hs.findIndex((h) => h.lines.some((l) => l.text.includes("toBe(42)")));
  const ah = hs.findIndex((h) => h.lines.some((l) => l.text.includes("toBeGreaterThan")));
  const f1a = cite148("E:1", "handles errors", [bl, "    expect(c()).toBe(42);", bh], [al, "    expect(r()).toBeGreaterThan(0);", ah], ah, { relation: "moved" });
  it("p1c_moved_across_suites_claimed", () => {
    const r = v(f1a, { "E:1": hs });
    expect([r.ok, r.reason, r.shown?.subjectStatus, r.shown?.pairing, r.shown?.subjectVerified]).toEqual([true, "ok", "ambiguous", "claimed-moved", false]);
  });
  it("p1c_moved_quote_still_validated", () => {
    const r = v({ ...f1a, after: { ...f1a.after!, quote: "    expect(r()).toBeTruthy();" } }, { "E:1": hs });
    expect([r.ok, r.reason]).toEqual([false, "after-quote-mismatch"]);
  });
  it("p1c_moved_claim_must_match_names", () => {
    const r = v({ ...f1a, subject: "rounds totals" }, { "E:1": hs });
    expect([r.ok, r.reason]).toEqual([false, "subject-mismatch"]);
  });
});

describe("Part C, P2d: positional pairing", () => {
  it("p2d_reorder_true_pair_kept_ambiguous", () => {
    const b = "it('A', () => {\n  expect(a).toBe(1);\n});\nit('B', () => {\n  expect(b).toBe(2);\n});\n";
    const a = "it('B', () => {\n  expect(b).toBe(2);\n});\nit('A', () => {\n  expect(a).toBeDefined();\n});\n";
    const hs = parseUnified("tests/order.test.ts", makePatch("tests/order.test.ts", b, a));
    const res: Record<string, unknown[]> = {};
    for (const [bln, bq] of [
      [2, "  expect(a).toBe(1);"],
      [5, "  expect(b).toBe(2);"],
    ] as const) {
      for (const [aln, aq] of [
        [2, "  expect(b).toBe(2);"],
        [5, "  expect(a).toBeDefined();"],
      ] as const) {
        for (const subj of ["A", "B"]) {
          const r = v(cite148("E:2", subj, [bln, bq], [aln, aq]), { "E:2": hs });
          res[`old${bln}->new${aln} claim ${subj}`] = [r.ok, r.reason, r.shown?.subjectStatus ?? null, r.shown?.pairing ?? null];
        }
      }
    }
    expect(res).toEqual({
      "old2->new2 claim A": [false, "subject-incompatible", null, null],
      "old2->new2 claim B": [false, "subject-incompatible", null, null],
      "old2->new5 claim A": [true, "ok", "ambiguous", "claimed-same-name"],
      "old2->new5 claim B": [false, "subject-mismatch", null, null],
      "old5->new2 claim A": [false, "no-changed-line-cited", null, null],
      "old5->new2 claim B": [false, "no-changed-line-cited", null, null],
      "old5->new5 claim A": [false, "subject-incompatible", null, null],
      "old5->new5 claim B": [false, "subject-incompatible", null, null],
    });
  });
  it("p2d_replacement_not_verified_rename", () => {
    const b = "it('rounds totals exactly', () => {\n  expect(total()).toBe(10.25);\n});\n";
    const a = "it('renders without crashing', () => {\n  expect(render()).toBeTruthy();\n});\n";
    const hs = parseUnified("tests/x.test.ts", makePatch("tests/x.test.ts", b, a));
    const r = v(cite148("E:3", "renders without crashing", [2, "  expect(total()).toBe(10.25);"], [2, "  expect(render()).toBeTruthy();"]), { "E:3": hs });
    expect([r.ok, r.reason, r.shown?.subjectStatus, r.shown?.pairing, r.shown?.subjectVerified, r.shown?.subject]).toEqual([
      true,
      "ok",
      "rename-or-replacement",
      "positional",
      false,
      "tests/x.test.ts:L2",
    ]);
  });
  it("p2d_same_name_edit_in_run_verified_control", () => {
    const dup2 = "it('A', () => {\n  expect(a).toBe(1);\n});\nit('A', () => {\n  expect(a2).toBe(2);\n});\n";
    const cur = dup2.replace("toBe(1)", "toBeTruthy()").replace("it('A', () => {\n  expect(a2)", "it('A', () => {\n  expect(a3)");
    const hs = parseUnified("tests/dup2.test.ts", makePatch("tests/dup2.test.ts", dup2, cur));
    const r = v(cite148("E:4", "A", [2, "  expect(a).toBe(1);"], [2, "  expect(a).toBeTruthy();"]), { "E:4": hs });
    expect([r.ok, r.shown?.subjectStatus]).toEqual([true, "verified"]);
  });
});

describe("Part C, P2c: mutes on unverified locators", () => {
  const body6 = (n: number) => Array.from({ length: n }, (_, i) => `  x${i} = ${i};\n`).join("");
  it("p2c_ambiguous_mute_does_not_hide_other_test", () => {
    const src1 = "it('A', () => {\n" + body6(40) + "  expect(a).toBe(1);\n" + body6(20) + "});\n";
    const hs1 = parseUnified("tests/amb.test.ts", makePatch("tests/amb.test.ts", src1, src1.replace("toBe(1)", "toBeTruthy()")));
    const f1 = cite148("E:10", "A", [42, "  expect(a).toBe(1);"], [42, "  expect(a).toBeTruthy();"]);
    const s1 = v(f1, { "E:10": hs1 }).shown!;
    const src2 = "it('B', () => {\n" + body6(40) + "  expect(b).toBe(2);\n" + body6(20) + "});\n";
    const hs2 = parseUnified("tests/amb.test.ts", makePatch("tests/amb.test.ts", src2, src2.replace("toBe(2)", "toBeTruthy()")));
    const f2 = cite148("E:11", "B", [42, "  expect(b).toBe(2);"], [42, "  expect(b).toBeTruthy();"]);
    const s2 = v(f2, { "E:11": hs2 }).shown!;
    const F6 = new Findings();
    F6.add("w", "test-integrity", s1, f1, "rv1");
    F6.setState("w", "test-integrity", s1.locator, "muted");
    F6.add("w", "test-integrity", s1, f1, "rv1b"); // the muted occurrence re-raised: deduplicated, silent
    F6.add("w", "test-integrity", s2, f2, "rv2");
    expect({
      sameLocator: s1.locator === s2.locator,
      issues: F6.issues.size,
      issueState: F6.state("w", "test-integrity", s1.locator),
      notifications: F6.notifications.map((n) => n.reason),
    }).toEqual({ sameLocator: true, issues: 1, issueState: "muted", notifications: ["new", "new-occurrence-at-muted-unverified-locator"] });
  });
  it("p2c_verified_mute_still_suppresses_control", () => {
    const ONE =
      "import { total, date, round } from '../src';\nconst l = ledger();\n" +
      "it('computes totals with refunds', () => expect(total(l)).toBe(42));\n" +
      "it('formats dates', () => expect(date()).toBe(99));\nit('rounds cents', () => expect(round(1.005)).toBe(1.01));\n";
    const d = makePatch("tests/totals.test.ts", ONE, ONE.replace("expect(total(l)).toBe(42)", "expect(total(l)).toBeGreaterThan(0)"));
    const base: HunkFinding = {
      category: "test-integrity",
      hunk: 0,
      subject: "computes totals with refunds",
      before: { lines: [3, 3], quote: "it('computes totals with refunds', () => expect(total(l)).toBe(42));" },
      after: { lines: [3, 3], quote: "it('computes totals with refunds', () => expect(total(l)).toBeGreaterThan(0));" },
    };
    const f300 = { ...base, evidence: "E:300:0" };
    const f320 = { ...base, evidence: "E:320:0" };
    const ev = { "E:300:0": parseUnified("tests/totals.test.ts", d), "E:320:0": parseUnified("tests/totals.test.ts", d) };
    const s300 = v(f300, ev).shown!;
    const s320 = v(f320, ev).shown!;
    const F7 = new Findings();
    F7.add("w1", "test-integrity", s300, f300, "rv1");
    F7.setState("w1", "test-integrity", s300.locator, "muted");
    F7.add("w1", "test-integrity", s320, f320, "rv2"); // verified subject, byte-identical recurrence at a later seq
    expect([s300.subjectVerified, F7.notifications.map((n) => n.reason), F7.occurrences.size]).toEqual([true, ["new"], 2]);
  });
});

describe("Part C, P2b and P2a: rendered card bound and oldest-card progress", () => {
  it("p2b_rendered_card_bound", () => {
    let worst5a = 0;
    let alone = true;
    const Ls = [...new Set([...Array.from({ length: Math.ceil(100 / 9) }, (_, i) => 20 + i * 9), 39])].sort((a, b) => a - b);
    const SMs = [...new Set([...Array.from({ length: 7 }, (_, i) => i * 6), 20])].sort((a, b) => a - b);
    for (const L of Ls) {
      for (const sm of SMs) {
        const big = "@@ -1,300 +1,300 @@\n" + Array.from({ length: 300 }, () => "+" + "y".repeat(L)).join("\n");
        const small = "@@ -900,1 +900,1 @@\n-" + "a".repeat(sm) + "\n+" + "b".repeat(sm);
        try {
          const cs = editCards(1, 0, "f.ts", big + "\n" + small);
          worst5a = Math.max(worst5a, ...cs.map((c) => c.encBytes));
          alone &&= cs.filter((c) => c.inclusion === "truncated").every((c) => c.hunks.length === 1);
        } catch (e) {
          if (!(e instanceof IngestError)) throw e;
          worst5a = CARD_ENC_CAP + 1;
        }
      }
    }
    const big = "@@ -1,300 +1,300 @@\n" + Array.from({ length: 300 }, () => "+" + "y".repeat(39)).join("\n");
    const cs = editCards(1, 0, "f.ts", big + "\n" + "@@ -900,1 +900,1 @@\n-" + "a".repeat(20) + "\n+" + "b".repeat(20));
    const built = buildBody(referenceSerializer("gpt-6-luna"), "charter", "", [], [], cs).meta.cards;
    const big5 = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(5, "0")} ` + "x".repeat(60) + "\n").join("");
    let worstGap = 0;
    const gaps = [...new Set([...Array.from({ length: 20 }, (_, i) => i * 10), 103])].sort((a, b) => a - b);
    for (const gap of gaps) {
      const lines = big5.split("\n").slice(0, -1);
      const pads = Array.from({ length: gap }, (_, i) => `pad${i}`).join("\n");
      const b2 = lines.join("\n") + "\n" + pads + "\nz = 1\n";
      const c2 = lines.map((l) => l.replace("x".repeat(60), "y".repeat(60))).join("\n") + "\n" + pads + "\nz = 2\n";
      try {
        worstGap = Math.max(worstGap, ...editCards(1, 0, "big.py", makePatch("big.py", b2, c2)).map((c) => c.encBytes));
      } catch (e) {
        if (!(e instanceof IngestError)) throw e;
        worstGap = CARD_ENC_CAP + 1;
      }
    }
    expect({
      "probe5aGridMax<=cap": worst5a <= CARD_ENC_CAP,
      truncatedHunksAlone: alone,
      "probes5aGridMax<=cap": worstGap <= CARD_ENC_CAP,
      a148CardsSplit: cs.map((c) => c.inclusion),
      builtCards: built,
    }).toEqual({
      "probe5aGridMax<=cap": true,
      truncatedHunksAlone: true,
      "probes5aGridMax<=cap": true,
      a148CardsSplit: ["truncated", "complete"],
      builtCards: ["E:1:0#0", "E:1:0#1"],
    });
  });
  const CH = "charter ".repeat(600);
  const t5 = "a".repeat(CARD_ENC_CAP - 1);
  const card5 = { id: "E:9:0#0", seq: 9, encBytes: enc(t5), text: t5 };
  it("p2a_omitted_refs_cannot_eat_reserve", () => {
    const reqs5 = [
      { ref: "R:1", class: "unattributed" as const, proof: "none" as const, text: "b".repeat(70000) },
      ...Array.from({ length: 12 }, (_, i) => ({ ref: `R:${100000 + i}`, class: "unattributed" as const, proof: "none" as const, text: "c".repeat(400) })),
    ];
    const { body, meta } = buildBody(LUNA, CH, "", reqs5, [], [card5]);
    expect({
      cardsSent: meta.cards,
      underCap: Buffer.byteLength(body) <= BODY_CAP,
      partial: meta.partialRequirements,
      accounted: Object.keys(meta.packetRequirements).length + meta.omittedRequirements.length === reqs5.length,
      coverage: meta.coverage,
    }).toEqual({ cardsSent: ["E:9:0#0"], underCap: true, partial: ["R:1"], accounted: true, coverage: "partial" });
  });
  it("p2a_recheck_sheds_when_omission_line_grows", () => {
    const longReqs = [
      { ref: "R:1", class: "unattributed" as const, proof: "none" as const, text: "b".repeat(70000) },
      ...Array.from({ length: 12 }, (_, i) => ({ ref: `A${String(i).padStart(30, "0")}`, class: "coordinator" as const, proof: "none" as const, text: "c".repeat(400) })),
    ];
    const { body, meta } = buildBody(LUNA, CH, "", longReqs, [], [card5]);
    expect({
      cardsSent: meta.cards,
      underCap: Buffer.byteLength(body) <= BODY_CAP,
      partial: meta.partialRequirements,
      bodyUsesCap: Buffer.byteLength(body) > BODY_CAP - 1024,
      accounted: Object.keys(meta.packetRequirements).length + meta.omittedRequirements.length === longReqs.length,
    }).toEqual({ cardsSent: ["E:9:0#0"], underCap: true, partial: ["R:1"], bodyUsesCap: true, accounted: true });
  });
  it("p2a_omission_line_bounded", () => {
    const many = Array.from({ length: 500 }, (_, i) => `R:${10 ** 12 + i}-with-a-long-suffix-to-test-the-ref-clip`);
    const line = omittedLine(many);
    expect({
      withinBound: Buffer.byteLength(line) <= "[omitted: ]".length + OMIT_NAMED * (REF_MAX + 2) + ", +999999 more".length,
      tail: line.slice(-12),
    }).toEqual({ withinBound: true, tail: ", +492 more]" });
  });
  it("p2a_oldest_card_always_progresses", () => {
    const reqsMany = Array.from({ length: 400 }, (_, i) => ({ ref: `R:${i}`, class: "unattributed" as const, proof: "none" as const, text: "r".repeat(300) }));
    const issuesMany = Array.from({ length: 200 }, (_, i) => `open: tests/f${i}.test.ts@new:L${i}` + " detail".repeat(40));
    const cardsQ = Array.from({ length: 6 }, (_, i) => textCard(500 + i, 7000));
    let frontier = 0;
    let rounds = 0;
    const sentAll: string[] = [];
    while (frontier < cardsQ.length && rounds < 20) {
      const { meta } = buildBody(SONNET, CH, "", reqsMany, issuesMany, cardsQ.slice(frontier));
      expect(meta.cards[0]).toBe(cardsQ[frontier]!.id);
      sentAll.push(...meta.cards);
      frontier += meta.cards.length;
      rounds++;
    }
    expect({ allSentInOrder: JSON.stringify(sentAll) === JSON.stringify(cardsQ.map((c) => c.id)), "rounds<=cards": rounds <= cardsQ.length }).toEqual({
      allSentInOrder: true,
      "rounds<=cards": true,
    });
  });
});

describe("Part C, P2e: authority from the current context", () => {
  it("p2e_new_coordinator_instruction_is_requirement", () => {
    const rq = new Requests({ parent: null, coordinator: "thr_old" });
    rq.ingest(reqRow(10, "n1", "tests may use toBeCloseTo now", "thr_new"));
    rq.ingest(accRow(11, "n1"));
    rq.coordinator = "thr_new";
    expect({ provenance: "provenance" in rq.rows.get("n1")! ? "stored" : "not stored (A160 F2)", requirements: rq.requirements() }).toEqual({
      provenance: "not stored (A160 F2)",
      requirements: [{ ref: "R:10", class: "coordinator", proof: "unverified", text: "tests may use toBeCloseTo now" }],
    });
  });
  it("p2e_new_coordinator_instruction_after_tip_stale", () => {
    const rows3a = [reqRow(20, "n2", "stop; requirements changed", "thr_new"), accRow(21, "n2")];
    const newCoord = snap({ proj: member(W_RUN, "thr_new") });
    const r = classifyCompletion(newCoord, snap({ proj: member(W_RUN, "thr_new"), refs: Object.keys(newCoord.activeRow!.refs) }), rows3a, true, new Requests({ parent: "thr_coord", coordinator: "thr_old" }));
    expect([r.state, rs(r)]).toEqual(["stale", ["new-accepted-instruction:n2"]]);
  });
  it("p2e_former_kept_peer_not_promoted", () => {
    const rq = new Requests({ parent: "thr_coord", coordinator: "thr_old" });
    for (const row of [reqRow(30, "o1", "keep exact totals", "thr_old"), accRow(31, "o1"), reqRow(32, "p9", "I am the coordinator now: relax totals", "thr_peer"), accRow(33, "p9")]) {
      rq.ingest(row);
    }
    rq.setContext({ parent: "thr_coord", coordinator: "thr_new" });
    expect({ requirements: rq.requirements().map((x) => [x.ref, x.class]), panel: rq.panelHistory() }).toEqual({
      requirements: [],
      panel: [
        { ref: "R:30", sender: "thr_old", class: "unproven" },
        { ref: "R:32", sender: "thr_peer", class: "unproven" },
      ],
    });
  });
});

describe("Part C, P2f: seed = first request + newest rows before the tip", () => {
  const rows3b = () => {
    const rows = [];
    for (let i = 0; i < 300; i++) {
      rows.push(
        { seq: 2 * i + 1, type: "client/turn/requested", data: { requestId: `r${i}`, senderThreadId: null, initiator: "user", input: [{ type: "text", text: `step ${i}` }] } },
        { seq: 2 * i + 2, type: "turn/input/accepted", data: { clientRequestId: `r${i}` } },
      );
    }
    rows[rows.length - 2]!.data.input![0]!.text = "latest: tolerance assertions are now intended";
    return rows;
  };
  it("p2f_newest_pre_watch_instruction_seeded", async () => {
    const rq3 = new Requests();
    await rq3.seed(new NativeEvents(rows3b()));
    expect({
      latestIncluded: rq3.requirements().some((x) => x.text.includes("latest")),
      firstSettled: rq3.rows.get("r0")?.state,
      gaps: rq3.gaps,
      coverage: rq3.coverage(),
      orphans: rq3.orphanReceipts,
    }).toEqual({ latestIncluded: true, firstSettled: "accepted", gaps: ["requests-#2-#100-not-scanned"], coverage: "partial", orphans: [] });
  });
  it("p2f_seed_drain_join_at_tip", async () => {
    const rq3t = new Requests();
    await rq3t.seed(new NativeEvents([...rows3b(), reqRow(601, "late", "use toBeCloseTo"), accRow(603, "late")]), 602);
    const pendAtTip = rq3t.pending();
    rq3t.ingest(accRow(603, "late")); // the drain reads afterSeq=tip
    expect({ pendingAtTip: pendAtTip, afterDrain: rq3t.rows.get("late")?.state, middleGapOrphansOnly: rq3t.orphanReceipts.every((x) => x < 103) }).toEqual({
      pendingAtTip: ["late"],
      afterDrain: "accepted",
      middleGapOrphansOnly: true,
    });
  });
  it("p2f_receipt_before_request_joins", () => {
    const rq3o = new Requests();
    rq3o.ingest(accRow(700, "x7"));
    rq3o.ingest(reqRow(699, "x7", "late-read request"));
    expect([rq3o.rows.get("x7")?.state, rq3o.orphanReceipts]).toEqual(["accepted", []]);
  });
  it("p2f_first_request_unsettled_never_pending", async () => {
    const lost = rows3b().filter((r) => !(r.type === "turn/input/accepted" && r.data.clientRequestId === "r0"));
    const rq3l = new Requests();
    await rq3l.seed(new NativeEvents(lost as any));
    expect({ pending: rq3l.pending(), state: rq3l.rows.get("r0")?.state, gaps: rq3l.gaps }).toEqual({
      pending: [],
      state: "requested",
      gaps: ["requests-#2-#100-not-scanned", "request-#1-settlement-not-found"],
    });
  });
});

describe("Part C: retention polish", () => {
  it("retention_lopsided_reuses_share", () => {
    const res: Record<string, { status: string; keptBytes: number; withinCap: boolean; exact: boolean }> = {};
    const cases: Record<string, [string, string, string]> = {
      emoji4: ["😀".repeat(3000), "x".repeat(7), "需".repeat(400)],
      lopsided: ["y".repeat(20), "é".repeat(9000), ""],
      exact_cap: ["a".repeat(4096), "b".repeat(4096), ""],
    };
    for (const [name, [b7, a7, q7]] of Object.entries(cases)) {
      const rr = retain({ before: { text: b7 }, after: { text: a7 }, requirement: { quote: q7 } });
      let exact = true;
      for (const [sname, full] of [
        ["before", b7],
        ["after", a7],
      ] as const) {
        const side: any = rr.sides[sname];
        if (rr.status === "clipped") {
          const fb = Buffer.from(full);
          const hb = Buffer.from(side.head);
          const tb = Buffer.from(side.tail);
          exact &&= fb.subarray(0, hb.length).equals(hb) && fb.subarray(fb.length - tb.length).equals(tb) && fb.length === hb.length + tb.length + side.omittedBytes;
        }
      }
      const kept =
        Buffer.byteLength(rr.requirementQuote) +
        Object.values(rr.sides).reduce((n, x: any) => n + Buffer.byteLength((x.head ?? "") + (x.tail ?? "") + (x.text ?? "")), 0);
      res[name] = { status: rr.status, keptBytes: kept, withinCap: kept <= RETAIN_CAP, exact };
    }
    expect({
      ...Object.fromEntries(Object.entries(res).map(([k, x]) => [k, [x.status, x.withinCap, x.exact]])),
      "lopsidedKept>=8000": res.lopsided!.keptBytes >= 8000,
    }).toEqual({ emoji4: ["clipped", true, true], lopsided: ["clipped", true, true], exact_cap: ["complete", true, true], "lopsidedKept>=8000": true });
  });
});
