// Admission, reservations, unknown usage, day rollover, cancellation and
// reload recovery through the real runtime, with fake fetch (no network).

import { describe, expect, it } from "vitest";
import { rig, oneLineDiff, type Rig } from "./helpers/world.js";
import type { FetchLike } from "../src/transport/types.js";

const T = "thr_b";
const EXACT = "it('computes totals with refunds', () => expect(total(l)).toBe(42));";
const LOOSE = "it('computes totals with refunds', () => expect(total(l)).toBeGreaterThan(0));";
const API = {
  reviewEnabled: true,
  providerRequestsEnabled: true,
  route: "sonnet:anthropic-api",
  anthropicApiKey: "sk-ant-test",
  usdPerDay: 1,
  apiRequestsPerDay: 10,
  budgetTimeZone: "UTC",
};
const okBody = (usage = { input_tokens: 3000, output_tokens: 200 }) =>
  new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"findings":[],"resolved":[]}' }], stop_reason: "end_turn", usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function turn(r: Rig, thread = T, n = 0) {
  r.world.turnStart(thread);
  r.world.fileChange(thread, `/repo/tests/t${n}.test.ts`, oneLineDiff(1, EXACT, LOOSE));
  r.world.turnEnd(thread);
}

async function setup(settings: Record<string, unknown>, fetch: FetchLike, threads = [T]) {
  const r = await rig({ ...API, ...settings }, { fetch });
  for (const t of threads) {
    r.world.addThread(t);
    await r.advisor.watch(t, "test");
  }
  await r.tick(); // seed
  return r;
}

