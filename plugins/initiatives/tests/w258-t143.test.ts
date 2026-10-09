import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { fixture, projectFixture, report } from "./fake-native";
import { REMOVED_ACTIONS } from "../lib/commands";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const cli = (f: Fx, args: string[], threadId?: string) => f.harness.runCli(args, threadId ? { threadId } : {});

describe("T145 memory moved to the Chat memory plugin", () => {
  it("refuses the memory command everywhere, with where it went; owns no turn hook; gives coordinators no memory tool", async () => {
    const { f, project } = await projectFixture();
    for (const command of [{ action: "memory" }, { action: "memory", mode: "optchat" }]) {
      const refused = await cli(f, ["command", JSON.stringify(command), project.id], "coordinator");
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(REMOVED_ACTIONS.memory);
      await expect(f.harness.callRpc("command", { projectId: project.id, command })).rejects.toThrow();
    }
    expect((await cli(f, ["zoom", "0", "1", project.id], "coordinator")).exitCode).not.toBe(0);
    const names = (f.harness.registrations.agentTools as { name: string }[]).map((t) => t.name);
    // initiative_zoom stays only as the retained sessions' alias (A469); the hook is Chat memory's.
    expect(names.filter((n) => /zoom|turn_context/.test(n))).toEqual(["initiative_zoom"]);
    const config = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "coordinator", title: null, parentThreadId: null, sourceThreadId: null } } as never));
    expect(config.tools.map((t) => t.name)).not.toContain("initiative_zoom");
    expect(config.instructions).not.toMatch(/memory/i);
  });

  it("tells the Chat memory plugin each Initiative's threads: its coordinator, a coordinator being started, none once archived", async () => {
    const { f, project } = await projectFixture();
    const sent = () => f.pluginRpc.mock.calls.map(([a]) => a).filter((a) => a.pluginId === "chat-memory");
    // Any ledger change syncs (the fixture wrote this one directly); so does every sweep.
    await f.memoryScopes.sync(project.id);
    expect(sent().at(-1)).toMatchObject({ method: "setScope", input: { key: project.id, threads: ["coordinator"] } });
    // Nothing changed: nothing is sent again.
    const count = sent().length;
    await f.memoryScopes.sync(project.id);
    expect(sent()).toHaveLength(count);
    // A replacement being started shares the memory before its start is confirmed.
    f.store.db.prepare("INSERT INTO coordinator_starts (project_id, op_id, state, thread_id, created_at) VALUES (?, 'op_x', 'pending', 'next', 1) ON CONFLICT (project_id) DO UPDATE SET op_id = 'op_x', state = 'pending', thread_id = 'next'").run(project.id);
    await f.memoryScopes.sync(project.id);
    expect(sent().at(-1)).toMatchObject({ input: { key: project.id, threads: ["coordinator", "next"] } });
    // A send that fails goes again at the next sync.
    f.pluginRpc.mockRejectedValueOnce(new Error("plugin chat-memory is reloading"));
    f.store.db.prepare("UPDATE coordinator_starts SET state = 'failed' WHERE project_id = ?").run(project.id);
    await f.memoryScopes.sync(project.id);
    await f.memoryScopes.sync(project.id);
    expect(sent().at(-1)).toMatchObject({ input: { threads: ["coordinator"] } });
    f.store.updateProject(project.id, { archivedAt: Date.now() });
    await f.memoryScopes.sync(project.id);
    expect(sent().at(-1)).toMatchObject({ input: { key: project.id, threads: [] } });
  });
});

