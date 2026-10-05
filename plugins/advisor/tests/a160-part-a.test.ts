// Part A of the accepted A160 reference suite: the A140 cases on the corrected
// rules, same raw inputs. Each `it` is named after its reference case; the
// lifetime, ledger, pruning and drain cases run against the real store and HTTP
// code in their own files.

import { describe, expect, it } from "vitest";
import { matchesAny, coherence, transition, DEFAULT_TEST_GLOBS } from "../src/rules/checkpoint.js";
import { parseUnified } from "../src/rules/diff.js";
import { Findings } from "../src/rules/findings.js";
import { CARD_ENC_CAP, BODY_CAP, ConfigError, buildBody, editCards, enc, referenceSerializer } from "../src/rules/packet.js";
import { Requests, inclusionOrder } from "../src/rules/requests.js";
import { deriveSubject } from "../src/rules/scope.js";
import { Watch } from "../src/rules/pause.js";
import { maxInWindow, tokenBucket } from "../src/rules/scheduler.js";
import { expandProjects } from "../src/rules/cards.js";
import { reservationUsd } from "../src/config/prices.js";
import { validate, type HunkFinding } from "../src/rules/validate.js";
import { ok as readOk } from "../src/rules/snapshot.js";
import { ROOT, accRow, fixture, makePatch, rejRow, reqRow } from "./helpers/a160.js";
import { W_RUN, fresh, textCard, work } from "./helpers/contract.js";
import type { EventRow } from "../src/rules/events.js";

const LUNA = referenceSerializer("gpt-6-luna");
const SONNET = referenceSerializer("claude-sonnet-5-5");
const v = (f: HunkFinding, ev: Record<string, ReturnType<typeof parseUnified>>, reqs: Record<string, string> = {}) =>
  validate(f, ev, reqs, ROOT);

const ONE_LINE =
  "import { total, date, round } from '../src';\n" +
  "const l = ledger();\n" +
  "it('computes totals with refunds', () => expect(total(l)).toBe(42));\n" +
  "it('formats dates', () => expect(date()).toBe(99));\n" +
  "it('rounds cents', () => expect(round(1.005)).toBe(1.01));\n";
const PATH = "tests/totals.test.ts";
const REQS = { "R:1": "Keep refund coverage: totals must equal the ledger sum including refunds." };
const weak = ONE_LINE.replace("expect(total(l)).toBe(42)", "expect(total(l)).toBeGreaterThan(0)");
const dWeak = makePatch(PATH, ONE_LINE, weak);
export const good: HunkFinding = {
  category: "test-integrity",
  evidence: "E:200:0",
  hunk: 0,
  subject: "computes totals with refunds",
  before: { lines: [3, 3], quote: "it('computes totals with refunds', () => expect(total(l)).toBe(42));" },
  after: { lines: [3, 3], quote: "it('computes totals with refunds', () => expect(total(l)).toBeGreaterThan(0));" },
  requirement: { ref: "R:1", quote: "totals must equal the ledger sum including refunds" },
};
const ev = { "E:200:0": parseUnified(PATH, dWeak) };
const dOther = makePatch(PATH, ONE_LINE, ONE_LINE.replace("expect(date()).toBe(99)", "expect(date()).toBeGreaterThan(0)"));
const ev2 = { "E:201:0": parseUnified(PATH, dOther) };

