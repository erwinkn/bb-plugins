import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { manageCommands, taskCommands, workerCommands } from "../lib/commands";

// BB's Claude Code bridge advertises only object roots; anything else becomes {type:"object"}.
const INSTALLED_BRIDGE = join(homedir(), ".npm-global/lib/node_modules/bb-app/server/dist/builtin-plugins/provider-claude-code/dist/host.js");
function claudeNormalize(): (schema: unknown) => any {
  if (existsSync(INSTALLED_BRIDGE)) {
    const source = readFileSync(INSTALLED_BRIDGE, "utf8").match(/function normalizeInputSchema\(inputSchema\) \{[\s\S]*?\n\}/)?.[0];
    if (source) return new Function(`${source}; return normalizeInputSchema;`)();
  }
  return (s: any) => s !== null && typeof s === "object" && !Array.isArray(s) && s.type === "object" ? s : { type: "object" };
}
type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];
const schemaOf = (f: Fixture, name: string) => (f.harness.registrations.agentTools.find(t => t.name === name) as { inputSchema: any } | undefined)?.inputSchema;
const actions = (options: readonly { shape: { action: { value: string } } }[]) => options.map(o => o.shape.action.value);
const COMMAND_TOOLS = { task: taskCommands, manage: manageCommands, worker: workerCommands } as const;

