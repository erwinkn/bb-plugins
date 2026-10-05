// The durable store against real SQLite on the SDK fake host: retention,
// retained citations, lossless idempotent drain, reload recovery.

import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { parseUnified } from "../src/rules/diff.js";
import { RETAIN_CAP, retain } from "../src/rules/retain.js";
import { editCards } from "../src/rules/packet.js";
import { validate } from "../src/rules/validate.js";
import { drainPass } from "../src/runtime/drain.js";
import { openStore, type Store } from "../src/store/store.js";
import { NativeEvents, makePatch } from "./helpers/a160.js";

function freshStore(): Store {
  const { bb } = createFakePluginHost({ pluginId: "advisor" });
  return openStore(bb);
}

const RET = { evidenceDays: 14, evidenceBytes: 200 * 1024 * 1024, findingsDays: 90, findingsMax: 5000 };

function occurrenceFor(store: Store, watchId: string, cardId: string, shown: any, retained: any, now: number) {
  store.addOccurrence(
    {
      id: `occ_${cardId}`,
      watchId,
      category: "test-integrity",
      locator: shown.locator,
      severity: "concern",
      evidence: cardId,
      reviewId: "rv1",
      route: "fake",
      model: null,
      summary: "s",
      shown,
      retained,
      asOfSeq: 5,
      coverage: "complete",
      score: null,
      preview: false,
      createdAt: now,
    },
    shown.subjectVerified,
  );
}

function openEvidence(store: Store, watchId: string, occId: string) {
  const o = store.getOccurrence(occId)!;
  const card = store.getCards(watchId, [o.evidence])[0];
  const r = o.retained as any;
  if (card) return { source: "evidence", complete: true };
  if (r.status === "complete") return { source: "retained", complete: true };
  return { source: "retained", complete: false, label: "citation clipped; full evidence pruned" };
}