describe("Part A: citation binding", () => {
  it("suspicious_weakening_valid", () => {
    const r = v(good, ev, REQS);
    expect([r.ok, r.reason, r.shown?.subject, r.shown?.subjectStatus]).toEqual([true, "ok", "computes totals with refunds", "verified"]);
  });
  it("wrong_subject_rejected", () => {
    const wrong = {
      ...good,
      evidence: "E:201:0",
      before: { lines: [4, 4] as [number, number], quote: "it('formats dates', () => expect(date()).toBe(99));" },
      after: { lines: [4, 4] as [number, number], quote: "it('formats dates', () => expect(date()).toBeGreaterThan(0));" },
    };
    const r = v(wrong, ev2, REQS);
    expect([r.ok, r.reason]).toEqual([false, "subject-mismatch"]);
  });
  it("unchanged_line_rejected", () => {
    const r = v({ ...good, evidence: "E:201:0", after: null, before: { lines: [3, 3], quote: good.before!.quote } }, ev2, REQS);
    expect([r.ok, r.reason]).toEqual([false, "no-changed-line-cited"]);
  });
  it("repeated_assertion_accepted", () => {
    const repBase = ONE_LINE.replace("expect(date()).toBe(99)", "expect(date()).toBe(42)");
    const repNew = repBase.replace("expect(total(l)).toBe(42)", "expect(total(l)).toBeGreaterThan(0)");
    const r = v(good, { "E:200:0": parseUnified(PATH, makePatch(PATH, repBase, repNew)) }, REQS);
    expect([r.ok, r.reason]).toEqual([true, "ok"]);
  });
  it("misquote_rejected", () => {
    const r = v({ ...good, before: { lines: [3, 3], quote: "expect(total(l)).toBe(4200)" } }, ev, REQS);
    expect([r.ok, r.reason]).toEqual([false, "before-quote-mismatch"]);
  });
  it("invented_requirement_rejected", () => {
    const r = v({ ...good, requirement: { ref: "R:1", quote: "approximate totals are fine" } }, ev, REQS);
    expect([r.ok, r.reason]).toEqual([false, "requirement-quote-not-in-packet"]);
  });
  it("a124_citation_valid_but_label_legitimate", () => {
    const a124 = fixture("a124-9289-filechange.json");
    const ch = a124.item.changes[0];
    const h124 = parseUnified(ch.path, ch.diff);
    const removed = h124.flatMap((h) => h.lines).filter((l) => l.kind === "-" && l.text.includes("expect(")).length;
    const added = h124.flatMap((h) => h.lines).filter((l) => l.kind === "+" && l.text.includes("expect(")).length;
    const claim: HunkFinding = {
      category: "test-integrity",
      evidence: "E:9289:0",
      hunk: 0,
      before: { lines: [94, 94], quote: h124[0]!.lines[1]!.text },
      after: { lines: [94, 94], quote: h124[0]!.lines[2]!.text },
    };
    const r = v(claim, { "E:9289:0": h124 });
    expect({
      hunks: h124.length,
      changedExpectLinesRemoved: removed,
      expectLinesAdded: added,
      citationValid: r.ok,
      subject: r.shown?.subject,
      subjectStatus: r.shown?.subjectStatus,
      evaluationLabel: "legitimate-update",
    }).toEqual({
      hunks: 4,
      changedExpectLinesRemoved: 2,
      expectLinesAdded: 5,
      citationValid: true,
      subject: "plugins/projects/tests/t66-contracts.test.ts:L94",
      subjectStatus: "ambiguous",
      evaluationLabel: "legitimate-update",
    });
  });
});

describe("Part A: checkpoints", () => {
  const MULTI = [..."ABCDEFGH"].map((n) => `it('${n}', () => {\n  const v = ${n.toLowerCase()}();\n  expect(v).toBe(42);\n});\n`).join("");
  const prevA = MULTI.replace("it('A', () => {\n  const v = a();\n  expect(v).toBe(42)", "it('A', () => {\n  const v = a();\n  expect(v).toBeGreaterThan(0)");
  const curH = MULTI.replace("it('H', () => {\n  const v = h();\n  expect(v).toBe(42)", "it('H', () => {\n  const v = h();\n  expect(v).toBeGreaterThan(0)");
  const pPrev = makePatch(PATH, MULTI, prevA);
  const pCur = makePatch(PATH, MULTI, curH);

  it("subject_swap_visible", () => {
    const t = transition(parseUnified(PATH, pPrev), parseUnified(PATH, pCur), coherence("H1", "H1", "H1"));
    if (t.kind !== "transition") throw new Error("expected a transition");
    const removedSubj = t.removed.map((h) => {
      const s = deriveSubject(h, "old", h.lines.find((l) => l.kind === "-")!.old!);
      return s.status === "proven" ? s.name : null;
    });
    const addedSubj = t.added.map((h) => {
      const s = deriveSubject(h, "new", h.lines.find((l) => l.kind === "+")!.new!);
      return s.status === "proven" ? s.name : null;
    });
    expect({ label: t.label, removedHunkSubjects: removedSubj, addedHunkSubjects: addedSubj }).toEqual({
      label: "head-stable",
      removedHunkSubjects: ["A"],
      addedHunkSubjects: ["H"],
    });
  });
  it("shell_edit_checkpoint_card", () => {
    const t = transition([], parseUnified(PATH, pCur), coherence("H1", "H1", "H1"));
    expect({ added: t.added?.length, observedEdits: 0, writer: "unknown" }).toEqual({ added: 1, observedEdits: 0, writer: "unknown" });
  });
  it("commit_during_read", () => {
    expect(coherence("H1", "H2", "H1")).toBe("head-moved-during-read");
  });
  it("commit_not_restoration", () => {
    const t = transition(parseUnified(PATH, pPrev), [], coherence("H2", "H2", "H1"));
    expect({ label: t.label, removed: t.removed }).toEqual({ label: "base-changed", removed: null });
  });
  it("status_unavailable", () => {
    expect(coherence(null, "H1", "H1")).toBe("unknown-head");
  });
  it("unrelated_file_scope", () => {
    const listing = ["src/util.ts", PATH, "README.md"];
    const inScope = listing.filter((p) => matchesAny(p, DEFAULT_TEST_GLOBS));
    expect({ patchRead: inScope, coverageOnly: listing.filter((p) => !inScope.includes(p)).sort() }).toEqual({
      patchRead: [PATH],
      coverageOnly: ["README.md", "src/util.ts"],
    });
  });
});

