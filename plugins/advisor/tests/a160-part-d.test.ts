// Part D of the accepted A160 reference suite: the A157 corrections F1–F4.

import { afterAll, describe, expect, it } from "vitest";
import { parseUnified } from "../src/rules/diff.js";
import { EVENT_PAGE_MAX, OWNER_PAGES, SEED_PAGES, SWEEP_PAGES, readPages, type EventQuery, type EventRow } from "../src/rules/events.js";
import { buildBody, referenceSerializer } from "../src/rules/packet.js";
import { CURRENT, Requests, inclusionOrder } from "../src/rules/requests.js";
import { classifyCompletion } from "../src/rules/snapshot.js";
import { validate, type HunkFinding } from "../src/rules/validate.js";
import { drainPass } from "../src/runtime/drain.js";
import { ROOT, NativeEvents, accRow, fixture, opRow, ownRow, reqRow } from "./helpers/a160.js";
import { A_RUN, W_RUN, member, snap } from "./helpers/contract.js";

const SONNET = referenceSerializer("claude-sonnet-5-5");
const NATIVE = fixture("native_query.json");
const SOURCES: NativeEvents[] = [];
const issued = (src: NativeEvents) => (SOURCES.push(src), src);
const reqsOf = (rq: Requests) => rq.requirements().map((x) => [x.ref, x.class, x.proof]);
const card1 = { id: "E:1:0#0", text: "x", encBytes: 1 };

const hist1200: EventRow[] = [];
for (let i = 0; i < 600; i++) hist1200.push(reqRow(2 * i + 1, `q${i}`, `step ${i}`), accRow(2 * i + 2, `q${i}`));