describe("spend ledger", () => {
  it("unknown_usage_charged_in_full", async () => {
    // Outcomes: completed with usage (reconciled), vendor 529 (ambiguous), refusal (cut), 429 (rejected, released),
    // and a row left sending by a reload (charged in full). Unknown usage is never refunded.
    const script: Array<() => Response> = [
      () => okBody(),
      () => new Response("{}", { status: 529 }),
      () => new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }),
      () => new Response("{}", { status: 429 }),
    ];
    let i = 0;
    const r = await setup({ minGapMinutes: 0, refillMinutes: 1, bucketSize: 10, apiRequestsPerDay: 100 }, async () => script[i++]!());
    for (let k = 0; k < 4; k++) {
      turn(r, T, k);
      r.clock.advance(60_000);
      await r.tick();
      r.advisor.resume(r.store.getWatchByThread(T)!.id, "test"); // two failures pause; resume to continue the script
    }
    const rows = r.store.listLedger().reverse();
    expect(rows.map((x) => [x.outcome, x.state])).toEqual([
      ["completed", "reconciled"],
      ["ambiguous", "unknown_charged"],
      ["cut", "unknown_charged"],
      ["rejected", "released"],
    ]);
    expect(rows[0]!.actualUsd).toBeCloseTo((3000 * 2 + 200 * 10) / 1e6, 10);
    expect(rows[1]!.actualUsd).toBeNull();
    const t = r.store.dayTotals(rows[0]!.day, "usd");
    expect(t.usd).toBeCloseTo(rows[0]!.actualUsd! + rows[1]!.reservedUsd + rows[2]!.reservedUsd, 10);
    expect(t.requests).toBe(4); // the rejected request was sent: it counts as a request, not as spend
    // A row still in flight when the plugin reloads is charged in full.
    r.store.db.prepare("UPDATE ledger SET state = 'sending' WHERE id = ?").run(rows[3]!.id);
    await r.reload();
    r.advisor.recover();
    expect(r.store.getLedger(rows[3]!.id)!.state).toBe("unknown_charged");
  });

  it("pool dispatch stamps decide the charge: 499/503 none release, 499 sent and 503 sent charge in full (A220 contract v1)", async () => {
    const script = [
      [499, "none"],
      [503, "none"],
      [499, "sent"],
      [503, "sent"],
    ] as const;
    let i = 0;
    const r = await setup(
      { route: "sonnet:pool", subscriptionRequestsPerDay: 50, subscriptionTokensPerDay: 10 ** 7, minGapMinutes: 0, refillMinutes: 1, bucketSize: 10 },
      async () => {
        const [status, stamp] = script[i++]!;
        return new Response(JSON.stringify({ type: "error", error: { type: "x", message: "m" } }), { status, headers: { "x-account-pool-dispatch": stamp } });
      },
    );
    for (let k = 0; k < 4; k++) {
      turn(r, T, k);
      r.clock.advance(60_000);
      await r.tick();
      r.advisor.resume(r.store.getWatchByThread(T)!.id, "test");
    }
    const rows = r.store.listLedger().reverse();
    expect(rows.map((x) => [x.outcome, x.state, x.posted])).toEqual([
      ["pre-upstream", "released", false],
      ["pre-upstream", "released", false],
      ["cut", "unknown_charged", true],
      ["ambiguous", "unknown_charged", true],
    ]);
    const t = r.store.dayTotals(rows[0]!.day, "subscription");
    expect(t.requests).toBe(2);
    expect(t.tokens).toBe(rows[2]!.reservedTokens + rows[3]!.reservedTokens);
    expect(t.usd).toBe(0); // quota is never converted to USD
  });

  it("refuses at the cap before any request, pauses with reason budget, and clears on day rollover", async () => {
    let posts = 0;
    // One review reserves (65,536 + 1,024) x $2.50 + 2,000 x $10 per MTok at most; a $0.03 cap admits none of a large body.
    const r = await setup({ usdPerDay: 0.01, bodyCapKiB: 24 }, async () => (posts++, okBody()));
    turn(r);
    r.clock.advance(5 * 60_000);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(posts).toBe(0);
    expect(w.state.pause).toEqual(["budget"]);
    expect(r.store.listReviews(w.id)[0]!.state).toBe("refused-budget");
    expect(r.store.backlog(w.id)).toBeGreaterThan(0);
    await r.harness.behavior.setSettings({ usdPerDay: 1 }); // a raised cap clears the hold
    r.clock.advance(5 * 60_000);
    await r.tick();
    expect(posts).toBe(1);
    expect(r.store.getWatchByThread(T)!.state.pause).toEqual([]);
  });

  it("the daily request cap counts per calendar day in the named zone", async () => {
    let posts = 0;
    const r = await setup({ apiRequestsPerDay: 1, minGapMinutes: 0, refillMinutes: 1 }, async () => (posts++, okBody()));
    r.clock.t = Date.UTC(2026, 9, 5, 23, 50);
    turn(r, T, 1);
    await r.tick();
    turn(r, T, 2);
    r.clock.advance(5 * 60_000);
    await r.tick();
    expect(posts).toBe(1);
    expect(r.store.getWatchByThread(T)!.state.pause).toEqual(["budget"]);
    r.clock.t = Date.UTC(2026, 9, 6, 0, 1); // next UTC day
    await r.tick();
    expect(posts).toBe(2);
    const days = r.store.listLedger().map((x) => x.day).sort();
    expect(days).toEqual(["2026-10-05", "2026-10-06"]);
  });

  it("subscription routes count requests and tokens, never USD", async () => {
    const r = await setup(
      { route: "sonnet:pool", subscriptionRequestsPerDay: 5, subscriptionTokensPerDay: 500000 },
      async () => new Response(okBody().body, { status: 200, headers: { "x-account-pool-dispatch": "sent" } }),
    );
    turn(r);
    r.clock.advance(5 * 60_000);
    await r.tick();
    const [row] = r.store.listLedger();
    expect(row).toMatchObject({ billing: "subscription", reservedUsd: 0, state: "reconciled", actualUsd: 0, actualTokens: 3200 });
    expect(r.world.tokenCalls).toBe(1);
  });

  it("a settings change cancels an in-flight review; the abort is charged in full and the frontier stays", async () => {
    let started!: () => void;
    const begun = new Promise<void>((res) => (started = res));
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, reject) => {
        started();
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const r = await setup({}, hang);
    turn(r);
    r.clock.advance(5 * 60_000);
    await r.advisor.tick(new AbortController().signal);
    await begun;
    await r.harness.behavior.setSettings({ sonnetEffort: "medium" });
    await r.advisor.idle();
    const w = r.store.getWatchByThread(T)!;
    const rv = r.store.listReviews(w.id)[0]!;
    expect([rv.state, rv.error]).toEqual(["cancelled", "canceled: settings-changed"]);
    expect(r.store.listLedger()[0]).toMatchObject({ state: "unknown_charged", outcome: "ambiguous" });
    expect(r.store.backlog(w.id)).toBeGreaterThan(0);
    expect(w.state.pause).toEqual([]); // a cancel is not a failure
  });

  it("at most `concurrency` reviews run at once, and one per watch", async () => {
    let inflight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const slow: FetchLike = () =>
      new Promise((res) => {
        inflight++;
        peak = Math.max(peak, inflight);
        release.push(() => {
          inflight--;
          res(okBody());
        });
      });
    const r = await setup({ concurrency: 2 }, slow, ["thr_1", "thr_2", "thr_3"]);
    for (const t of ["thr_1", "thr_2", "thr_3"]) turn(r, t);
    r.clock.advance(5 * 60_000);
    await r.advisor.tick(new AbortController().signal);
    await new Promise((res) => setTimeout(res, 20));
    expect(peak).toBe(2);
    expect(r.advisor.inflightWatches()).toHaveLength(2);
    while (release.length) release.shift()!();
    await r.advisor.idle();
  });

  it("nothing is sent while provider requests are off, even with reviews on", async () => {
    let posts = 0;
    const r = await setup({ providerRequestsEnabled: false }, async () => (posts++, okBody()));
    turn(r);
    r.clock.advance(5 * 60_000);
    await r.tick();
    expect(posts).toBe(0);
    expect(r.advisor.dispatchHold(r.store.getWatchByThread(T)!)).toBe("model provider requests are off");
  });
});