describe("Part A: recurrence", () => {
  const f300 = { ...good, evidence: "E:300:0" };
  const f320 = { ...good, evidence: "E:320:0" };
  const evr = { "E:300:0": parseUnified(PATH, dWeak), "E:320:0": parseUnified(PATH, dWeak) };
  const s300 = v(f300, evr, REQS).shown!;
  const s320 = v(f320, evr, REQS).shown!;

  it("identical_regression_new_occurrence", () => {
    const F = new Findings();
    const o1 = F.add("w1", "test-integrity", s300, f300, "rv1");
    F.setState("w1", "test-integrity", s300.locator, "model-reported-resolved");
    const o1b = F.add("w1", "test-integrity", s300, f300, "rv3");
    const o3 = F.add("w1", "test-integrity", s320, f320, "rv3");
    expect({
      sameLocator: s300.locator === s320.locator,
      distinctOccurrences: o1 !== o3,
      oldReRaiseDeduped: o1 === o1b,
      notifications: F.notifications.map((n) => n.reason),
    }).toEqual({ sameLocator: true, distinctOccurrences: true, oldReRaiseDeduped: true, notifications: ["new", "recurred-after-model-reported-resolved"] });
  });
  it("passing_weakened_test_stays_open", () => {
    const F2 = new Findings();
    F2.add("w1", "test-integrity", s300, f300, "rv1");
    // A passing run (`npm test`, exit 0) after the weakening is ordinary evidence; nothing closes the issue.
    expect(F2.state("w1", "test-integrity", s300.locator)).toBe("open");
  });
  it("dismissed_then_recurred_notifies", () => {
    const F2 = new Findings();
    F2.add("w1", "test-integrity", s300, f300, "rv1");
    F2.setState("w1", "test-integrity", s300.locator, "dismissed-unverified");
    F2.add("w1", "test-integrity", s320, f320, "rv4");
    expect(F2.notifications.at(-1)!.reason).toBe("recurred-after-dismissed-unverified");
  });
});