describe("retention and retained citations", () => {
  it("a141_retained_citation_complete_after_prune", () => {
    const store = freshStore();
    const w = store.createWatch("thr", "selected", 1000);
    const bq = "it('large', () => expect('" + "x".repeat(2400) + "').toBe(42));";
    const aq = bq.replace("toBe(42)", "toBeTruthy()");
    const c = editCards(5, 0, "tests/large.test.ts", makePatch("tests/large.test.ts", bq, aq))[0]!;
    const v = validate({ category: "test-integrity", evidence: c.id, hunk: 0, subject: "large", before: { lines: [1, 1], quote: bq }, after: { lines: [1, 1], quote: aq } }, { [c.id]: c.hunks }, {});
    const ret = retain(v.shown!);
    store.insertCard({ watchId: w.id, id: c.id, seq: 5, ord: 0, kind: "edit", path: "tests/large.test.ts", text: c.text, encBytes: c.encBytes, meta: { hunks: c.hunks }, judge: true, createdAt: 1000 });
    store.markReviewed(w.id, [c.id]);
    occurrenceFor(store, w.id, c.id, v.shown, ret, 1000);
    store.prune(2000, { ...RET, evidenceBytes: 1 });
    expect({ accepted: v.ok, retainedStatus: ret.status, retainedBytes: ret.bytes, open: openEvidence(store, w.id, `occ_${c.id}`) }).toEqual({
      accepted: true,
      retainedStatus: "complete",
      retainedBytes: 4882,
      open: { source: "retained", complete: true },
    });
  });

  it("retained_citation_clipped_exactly", () => {
    const store = freshStore();
    const w = store.createWatch("thr", "selected", 1000);
    const lb = "it('big', () => expect('" + "é".repeat(2600) + "').toBe(1));";
    const la = lb.replace("toBe(1)", "toBeTruthy()");
    const d7b = makePatch("tests/big.test.ts", lb + "\n" + "pad();\n".repeat(6), "pad();\n".repeat(6) + la + "\n", 1);
    const hs = parseUnified("tests/big.test.ts", d7b);
    const v = validate({ category: "test-integrity", evidence: "E:7", hunk: 0, subject: "big", relation: "moved", before: { lines: [1, 1], quote: lb }, after: { hunk: 1, lines: [7, 7], quote: la } }, { "E:7": hs }, {});
    const ret = retain(v.shown!);
    store.insertCard({ watchId: w.id, id: "E:7", seq: 7, ord: 0, kind: "edit", path: "tests/big.test.ts", text: d7b, encBytes: 1, meta: { hunks: hs }, judge: true, createdAt: 1000 });
    store.markReviewed(w.id, ["E:7"]);
    occurrenceFor(store, w.id, "E:7", v.shown, ret, 1000);
    store.prune(2000, { ...RET, evidenceBytes: 1 });
    const sides = Object.values(ret.sides) as any[];
    const kept = sides.reduce((n, x) => n + Buffer.byteLength(x.head) + Buffer.byteLength(x.tail), 0);
    const lost = sides.reduce((n, x) => n + x.omittedBytes, 0);
    const opened = openEvidence(store, w.id, "occ_E:7");
    expect({
      accepted: v.ok,
      status: ret.status,
      withinCap: ret.bytes <= RETAIN_CAP,
      exactAccounting: kept + lost === Buffer.byteLength(lb) + Buffer.byteLength(la),
      validUtf8: sides.every((x) => !(x.head + x.tail).includes("�")),
      openComplete: opened.complete,
      label: opened.label,
    }).toEqual({ accepted: true, status: "clipped", withinCap: true, exactAccounting: true, validUtf8: true, openComplete: false, label: "citation clipped; full evidence pruned" });
  });

  it("prune_unreviewed_records_not_judged_gap", () => {
    const store = freshStore();
    const w = store.createWatch("thr", "selected", 1000);
    for (let i = 0; i < 6; i++) {
      store.insertCard({ watchId: w.id, id: `C:${i}`, seq: 10 + i, ord: 0, kind: "command", path: null, text: "c".repeat(100), encBytes: 100, meta: {}, judge: true, createdAt: 1000 + i });
    }
    store.markReviewed(w.id, ["C:0", "C:1"]); // frontier at C:2
    const before = store.evidenceBytes();
    const per = before / 6;
    const res = store.prune(5000, { ...RET, evidenceBytes: Math.floor(per * 3) });
    const left = store.listCards(w.id, { limit: 10 }).map((c) => c.id).reverse();
    expect({ pruned: res.cards, left, frontier: store.frontierCards(w.id)[0]!.id, gaps: store.listGaps(w.id).map((g) => [g.layer, g.reason, g.fromSeq, g.toSeq, g.detail]) }).toEqual({
      pruned: 3,
      left: ["C:3", "C:4", "C:5"],
      frontier: "C:3",
      gaps: [["judgment", "pruned-before-review", 12, 12, "1 cards"]],
    });
  });

  it("drain_catch_up_lossless_idempotent", async () => {
    const evs = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, itemId: `i${i + 1}`, type: "item/completed", data: {} }));
    const src = new NativeEvents(evs as any);
    const stored = new Map<number, unknown>();
    const commit = (page: any[]) => {
      for (const e of page) if (!stored.has(e.seq)) stored.set(e.seq, e);
    };
    let cur = 0;
    let passes = 0;
    for (;;) {
      const info = await drainPass(src, cur, commit);
      cur = info.cursor;
      passes++;
      if (info.atTip) break;
    }
    await drainPass(src, 250, commit); // a replay from an older cursor adds nothing
    expect({ passes, cards: stored.size, cursor: cur, replayAddsNothing: stored.size === 500 }).toEqual({ passes: 3, cards: 500, cursor: 500, replayAddsNothing: true });
  });

  it("cards are immutable: a second insert of the same id is ignored", () => {
    const store = freshStore();
    const w = store.createWatch("thr", "selected", 1);
    const base = { watchId: w.id, id: "E:1:0#0", seq: 1, ord: 0, kind: "edit" as const, path: "a", text: "first", encBytes: 5, meta: {}, judge: true, createdAt: 1 };
    expect(store.insertCard(base)).toBe(true);
    expect(store.insertCard({ ...base, text: "second" })).toBe(false);
    expect(store.getCards(w.id, ["E:1:0#0"])[0]!.text).toBe("first");
  });

  it("atomic admission: two reservations cannot both fit under one remaining cap", () => {
    const store = freshStore();
    const row = (id: string) => ({ id, reviewId: id, watchId: "w", route: "sonnet:anthropic-api", model: "claude-sonnet-5-5", billing: "usd" as const, day: "2026-10-05", reservedUsd: 0.6, reservedTokens: 1, priceVersion: "v", basis: "b" });
    const caps = { usd: 1, requests: 10, tokens: null };
    expect(store.reserve(row("a"), caps, 1).ok).toBe(true);
    const b = store.reserve(row("b"), caps, 1);
    expect(b.ok).toBe(false);
    expect(store.listLedger()).toHaveLength(1);
  });

  it("findings retention keeps at most the configured count, oldest first; the ledger is never pruned", () => {
    const store = freshStore();
    const w = store.createWatch("thr", "selected", 1);
    for (let i = 0; i < 15; i++) occurrenceFor(store, w.id, `E:${i}`, { locator: `l${i}`, subjectVerified: true }, { status: "complete" }, 1000 + i);
    store.reserve({ id: "lg", reviewId: "r", watchId: w.id, route: "x", model: null, billing: "usd", day: "d", reservedUsd: 0.1, reservedTokens: 1, priceVersion: null, basis: "b" }, { usd: 1, requests: 1, tokens: null }, 1);
    store.prune(10 ** 13, { evidenceDays: 1, evidenceBytes: 1, findingsDays: 10 ** 6, findingsMax: 10 });
    expect(store.listOccurrences(w.id, 100).map((o) => o.evidence).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `E:${i + 5}`).sort());
    expect(store.listLedger()).toHaveLength(1);
  });
});
