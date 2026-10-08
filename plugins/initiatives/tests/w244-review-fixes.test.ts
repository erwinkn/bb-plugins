import { describe, expect, it, vi } from "vitest";
import { fixture, projectFixture } from "./fake-native";
import { FairPermits } from "../lib/memory/permits";
import { SESSION_NOTE, cacheKey } from "../lib/memory/memory";
import type { Summarizer, SummarizerResult } from "../lib/memory/summarizer";
import { sendWrite, WriteUnconfirmedError, WRITE_UNCONFIRMED_MS } from "../lib/write-timeout";

// W244: the fixes for W242's review (A421) of W239's memory setting redesign.
type Fx = ReturnType<typeof fixture>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n = 30) => { for (let k = 0; k < n; k++) await tick(); };
const seed = (f: Fx, projectId: string, n: number) =>
  f.service.memory.store.append(projectId, "none", Array.from({ length: n }, (_, i) => ({ kind: "user" as const, text: `${i}: `.padEnd(1000, "x"), at: i, threadId: "none", seq: i })), n);
const line: SummarizerResult = { ok: true, text: "summary".padEnd(300, "."), usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 };

/** A summarizer whose calls wait until released (or aborted), counting the calls in flight. */
function heldLuna() {
  const held: (() => void)[] = [];
  const luna = { active: 0, peak: 0, calls: 0, byProject: new Map<string, number>(), release: () => { for (const go of held.splice(0)) go(); } };
  const summarize: Summarizer = async (r) => {
    luna.calls++;
    luna.active++;
    luna.peak = Math.max(luna.peak, luna.active);
    r.onStart?.();
    await new Promise<void>((resolve) => {
      held.push(resolve);
      r.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    luna.active--;
    return r.signal.aborted ? { ok: false, reason: "aborted", error: "stopped" } : line;
  };
  return { luna, summarize };
}

describe("W244 a write sent again after a lost answer runs once", () => {
  it("the server answers a repeated key with the first run's answer, even while the first is still queued", async () => {
    const { f, project } = await projectFixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    f.intercept(async (path, _args, call) => {
      if (path === "threads.spawn") {
        reached();
        await gate;
      }
      return call();
    });
    // A delegate holds the write queue, as a slow native spawn does.
    const slow = f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", label: "Search", area: "search", note: "Do it." } });
    await atGate;
    const command = { action: "task-create", title: "Single intended task", summary: "Create once" } as const;
    // The first send's answer is lost; the user sends the same again with its key.
    const first = f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-1" });
    const again = f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-1" });
    release();
    await slow;
    const [a, b] = await Promise.all([first, again]);
    expect(b).toEqual(a);
    expect(f.store.tasks(project.id).map((t) => t.title)).toEqual(["Single intended task"]);
    // Once done, a repeat still gets the same answer and creates nothing.
    expect(await f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-1" })).toEqual(a);
    expect(f.store.tasks(project.id)).toHaveLength(1);
    // Without a key, or with a new one, the same command runs again: that is the user's intent.
    await f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-2" });
    expect(f.store.tasks(project.id)).toHaveLength(2);
    f.intercept();
    await f.service.memory.settled();
  });

  it("the client keeps a keyed write's key for the same content only, until an answer settles it", async () => {
    vi.useFakeTimers();
    try {
      const keys: (string | undefined)[] = [];
      const never = ({ key }: { key?: string }) => { keys.push(key); return new Promise<never>(() => {}); };
      const answer = ({ key }: { key?: string }) => { keys.push(key); return Promise.resolve({ write: "done", answer: "ok" }); };
      const task = { projectId: "p", command: { action: "task-create", title: "A" } };
      const lost = expect(sendWrite(task, never)).rejects.toBeInstanceOf(WriteUnconfirmedError);
      await vi.advanceTimersByTimeAsync(WRITE_UNCONFIRMED_MS);
      await lost;
      // The same content again: the same key, so the server runs it once.
      expect(await sendWrite(task, answer)).toBe("ok");
      expect(keys[1]).toBe(keys[0]);
      // Answered, so the next send of it is a new write with a new key.
      await sendWrite(task, answer);
      expect(keys[2]).not.toBe(keys[0]);
      // Different content is a different write.
      await sendWrite({ projectId: "p", command: { action: "task-create", title: "B" } }, answer);
      expect(new Set(keys).size).toBe(3);
      // W248: a refusal the server answers settles the key; the next send is a new write.
      await expect(sendWrite(task, async ({ key }) => { keys.push(key); return { write: "rejected", message: "no" }; })).rejects.toThrow("no");
      await sendWrite(task, answer);
      expect(keys.at(-1)).not.toBe(keys.at(-2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("W244 one Luna limit across every Initiative", () => {
  it("lets one Initiative's waiting calls in by turns, and never starts one stopped while waiting", async () => {
    const permits = new FairPermits(() => 1);
    const order: string[] = [];
    let release!: () => void;
    const first = permits.run("a", new AbortController().signal, () => new Promise<void>((resolve) => (release = resolve)));
    const work = (owner: string, k: number) => permits.run(owner, new AbortController().signal, async () => void order.push(`${owner}${k}`));
    const waiting = [work("a", 1), work("a", 2), work("a", 3), work("b", 1), work("c", 1)];
    const stop = new AbortController();
    const stopped = permits.run("b", stop.signal, async () => void order.push("never"));
    stop.abort();
    expect(await stopped).toBeNull();
    release();
    await first;
    await Promise.all(waiting);
    expect(order).toEqual(["a1", "b1", "c1", "a2", "a3"]);
    expect(permits.inFlight).toBe(0);
  });

  for (const limit of [1, 8, 16])
    it(`never runs more than memoryConcurrency (${limit}) calls across 12 Initiatives, paused ones included, and every one advances`, async () => {
      const f = fixture({ memoryConcurrency: limit });
      const { luna, summarize } = heldLuna();
      f.service.memory.useSummarizer(summarize);
      const ids = Array.from({ length: 12 }, (_, n) => `scale-${n}`);
      for (const [n, id] of ids.entries()) {
        f.store.createProject({ id, name: id, objective: "test", memberProjectIds: [], coordinatorThreadId: null });
        if (n % 2 === 0) f.store.updateProject(id, { paused: true });
        seed(f, id, 8);
        f.service.memory.build(id);
      }
      await ticks();
      expect(luna.active).toBe(limit);
      for (let round = 0; round < 2000 && ids.some((id) => f.service.memory.status(id).tree.summarized === 0 || f.service.memory.status(id).tree.state !== "idle"); round++) {
        luna.release();
        await ticks(5);
        expect(luna.active).toBeLessThanOrEqual(limit);
      }
      expect(luna.peak).toBe(limit);
      for (const id of ids) expect(f.service.memory.status(id).tree).toMatchObject({ summarized: 8, state: "idle" });
      expect(f.service.memory.permits.inFlight).toBe(0);
      f.runtime.dispose();
      await f.service.memory.settled();
    });
});

describe("W244 permits come back whatever happens to a call", () => {
  it("a refused or thrown call returns its permit, and archive or dispose while queued starts nothing", async () => {
    const f = fixture({ memoryConcurrency: 1 });
    const { luna, summarize } = heldLuna();
    for (const id of ["thrown", "holder", "queued", "later"]) {
      f.store.createProject({ id, name: id, objective: "test", memberProjectIds: [], coordinatorThreadId: null });
      seed(f, id, 2);
    }
    // A summarizer that throws ends its build, and its permit comes back.
    f.service.memory.useSummarizer(async () => { throw new Error("dropped"); });
    f.service.memory.build("thrown");
    await ticks();
    expect(f.service.memory.permits.inFlight).toBe(0);
    // Three refused calls, then calls hold until released.
    let failing = 3;
    const started: string[] = [];
    f.service.memory.useSummarizer(async (r) => (failing-- > 0 ? { ok: false, reason: "failed", error: "refused" } : (started.push(r.cacheKey), summarize(r))));
    f.service.memory.build("holder");
    await ticks();
    // The failures came back: the holder's next call has the one permit.
    expect(luna.active).toBe(1);
    expect(f.service.memory.permits.inFlight).toBe(1);
    f.service.memory.build("queued");
    f.service.memory.build("later");
    await ticks();
    expect(started).not.toContain(cacheKey("queued"));
    const before = luna.calls;
    // Archived while waiting for the permit: none of its calls ever starts.
    f.store.updateProject("queued", { archivedAt: Date.now() });
    f.service.memory.stop("queued");
    luna.release();
    await ticks();
    expect(luna.calls).toBeGreaterThan(before);
    expect(f.service.memory.permits.inFlight).toBeLessThanOrEqual(1);
    // Dispose with calls held and queued: every permit comes back, and nothing starts after.
    f.runtime.dispose();
    await f.service.memory.settled();
    const after = luna.calls;
    expect(f.service.memory.permits.inFlight).toBe(0);
    await ticks();
    expect(luna.calls).toBe(after);
    expect(started).not.toContain(cacheKey("queued"));
    expect(started).toContain(cacheKey("later"));
  });
});

describe("W244 every Initiative gets its first tree", () => {
  it("40 quiet Initiatives, paused ones included, are all read within 14 sweeps", async () => {
    const f = fixture();
    let now = 1_900_000_000_000;
    f.store.now = () => now;
    f.service.memory.useSummarizer(async () => line);
    const ids = Array.from({ length: 40 }, (_, n) => `sweep-${n}`);
    for (const [n, id] of ids.entries()) {
      f.store.createProject({ id, name: id, objective: "test", memberProjectIds: [], coordinatorThreadId: null });
      if (n % 3 === 0) f.store.updateProject(id, { paused: true });
      f.service.memory.store.append(id, "none", [{ kind: "user", text: "short", at: 0, threadId: "none", seq: 1 }], 1);
    }
    // ceil(40 / 3) sweeps, 30 s apart: before, the first 30 took every turn once they were due again.
    for (let pass = 0; pass < 14; pass++) {
      f.service.memory.sweep();
      await f.service.memory.settled();
      now += 30_000;
    }
    expect(ids.filter((id) => f.service.memory.status(id).tree.summarized === 0)).toEqual([]);
  });
});

describe("W244 archiving stops the build at once", () => {
  it("aborts the call in flight, starts no other, and its summary waiter gets false", async () => {
    const { f, project } = await projectFixture({ memoryConcurrency: 1 });
    const { luna, summarize } = heldLuna();
    f.service.memory.useSummarizer(summarize);
    seed(f, project.id, 4);
    const waiter = f.service.memory.waitSummarized(project.id, 4, new AbortController().signal);
    await ticks();
    expect(luna.active).toBe(1);
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "archive" } });
    expect(luna.active).toBe(0);
    expect(await waiter).toBe(false);
    luna.release();
    await f.service.memory.settled();
    expect(luna.calls).toBe(1);
    expect(f.service.memory.status(project.id).tree.nodes).toBe(0);
    // Nothing starts it again.
    f.service.memory.build(project.id);
    f.service.memory.sweep();
    await f.service.memory.settled();
    expect(luna.calls).toBe(1);
  });
});

describe("W244 a coordinator from before D447 may lack its memory tools", () => {
  it("outside regular mode, its status says so until the coordinator is a new one", async () => {
    const { f, project } = await projectFixture();
    // The first start of this version notes the coordinators it finds.
    f.store.db.prepare("DELETE FROM plugin_flags WHERE key LIKE 'memory-tools-legacy%'").run();
    f.service.memory.start();
    expect(f.service.memory.status(project.id).sessionNote).toBeNull();
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    expect(f.service.memory.status(project.id).sessionNote).toBe(SESSION_NOTE);
    expect((await f.overview(project.id)).memory).toMatchObject({ sessionNote: SESSION_NOTE });
    // A later start notes nothing new; a coordinator built since has its tools.
    f.store.createProject({ id: "later", name: "later", objective: "test", memberProjectIds: [], coordinatorThreadId: "later-coordinator" });
    f.service.memory.start();
    f.service.memory.configure("later", { mode: "hybrid" });
    expect(f.service.memory.status("later").sessionNote).toBeNull();
    await f.service.memory.settled();
  });
});
