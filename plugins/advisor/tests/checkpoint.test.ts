// Turn-end checkpoints through the runtime: a shell edit to a test file (no
// fileChange event) becomes a state card; HEAD moves become named gaps.

import { describe, expect, it } from "vitest";
import { rig } from "./helpers/world.js";

const T = "thr_c";
const P = "tests/totals.test.ts";
const weakPatch = "@@ -3,1 +3,1 @@\n-it('computes totals', () => expect(total(l)).toBe(42));\n+it('computes totals', () => expect(total(l)).toBeGreaterThan(0));";

async function setup() {
  const r = await rig({});
  r.world.addThread(T);
  await r.advisor.watch(T, "test");
  await r.tick(); // seed + baseline checkpoint (clean)
  return r;
}

describe("checkpoints", () => {
  it("a shell edit to a test file appears as a state card with no observed edit event", async () => {
    const r = await setup();
    const env = r.world.envs.get(`env_${T}`)!;
    env.files = [{ path: P }, { path: "src/x.ts" }];
    env.patches[P] = weakPatch;
    r.world.turnStart(T);
    r.world.command(T, "sed -i 's/toBe(42)/toBeGreaterThan(0)/' tests/totals.test.ts", 0);
    r.world.turnEnd(T);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const states = r.store.listCards(w.id, { limit: 50 }).filter((c) => c.kind === "state");
    expect(states.map((c) => c.id)).toEqual(["S:2:0a#0"]);
    expect(states[0]!.meta).toMatchObject({ side: "added", writer: "unknown", observedEdits: [] });
    expect(states[0]!.text).toContain("observed edit events: none (shell or another writer)");
    const gaps = r.store.listGaps(w.id).map((g) => g.reason);
    expect(gaps).toContain("non-test-paths-changed");
  });

  it("a restoration shows as a removed hunk; it never closes an issue by itself", async () => {
    const r = await setup();
    const env = r.world.envs.get(`env_${T}`)!;
    env.files = [{ path: P }];
    env.patches[P] = weakPatch;
    r.world.turnStart(T);
    r.world.turnEnd(T);
    await r.tick();
    env.files = [];
    env.patches = {};
    r.world.turnStart(T);
    r.world.turnEnd(T);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const removed = r.store.listCards(w.id, { limit: 50 }).filter((c) => c.kind === "state" && c.meta.side === "removed");
    expect(removed).toHaveLength(1);
  });

  it("HEAD moving between checkpoints is a named gap, not a restoration", async () => {
    const r = await setup();
    const env = r.world.envs.get(`env_${T}`)!;
    env.head = "h2"; // the agent committed
    r.world.turnStart(T);
    r.world.turnEnd(T);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const gap = r.store.listGaps(w.id).find((g) => g.reason === "checkpoint-base-changed");
    expect(gap?.detail).toBe("HEAD moved h1→h2; committed content not reviewed");
    expect(r.store.listCards(w.id, { limit: 50 }).filter((c) => c.kind === "state")).toHaveLength(0);
  });

  it("a non-git environment makes checkpoints unavailable, shown as a gap", async () => {
    const r = await rig({});
    r.world.addThread(T);
    r.world.envs.get(`env_${T}`)!.files = [];
    const sdk = r.world.sdk();
    sdk.environments.diffFiles = async () => ({ outcome: "not_applicable", reason: "non_git_environment", message: "not git" });
    r.harness.sdk.stub("environments.diffFiles", sdk.environments.diffFiles);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(r.store.listGaps(w.id).find((g) => g.reason === "checkpoint-unavailable")?.detail).toBe("not a git environment");
  });
});
