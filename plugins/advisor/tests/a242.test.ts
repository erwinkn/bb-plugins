// A242 P2: out-of-range stored settings reach the plugin through the host's
// settings read (installed BB and the SDK fake host check type and options
// only on read). Every such value runs on its documented default, reviews stay
// visibly off, and destructive work (pruning, held-review expiry) waits.

import { describe, expect, it } from "vitest";
import { rig, oneLineDiff, type Rig } from "./helpers/world.js";

const T = "thr_s";
const weaken = oneLineDiff(3, "expect(a).toBe(42);", "expect(a).toBeGreaterThan(0);", ["x", "y"], ["z"]);
const DAY = 86_400_000;
const BAD = { evidenceRetentionMB: 0, evidenceRetentionDays: 0, findingsMaxCount: 5, pollSeconds: 0, checkpointMaxPaths: 500 };

function turn(r: Rig) {
  r.world.turnStart(T);
  r.world.fileChange(T, "/repo/tests/a.test.ts", weaken);
  r.world.command(T, "npm test", 1, "1 failed");
  r.world.turnEnd(T);
}

async function withEvidence(settings: Record<string, unknown>) {
  const r = await rig(settings);
  r.world.addThread(T);
  await r.advisor.watch(T, "test");
  await r.tick();
  turn(r);
  await r.tick();
  const w = r.store.getWatchByThread(T)!;
  const cards = r.store.listCards(w.id, { limit: 50 }).length;
  expect(cards).toBeGreaterThan(0);
  return { r, w, cards };
}

function expectPreserved(r: Rig, watchId: string, cards: number) {
  expect(r.store.listCards(watchId, { limit: 50 })).toHaveLength(cards);
  expect(r.store.listGaps(watchId).map((g) => g.reason)).not.toContain("pruned-before-review");
}

describe("A242 invalid stored numbers through the host settings read", () => {
  it("at load: defaults run, reviews are visibly off, and pruning waits (evidence kept)", async () => {
    const { r, w, cards } = await withEvidence({ reviewEnabled: true, ...BAD });
    const c = r.advisor.resolved;
    expect(c.config.pollSeconds).toBe(15);
    expect(c.config.checkpointMaxPaths).toBe(20);
    expect(c.config.retention).toEqual({ evidenceDays: 14, evidenceBytes: 200 * 1024 * 1024, findingsDays: 90, findingsMax: 5000 });
    for (const k of Object.keys(BAD)) expect(c.reviewErrors.join(" ")).toContain(`Setting ${k} has an invalid stored value`);
    expect(c.notes.join(" ")).toMatch(/Pruning is paused until evidenceRetentionDays, evidenceRetentionMB, findingsMaxCount is fixed/u);
    expect(c.notes).toContain("Observation uses the default for pollSeconds until it is fixed.");
    expect(r.advisor.dispatchHold(r.store.getWatch(w.id)!)).toMatch(/^settings: Setting/u);
    expect(r.store.listReviews(w.id)).toEqual([]);
    for (let d = 0; d < 3; d++) {
      r.clock.advance(20 * DAY);
      await r.tick();
    }
    expectPreserved(r, w.id, cards);
  });

  it("on a later settings change (the stored invalid value is read again): still defaulted, evidence kept", async () => {
    const { r, w, cards } = await withEvidence({ ...BAD });
    await r.harness.behavior.setSettings({ minGapMinutes: 3 }); // a valid edit of another key fires onChange with all values
    expect(r.advisor.resolved.config.cadence.minGapMinutes).toBe(3);
    expect(r.advisor.resolved.config.retention.evidenceBytes).toBe(200 * 1024 * 1024);
    expect(r.advisor.resolved.invalidKeys).toContain("evidenceRetentionMB");
    r.clock.advance(40 * DAY);
    await r.tick();
    expectPreserved(r, w.id, cards);
  });

  it("after a reload: still defaulted, evidence kept", async () => {
    const { r, w, cards } = await withEvidence({ ...BAD });
    await r.reload();
    expect(r.advisor.resolved.config.pollSeconds).toBe(15);
    r.clock.advance(40 * DAY);
    await r.tick();
    expectPreserved(r, w.id, cards);
  });

  it("valid retention still prunes: the pause is only for invalid values", async () => {
    const { r, w } = await withEvidence({ evidenceRetentionDays: 1 });
    r.clock.advance(3 * DAY);
    await r.tick();
    expect(r.store.listCards(w.id, { limit: 50 })).toHaveLength(0);
    expect(r.store.listGaps(w.id).map((g) => g.reason)).toContain("pruned-before-review");
  });
});

describe("A242 an invalid held expiry never expires a paid result", () => {
  it("a held review is rechecked but kept while heldExpiryMinutes is invalid, then expires on the fixed value", async () => {
    const settings = { reviewEnabled: true };
    const r = await rig(settings);
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const flag = { on: true };
    r.harness.sdk.stub("threads.events.list", async (args: any) => {
      if (flag.on && args.order === "asc" && args.limit === "100") throw Object.assign(new Error("read failed"), { status: 503 });
      return r.world.sdk().threads.events.list(args);
    });
    turn(r);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const [held] = r.store.listReviews(w.id);
    expect(held!.state).toBe("held");
    // The host delivers the whole stored set on every change (settings.onChange -> applySettings);
    // the fake host refuses to save an out-of-range value, so the stored set is handed over here.
    const stored = { ...(r.advisor as any).raw } as Record<string, unknown>;
    r.advisor.applySettings({ ...stored, heldExpiryMinutes: 0 });
    expect(r.advisor.resolved.notes).toContain("Held reviews do not expire until heldExpiryMinutes is fixed; they are still rechecked.");
    for (let i = 0; i < 4; i++) {
      r.clock.advance(60 * 60_000);
      await r.tick();
    }
    const kept = r.store.getReview(held!.id)!;
    expect(kept.state).toBe("held");
    expect(kept.result?.parsed).toBeDefined(); // the paid result is still there
    expect(kept.checkedAt).toBeGreaterThan(held!.checkedAt!);
    r.advisor.applySettings(stored);
    r.clock.advance(60_000);
    await r.tick();
    expect(r.store.getReview(held!.id)!.state).toBe("expired");
  });
});
