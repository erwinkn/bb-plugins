import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { fixture, projectFixture, report } from "./fake-native";
import { STOPPED, eventEntries } from "../lib/memory/log";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let seq = 10_000;
const push = (f: Fx, type: string, data: Record<string, unknown>) =>
  f.history.push({ type, seq: ++seq, createdAt: seq, threadId: "coordinator", data } as never);
const log = (f: Fx, projectId: string) => f.service.memory.store.messages(projectId).map((m) => `${m.kind}: ${m.text}`);
const cli = (f: Fx, args: string[], threadId?: string) => f.harness.runCli(args, threadId ? { threadId } : {});

describe("T143 stopped turns in the memory log", () => {
  it("marks a stopped turn after what it had said; a finished turn adds nothing", async () => {
    const { f, project } = await projectFixture();
    push(f, "client/turn/requested", { direction: "outbound", source: "tell", initiator: "user", input: [{ type: "text", text: "Plan T4" }] });
    push(f, "item/completed", { item: { type: "agentMessage", id: "a1", text: "First, the" } });
    push(f, "turn/completed", { providerThreadId: "p", status: "interrupted" });
    push(f, "client/turn/requested", { direction: "outbound", source: "tell", initiator: "user", input: [{ type: "text", text: "Go on" }] });
    push(f, "item/completed", { item: { type: "agentMessage", id: "a2", text: "Done." } });
    push(f, "turn/completed", { providerThreadId: "p", status: "completed" });
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.service.memory.settled();
    expect(log(f, project.id)).toEqual(["user: Plan T4", "coord: First, the", `work: ${STOPPED}`, "user: Go on", "coord: Done."]);
  });

  it("maps only an interrupted turn/completed", () => {
    const row = (status: string) => ({ seq: 1, type: "turn/completed", createdAt: 1, data: { status } });
    expect(eventEntries(row("interrupted"), "c", () => null).map((e) => e.text)).toEqual([STOPPED]);
    expect(eventEntries(row("completed"), "c", () => null)).toEqual([]);
    expect(eventEntries(row("failed"), "c", () => null)).toEqual([]);
  });
});