describe("Part A: requirements", () => {
  const rows = [
    reqRow(1, "r0", REQS["R:1"]),
    accRow(2, "r0"),
    reqRow(3, "r1", "skip the slow refund tests", "thr_peer"),
    accRow(4, "r1"),
    reqRow(5, "r2", "drop refund coverage"),
    rejRow(6, "r2"),
    reqRow(50, "r3", "Also cover partial refunds.", "thr_coord"),
    accRow(51, "r3"),
  ];
  const seeded = async (rs: EventRow[]) => {
    const { NativeEvents } = await import("./helpers/a160.js");
    const q = new Requests({ coordinator: "thr_coord" });
    await q.seed(new NativeEvents(rs));
    return q;
  };

  it("pre_watch_requirement_seeded", async () => {
    const RQ = await seeded(rows);
    const RA = await seeded(rows.filter((r) => r.seq > 40));
    expect({
      refs: RQ.requirements().map((x) => x.ref),
      anchorOnlyRefs: RA.requirements().map((x) => x.ref),
      coverage: RQ.coverage(),
    }).toEqual({ refs: ["R:1", "R:50"], anchorOnlyRefs: ["R:50"], coverage: "complete" });
  });
  it("pending_request_blocks", async () => {
    const RP = await seeded([...rows, reqRow(60, "r4", "rename totals")]);
    expect(RP.pending()).toEqual(["r4"]);
  });
  it("partial_requirements_disable_missed_requirement", async () => {
    const RQ = await seeded(rows);
    const CHARTER = "charter ".repeat(600);
    const card1 = { id: "E:1:0#0", text: "x", encBytes: 1 };
    const reqsIn = inclusionOrder([], RQ.requirements());
    let tight = null;
    for (let c = 8000; c < 60000; c += 4) {
      try {
        const { meta } = buildBody(LUNA, CHARTER, "", reqsIn, [], [card1], c);
        if ("R:1" in meta.packetRequirements && !meta.partialRequirements.includes("R:1")) {
          tight = meta;
          break;
        }
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
      }
    }
    expect({ coverage: tight?.coverage, omitted: tight?.omittedRequirements, categories: tight?.categories }).toEqual({
      coverage: "partial",
      omitted: ["R:50"],
      categories: ["test-integrity", "unsupported-claim"],
    });
  });
  it("projects_truncation_expanded", () => {
    const worker = { assignments: [{ ref: "A7", tasks: ["T1", "T2", "T3", "T4", "T5"], tasksTruncated: true }], assignmentsTruncated: false };
    const rowsA = { A7: { tasks: Array.from({ length: 20 }, (_, i) => `T${i + 1}`), truncatedFields: ["tasks"] } };
    expect(expandProjects(worker, rowsA).gaps).toEqual(["A7-tasks-trimmed"]);
  });
});

const reasons = (c: ReturnType<typeof fresh>) => ("reasons" in c ? c.reasons : undefined);

describe("Part A: freshness at completion", () => {
  it("fresh_after_ordinary_work", () => {
    expect(fresh(work).state).toBe("current-as-of-tip");
  });
  it("stale_after_accepted_instruction", () => {
    expect(reasons(fresh([...work, reqRow(71, "r9", "stop editing tests"), accRow(72, "r9")]))).toEqual(["new-accepted-instruction:r9"]);
  });
  it("unknown_while_instruction_pending", () => {
    expect(fresh([reqRow(71, "r9", "x")]).state).toBe("unknown");
  });
  it("unknown_when_drain_behind", () => {
    expect(reasons(fresh(work, { drained: false }))).toEqual(["drain-behind"]);
  });
  it("stale_after_stop", () => {
    expect(reasons(fresh([{ seq: 73, type: "system/thread/interrupted", data: {} }]))).toEqual(["stopped"]);
  });
  it("stale_after_membership_loss", () => {
    expect(reasons(fresh(work, { proj: readOk({ coordinatorThreadId: "thr_coord", worker: W_RUN, former: true }) }))).toEqual(["membership-changed"]);
  });
  it("peer_message_not_authoritative", () => {
    expect(fresh([reqRow(74, "r10", "relax that test", "thr_peer"), accRow(75, "r10")]).state).toBe("current-as-of-tip");
  });
  it("stop_latch_then_resume", () => {
    const w = new Watch();
    w.observe({ type: "turn/completed", data: { status: "interrupted" } });
    w.observe({ type: "item/completed", data: {} });
    const seqs = [w.mayDispatch()];
    w.observe(accRow(80, "r11"));
    seqs.push(w.mayDispatch());
    expect(seqs).toEqual([false, true]);
  });
});

