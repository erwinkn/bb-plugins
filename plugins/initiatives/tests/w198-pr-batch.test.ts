import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { MIGRATIONS, Store } from "../lib/store";
import { canonicalPrUrl } from "../lib/pr-stages";

const PR = "https://github.com/erwinkn/bb-plugins/pull/68";
const call = async (f: Awaited<ReturnType<typeof projectFixture>>["f"], tool: string, input: unknown, threadId = "coordinator") =>
  JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);

describe("W198 PR stages", () => {
  it("canonicalizes PR URLs and owner/repo#N", () => {
    expect(canonicalPrUrl("https://github.com/ErwinKN/bb-plugins/pull/68/files?diff=split#r1")).toBe(PR);
    expect(canonicalPrUrl("erwinkn/bb-plugins#68")).toBe(PR);
    expect(canonicalPrUrl("http://www.github.com/erwinkn/bb-plugins/pull/068")).toBe(PR);
    expect(canonicalPrUrl("https://github.com/erwinkn/bb-plugins/issues/68")).toBeNull();
    expect(canonicalPrUrl("68")).toBeNull();
  });

  it("initiative_pr sets several stages in one call, clears one, and refuses bad input", async () => {
    const { f, project } = await projectFixture();
    const result = await call(f, "initiative_pr", { prs: [
      { url: "https://github.com/ErwinKN/bb-plugins/pull/68/files", stage: "in-review", note: "W14 reviewing" },
      { url: "erwinkn/bb#12", stage: "ready-for-erwin" },
    ] });
    expect(result).toEqual({ prs: [
      { url: PR, stage: "in-review", note: "W14 reviewing" },
      { url: "https://github.com/erwinkn/bb/pull/12", stage: "ready-for-erwin" },
    ] });
    const stages = f.store.prStages(project.id);
    expect(stages.get(PR)).toMatchObject({ stage: "in-review", note: "W14 reviewing" });
    expect(stages.get(PR)!.setAt).toBeGreaterThan(0);
    // A later stage replaces the earlier one and its note.
    await call(f, "initiative_pr", { prs: [{ url: PR, stage: "ready-for-erwin" }] });
    expect(f.store.prStages(project.id).get(PR)).toMatchObject({ stage: "ready-for-erwin", note: null });
    await call(f, "initiative_pr", { prs: [{ url: PR, stage: "clear" }] });
    expect([...f.store.prStages(project.id).keys()]).toEqual(["https://github.com/erwinkn/bb/pull/12"]);

    await expect(call(f, "initiative_pr", { prs: [{ url: PR, stage: "merged" }] })).rejects.toThrow(/Invalid arguments for initiative_pr: prs\.0\.stage/);
    await expect(call(f, "initiative_pr", { prs: [{ url: "https://github.com/erwinkn/bb-plugins/issues/3", stage: "working" }] })).rejects.toThrow(/GitHub PR URL/);
    await expect(call(f, "initiative_pr", { prs: [] })).rejects.toThrow(/prs/);
    // A bad entry stores none of the call's entries.
    await expect(call(f, "initiative_pr", { prs: [{ url: PR, stage: "working" }, { url: "nope", stage: "working" }] })).rejects.toThrow();
    expect(f.store.prStages(project.id).has(PR)).toBe(false);
  });

  it("is the coordinator's: a worker cannot set stages, through the tool or the CLI", async () => {
    const { f } = await projectFixture();
    const [w] = await call(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await expect(call(f, "initiative_pr", { prs: [{ url: PR, stage: "working" }] }, w.threadId)).rejects.toThrow(/coordinator/i);
    const cli = await f.harness.runCli(["pr", JSON.stringify({ prs: [{ url: PR, stage: "working" }] })], { threadId: w.threadId });
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toMatch(/Only the current initiative coordinator sets PR stages/);
  });

  it("bb initiative pr works from the coordinator and from a terminal with the initiative id", async () => {
    const { f, project } = await projectFixture();
    const fromCoordinator = await f.harness.runCli(["pr", JSON.stringify({ prs: [{ url: PR, stage: "working", note: "W198" }] })], { threadId: "coordinator" });
    expect(fromCoordinator.exitCode).toBe(0);
    expect(JSON.parse(fromCoordinator.stdout!)).toEqual({ prs: [{ url: PR, stage: "working", note: "W198" }] });
    const noId = await f.harness.runCli(["pr", JSON.stringify({ prs: [{ url: PR, stage: "experiment" }] })]);
    expect(noId.stderr).toMatch(/Pass the initiative id/);
    const fromTerminal = await f.harness.runCli(["pr", JSON.stringify({ prs: [{ url: PR, stage: "experiment" }] }), project.id]);
    expect(fromTerminal.exitCode).toBe(0);
    expect(f.store.prStages(project.id).get(PR)?.stage).toBe("experiment");
  });

  it("is stored by an additive migration, appended after the earlier ones", () => {
    const index = MIGRATIONS.findIndex(migration => /^CREATE TABLE pr_stages/.test(migration));
    expect(index).toBeGreaterThan(0);
    // An existing database gains the table without touching earlier ones.
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS.slice(0, index)) db.exec(migration);
    db.exec(MIGRATIONS[index]!);
    const store = new Store(db);
    store.setPrStage("p1", PR, "in-review", null, 1);
    expect(store.prStages("p1").get(PR)).toEqual({ url: PR, stage: "in-review", note: null, setAt: 1 });
    // A stage a later version wrote and this one doesn't know is skipped, not misread.
    db.prepare("INSERT INTO pr_stages (project_id, url, stage, note, set_at) VALUES ('p1', 'x', 'shipped', NULL, 2)").run();
    expect([...store.prStages("p1").keys()]).toEqual([PR]);
  });
});