describe("T86 every Initiative tool keeps its arguments through Claude normalization", () => {
  it("publishes object roots with visible fields for all registered tools and legacy aliases", async () => {
    const { f } = await projectFixture();
    const normalize = claudeNormalize();
    const tools = f.harness.registrations.agentTools as { name: string; inputSchema: any }[];
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["initiative_task", "project_task", "initiative_manage", "project_manage", "initiative_worker", "project_worker", "initiative_decision"]));
    for (const { name, inputSchema } of tools) {
      expect(inputSchema.type, name).toBe("object");
      for (const key of ["oneOf", "anyOf", "allOf"]) expect(inputSchema[key], `${name}.${key}`).toBeUndefined();
      expect(normalize(inputSchema), name).toBe(inputSchema);
      // The removed project_knowledge publisher always refuses and has no arguments by design.
      if (name !== "project_knowledge") expect(Object.keys(inputSchema.properties ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  it("task, manage and worker (and their aliases) advertise every action and each action's fields with real types", async () => {
    const { f } = await projectFixture();
    for (const [suffix, options] of Object.entries(COMMAND_TOOLS)) for (const name of [`initiative_${suffix}`, `project_${suffix}`]) {
      const schema = schemaOf(f, name);
      expect(schema.required, name).toEqual(["action"]);
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.properties.action.enum, name).toEqual(actions(options as never));
      for (const option of options) {
        const action = (option as { shape: { action: { value: string } } }).shape.action.value;
        for (const field of Object.keys((option as { shape: object }).shape)) expect(schema.properties, `${name} ${action}.${field}`).toHaveProperty(field);
        const required = ((option as never as { toJSONSchema: (o: object) => { required?: string[] } }).toJSONSchema({ io: "input" }).required ?? []).filter(key => key !== "action");
        for (const key of required) expect(schema.properties.action.description, `${name} ${action} requires ${key}`).toMatch(new RegExp(`${action}[^;]*\\b${key}\\b`));
      }
    }
    const task = schemaOf(f, "initiative_task");
    // Nested contracts keep their types and limits rather than collapsing to passthrough.
    expect(task.properties.report.properties.handoff.properties.workspaceRevision).toMatchObject({ type: "string", maxLength: 200 });
    expect(task.properties.reason).toMatchObject({ type: "string" });
    expect(task.properties.task.description).toMatch(/task-accept/);
    expect(schemaOf(f, "initiative_manage").properties.paused).toMatchObject({ type: "boolean" });
    expect(schemaOf(f, "initiative_worker").properties.role.enum).toEqual(expect.arrayContaining(["work", "review"]));
  });
});

describe("T86 registered tools still validate strictly per action", () => {
  const call = (f: Fixture, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });

  it("valid payloads run through the tool and its alias; cross-action and unknown fields are refused without writes", async () => {
    const { f, project } = await projectFixture();
    const created = JSON.parse(await call(f, "initiative_task", { action: "task-create", title: "Search ranking", summary: "Rank recent threads first." }) as string);
    expect(created.ref).toMatch(/^T\d+$/);
    expect(JSON.parse(await call(f, "project_task", { action: "task-update", task: created.ref, summary: "Rank recent threads first, then pinned." }) as string)).toMatchObject({ ref: created.ref });
    const before = f.store.tasks(project.id).map(t => [t.ref, t.title, t.status]);
    for (const name of ["initiative_task", "project_task"]) {
      await expect(call(f, name, { action: "task-cancel", task: created.ref, reason: "Dropped.", title: "Renamed" })).rejects.toThrow(/title/);
      await expect(call(f, name, { action: "task-cancel", task: created.ref })).rejects.toThrow(/reason/);
      await expect(call(f, name, { action: "task-delete", task: created.ref })).rejects.toThrow(/action/);
      await expect(call(f, name, { task: created.ref })).rejects.toThrow(/action/);
    }
    expect(f.store.tasks(project.id).map(t => [t.ref, t.title, t.status])).toEqual(before);
    await expect(call(f, "initiative_manage", { action: "pause", paused: true, reason: "x" })).rejects.toThrow(/reason/);
    await expect(call(f, "initiative_manage", { action: "pause" })).rejects.toThrow(/paused/);
    expect(f.store.project(project.id)?.paused).toBe(false);
    expect(JSON.parse(await call(f, "project_manage", { action: "pause", paused: true }) as string)).toBeTruthy();
    expect(f.store.project(project.id)?.paused).toBe(true);
    await expect(call(f, "initiative_worker", { action: "worker-retire", worker: "W1", reason: "Done.", role: "work" })).rejects.toThrow(/role/);
    await expect(call(f, "initiative_worker", { action: "adopt", threadId: "thr_x", role: "boss", label: "X" })).rejects.toThrow(/role/);
  });

  it("guards are unchanged: workers cannot coordinate and running workers cannot be retired", async () => {
    const { f, project } = await projectFixture();
    const [worker] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    await expect(call(f, "initiative_task", { action: "task-create", title: "T", summary: "S" }, worker.threadId!)).rejects.toThrow();
    await expect(call(f, "initiative_manage", { action: "pause", paused: true }, worker.threadId!)).rejects.toThrow();
    await expect(call(f, "initiative_worker", { action: "worker-retire", worker: worker.worker, reason: "Done." })).rejects.toThrow();
    expect(f.store.project(project.id)?.paused).toBe(false);
  });
});

describe("T86 real erwinkn.com task-update: brief sent as JSON text", () => {
  // thr_83umudet2c seq 1754/1756: identical initiative_task calls whose brief was a JSON string.
  const real = JSON.parse(readFileSync(join(__dirname, "fixtures/erwinkn-t5-task-update.json"), "utf8")).arguments as { action: string; task: string; brief: string };
  const decoded = { ...real, brief: JSON.parse(real.brief) };
  async function withT5() {
    const { f, project } = await projectFixture();
    for (let i = 0; i < 5; i++) f.task(project.id, `Task ${i + 1}`);
    const before = f.store.tasks(project.id).find(t => t.ref === real.task)!.brief;
    return { f, project, before, brief: () => f.store.tasks(project.id).find(t => t.ref === real.task)!.brief };
  }

  it("advertises brief as an object with its required nested fields", async () => {
    const { f } = await projectFixture();
    expect(typeof real.brief).toBe("string");
    for (const name of ["initiative_task", "project_task"]) {
      const brief = schemaOf(f, name).properties.brief;
      expect(brief.type, name).toBe("object");
      expect(brief.required, name).toEqual(expect.arrayContaining(["objective", "acceptanceCriteria", "areas", "verification"]));
      expect(brief.properties.areas.items.required, name).toContain("bbProjectId");
      expect(brief.description, name).toMatch(/task-update/);
    }
  });

  for (const name of ["initiative_task", "project_task"]) it(`${name}: the exact string is refused unchanged; its decoded object is recorded`, async () => {
    const { f, before, brief } = await withT5();
    await expect(f.harness.callAgentTool(name, real, { threadId: "coordinator" })).rejects.toThrow(/brief: Invalid input: expected object, received string/);
    expect(brief()).toEqual(before);
    await f.harness.callAgentTool(name, decoded, { threadId: "coordinator" });
    expect(brief()).toMatchObject(decoded.brief);
  });

  it("CLI command: the exact string is refused unchanged; its decoded object is recorded", async () => {
    const { f, project, before, brief } = await withT5();
    const refused = await f.harness.runCli(["command", JSON.stringify(real), project.id], { threadId: "coordinator" });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/brief/);
    expect(brief()).toEqual(before);
    expect((await f.harness.runCli(["command", JSON.stringify(decoded), project.id], { threadId: "coordinator" })).exitCode).toBe(0);
    expect(brief()).toMatchObject(decoded.brief);
  });
});