describe("D452 only the user switches an Initiative's memory", () => {
  it("refuses mode and compactTokens from agent threads, lets them read it, and the user's terminal, and the generic command RPC; only setMemory writes", async () => {
    const { f, project } = await projectFixture();
    const [w] = JSON.parse((await cli(f, ["command", JSON.stringify({ action: "delegate", route: "fresh", label: "S", area: "s", note: "Do it." }), project.id], "coordinator")).stdout!);
    for (const command of [{ action: "memory", mode: "optchat" }, { action: "memory", compactTokens: 100_000 }, { action: "memory", compactTokens: null }]) {
      const refused = await cli(f, ["command", JSON.stringify(command), project.id], "coordinator");
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/Only the user changes an Initiative's memory/);
      expect((await cli(f, ["command", JSON.stringify(command), project.id], w.threadId)).exitCode).toBe(1);
    }
    expect(f.service.memory.settings(project.id)).toEqual({ mode: "regular", compactTokens: null });
    const read = await cli(f, ["command", '{"action":"memory"}', project.id], "coordinator");
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout!)).toMatchObject({ mode: "regular", sessionNote: null });
    // An agent path with author coordinator is refused at the command itself, whatever the entry point.
    await expect(f.perform(project.id, { action: "memory", mode: "hybrid" }, "coordinator", "coordinator")).rejects.toThrow(/Only the user/);
    // A terminal without a thread (no BB_THREAD_ID) is refused too: only the dashboard switches.
    for (const command of [{ action: "memory", mode: "hybrid" }, { action: "memory", compactTokens: 100_000 }, { action: "memory", compactTokens: null }]) {
      const terminal = await cli(f, ["command", JSON.stringify(command), project.id]);
      expect(terminal.exitCode).toBe(1);
      expect(terminal.stderr).toMatch(/Only the user changes an Initiative's memory, from its dashboard/);
    }
    expect(f.service.memory.settings(project.id)).toEqual({ mode: "regular", compactTokens: null });
    expect(JSON.parse((await cli(f, ["command", '{"action":"memory"}', project.id])).stdout!)).toMatchObject({ mode: "regular" });
    // The generic command RPC refuses every change, with or without a project or thread in the input
    // (an RPC carries no caller identity); reads through it still work.
    for (const command of [{ action: "memory", mode: "hybrid" }, { action: "memory", compactTokens: 100_000 }, { action: "memory", compactTokens: null }])
      for (const input of [{ projectId: project.id, command }, { command }, { projectId: project.id, threadId: "coordinator", command }])
        await expect(f.harness.callRpc("command", input)).rejects.toThrow(/Only the user changes an Initiative's memory, from its dashboard/);
    expect(f.service.memory.settings(project.id)).toEqual({ mode: "regular", compactTokens: null });
    expect(await f.harness.callRpc("command", { projectId: project.id, command: { action: "memory" } })).toMatchObject({ mode: "regular" });
    // The dashboard's setMemory RPC is the one that writes.
    expect(await f.harness.callRpc("setMemory", { projectId: project.id, mode: "hybrid" })).toMatchObject({ mode: "hybrid" });
    await f.harness.callRpc("setMemory", { projectId: project.id, compactTokens: 100_000 });
    expect(f.service.memory.settings(project.id)).toEqual({ mode: "hybrid", compactTokens: 100_000 });
    await f.harness.callRpc("setMemory", { projectId: project.id, compactTokens: null });
    expect(f.service.memory.settings(project.id)).toEqual({ mode: "hybrid", compactTokens: null });
    expect(f.store.activity(project.id).map((a) => a.summary)).toContain("Memory set to hybrid by you, from the next turn");
  });
});

describe("T143 coordinators start in full permission mode", () => {
  it("spawns a new Initiative's coordinator with permissionMode full, not the project default", async () => {
    const f = fixture();
    const result = await f.service.createProject({ name: "Search", objective: "Historical search", memberProjectIds: ["proj_a"], coordinator: { kind: "new" } });
    expect(result.note).toBeNull();
    expect(f.spawn.mock.calls[0]![0].permissionMode).toBe("full");
  });
});

describe("T143 tool surface", () => {
  it("loads zoom, read, message, spawn and batch upfront; others stay deferred", () => {
    const host = createFakePluginHost({});
    const register = vi.spyOn(host.bb.agents, "registerTool");
    const p = plugin(host.bb);
    try {
      const upfront = register.mock.calls.map(([tool]) => tool as { name: string; alwaysLoad?: boolean }).filter((tool) => tool.alwaysLoad).map((tool) => tool.name);
      expect(upfront.sort()).toEqual(["initiative_batch", "initiative_message", "initiative_read", "initiative_spawn", "initiative_zoom"]);
    } finally {
      p.runtime.dispose();
      void host.harness.dispose();
    }
  });

  it("advertises bounds but no $schema or implicit integer maximum; message hides the older target", async () => {
    const { f } = await projectFixture();
    const tools = f.harness.registrations.agentTools as { name: string; inputSchema: unknown }[];
    for (const { name, inputSchema } of tools.filter((t) => t.name.startsWith("initiative_")))
      expect(JSON.stringify(inputSchema), name).not.toMatch(/"\$schema"|9007199254740991/);
    // W262: a bound the tool enforces is one the agent can see before preparing a 20,001-character brief.
    const spawn = (tools.find((t) => t.name === "initiative_spawn")!.inputSchema as { properties: Record<string, object> }).properties;
    expect(spawn.text).toMatchObject({ type: "string", maxLength: 20000 });
    expect(spawn.tasks).toMatchObject({ type: "array", maxItems: 30 });
    await expect(f.harness.callAgentTool("initiative_spawn", { label: "l", purpose: "p", text: "x".repeat(20001) }, { threadId: "coordinator" })).rejects.toThrow(/text/);
    expect((tools.find((t) => t.name === "initiative_message")!.inputSchema as { properties: object }).properties).not.toHaveProperty("target");
    await expect(f.harness.callAgentTool("initiative_spawn", { label: "x".repeat(201), purpose: "p", text: "t" }, { threadId: "coordinator" })).rejects.toThrow(/label/);
    // An older session's target is still read: it resolves (to the caller itself, here).
    await expect(f.harness.callAgentTool("initiative_message", { target: "coordinator", text: "hi" }, { threadId: "coordinator" })).rejects.toThrow(/yourself/);
  });
});