describe("Part D, F1: the installed event-read contract", () => {
  it("d1_fake_matches_installed_schema", async () => {
    const verdicts: Record<string, number> = {};
    for (const [name, q] of Object.entries<any>(NATIVE.cases)) {
      const { threadId: _t, ...args } = q;
      try {
        new NativeEvents([]).listSync(args);
        verdicts[name] = 200;
      } catch (e: any) {
        verdicts[name] = e.status;
      }
    }
    expect({ pageMax: EVENT_PAGE_MAX, verdicts, cursorsStrict: NATIVE.cursorStrictness, bareArray: NATIVE.responseIsBareArray }).toEqual({
      pageMax: NATIVE.pageSize,
      verdicts: Object.fromEntries(Object.entries<any>(NATIVE.admitted).map(([k, x]) => [k, x.status])),
      cursorsStrict: { afterSeq: true, beforeSeq: true },
      bareArray: true,
    });
  });
  it("d1_seed_pages_at_most_100", async () => {
    const src = issued(new NativeEvents(hist1200));
    const rq = new Requests();
    await rq.seed(src, 1200);
    const desc = src.log.filter((q) => q.order === "desc" && JSON.stringify(q.types) === JSON.stringify(["client/turn/requested", "turn/input/accepted", "client/turn/rejected"]));
    expect({
      maxLimit: Math.max(...src.log.map((q) => Number(q.limit))),
      reads: src.log.length,
      newestPages: desc.map((q) => q.beforeSeq),
      requirements: rq.requirements().length,
      gaps: rq.gaps,
      first: rq.rows.get("q0")?.state,
      latest: rq.rows.get("q599")?.state,
    }).toEqual({
      maxLimit: 100,
      reads: 1 + 1 + SEED_PAGES + 1,
      newestPages: ["1201", "1101", "1001", "901", "801"],
      requirements: 251,
      gaps: ["requests-#2-#700-not-scanned"],
      first: "accepted",
      latest: "accepted",
    });
  });
  it("d1_receipt_sweep_pages_strict_cursor", async () => {
    const hist = [
      reqRow(1, "first", "keep exact totals"),
      ...Array.from({ length: 250 }, (_, i) => accRow(2 + i, `other${i}`)),
      accRow(260, "first"),
      ...Array.from({ length: 300 }, (_, i) => [reqRow(1000 + 2 * i, `n${i}`, `n ${i}`), accRow(1001 + 2 * i, `n${i}`)]).flat(),
    ];
    const src = issued(new NativeEvents(hist));
    const rq = new Requests();
    await rq.seed(src);
    const sweep = src.log.filter((q) => JSON.stringify(q.types) === JSON.stringify(["turn/input/accepted", "client/turn/rejected"]));
    expect({ first: rq.rows.get("first")?.state, sweepAfterSeq: sweep.map((q) => q.afterSeq), gaps: rq.gaps }).toEqual({
      first: "accepted",
      sweepAfterSeq: ["1", "101", "201"],
      gaps: ["requests-#2-#1099-not-scanned"],
    });
  });
  it("d1_receipt_sweep_page_cap_named", async () => {
    const hist = [
      reqRow(1, "first", "keep exact totals"),
      ...Array.from({ length: 1500 }, (_, i) => accRow(2 + i, `other${i}`)),
      accRow(1600, "first"),
      ...Array.from({ length: 300 }, (_, i) => [reqRow(2000 + 2 * i, `n${i}`, `n ${i}`), accRow(2001 + 2 * i, `n${i}`)]).flat(),
    ];
    const src = issued(new NativeEvents(hist));
    const rq = new Requests();
    await rq.seed(src);
    expect({
      pending: rq.pending(),
      state: rq.rows.get("first")?.state,
      gaps: rq.gaps,
      coverage: rq.coverage(),
      sweepReads: src.log.filter((q) => JSON.stringify(q.types) === JSON.stringify(["turn/input/accepted", "client/turn/rejected"])).length,
    }).toEqual({
      pending: [],
      state: "requested",
      gaps: ["requests-#2-#2099-not-scanned", "request-#1-settlement-not-found", "receipt-sweep-page-cap@1001"],
      coverage: "partial",
      sweepReads: SWEEP_PAGES,
    });
  });
  it("d1_empty_history", async () => {
    const src = issued(new NativeEvents([]));
    const rq = new Requests();
    await rq.seed(src);
    expect({ gaps: rq.gaps, notes: rq.notes, coverage: rq.coverage(), reads: src.log.length }).toEqual({ gaps: [], notes: [], coverage: "complete", reads: 3 });
  });
  const samePage = (args: EventQuery) => {
    const { afterSeq: _a, beforeSeq: _b, ...rest } = args;
    return new NativeEvents(hist1200).listSync(rest); // ignores the cursor: the first page again, forever
  };
  const overlap = (args: EventQuery, page: EventRow[]) =>
    args.beforeSeq !== undefined && Number(args.beforeSeq) < 1201 && page.length > 0
      ? [{ ...page[0]!, seq: Number(args.beforeSeq) }, ...page.slice(0, -1)] // re-sends the cursor row
      : page;
  for (const [name, bad] of [
    ["non_progress", samePage],
    ["duplicate_cursor_row", overlap],
  ] as const) {
    it(`d1_${name}_server_named_gap`, async () => {
      const src = issued(new NativeEvents(hist1200, bad));
      const rq = new Requests();
      await rq.seed(src, 1200);
      expect({
        "reads<=bound": src.log.length <= OWNER_PAGES + 1 + SEED_PAGES + SWEEP_PAGES,
        violation: rq.gaps.filter((g) => g.includes("contract-violation")),
        coverage: rq.coverage(),
      }).toEqual({ "reads<=bound": true, violation: ["seed-newest-contract-violation-non-progress@1101"], coverage: "partial" });
    });
  }
  it("d1_byte_bound_named", async () => {
    const big = [...Array.from({ length: 300 }, (_, i) => reqRow(2 * i + 1, `b${i}`, "x".repeat(30000))), ...Array.from({ length: 300 }, (_, i) => accRow(2 * i + 2, `b${i}`))];
    const src = issued(new NativeEvents(big));
    const rq = new Requests();
    await rq.seed(src);
    expect({
      gaps: rq.gaps.filter((g) => g.includes("byte-cap") || g.includes("not-scanned")),
      accepted: [...rq.rows.values()].filter((r) => r.state === "accepted").length,
    }).toEqual({ gaps: ["seed-newest-byte-cap@401", "requests-#2-#400-not-scanned"], accepted: 101 });
  });
  it("d1_413_halves_then_names_gap", async () => {
    const src = issued(new NativeEvents(hist1200.slice(0, 200), undefined, 6000));
    const r = await readPages(src, { types: ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"] }, "asc", null, 40, 2 ** 30);
    const oneBig = issued(new NativeEvents([reqRow(1, "huge", "z".repeat(9000))], undefined, 6000));
    const big = await readPages(oneBig, {}, "asc", null, 10, 2 ** 30);
    expect({
      limits: [...new Set(src.log.map((q) => q.limit!))].sort((a, b) => Number(a) - Number(b)),
      rows: r.rows.length,
      status: r.status,
      singleRowTooLarge: big.status,
    }).toEqual({ limits: ["25", "50", "100"], rows: 200, status: "complete", singleRowTooLarge: "read-failed-413@None" });
  });
  it("d1_drain_non_progress_stops", async () => {
    const dsrc = issued(new NativeEvents(hist1200, (_a, p) => (p.length > 0 ? [p[0]!, p[0]!] : p)));
    const stored = new Map<number, EventRow>();
    const info = await drainPass(dsrc, 0, async (page) => {
      for (const e of page) if (!stored.has(e.seq)) stored.set(e.seq, e);
    });
    expect({ gap: info.gap, atTip: info.atTip, stored: stored.size }).toEqual({ gap: "contract-violation-non-progress@0", atTip: false, stored: 0 });
  });
});

// ---- F2: provenance from recorded history and the current context only.
const H = [reqRow(30, "o1", "keep exact totals", "thr_old"), accRow(31, "o1"), ownRow(35, "thr_old", "thr_new"), reqRow(40, "n1", "tests may use toBeCloseTo now", "thr_new"), accRow(41, "n1")];
const NEW = { parent: "thr_new", coordinator: "thr_new" };
const LATE = [reqRow(50, "late", "ignore the toBeCloseTo change; keep exact", "thr_old"), accRow(51, "late")];
const P = H.filter((x) => x.type !== "system/operation");
const BOTH = [
  ["R:30", "former-parent", "native-parent-at-acceptance"],
  ["R:40", "coordinator", "native-parent-at-acceptance"],
];

async function topologyA() {
  const a = new Requests({ parent: "thr_old", coordinator: "thr_old" });
  for (const r of H.slice(0, 2)) a.ingest(r);
  a.drainBatch(NEW, H.slice(2), true);
  return a;
}
async function topologyA7() {
  const a7 = new Requests({ parent: "thr_coord", coordinator: "thr_old" });
  for (const r of P.slice(0, 2)) a7.ingest(r);
  a7.drainBatch({ parent: "thr_coord", coordinator: "thr_new" }, P.slice(2), true);
  return a7;
}

describe("Part D, F2: authority at use, from recorded history and the current context", () => {
  it("d2_A_equals_B_projects_topology", async () => {
    const a = await topologyA();
    const b = new Requests(NEW);
    await b.seed(issued(new NativeEvents(H)), 41);
    const b2 = new Requests({ parent: "thr_old", coordinator: "thr_old" });
    await b2.seed(issued(new NativeEvents(H)), 31);
    b2.drainBatch(NEW, H.slice(2), true);
    expect({ A: reqsOf(a), B: reqsOf(b), B2: reqsOf(b2) }).toEqual({ A: BOTH, B: BOTH, B2: BOTH });
  });
  it("d2_A_equals_B_a157_topology", async () => {
    const a7 = await topologyA7();
    const b7 = new Requests({ parent: "thr_coord", coordinator: "thr_new" });
    await b7.seed(issued(new NativeEvents(P)), 41);
    const panel = [{ ref: "R:30", sender: "thr_old", class: "unproven" }];
    expect({ A: reqsOf(a7), B: reqsOf(b7), panelA: a7.panelHistory(), panelB: b7.panelHistory() }).toEqual({
      A: [["R:40", "coordinator", "unverified"]],
      B: [["R:40", "coordinator", "unverified"]],
      panelA: panel,
      panelB: panel,
    });
  });
  it("d2_C_late_replaced_coordinator_never_requirement", async () => {
    const c = new Requests({ parent: "thr_old", coordinator: "thr_old" });
    for (const r of [...H.slice(0, 2), ...LATE]) c.ingest(r); // the late message is ingested before the context refresh
    c.drainBatch(NEW, H.slice(2), true);
    const cOk = new Requests(NEW);
    await cOk.seed(issued(new NativeEvents([...H, ...LATE].sort((x, y) => x.seq - y.seq))), 51);
    expect({
      reqs: reqsOf(c),
      sameAsSeeded: JSON.stringify(reqsOf(c)) === JSON.stringify(reqsOf(cOk)),
      panel: c.panelHistory(),
      newestCurrent: c.requirements().filter((x) => CURRENT.has(x.class)).at(-1)?.ref,
    }).toEqual({ reqs: BOTH, sameAsSeeded: true, panel: [{ ref: "R:50", sender: "thr_old", class: "unproven" }], newestCurrent: "R:40" });
  });
  it("d2_C_transfer_in_flight_late_message_historic", async () => {
    const HP = [reqRow(30, "o1", "keep exact totals", "thr_old"), accRow(31, "o1"), reqRow(40, "n1", "tests may use toBeCloseTo now", "thr_new"), accRow(41, "n1"), ...LATE];
    const cp = new Requests({ parent: "thr_old", coordinator: "thr_new" });
    await cp.seed(issued(new NativeEvents(HP)), 51);
    const txt = buildBody(SONNET, "charter", "", inclusionOrder([], cp.requirements()), [], [card1]).body;
    expect({
      reqs: reqsOf(cp),
      pending: cp.pending(),
      historicAfterCurrent: -1 < txt.indexOf("[R:40 coordinator") && txt.indexOf("[R:40 coordinator") < txt.indexOf("## Historic"),
      lateInHistoric: -1 < txt.indexOf("## Historic") && txt.indexOf("## Historic") < txt.indexOf("[R:50 former parent, replaced]"),
    }).toEqual({
      reqs: [
        ["R:30", "former-parent", "native-parent-at-acceptance"],
        ["R:40", "coordinator", "unverified"],
        ["R:50", "former-parent", "native-parent-at-acceptance"],
      ],
      pending: [],
      historicAfterCurrent: true,
      lateInHistoric: true,
    });
  });
  it("d2_former_never_stales_current_does", () => {
    const memNew = snap({ proj: member(W_RUN, "thr_new") });
    const refs = Object.keys(memNew.activeRow!.refs);
    const lateAfterTip = classifyCompletion(memNew, snap({ proj: member(W_RUN, "thr_new"), refs }), LATE, true, new Requests({ parent: "thr_coord", coordinator: "thr_new" }));
    const newAfterTip = classifyCompletion(
      memNew,
      snap({ proj: member(W_RUN, "thr_new"), refs }),
      [reqRow(60, "n9", "now also cover VAT", "thr_new"), accRow(61, "n9")],
      true,
      new Requests({ parent: "thr_coord", coordinator: "thr_new" }),
    );
    expect([lateAfterTip.state, newAfterTip.state, "reasons" in newAfterTip ? newAfterTip.reasons : null]).toEqual(["current-as-of-tip", "stale", ["new-accepted-instruction:n9"]]);
  });
  it("d2_D_peer_promoted_later", async () => {
    const HD = [reqRow(10, "p1", "relax totals", "thr_peer"), accRow(11, "p1"), ownRow(20, "thr_old", "thr_peer")];
    const dNow = new Requests({ parent: "thr_peer", coordinator: "thr_peer" });
    await dNow.seed(issued(new NativeEvents(HD)), 20);
    const HD2 = [...HD, ownRow(30, "thr_peer", "thr_new")];
    const dLater = new Requests({ parent: "thr_new", coordinator: "thr_new" });
    await dLater.seed(issued(new NativeEvents(HD2)), 30);
    expect({ whileCoordinator: reqsOf(dNow), afterReplaced: reqsOf(dLater), panel: dLater.panelHistory() }).toEqual({
      whileCoordinator: [["R:10", "coordinator", "unverified"]],
      afterReplaced: [],
      panel: [{ ref: "R:10", sender: "thr_peer", class: "unproven" }],
    });
  });
  it("d2_E_labels_reach_judge", async () => {
    const a = await topologyA();
    const a7 = await topologyA7();
    const { body: txt, meta } = buildBody(SONNET, "charter", "", inclusionOrder([], a.requirements()), [], [card1]);
    const txt7 = buildBody(SONNET, "charter", "", inclusionOrder([], a7.requirements()), [], [card1]).body;
    expect({
      current: txt.includes("[R:40 coordinator] tests may use toBeCloseTo now"),
      historicSection: -1 < txt.indexOf("## Historic requirements") && txt.indexOf("## Historic requirements") < txt.indexOf("[R:30 former parent, replaced] keep exact totals"),
      classes: meta.packetClasses,
      unverifiedLabel: txt7.includes("[R:40 coordinator; authority when accepted unverified]"),
    }).toEqual({ current: true, historicSection: true, classes: { "R:40": "coordinator", "R:30": "former-parent" }, unverifiedLabel: true });
  });
  it("d2_E_historic_requirement_not_missable", async () => {
    const a = await topologyA();
    const { meta } = buildBody(SONNET, "charter", "", inclusionOrder([], a.requirements()), [], [card1]);
    const a124 = fixture("a124-9289-filechange.json").item.changes[0];
    const h124 = parseUnified(a124.path, a124.diff);
    const claim: HunkFinding = {
      category: "test-integrity",
      evidence: "E:9289:0",
      hunk: 0,
      before: { lines: [94, 94], quote: h124[0]!.lines[1]!.text },
      after: { lines: [94, 94], quote: h124[0]!.lines[2]!.text },
    };
    const run = (f: HunkFinding) => validate(f, { "E:9289:0": h124 }, meta.packetRequirements, ROOT, meta.packetClasses);
    const rMiss = run({ ...claim, category: "missed-requirement", requirement: { ref: "R:30", quote: "keep exact totals" } });
    const rCtx = run({ ...claim, requirement: { ref: "R:30", quote: "keep exact totals" } });
    const rCur = run({ ...claim, category: "missed-requirement", requirement: { ref: "R:40", quote: "toBeCloseTo" } });
    expect({ missedHistoric: [rMiss.ok, rMiss.reason], contextHistoric: [rCtx.ok, rCtx.shown?.requirementStatus], missedCurrent: [rCur.ok, rCur.reason] }).toEqual({
      missedHistoric: [false, "historic-requirement-not-missable"],
      contextHistoric: [true, "historic: replaced authority, context only"],
      missedCurrent: [true, "ok"],
    });
  });
  it("d2_refresh_order_independent", async () => {
    const o1 = new Requests({ parent: "thr_old", coordinator: "thr_old" });
    o1.ingest(H[0]!);
    o1.ingest(H[1]!);
    o1.drainBatch(NEW, H.slice(2), true);
    const o2 = new Requests({ parent: "thr_old", coordinator: "thr_old" });
    o2.drainBatch(NEW, H, true);
    const a = await topologyA();
    expect(JSON.stringify(reqsOf(o1)) === JSON.stringify(reqsOf(o2)) && JSON.stringify(reqsOf(o2)) === JSON.stringify(reqsOf(a))).toBe(true);
  });
  it("d2_ownership_history_unknown_not_guessed", async () => {
    const mal = [ownRow(35, null, null, { action: "transfer" }), ...H.filter((x) => x.type !== "system/operation")];
    const m = new Requests(NEW);
    await m.seed(issued(new NativeEvents(mal)), 41);
    const noise = Array.from({ length: OWNER_PAGES * EVENT_PAGE_MAX + 5 }, (_, i) => opRow(1000 + i));
    const tr = new Requests(NEW);
    await tr.seed(issued(new NativeEvents([...H, ...noise])), 2000);
    expect({ malformed: reqsOf(m), truncated: reqsOf(tr), truncNote: tr.notes }).toEqual({
      malformed: [["R:40", "coordinator", "unverified"]],
      truncated: [["R:40", "coordinator", "unverified"]],
      truncNote: ["ownership-history-before-#1005-not-scanned:page-cap@1005"],
    });
  });
  it("d2_parent_anchor_needs_drain_after_refresh", () => {
    const an = new Requests({ parent: "thr_coord", coordinator: "thr_coord" });
    an.ingest(reqRow(5, "c1", "cover VAT", "thr_coord"));
    an.ingest(accRow(6, "c1"));
    const beforeDrain = reqsOf(an);
    an.setContext({ parent: "thr_coord", coordinator: "thr_coord" });
    const mid = reqsOf(an);
    an.drained(true);
    expect([beforeDrain, mid, reqsOf(an)]).toEqual([
      [["R:5", "coordinator", "native-parent-at-acceptance"]],
      [["R:5", "coordinator", "unverified"]],
      [["R:5", "coordinator", "native-parent-at-acceptance"]],
    ]);
  });
});

// ---- F3: sender-less requests are UNATTRIBUTED; an exact briefText match labels the assignment brief.
const BRIEF = "Initiative · bb-plugins · W9 Fix totals — A7: keep refund coverage while fixing rounding.";
const BRIEFS = { A7: { text: BRIEF, state: "running" } };
const withSource = (row: EventRow, source: string): EventRow => ({ ...row, data: { ...row.data, source } });

describe("Part D, F3: unattributed senders and assignment briefs", () => {
  it("d3_route_parity_assignment_brief", () => {
    const routes = {
      spawn: withSource(reqRow(1, "s", BRIEF), "spawn"),
      fork: reqRow(1, "s", BRIEF),
      continue: withSource(reqRow(1, "s", BRIEF, "thr_coord"), "tell"),
    };
    const parity: Record<string, unknown> = {};
    for (const [route, row] of Object.entries(routes)) {
      const rr = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: BRIEFS });
      rr.ingest(row);
      rr.ingest(accRow(2, "s"));
      parity[route] = reqsOf(rr);
    }
    const want = [["R:1", "assignment-brief", "assignment:A7"]];
    expect(parity).toEqual({ spawn: want, fork: want, continue: want });
  });
  it("d3_senderless_notice_unattributed", () => {
    const NOTICE = "Initiative · bb-plugins · Your review of D12\n\nNot okay: switch to toBeCloseTo\n\nkeep exact\n\n[op:abc]";
    const nt = new Requests({ parent: null, coordinator: "thr_coord", briefs: BRIEFS });
    nt.ingest(reqRow(3, "nt", NOTICE));
    const pend = nt.pending();
    nt.ingest(accRow(4, "nt"));
    const body = buildBody(SONNET, "charter", "", nt.requirements(), [], [card1]).body;
    expect({ reqs: reqsOf(nt), heldWhilePending: pend, label: body.includes("[R:3 UNATTRIBUTED: user or plugin]") }).toEqual({
      reqs: [["R:3", "unattributed", "none"]],
      heldWhilePending: ["nt"],
      label: true,
    });
  });
  it("d3_explicit_coordinator_not_brief", () => {
    const ex = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: BRIEFS });
    ex.ingest(reqRow(5, "ex", "Also cover partial refunds.", "thr_coord"));
    ex.ingest(accRow(6, "ex"));
    expect(reqsOf(ex)).toEqual([["R:5", "coordinator", "native-parent-at-acceptance"]]);
  });
  it("d3_mismatched_brief_not_labeled", () => {
    const mm: Record<string, unknown> = {};
    for (const [name, text, sender] of [
      ["trailing_newline", BRIEF + "\n", null],
      ["one_char", BRIEF.replace("rounding", "Rounding"), null],
      ["coordinator_mismatch", BRIEF + " ", "thr_coord"],
    ] as const) {
      const rr = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: BRIEFS });
      rr.ingest(reqRow(7, "m", text, sender));
      rr.ingest(accRow(8, "m"));
      mm[name] = reqsOf(rr);
    }
    const two = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: BRIEFS });
    two.ingest({
      seq: 9,
      type: "client/turn/requested",
      data: { requestId: "t2", senderThreadId: null, initiator: "user", input: [{ type: "text", text: "seed", visibility: "agent-only" }, { type: "text", text: BRIEF }] },
    });
    two.ingest(accRow(10, "t2"));
    const dup = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: { ...BRIEFS, A8: { text: BRIEF, state: "queued" } } });
    dup.ingest(reqRow(11, "d", BRIEF));
    dup.ingest(accRow(12, "d"));
    mm.two_parts = reqsOf(two);
    mm.same_text_two_assignments = reqsOf(dup);
    expect(mm).toEqual({
      trailing_newline: [["R:7", "unattributed", "none"]],
      one_char: [["R:7", "unattributed", "none"]],
      coordinator_mismatch: [["R:7", "coordinator", "native-parent-at-acceptance"]],
      two_parts: [["R:9", "unattributed", "none"]],
      same_text_two_assignments: [["R:11", "unattributed", "none"]],
    });
  });
  it("d3_ambiguous_human_input_no_user_attribution", async () => {
    const hu = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: BRIEFS });
    hu.ingest(reqRow(13, "h", "Actually keep exact totals; do not loosen the test."));
    hu.ingest(accRow(14, "h"));
    const { body, meta } = buildBody(SONNET, "charter", "", hu.requirements(), [], [card1]);
    const a124 = fixture("a124-9289-filechange.json").item.changes[0];
    const h124 = parseUnified(a124.path, a124.diff);
    const r = validate(
      {
        category: "test-integrity",
        evidence: "E:9289:0",
        hunk: 0,
        before: { lines: [94, 94], quote: h124[0]!.lines[1]!.text },
        after: { lines: [94, 94], quote: h124[0]!.lines[2]!.text },
        requirement: { ref: "R:13", quote: "keep exact totals" },
      },
      { "E:9289:0": h124 },
      meta.packetRequirements,
      ROOT,
      meta.packetClasses,
    );
    const all = [await topologyA(), await topologyA7(), hu].flatMap((q) => q.requirements().map((x) => x.class));
    expect({
      source: r.shown?.requirementSource,
      packetSaysUser: body.includes(" user]") || body.includes("[R:13 user"),
      anyUserClass: [...new Set(all)].filter((k) => k.includes("user") || k.includes("owner")).sort(),
    }).toEqual({ source: "UNATTRIBUTED: user or plugin", packetSaysUser: false, anyUserClass: [] });
  });
  it("d3_cancelled_assignment_brief_historic", () => {
    const done = new Requests({ parent: "thr_coord", coordinator: "thr_coord", briefs: { A7: { text: BRIEF, state: "cancelled" } } });
    done.ingest(reqRow(1, "s", BRIEF));
    const pend = done.pending();
    done.ingest(accRow(2, "s"));
    expect({ reqs: reqsOf(done), pending: pend }).toEqual({ reqs: [["R:1", "former-assignment-brief", "assignment:A7"]], pending: [] });
  });
  it("d3_completion_reads_installed_brief_text", () => {
    const BRIEF_A1 = A_RUN.items[0].briefText;
    const spawnRow = withSource(reqRow(70, "b1", BRIEF_A1), "spawn");
    const rqW = new Requests({ parent: "thr_coord", coordinator: "thr_coord" });
    const cw = classifyCompletion(snap({ refs: ["A1"] }), snap({ refs: ["A1"] }), [spawnRow, accRow(71, "b1")], true, rqW);
    expect([cw.state, "reasons" in cw ? cw.reasons : null, reqsOf(rqW)]).toEqual(["stale", ["new-accepted-instruction:b1"], [["R:70", "assignment-brief", "assignment:A1"]]]);
  });
});