describe("A469 retained sessions and the Chat memory plugin", () => {
  it("keeps initiative_read {view:\"memory\"} and initiative_zoom as read-only aliases of Chat memory's read and zoom", async () => {
    const { f } = await projectFixture();
    const view = { messages: 2, view: "0+2|user: hi; agent: hello", note: "One line per summary" };
    f.pluginRpc.mockImplementation(async (args) => (args.method === "read" ? view : args.method === "zoom" ? "2026-10-08 12:00Z 0+1|user: hi" : { ok: true }));
    expect(JSON.parse((await f.harness.callAgentTool("initiative_read", { view: "memory" }, { threadId: "coordinator" })) as string)).toEqual(view);
    expect(await f.harness.callAgentTool("initiative_zoom", { id: 0, n: 1 }, { threadId: "coordinator" })).toBe("2026-10-08 12:00Z 0+1|user: hi");
    const calls = f.pluginRpc.mock.calls.map(([a]) => a).filter((a) => a.pluginId === "chat-memory" && a.method !== "setScope");
    expect(calls).toEqual([
      expect.objectContaining({ method: "read", input: { threadId: "coordinator" } }),
      expect.objectContaining({ method: "zoom", input: { threadId: "coordinator", id: 0, n: 1 } }),
    ]);
  });

  it("never leaves an in-flight membership as the last one sent when the ledger changed meanwhile (W286's race)", async () => {
    const { f, project } = await projectFixture();
    const sent: Array<{ threads: string[] }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.pluginRpc.mockImplementation(async (args) => {
      const input = args.input as { threads: string[] };
      sent.push(input);
      if (input.threads.includes("pending")) await held;
      return { scope: `initiatives:${project.id}` };
    });
    await f.memoryScopes.sync(project.id);
    f.store.db.prepare("INSERT INTO coordinator_starts (project_id, op_id, state, thread_id, created_at) VALUES (?, 'op_probe', 'pending', 'pending', 1) ON CONFLICT(project_id) DO UPDATE SET state = 'pending', thread_id = 'pending'").run(project.id);
    const pending = f.memoryScopes.sync(project.id);
    await Promise.resolve();
    await Promise.resolve();
    // The start fails while [coordinator, pending] is still on its way.
    f.store.db.prepare("UPDATE coordinator_starts SET state = 'failed' WHERE project_id = ?").run(project.id);
    const latest = f.memoryScopes.sync(project.id);
    release();
    await Promise.all([pending, latest]);
    expect(f.memoryScopes.threads(project.id)).toEqual(["coordinator"]);
    expect(sent.at(-1)!.threads).toEqual(["coordinator"]);
  });

  it("holds the Initiative's automatic compaction while it is paused (the pause guard, through the plugin boundary)", async () => {
    const { f, project } = await projectFixture();
    const last = () => f.pluginRpc.mock.calls.map(([a]) => a).filter((a) => a.method === "setScope").at(-1)?.input;
    await f.memoryScopes.sync(project.id);
    expect(last()).toEqual({ key: project.id, threads: ["coordinator"], hold: false });
    f.service.setPaused(project.id, true);
    await f.memoryScopes.sync(project.id);
    expect(last()).toEqual({ key: project.id, threads: ["coordinator"], hold: true });
    f.service.setPaused(project.id, false);
    await f.memoryScopes.sync(project.id);
    expect(last()).toMatchObject({ hold: false });
  });

  it("names the memory a new coordinator joins in its spawn metadata, for Chat memory to wait for its registration", async () => {
    const f = fixture();
    await f.service.createProject({ name: "Search", objective: "Historical search", memberProjectIds: ["proj_a"], coordinator: { kind: "new" } });
    const metadata = f.spawn.mock.calls[0]![0].pluginMetadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ role: "coordinator", memoryScope: metadata.projectId });
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
  it("loads read, message, spawn and batch upfront; others stay deferred (memory_zoom and memory_read are Chat memory's)", () => {
    const host = createFakePluginHost({});
    const register = vi.spyOn(host.bb.agents, "registerTool");
    const p = plugin(host.bb);
    try {
      const upfront = register.mock.calls.map(([tool]) => tool as { name: string; alwaysLoad?: boolean }).filter((tool) => tool.alwaysLoad).map((tool) => tool.name);
      expect(upfront.sort()).toEqual(["initiative_batch", "initiative_message", "initiative_read", "initiative_spawn"]);
      void p;
    } finally {
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