describe("T143 In flight: each assignment is its own", () => {
  it("never writes or repeats \"With W#\" as the task's progress", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: "Fork", area: "fork" });
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: "Plugin", area: "plugin" });
    expect(f.store.task(project.id, task.num)!.progress).toBeNull();
    const inFlight = (await f.overview(project.id)).inFlight;
    expect(inFlight.map((a) => [a.owner.worker, a.owner.label])).toEqual([["W1", "Fork"], ["W2", "Plugin"]]);
    // A task recorded before T143 still carries the old text; it is not shown as progress.
    f.store.updateTask(project.id, task.num, { progress: "With W1" });
    expect((await f.overview(project.id)).inFlight.map((a) => a.progress)).not.toContain("With W1");
  });

  it("names each assignment by its own brief: a queued continuation's staged rename is not the worker's label yet (W262)", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [first] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: "Old worker label", area: "first" });
    // A1 has reported but its turn is still finishing, so it stays in flight while A2 waits in the queue.
    await f.service.report(first.threadId!, report());
    f.queueSend("q-rename");
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [task.ref], label: "New assignment label", area: "second" });
    const inFlight = (await f.overview(project.id)).inFlight;
    expect(inFlight.map((a) => [a.assignment, a.state, a.owner.label, a.brief])).toEqual([
      ["A1", "reported", "Old worker label", "Old worker label"],
      ["A2", "queued", "Old worker label", "New assignment label"],
    ]);
  });
});

describe("T143 an assignment is named by its recorded identity, not by parsing its brief", () => {
  it("shows a queued continuation's staged label whole, quotes and parentheses included, while the worker keeps the old one", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [first] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: "Old label", area: 'fix the "cache" (again) bug' });
    await f.service.report(first.threadId!, report());
    f.queueSend("q-quoted");
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [task.ref], label: 'Renamed "cache" (v2)', area: 'fix "x" (y) · work' });
    const inFlight = (await f.overview(project.id)).inFlight;
    expect(inFlight.map((a) => [a.assignment, a.state, a.owner.label, a.brief])).toEqual([
      ["A1", "reported", "Old label", "Old label"],
      ["A2", "queued", "Old label", 'Renamed "cache" (v2)'],
    ]);
  });

  it("keeps A1's own label once A2's rename is delivered and the worker takes the new one", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [first] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: 'Old "cache" (v1)', area: "first" });
    await f.service.report(first.threadId!, report());
    f.queueSend("q-delivered");
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [task.ref], label: 'Renamed "cache" (v2)', area: "second" });
    f.runtime.onMessageDispatched("q-delivered");
    expect(f.store.worker(project.id, 1)!.label).toBe('Renamed "cache" (v2)');
    const inFlight = (await f.overview(project.id)).inFlight;
    expect(inFlight.map((a) => [a.assignment, a.owner.label, a.brief])).toEqual([
      ["A1", 'Renamed "cache" (v2)', 'Old "cache" (v1)'],
      ["A2", 'Renamed "cache" (v2)', 'Renamed "cache" (v2)'],
    ]);
  });
});