// ---- F4: a k-th same-run pair is verified only if the enclosing scope provably holds.
function pair(path: string, diff: string, before: [number, string], after: [number, string], subj = "x") {
  const f: HunkFinding = {
    evidence: "E",
    hunk: 0,
    category: "test-integrity",
    subject: subj,
    before: { lines: [before[0], before[0]], quote: before[1] },
    after: { lines: [after[0], after[0]], quote: after[1] },
  };
  const r = validate(f, { E: parseUnified(path, diff) }, {});
  return [r.ok, r.reason, r.shown?.subjectStatus ?? null, r.shown?.pairing ?? null];
}
const DPY = "@@ -20,4 +20,4 @@\n     def test_5(self):\n         assert 5\n-    def test_x(self):\n-        assert total() == 10.25\n+def test_x():\n+    assert total()\n";
const DJS = "@@ -40,5 +40,5 @@\n   it('y', () => {\n     expect(y).toBe(1);\n   });\n" + "-  it('x', () => { expect(a).toBe(1); });\n-});\n+});\n+it('x', () => { expect(a).toBeTruthy(); });\n";
const DJS_SAME_IND =
  "@@ -40,4 +40,6 @@\n   it('y', () => {\n     expect(y).toBe(1);\n   });\n" +
  "-  it('x', () => { expect(a).toBe(1); });\n+  });\n+  describe.each([1])('B', () => {\n+  it('x', () => { expect(a).toBeTruthy(); });\n";