describe("Part A: packet builder", () => {
  const CHARTER = "charter ".repeat(600);
  it("fifo_no_starvation", () => {
    let cards = [textCard(1)];
    let frontier = 0;
    const packets: string[][] = [];
    for (let p = 0; p < 8; p++) {
      cards = [...cards, ...Array.from({ length: 8 }, (_, i) => textCard(100 + p * 8 + i))];
      const { meta } = buildBody(LUNA, CHARTER, "", [], [], cards.slice(frontier), 24 * 1024);
      packets.push(meta.cards);
      frontier += meta.cards.length;
    }
    expect(packets[0]![0]).toBe("C:1");
  });
  it("failure_keeps_frontier", () => {
    const cards = [textCard(1), ...Array.from({ length: 8 }, (_, i) => textCard(100 + i))];
    const { meta } = buildBody(LUNA, CHARTER, "", [], [], cards, 24 * 1024);
    // A failed review leaves the frontier at 0, so the next packet starts at the same oldest card.
    expect([0, meta.cards[0]]).toEqual([0, "C:1"]);
  });
  it("oversized_edit_split_in_order", () => {
    const SPREAD = Array.from({ length: 60 }, (_, i) => `it('t${i}', () => {\n` + "  pad();\n".repeat(8) + `  expect(v${i}).toBe(42);\n});\n`).join("");
    const big = makePatch(PATH, SPREAD, SPREAD.replaceAll("toBe(42)", "toBeTruthy()"));
    const parts = editCards(400, 0, PATH, big);
    const hugeHunk = "@@ -1,1 +1,1 @@\n-" + "x".repeat(9000) + "\n+" + "y".repeat(9000);
    expect({
      parts: parts.length > 1,
      ordered: JSON.stringify(parts.map((c) => c.part)) === JSON.stringify(parts.map((_, i) => i)),
      allWithinCap: parts.every((c) => c.encBytes <= CARD_ENC_CAP),
      singleHugeHunk: editCards(401, 0, PATH, hugeHunk)[0]!.inclusion,
    }).toEqual({ parts: true, ordered: true, allWithinCap: true, singleHugeHunk: "truncated" });
  });
  it("first_card_always_progresses", () => {
    const maxCard = { id: "X", text: "z".repeat(CARD_ENC_CAP), encBytes: CARD_ENC_CAP };
    const { meta } = buildBody(LUNA, CHARTER, "", [{ ref: "R:1", class: "unattributed", proof: "none", text: "q".repeat(60000) }], [], [maxCard]);
    expect([meta.cards, meta.bodyBytes <= BODY_CAP]).toEqual([["X"], true]);
  });
  it("scheduler_bound", () => {
    const sched = {
      continuous_8h: tokenBucket(() => true, 480),
      burst_then_idle: tokenBucket((t) => t < 30 || (150 <= t && t < 180), 480),
      turn_end_every_7min: tokenBucket((t) => t % 7 === 0, 480),
    };
    const boundOk = Object.fromEntries(
      Object.entries(sched).map(([k, x]) => [k, [10, 60, 120, 332, 480].every((T) => maxInWindow(x, T) <= Math.trunc(2 + T / 10))]),
    );
    const rolling: number[] = [];
    let last = -99;
    for (let tt = 0; tt < 333; tt++) {
      if (tt - last >= 3 && rolling.filter((x) => tt - x < 60).length < 6) {
        rolling.push(tt);
        last = tt;
      }
    }
    expect({
      counts: Object.fromEntries(Object.entries(sched).map(([k, x]) => [k, x.length])),
      boundHolds: boundOk,
      a137RollingIn332min: rolling.length,
      bucketIn332min: maxInWindow(sched.continuous_8h, 332),
    }).toEqual({
      counts: { continuous_8h: 49, burst_then_idle: 8, turn_end_every_7min: 49 },
      boundHolds: { continuous_8h: true, burst_then_idle: true, turn_end_every_7min: true },
      a137RollingIn332min: 36,
      bucketIn332min: 35,
    });
  });
  for (const [model, ser] of [
    ["gpt-6-luna", LUNA],
    ["claude-sonnet-5-5", SONNET],
  ] as const) {
    it(`body_fit_${model}`, () => {
      const quoteHeavy = Array.from({ length: 40 }, (_, i) => {
        const tq = '"'.repeat(2048) + "\n".repeat(512);
        return { id: `Q:${i}`, text: tq, encBytes: enc(tq) };
      });
      const { body, meta } = buildBody(ser, CHARTER, "", [], [], quoteHeavy);
      expect({ underCap: Buffer.byteLength(body) <= BODY_CAP, firstCard: meta.cards[0], measured: meta.bodyBytes === Buffer.byteLength(body) }).toEqual({
        underCap: true,
        firstCard: "Q:0",
        measured: true,
      });
    });
  }
  it("reservation_formula_spot", () => {
    expect(Math.round(reservationUsd("claude-sonnet-5-5", BODY_CAP, 2000) * 1e5) / 1e5).toBe(0.1864);
  });
});
