import { afterEach, describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";

// W213 (T142), D529: more work for an idle worker whose large prompt cache has gone cold is
// refused to a lead with the numbers, unless the call passes resumeCold:true; the user's own
// sends never are. Warm, small and running workers pass.
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

/** A worker that finished its first turn with a report and is idle (v9: only a report ends work). */
async function idleWorker(settings?: Record<string, number>) {
  const { f, project } = await projectFixture(settings);
  const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
  finish(f, "Done.");
  await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
  await f.runtime.onThreadIdle(f.idle(w.threadId));
  return { f, project, w };
}
async function reportAgain(f: Fx, threadId: string) {
  await tool(f, "initiative_report", { outcome: "done", summary: "Done again.", report: "Done again." }, threadId);
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
const COST = 'W1\'s cache is cold (last request 23 min ago) and its context is ~480k tokens: resuming it costs ~600k tokens of cache rewrite.';
const REFUSAL = `${COST} To send it anyway, repeat the call with resumeCold:true. Or spawn a fresh worker with handoffs:["W1"] (its report is embedded); it takes the PR over but loses what the report leaves out.`;

afterEach(() => {
  vi.useRealTimers();
});

describe("W213 cold-cache guard on work messages", () => {
  it("refuses a large cold worker with the numbers and both ways on; resumeCold:true sends it with the cost (D529)", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const before = assignments(f, project.id);
    const sends = f.send.mock.calls.length;
    await expect(tool(f, "initiative_message", { to: "W1", text: "Fix the findings.", work: true })).rejects.toThrow(REFUSAL);
    expect(assignments(f, project.id)).toBe(before);
    expect(f.send.mock.calls.length).toBe(sends);
    expect(poolerCalls(f)[0]![0].input).toEqual({ threadIds: [f.store.worker(project.id, 1)!.threadId] });

    // The explicit option sends it, and the result states what it costs.
    const [sent] = await tool(f, "initiative_message", { to: "W1", text: "Fix the findings.", work: true, resumeCold: true });
    expect(sent.warnings).toEqual([`Sent with resumeCold: ${COST}`]);
    expect(assignments(f, project.id)).toBe(before + 1);
    // A plain message has no work to resume: the option is refused there.
    await expect(tool(f, "initiative_message", { to: "W1", text: "A note.", resumeCold: true })).rejects.toThrow(/resumeCold applies to more work/);
  });

  it("a 1-hour entry is priced at twice its prefix", async () => {
    const { f } = await idleWorker();
    pooler(f, { ...cold(), ttl: "1h" });
    await expect(tool(f, "initiative_message", { to: "W1", text: "More.", work: true })).rejects.toThrow("resuming it costs ~960k tokens");
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

  it("in a batch, the refused action fails alone and resumeCold:true sends it", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const result = await tool(f, "initiative_batch", { actions: [
      { tool: "message", to: "W1", text: "Fix it.", work: true },
      { tool: "task", action: "create", title: "Follow-up" },
      { tool: "message", to: "W1", text: "Fix it.", work: true, resumeCold: true },
    ] });
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result.results[0]).toEqual({ tool: "message", ok: false, error: REFUSAL });
    expect(result.results[2]).toMatchObject({ tool: "message", ok: true, warnings: [`Sent with resumeCold: ${COST}`] });
    expect(f.store.assignments(project.id)).toHaveLength(2);
  });

  it("the coordinator's CLI refuses the same way and takes resumeCold", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    const refused = await f.harness.runCli(["message", JSON.stringify({ to: "W1", text: "More.", work: true })], { threadId: "coordinator" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain("resumeCold:true");
    const forced = await f.harness.runCli(["message", JSON.stringify({ to: "W1", text: "More.", work: true, resumeCold: true })], { threadId: "coordinator" });
    expect(forced.exitCode).toBe(0);
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
    const forced = await f.harness.runCli(["command", JSON.stringify({ ...command, resumeCold: true })], { threadId: "coordinator" });
    expect(forced.exitCode).toBe(0);
    expect(f.store.assignments(project.id)).toHaveLength(2);
  });

  it("the user's dashboard send is never refused: the operator can still resume a large cold worker", async () => {
    const { f, project } = await idleWorker();
    pooler(f, cold());
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", route: "continue", worker: "W1", note: "More." } });
    expect(f.store.assignments(project.id)).toHaveLength(2);
    expect(poolerCalls(f)).toHaveLength(0);
  });

  it("initiative_message documents the override (D529)", async () => {
    const { messageToolAdvertised } = await import("../lib/agent-tools");
    expect(Object.keys(messageToolAdvertised.shape)).toContain("resumeCold");
    expect(messageToolAdvertised.shape.resumeCold.description).toMatch(/rewrite cost/);
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
    await reportAgain(f, w.threadId);
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
      "its context is ~300k tokens: resuming it costs ~375k tokens of cache rewrite",
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

describe("W213 a BB thread lookup that never answers (D427: fail open)", () => {
  it.each([
    ["first status read", 1],
    ["final idle recheck", 2],
  ])("the guard's %s is aborted after 2 s, the work goes ahead, and it is logged once", async (_name, which) => {
    const { f, w } = await idleWorker();
    pooler(f, cold());
    // Only the guard's reads carry a signal; the chosen one hangs until it is aborted.
    const hung: AbortSignal[] = [];
    let reads = 0;
    f.intercept((path, args, call) => {
      const { threadId, signal } = (args ?? {}) as { threadId?: string; signal?: AbortSignal };
      if (path !== "threads.get" || threadId !== w.threadId || !signal || ++reads !== which) return call();
      hung.push(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const warn = vi.spyOn(f.bb.log, "warn");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = tool(f, "initiative_message", { to: "W1", text: "More.", work: true });
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await expect(sent).resolves.toBeTruthy();
    expect(hung.map(signal => signal.aborted)).toEqual([true]);
    expect(poolerCalls(f)).toHaveLength(which === 1 ? 0 : 1);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("BB's thread status is unavailable"))).toHaveLength(1);
  });
});