const DPY_SAME_IND = "@@ -20,3 +20,4 @@\n     def test_5(self):\n         assert 5\n-    def test_x(self):\n" + "+if SLOW:\n+    def test_x(self):\n";
const DPY_NEW_CLASS = "@@ -20,3 +20,4 @@\n     def test_5(self):\n         assert 5\n-    def test_x(self):\n" + "+class TestB:\n+    def test_x(self):\n";
const DJS_ENTER = "@@ -40,4 +40,4 @@\n   it('y', () => {\n     expect(y).toBe(1);\n   });\n" + "-});\n-it('x', () => { expect(a).toBe(1); });\n+it('x', () => { expect(a).toBeTruthy(); });\n+});\n";
const DJS_CTRL = "@@ -40,3 +40,3 @@\n   it('y', () => {\n     expect(y).toBe(1);\n   });\n" + "-  it('x', () => { expect(a).toBe(1); });\n+  it('x', () => { expect(a).toBeTruthy(); });\n";
const DJS_KTH =
  "@@ -40,6 +40,6 @@\n   it('y', () => {\n     expect(y).toBe(1);\n   });\n" +
  "-  it('w', () => {\n-    expect(w).toBe(1);\n-  });\n-  it('x', () => { expect(a).toBe(1); });\n" +
  "+  it('w', () => {\n+    expect(w).toBe(2);\n+  });\n+  it('x', () => { expect(a).toBeTruthy(); });\n";
