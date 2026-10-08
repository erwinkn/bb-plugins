import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import type { Summarizer, SummarizerRequest } from "../lib/memory/summarizer";

// W239 (D447): one memory setting per Initiative, switchable at will. The tree builds in every
// mode; a switch from the dashboard never waits behind other writes; the memory's own progress
// reaches the dashboards at most every 30 s per Initiative.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let seq = 700_000;
let at = 1_790_000_000_000;
const say = (f: Fx, text: string) =>
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: ++at, threadId: "coordinator", data: { direction: "outbound", source: "tell", initiator: "user", input: [{ type: "text", text }] } } as never);
const fakeLuna: Summarizer = async (r: SummarizerRequest) => {
  const task = (r.input[0]!.content[1] as { text: string }).text;
  return { ok: true, text: `summary ${task.length} `.padEnd(300, "."), usage: { input: 2000, cached: 1500, output: 100, reasoning: 50 }, latencyMs: 1 };
};

describe("W239 memory setting", () => {
  it("a dashboard switch answers at once while a slow write holds the write queue", async () => {
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
    const slow = f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", label: "Search", area: "search", note: "Do it." } });
    await atGate;
    const switched = await f.harness.callRpc("setMemory", { projectId: project.id, mode: "hybrid" });
    expect(switched).toMatchObject({ mode: "hybrid", compactTokens: 150_000 });
    release();
    await slow;
    f.intercept();
    await f.service.memory.settled();
  });

  it("a switch applies from the next turn: the next idle compacts at the new mode's limit", async () => {
    const { f, project } = await projectFixture();
    f.service.memory.useSummarizer(fakeLuna);
    const turnEnds = (usedTokens: number) =>
      f.history.push({ type: "thread/contextWindowUsage/updated", seq: ++seq, createdAt: Date.now(), threadId: "coordinator", data: { contextWindowUsage: { usedTokens, modelContextWindow: 1_000_000, estimated: true } } } as never);
    await f.harness.callRpc("setMemory", { projectId: project.id, mode: "hybrid" });
    await f.harness.callRpc("setMemory", { projectId: project.id, mode: "regular" });
    turnEnds(200_000);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.runtime.compactionsSettled();
    expect(f.compact).not.toHaveBeenCalled();
    await f.harness.callRpc("setMemory", { projectId: project.id, mode: "hybrid" });
    turnEnds(210_000);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.runtime.compactionsSettled();
    expect(f.compact).toHaveBeenCalledTimes(1);
    await f.service.memory.settled();
  });

  it("publishes the memory's own progress at most every 30 s per Initiative", async () => {
    const { f, project } = await projectFixture();
    f.service.memory.useSummarizer(fakeLuna);
    const memorySignals = () => f.harness.inspection.realtimeSignals.filter((s) => s.channel === "initiatives-changed" && (s.payload as { projectId?: string })?.projectId === project.id).length;
    let now = Date.now();
    f.store.now = () => now;
    const before = memorySignals();
    for (let n = 0; n < 5; n++) {
      say(f, `message ${n}`);
      f.service.memory.kick(project.id);
      await f.service.memory.settled();
    }
    expect(memorySignals() - before).toBe(1);
    now += 30_000;
    say(f, "later");
    f.service.memory.kick(project.id);
    await f.service.memory.settled();
    expect(memorySignals() - before).toBe(2);
    expect(f.service.memory.status(project.id).tree.summarized).toBe(6);
  });
});
