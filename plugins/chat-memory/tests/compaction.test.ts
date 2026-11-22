import { describe, expect, it } from "vitest";
import { createCompaction } from "../lib/compaction";
import { fixture, type Fixture } from "./fixture";

/** A469 8 and A471 6 (W286's and W288's reviews of T145): compaction failures are visible and retried. */
const compaction = (f: Fixture, sdk: { list: () => Promise<unknown[]>; compact: () => Promise<unknown> }) =>
  createCompaction({ store: f.store, limit: (s, threadId) => f.memory.threadCompactLimit(s, threadId), log: () => {}, sdk: { threads: { events: { list: sdk.list }, compact: sdk.compact } } as never });
const usage = (usedTokens: number) => [{ seq: 7, type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens } } }];
const due = (f: Fixture) => f.store.handle.prepare(`UPDATE threads SET compact_tried_at = 0`).run();

/** A Regular memory: only a Regular one compacts (a coordinator's is OptChat). */
async function regular() {
  const f = fixture();
  await f.attach("chat-memory", "p", f.thread("coord", { title: "Coordinator" }));
  return f;
}

describe("A469 8: a failed compaction is shown and retried", () => {
  it("records it as failed, shows it, tries the same snapshot again at most three times, and clears it once one succeeds", async () => {
    const f = await regular();
    let fails = true;
    let tries = 0;
    const c = compaction(f, {
      list: async () => usage(400_000),
      compact: async () => {
        tries++;
        if (fails) throw new Error("503 BB unavailable");
        return {};
      },
    });
    const signal = new AbortController().signal;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    const status = await f.memory.status("chat-memory:p");
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
    expect((await f.memory.status("chat-memory:p")).problems).toEqual([]);
    expect(f.store.thread("coord")!.compactedAt).not.toBeNull();
  });
});

describe("A471 6: a failed read of the context size is a visible, retried compaction failure", () => {
  it("keeps the read's error on the thread, shows it, retries it within the bound, and clears it once a read works", async () => {
    const f = await regular();
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
    expect((await f.memory.status("chat-memory:p")).problems).toContainEqual(expect.stringMatching(/Compacting "Coordinator" failed: reading its context size failed/));
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
    expect((await f.memory.status("chat-memory:p")).problems).toEqual([]);
  });

  it("compacts a Regular memory past its limit (D487: no hold), and never a coordinator's OptChat one (R3)", async () => {
    const f = fixture();
    await f.attach("chat-memory", "p", f.thread("plain"));
    await f.attach("initiatives", "p", f.thread("coord"));
    for (const id of ["plain", "coord"]) {
      await f.configure(id, { compactTokens: 100_000 });
      f.usage(id, 150_000);
      await f.idle(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.compacts).toEqual(["plain"]);
  });
});

describe("W635: eligibility is rechecked after its async lookups", () => {
  /** A compaction whose limit lookup for the thread waits on `gate`, from its `nth` call on (1-based). */
  const gated = (f: Fixture, nth: number, compact: () => Promise<unknown>) => {
    let calls = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const c = createCompaction({
      store: f.store,
      limit: async (s, threadId) => {
        const limit = await f.memory.threadCompactLimit(s, threadId);
        if (++calls === nth) await gate;
        return limit;
      },
      log: () => {},
      sdk: { threads: { events: { list: async () => usage(400_000) }, compact } } as never,
    });
    return { c, open };
  };
  const agy = async () => {
    const f = fixture();
    await f.attach("initiatives", "p", f.thread("agy", { providerId: "acp-antigravity" }));
    return f;
  };

  it("retries a failed UniiChat compaction of Antigravity from the sweep, not a Claude Code one's", async () => {
    const f = fixture();
    await f.attach("initiatives", "p", f.thread("agy", { providerId: "acp-antigravity" }), f.thread("cc"));
    f.store.handle.prepare(`UPDATE threads SET compact_error = '503', compact_tries = 1`).run();
    expect(f.store.compactFailures(3).sort()).toEqual(["agy", "cc"]);
    let compacts = 0;
    const c = compaction(f, { list: async () => usage(400_000), compact: async () => (compacts++, {}) });
    const signal = new AbortController().signal;
    due(f);
    expect(await c.afterIdle("cc", signal)).toBe(false);
    expect(await c.afterIdle("agy", signal)).toBe(true);
    expect(compacts).toBe(1);
  });

  it("does not compact a thread detached while its limit was being read", async () => {
    const f = await agy();
    let compacts = 0;
    const { c, open } = gated(f, 2, async () => (compacts++, {}));
    const run = c.afterIdle("agy", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.store.handle.prepare(`UPDATE threads SET scope = NULL`).run();
    open();
    expect(await run).toBe(false);
    expect(compacts).toBe(0);
  });

  it("does not compact once aborted during the final eligibility lookup", async () => {
    const f = await agy();
    let compacts = 0;
    const abort = new AbortController();
    const { c, open } = gated(f, 2, async () => (compacts++, {}));
    const run = c.afterIdle("agy", abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    open();
    expect(await run).toBe(false);
    expect(compacts).toBe(0);
    expect(f.store.thread("agy")!.compactedSeq).toBeNull();
  });
});
