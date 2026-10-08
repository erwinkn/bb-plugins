import { afterEach, describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";

// W213 (T142): more work for an idle worker whose large prompt cache has gone cold is refused
// with the numbers and a fresh-worker alternative; warm, small and running workers pass.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const MINUTE = 60_000;
let seq = 200000;

function finish(f: Fx, text: string) {
  const brief = (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as { brief_text: string }).brief_text;
  const requestId = `creq_${++seq}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId, initiator: "agent", input: [{ type: "text", text: brief }] } });
  f.history.push({ type: "turn/started", seq: ++seq, createdAt: Date.now() });
  f.history.push({ type: "turn/input/accepted", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: requestId } });
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: Date.now(), data: { item: { type: "agentMessage", text } } });
  f.history.push({ type: "turn/completed", seq: ++seq, createdAt: Date.now(), data: { status: "completed" } });
}

/** A worker (and, with review, its reviewer as W2) that finished its first turn and is idle. */
async function idleWorker(settings?: Record<string, number>, review = false) {
  const { f, project } = await projectFixture(settings);
  const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
  finish(f, "Done.");
  await f.runtime.onThreadIdle(f.idle(w.threadId));
  if (!review) return { f, project, w };
  const [r] = await tool(f, "initiative_spawn", { role: "review", label: "Review", purpose: "review search", reviews: "W1", text: "Review it." });
  finish(f, "Two findings.");
  await f.runtime.onThreadIdle(f.idle(r.threadId));
  return { f, project, w: r };
}

type Cache = { lastRequestAt: number; prefixTokens: number; ttl: "5m" | "1h"; coveredUntil: number };
/** The Account Pooler's threads.cacheState for every asked thread. */
function pooler(f: Fx, cache: Cache | null | (() => Promise<never>)) {
  f.pluginRpc.mockImplementation(async (args: { pluginId: string; method: string; input?: unknown }) => {
    if (args.pluginId !== "account-pool-local") return { ok: true };
    expect(args.method).toBe("threads.cacheState");
    if (typeof cache === "function") return cache();
    const { threadIds } = args.input as { threadIds: string[] };
    return {
      threads: threadIds.map(threadId => ({
        threadId,
        cache: cache && { sessionId: "s1", model: "claude-opus-5-5", leased: false, ...cache },
      })),
    };
  });
}
const poolerCalls = (f: Fx) => f.pluginRpc.mock.calls.filter(([args]) => args.pluginId === "account-pool-local");
const cold = (now = Date.now()): Cache => ({ lastRequestAt: now - 23 * MINUTE, prefixTokens: 480_000, ttl: "5m", coveredUntil: now - 18 * MINUTE });
const assignments = (f: Fx, projectId: string) => f.store.assignments(projectId).length;
const REFUSAL = 'W1\'s cache is cold (last request 23 min ago) and its context is ~480k tokens: resuming costs ~600k tokens of cache rewrite. Spawn a fresh worker with handoffs:["W1"] (its report is embedded), or pass resumeCold:true to resume anyway.';

afterEach(() => {
  vi.useRealTimers();
});

describe("W213 cold-cache guard on work messages", () => {
  it("refuses a large cold worker with the numbers and alternatives; resumeCold:true sends it", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const before = assignments(f, project.id);
    await expect(tool(f, "initiative_message", { to: "W1", text: "Fix the findings.", work: true })).rejects.toThrow(REFUSAL);
    expect(assignments(f, project.id)).toBe(before);
    expect(f.send).not.toHaveBeenCalled();
    expect(poolerCalls(f)[0]![0].input).toEqual({ threadIds: [f.store.worker(project.id, 1)!.threadId] });

    const [sent] = await tool(f, "initiative_message", { to: "W1", text: "Fix the findings.", tasks: [], work: true, resumeCold: true });
    expect(sent).toMatchObject({ worker: "W1" });
    expect(assignments(f, project.id)).toBe(before + 1);
  });

  it("a 1-hour entry is priced at twice its prefix", async () => {
    const { f } = await idleWorker();
    pooler(f, { ...cold(), ttl: "1h" });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).rejects.toThrow("resuming costs ~960k tokens");
  });

  it("passes warm, leased and small workers, and plain messages without asking", async () => {
    const now = Date.now();
    for (const cache of [
      { ...cold(now), coveredUntil: now + 2 * MINUTE },
      { lastRequestAt: now - 50 * MINUTE, prefixTokens: 480_000, ttl: "5m" as const, coveredUntil: now + 4 * MINUTE },
      { ...cold(now), prefixTokens: 150_000 },
    ]) {
      const { f, project } = await idleWorker();
      pooler(f, cache);
      const [sent] = await tool(f, "initiative_message", { to: "W1", text: "More.", work: true });
      expect(sent).toMatchObject({ worker: "W1" });
      expect(f.store.assignments(project.id)).toHaveLength(2);
    }
    const { f } = await idleWorker();
    pooler(f, cold());
    await tool(f, "initiative_message", { to: "W1", text: "Just a note." });
    expect(poolerCalls(f)).toHaveLength(0);
  });

  it("passes a running worker without asking the Pooler", async () => {
    const { f, w } = await idleWorker();
    pooler(f, cold());
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, status: "active" });
    await expect(tool(f, "initiative_message", { to: "W1", text: "Queue this.", work: true })).resolves.toBeTruthy();
    expect(poolerCalls(f)).toHaveLength(0);
  });

  it("the threshold is a setting; 0 turns the check off", async () => {
    for (const [limit, refused] of [[500_000, false], [400_000, true], [0, false]] as const) {
      const { f } = await idleWorker({ coldResumeTokens: limit });
      pooler(f, cold());
      const sent = tool(f, "initiative_message", { to: "W1", text: "More.", work: true });
      if (refused) await expect(sent).rejects.toThrow("cache is cold");
      else await expect(sent).resolves.toBeTruthy();
    }
  });

  it("a reviewer, cold or warm, is refused before the cache check: reviews are not reused (W239)", async () => {
    const { f } = await idleWorker(undefined, true);
    pooler(f, cold());
    await expect(tool(f, "initiative_message", { to: "W2", text: "Re-review.", work: true })).rejects.toThrow(/^W2 is a reviewer, and reviews are not reused/);
    await expect(tool(f, "initiative_message", { to: "W2", text: "Re-review.", work: true, resumeCold: true })).rejects.toThrow(/reviews are not reused/);
    pooler(f, { ...cold(), prefixTokens: 90_000 });
    await expect(tool(f, "initiative_message", { to: "W2", text: "Re-review.", work: true })).rejects.toThrow(/reviews are not reused/);
  });

  it("in a batch, the refused action fails alone and resumeCold sends it", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const result = await tool(f, "initiative_batch", { actions: [
      { tool: "message", to: "W1", text: "Fix it.", work: true },
      { tool: "task", action: "create", title: "Follow-up" },
      { tool: "message", to: "W1", text: "Fix it.", work: true, resumeCold: true },
    ] });
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result.results[0]).toEqual({ tool: "message", ok: false, error: REFUSAL });
    expect(result.results[2]).toMatchObject({ tool: "message", ok: true });
    expect(f.store.assignments(project.id)).toHaveLength(2);
  });

  it("the coordinator's CLI refuses the same way and accepts resumeCold", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const refused = await f.harness.runCli(["message", JSON.stringify({ to: "W1", text: "More.", work: true })], { threadId: "coordinator" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain("resumeCold:true");
    const sent = await f.harness.runCli(["message", JSON.stringify({ to: "W1", text: "More.", work: true, resumeCold: true })], { threadId: "coordinator" });
    expect(sent.exitCode).toBe(0);
    expect(f.store.assignments(project.id)).toHaveLength(2);
  });
});

/** BB's context record for the worker, as the runtime samples it. */
function context(f: Fx, projectId: string, threadId: string, record: { used: number; observedAt: number; changedAt?: number }) {
  f.store.saveUsage({
    threadId, projectId, workerNum: 1, lastSeq: 1, providerThreadId: null, sessionTotals: null,
    closedTotals: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 }, resets: 0, lastReportAt: null,
    contextUsed: record.used, contextWindow: 1_000_000, model: null,
    contextObservedAt: record.observedAt, contextChangedAt: record.changedAt ?? null,
  });
}

describe("W213 every coordinator path, and never the user's", () => {
  it("bb initiative command delegate/continue and the legacy initiative_delegate are refused; resumeCold passes", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const command = { action: "delegate", route: "continue", worker: "W1", note: "More." };
    const refused = await f.harness.runCli(["command", JSON.stringify(command)], { threadId: "coordinator" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain(REFUSAL);
    await expect(tool(f, "initiative_delegate", { route: "continue", worker: "W1", note: "More." })).rejects.toThrow(REFUSAL);
    expect(f.store.assignments(project.id)).toHaveLength(1);
    const sent = await f.harness.runCli(["command", JSON.stringify({ ...command, resumeCold: true })], { threadId: "coordinator" });
    expect(sent.exitCode).toBe(0);
    expect(f.store.assignments(project.id)).toHaveLength(2);
  });

  it("the user's dashboard send is never refused", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", route: "continue", worker: "W1", note: "More." } });
    expect(f.store.assignments(project.id)).toHaveLength(2);
    expect(poolerCalls(f)).toHaveLength(0);
  });

  it("resumeCold belongs to more work for an existing worker", async () => {
    const { f } = await idleWorker();
    await expect(tool(f, "initiative_delegate", { route: "fresh", label: "New", area: "new", note: "Go.", resumeCold: true })).rejects.toThrow("resumeCold applies only to more work for an existing worker");
  });
});

describe("W213 without the Pooler's answer (D426: fail open)", () => {
  it("an absent Pooler never blocks, and is logged once", async () => {
    const { f, project, w } = await idleWorker();
    pooler(f, async () => { throw Object.assign(new Error('plugin "account-pool-local" is not installed'), { status: 404 }); });
    // BB alone says the context is large and long idle; that is not enough to refuse.
    context(f, project.id, w.threadId, { used: 600_000, observedAt: Date.now() - 3 * 60 * MINUTE });
    const warn = vi.spyOn(f.bb.log, "warn");
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).resolves.toBeTruthy();
    finish(f, "Done again.");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).resolves.toBeTruthy();
    expect(warn.mock.calls.filter(([message]) => String(message).includes("Account Pooler's cache state is unavailable"))).toHaveLength(1);
  });

  it("a Pooler slower than 2 s is abandoned and the work goes ahead", async () => {
    const { f } = await idleWorker();
    pooler(f, () => new Promise<never>(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = tool(f, "initiative_message", { to: "W1", text: "More.", work: true });
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await expect(sent).resolves.toBeTruthy();
  });

  it("a thread the Pooler has no record of goes ahead, however large BB says it is", async () => {
    const { f, project, w } = await idleWorker();
    pooler(f, null);
    context(f, project.id, w.threadId, { used: 600_000, observedAt: Date.now() - 3 * 60 * MINUTE });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).resolves.toBeTruthy();
  });
});

describe("W213 BB's context record and the worker's state", () => {
  it("a context snapshot after the Pooler's last request gives the current, smaller size", async () => {
    const now = Date.now();
    const { f, project, w } = await idleWorker();
    pooler(f, cold(now));
    context(f, project.id, w.threadId, { used: 120_000, observedAt: now - 20 * MINUTE, changedAt: now - 21 * MINUTE });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).resolves.toBeTruthy();
    // Still large after the compaction: refused with BB's size.
    const second = await idleWorker();
    pooler(second.f, cold(now));
    context(second.f, second.project.id, second.w.threadId, { used: 300_000, observedAt: now - 20 * MINUTE });
    await expect(tool(second.f, "initiative_message", { to: "W1", text: "More.", work: true })).rejects.toThrow(
      "its context is ~300k tokens: resuming costs ~375k tokens of cache rewrite",
    );
  });

  it("a compaction after the last request with no snapshot since leaves the size unknown: go ahead", async () => {
    const now = Date.now();
    const { f, project, w } = await idleWorker();
    pooler(f, cold(now));
    context(f, project.id, w.threadId, { used: 480_000, observedAt: now - 30 * MINUTE, changedAt: now - 20 * MINUTE });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).resolves.toBeTruthy();
  });

  it("an older snapshot does not override the Pooler's size", async () => {
    const now = Date.now();
    const { f, project, w } = await idleWorker();
    pooler(f, cold(now));
    context(f, project.id, w.threadId, { used: 90_000, observedAt: now - 60 * MINUTE });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).rejects.toThrow(REFUSAL);
  });

  it("a worker that starts a turn while the Pooler answers is not refused", async () => {
    const { f, w } = await idleWorker();
    pooler(f, cold());
    let reads = 0;
    f.intercept((path, args, call) => {
      if (path !== "threads.get" || args.threadId !== w.threadId) return call();
      // Idle for the guard's first read, running from then on.
      if (++reads === 1) return call();
      return (call() as Promise<object>).then(thread => ({ ...thread, status: "active" }));
    });
    await expect(tool(f, "initiative_message", { to: "W1", text: "Queue this.", work: true })).resolves.toBeTruthy();
    expect(poolerCalls(f)).toHaveLength(1);
  });
});