describe("W198 initiative_batch", () => {
  it("runs actions in order through their own tools, keeps going after a failure, and reports each", async () => {
    const { f, project } = await projectFixture();
    const result = await call(f, "initiative_batch", { actions: [
      { tool: "task", action: "create", title: "Merge queue" },
      { tool: "task", action: "close", task: "T999", outcome: "done" },
      { tool: "pr", prs: [{ url: PR, stage: "in-review" }] },
      { tool: "task", action: "close", task: "T1", outcome: "done", note: "Shipped." },
      { tool: "read", refs: ["T1"] },
    ] });
    expect(result.succeeded).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.results.map((r: { tool: string; ok: boolean }) => [r.tool, r.ok])).toEqual([
      ["task", true], ["task", false], ["pr", true], ["task", true], ["read", true],
    ]);
    // Same validation and errors as the tool itself.
    expect(result.results[1].error).toMatch(/T999/);
    expect(result.results[0].result).toMatchObject({ ref: "T1" });
    expect(f.store.task(project.id, 1)?.status).toBe("done");
    expect(f.store.prStages(project.id).get(PR)?.stage).toBe("in-review");
    expect(JSON.stringify(result.results[4].result)).toContain("Merge queue");
  });

  it("validates every batched action with its tool's own schema (W200 probes)", async () => {
    const { f, project } = await projectFixture();
    f.store.createProject({ id: "other-init", coordinatorThreadId: null, name: "Other Initiative", objective: "Private context", memberProjectIds: ["other-project"], policy: {}, context: { vision: "Other vision", objectives: [], ideas: [] } } as never);
    await expect(call(f, "initiative_read", { view: "projects", detailed: true })).rejects.toThrow(/view/);
    const projects = await call(f, "initiative_batch", { actions: [{ tool: "read", view: "projects", detailed: true }] });
    expect(projects).toMatchObject({ succeeded: 0, failed: 1 });
    expect(projects.results[0].error).toMatch(/Invalid arguments for initiative_read: view/);
    expect(JSON.stringify(projects)).not.toContain("Other Initiative");

    f.store.db.prepare("INSERT INTO handover_drafts (project_id, state, created_at, updated_at) VALUES (?, ?, ?, ?)").run(project.id, "requested", 1, 1);
    const clear = await call(f, "initiative_batch", { actions: [{ tool: "read", view: "clearHandoverDraft" }, { tool: "read", refs: ["T1"], bogus: true }] });
    expect(clear.results.map((r: { ok: boolean; error: string }) => [r.ok, /Invalid arguments for initiative_read/.test(r.error)])).toEqual([[false, true], [false, true]]);
    // The draft survives: nothing past validation ran.
    expect((f.store.db.prepare("SELECT count(*) AS n FROM handover_drafts").get() as { n: number }).n).toBe(1);
  });

  it("keeps the whole batch response within one read's 64 KiB, and still runs every action", async () => {
    const { f, project } = await projectFixture();
    for (let n = 0; n < 3; n++) await call(f, "initiative_task", { action: "create", title: `Task ${n}`, text: "x".repeat(19000) });
    const reads = Array.from({ length: 18 }, () => ({ tool: "read", view: "tasks", detailed: true }));
    const result = await call(f, "initiative_batch", { actions: [...reads, { tool: "pr", prs: [{ url: PR, stage: "working" }] }, { tool: "task", action: "close", task: "T1", outcome: "done" }] });
    const size = Buffer.byteLength(JSON.stringify(result));
    // The complete serialized response, envelope and receipts included.
    expect(size).toBeLessThanOrEqual(65536);
    expect(result.succeeded).toBe(20);
    const omitted = result.results.filter((r: { omitted?: boolean }) => r.omitted);
    expect(omitted.length).toBeGreaterThan(10);
    expect(omitted[0]).toEqual({ tool: "read", ok: true, omitted: true, reason: "result left out: the batch response is capped at 64 KiB" });
    expect(result.note).toMatch(/left out to stay under 64 KiB; the actions ran\. Read what you need separately/);
    // Mutations past the budget ran; only their detail was trimmed.
    expect(f.store.prStages(project.id).get(PR)?.stage).toBe("working");
    expect(f.store.task(project.id, 1)?.status).toBe("done");
  });

  it("caps W200's twenty valid reads at 64 KiB, measured on the raw response", async () => {
    const { f } = await projectFixture();
    for (let n = 0; n < 3; n++) await call(f, "initiative_task", { action: "create", title: `Task ${n}`, text: "x".repeat(19000) });
    const raw = await f.harness.callAgentTool("initiative_batch", { actions: Array.from({ length: 20 }, () => ({ tool: "read", view: "tasks", detailed: true })) }, { threadId: "coordinator" }) as string;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(65536);
    const result = JSON.parse(raw);
    expect(result.succeeded).toBe(20);
    // At least one full read fits; the rest are receipts.
    expect(result.results.filter((r: { omitted?: boolean }) => !r.omitted).length).toBeGreaterThan(0);
    expect(result.results.filter((r: { omitted?: boolean }) => r.omitted).length).toBeGreaterThan(0);
  });

  it("validates its own shape and is the coordinator's only", async () => {
    const { f } = await projectFixture();
    await expect(call(f, "initiative_batch", { actions: [] })).rejects.toThrow(/actions/);
    await expect(call(f, "initiative_batch", { actions: [{ tool: "manage", action: "archive" }] })).rejects.toThrow(/actions\.0\.tool/);
    await expect(call(f, "initiative_batch", { actions: [{ tool: "batch", actions: [] }] })).rejects.toThrow(/actions\.0\.tool/);
    const [w] = await call(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await expect(call(f, "initiative_batch", { actions: [{ tool: "message", to: "coordinator", text: "hi" }] }, w.threadId)).rejects.toThrow(/coordinator/i);
  });

  it("registers both new tools with object-root schemas", async () => {
    const { f } = await projectFixture();
    const tools = (f.harness.registrations.agentTools as { name: string; inputSchema: { type: string } }[]).filter(t => ["initiative_pr", "initiative_batch"].includes(t.name));
    expect(tools.map(t => [t.name, t.inputSchema.type])).toEqual([["initiative_pr", "object"], ["initiative_batch", "object"]]);
  });
});