const DPY_CTRL = "@@ -20,4 +20,4 @@\n     def test_5(self):\n         assert 5\n-    def test_x(self):\n-        assert total() == 10.25\n" + "+    def test_x(self):\n+        assert total()\n";

describe("Part D, F4: k-th same-run pairs need scope proof", () => {
  it("d4_scope_change_not_verified", () => {
    expect({
      py_class_to_module_a157: pair("tests/t_py.py", DPY, [22, "    def test_x(self):"], [22, "def test_x():"], "test_x"),
      js_leave_describe_a157: pair("tests/t.test.ts", DJS, [43, "  it('x', () => { expect(a).toBe(1); });"], [44, "it('x', () => { expect(a).toBeTruthy(); });"]),
      js_same_indent_closer: pair("tests/t.test.ts", DJS_SAME_IND, [43, "  it('x', () => { expect(a).toBe(1); });"], [45, "  it('x', () => { expect(a).toBeTruthy(); });"]),
      py_same_indent_dedent: pair("tests/t_py.py", DPY_SAME_IND, [22, "    def test_x(self):"], [23, "    def test_x(self):"], "test_x"),
      py_new_class_chain_differs: pair("tests/t_py.py", DPY_NEW_CLASS, [22, "    def test_x(self):"], [23, "    def test_x(self):"], "test_x"),
      js_enter_scope_closer_removed_side: pair("tests/t.test.ts", DJS_ENTER, [44, "it('x', () => { expect(a).toBe(1); });"], [43, "it('x', () => { expect(a).toBeTruthy(); });"]),
    }).toEqual({
      py_class_to_module_a157: [true, "ok", "ambiguous", "claimed-same-name"],
      js_leave_describe_a157: [true, "ok", "ambiguous", "claimed-same-name"],
      js_same_indent_closer: [true, "ok", "ambiguous", "claimed-same-name"],
      py_same_indent_dedent: [true, "ok", "ambiguous", "claimed-same-name"],
      py_new_class_chain_differs: [true, "ok", "rename-or-replacement", "positional"],
      js_enter_scope_closer_removed_side: [true, "ok", "ambiguous", "claimed-same-name"],
    });
  });
  it("d4_controls_still_verified", () => {
    expect({
      js_one_line_edit: pair("tests/t.test.ts", DJS_CTRL, [43, "  it('x', () => { expect(a).toBe(1); });"], [43, "  it('x', () => { expect(a).toBeTruthy(); });"]),
      js_kth_after_balanced_test: pair("tests/t.test.ts", DJS_KTH, [46, "  it('x', () => { expect(a).toBe(1); });"], [46, "  it('x', () => { expect(a).toBeTruthy(); });"]),
      py_same_class: pair("tests/t_py.py", DPY_CTRL, [23, "        assert total() == 10.25"], [23, "        assert total()"], "test_x"),
    }).toEqual({
      js_one_line_edit: [true, "ok", "verified", null],
      js_kth_after_balanced_test: [true, "ok", "verified", null],
      py_same_class: [true, "ok", "verified", null],
    });
  });
});

describe("Part D: every issued query is admitted by the installed contract", () => {
  afterAll(() => undefined);
  it("d1_issued_queries_admitted_by_installed_schema", () => {
    const all = SOURCES.flatMap((s) => s.log);
    const rejected = all.filter((q) => {
      try {
        new NativeEvents([]).listSync(q);
        return false;
      } catch {
        return true;
      }
    });
    // native_query.json records the installed schema's verdicts; d1_fake_matches_installed_schema
    // proves this fake agrees with them on every recorded shape.
    expect({ rejected, count: all.length > 50, maxLimit: Math.max(...all.map((q) => Number(q.limit ?? "100"))) }).toEqual({
      rejected: [],
      count: true,
      maxLimit: 100,
    });
  });
});
