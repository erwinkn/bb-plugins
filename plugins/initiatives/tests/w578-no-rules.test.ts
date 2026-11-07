import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS } from "../lib/guidance";

// W578 (Erwin: "let's just remove the rules"): no standing rules in briefs, work messages,
// instructions or tools. The rules table stays, unread, for rollback.

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const configure = (f: Fx, threadId: string) =>
  f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)! }));
const RULES = /Standing rules|initiative_rule|view:"rules"|Rule … changed/;

describe("W578 standing rules are gone", () => {
  it("a brief and a work message carry no rules section, even with rows left in the rules table", async () => {
    const { f, project } = await projectFixture();
    // A row the previous build wrote: nothing reads it now.
    f.store.db.prepare("INSERT INTO rules (project_id, num, text, position, sources, created_at, updated_at) VALUES (?, 1, 'Every PR targets dev.', 1, '[]', 1, 1)").run(project.id);
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    const brief = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(brief).toContain("Reviewer command");
    expect(brief).not.toMatch(RULES);
    expect(brief).not.toContain("Every PR targets dev.");
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.send.mockClear();
    await tool(f, "initiative_message", { to: "W1", text: "One more pass.", work: true });
    const work = f.send.mock.calls.map(([a]) => a).filter((a) => a.threadId === w.threadId).at(-1)!.input[0].text as string;
    expect(work).toContain("How you work in this Initiative");
    expect(work).not.toMatch(RULES);
    expect(work).not.toContain("Every PR targets dev.");
    // The coordinator's and the worker's instructions carry no rules pointer either.
    for (const threadId of ["coordinator", w.threadId]) expect((await configure(f, threadId)).instructions, threadId).not.toMatch(RULES);
  });

  it("no initiative_rule tool, rules view, rule commands or rules CLI", async () => {
    const { f, project } = await projectFixture();
    expect(f.harness.registrations.agentTools.map((t) => t.name)).not.toContain("initiative_rule");
    expect((await configure(f, "coordinator")).tools.map((t) => t.name)).not.toContain("initiative_rule");
    for (const t of f.harness.registrations.agentTools) expect(t.description ?? "", t.name).not.toMatch(RULES);
    await expect(tool(f, "initiative_read", { view: "rules" })).rejects.toThrow();
    await expect(tool(f, "initiative_batch", { actions: [{ tool: "rule", action: "add", text: "x" }] })).rejects.toThrow();
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "rule-add", text: "x" } })).rejects.toThrow();
    expect((await f.harness.runCli(["command", JSON.stringify({ action: "rule-add", text: "x" }), project.id])).exitCode).not.toBe(0);
    expect((await f.harness.runCli(["rules", "export", project.id])).exitCode).not.toBe(0);
    expect((await f.harness.runCli(["read", "rules", project.id])).exitCode).not.toBe(0);
    expect("rules" in (await f.overview(project.id))).toBe(false);
  });

  it("the default guidance points lasting choices at the repo's docs", () => {
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("A lasting choice goes in the repo's docs or `AGENTS.md`; a choice about one PR goes in its brief.");
    for (const text of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) expect(text).not.toMatch(/standing rule|initiative_rule|Reversible/i);
  });
});
