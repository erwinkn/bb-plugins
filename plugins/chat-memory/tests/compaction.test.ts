import { describe, expect, it } from "vitest";
import { createCompaction } from "../lib/compaction";
import { fixture, type Fixture } from "./fixture";

/** A469 8 and A471 6 (W286's and W288's reviews of T145): compaction failures are visible and retried. */
const compaction = (f: Fixture, sdk: { list: () => Promise<unknown[]>; compact: () => Promise<unknown> }) =>
  createCompaction({ store: f.store, limit: (s) => f.memory.compactLimit(s), log: () => {}, sdk: { threads: { events: { list: sdk.list }, compact: sdk.compact } } as never });
const usage = (usedTokens: number) => [{ seq: 7, type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens } } }];
const due = (f: Fixture) => f.store.handle.prepare(`UPDATE threads SET compact_tried_at = 0`).run();

async function hybrid() {
  const f = fixture();
  await f.attach("initiatives", "p", f.thread("coord", { title: "Coordinator" }));
  await f.configure("coord", { mode: "hybrid" });
  return f;
}

describe("A469 8: a failed compaction is shown and retried", () => {
  it("records it as failed, shows it, tries the same snapshot again at most three times, and clears it once one succeeds", async () => {
    const f = await hybrid();
    let fails = true;
    let tries = 0;
    const c = compaction(f, {
      list: async () => usage(200_000),
      compact: async () => {
        tries++;
        if (fails) throw new Error("503 BB unavailable");
        return {};
      },
    });
    const signal = new AbortController().signal;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    const status = await f.memory.status("initiatives:p");
    expect(status.threads[0]).toMatchObject({ compactedAt: null, compactError: "503 BB unavailable" });
    expect(status.problems).toContainEqual(expect.stringMatching(/Compacting "Coordinator" failed: 503 BB unavailable/));
    // Not again at once; again once the retry wait is over; never more than three times a snapshot.
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(tries).toBe(1);
    expect(f.store.compactFailures(3)).toEqual(["coord"]);
    for (let n = 0; n < 3; n++) {
      due(f);
      await c.afterIdle("coord", signal);
    }
    expect(tries).toBe(3);
    expect(f.store.thread("coord")!.compactError).toBe("503 BB unavailable");
    expect(f.store.compactFailures(3)).toEqual([]);
    // A later snapshot starts over; a success clears the problem.
    f.store.handle.prepare(`UPDATE threads SET compacted_seq = 0`).run();
    fails = false;
    expect(await c.afterIdle("coord", signal)).toBe(true);
    expect((await f.memory.status("initiatives:p")).problems).toEqual([]);
    expect(f.store.thread("coord")!.compactedAt).not.toBeNull();
  });
});

describe("A471 6: a failed read of the context size is a visible, retried compaction failure", () => {
  it("keeps the read's error on the thread, shows it, retries it within the bound, and clears it once a read works", async () => {
    const f = await hybrid();
    let reads = 0;
    let failing = true;
    const c = compaction(f, {
      list: async () => {
        reads++;
        if (failing) throw new Error("503 events unavailable");
        return usage(1_000);
      },
      compact: async () => ({}),
    });
    const signal = new AbortController().signal;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(f.store.thread("coord")!.compactError).toBe("reading its context size failed: 503 events unavailable");
    expect((await f.memory.status("initiatives:p")).problems).toContainEqual(expect.stringMatching(/Compacting "Coordinator" failed: reading its context size failed/));
    expect(f.store.compactFailures(3)).toEqual(["coord"]);
    // Not read again at once; again once the retry wait is over; the sweep stops after three.
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(reads).toBe(1);
    due(f);
    await c.afterIdle("coord", signal);
    due(f);
    await c.afterIdle("coord", signal);
    expect(reads).toBe(3);
    expect(f.store.compactFailures(3)).toEqual([]);
    // A later turn reads again; a read that works clears the problem.
    due(f);
    failing = false;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(f.store.thread("coord")).toMatchObject({ compactError: null, compactTries: 0 });
    expect((await f.memory.status("initiatives:p")).problems).toEqual([]);
  });

  it("compacts a paused Initiative's coordinator like any other (D487: no hold)", async () => {
    const f = fixture();
    await f.attach("initiatives", "p", f.thread("coord"));
    await f.configure("coord", { compactTokens: 100_000 });
    f.usage("coord", 150_000);
    await f.idle("coord");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.compacts).toEqual(["coord"]);
  });
});
