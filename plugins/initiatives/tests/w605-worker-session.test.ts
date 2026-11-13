import { describe, expect, it, vi } from "vitest";
import { FALLBACK_ROLE } from "../lib/reviewer-fallback";
import { CHECKOUT_READ_MS, MAX_WORKER_ANCESTORS, WORKER_SETTINGS_ENV, workerClaudeSettings } from "../lib/worker-session";
import { projectFixture } from "./fake-native";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const workerInput = (task: string) => ({ route: "fresh" as const, tasks: [task], label: "Trim", area: "Tokens", permissionMode: "full" as const });

/** The claude-code provider env BB resolves for a session start of `threadId`. */
const sessionEnv = (f: Fx, threadId: string) =>
  f.harness.resolveProviderEnv("claude-code", { threadId, projectId: "proj_a", hostId: "host_a" });
const settingsOf = async (f: Fx, threadId: string) => {
  const entry = (await sessionEnv(f, threadId)).find((e: { name: string }) => e.name === WORKER_SETTINGS_ENV);
  return entry ? JSON.parse(entry.value as string) : null;
};
/** A thread some agent spawned with --parent-self: no Initiative origin or metadata. */
const child = (f: Fx, id: string, parentThreadId: string) =>
  f.threads.set(id, { ...f.threads.get("coordinator")!, id, parentThreadId, originPluginId: null });

describe("W605 worker sessions leave out unused tools and skills", () => {
  it("trims a worker and its descendants, also once they join the Initiative as nested threads", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));

    const worker = await settingsOf(f, d.threadId!);
    expect(worker.permissions.deny).toEqual(expect.arrayContaining(["Workflow", "ReportFindings", "AskUserQuestion", "ListAgents", "ScheduleWakeup", "CronCreate", "Agent(statusline-setup)"]));
    expect(worker.permissions.deny).not.toContain("Agent");
    // Hidden from the model, still typable; workflow-authoring goes with the Workflow tool.
    expect(worker.skillOverrides).toMatchObject({ "workflow-authoring": "user-invocable-only", "bb-global-skills:thread-list": "user-invocable-only" });
    for (const kept of ["code-review", "principles", "agent-browser", "bb-global-skills:provider-retry"])
      expect(worker.skillOverrides).not.toHaveProperty([kept]);

    // Its reviewer, and a helper that reviewer spawns.
    child(f, "review", d.threadId!);
    child(f, "helper", "review");
    expect(await settingsOf(f, "review")).toEqual(worker);
    expect(await settingsOf(f, "helper")).toEqual(worker);
    // Once idle, BB's sweep records them as the Initiative's nested threads.
    for (const threadId of ["review", "helper"])
      f.store.associateNestedThread({ projectId: project.id, threadId, label: threadId, bbProjectId: "proj_a" });
    expect(f.store.membership("review")?.kind).toBe("adhoc");
    expect(await settingsOf(f, "review")).toEqual(worker);
    expect(await settingsOf(f, "helper")).toEqual(worker);
  });

  it("trims a worker's first session, before its spawn response confirms it", async () => {
    const { f, project } = await projectFixture();
    let firstStart: unknown = null;
    const spawn = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      const thread = await spawn(args);
      expect(f.store.membership(thread.id)).toBeNull();
      firstStart = await settingsOf(f, thread.id);
      return thread;
    });
    await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    expect(firstStart).toMatchObject({ permissions: { deny: expect.arrayContaining(["Workflow"]) } });
  });

  it("looks up to MAX_WORKER_ANCESTORS parents for a worker", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    let parent = d.threadId!;
    for (let depth = 1; depth <= MAX_WORKER_ANCESTORS; depth++) {
      child(f, `depth-${depth}`, parent);
      parent = `depth-${depth}`;
    }
    expect(await settingsOf(f, `depth-${MAX_WORKER_ANCESTORS}`)).not.toBeNull();
    child(f, "too-deep", parent);
    expect(await sessionEnv(f, "too-deep")).toEqual([]);
  });

  it("trims a fallback reviewer the plugin started", async () => {
    const { f } = await projectFixture();
    f.threads.set("fallback", { ...f.threads.get("coordinator")!, id: "fallback", originPluginId: "initiatives" });
    f.metadata.set("fallback", { role: FALLBACK_ROLE, projectId: "p", worker: 1, replaces: "r" });
    expect(await settingsOf(f, "fallback")).not.toBeNull();
  });

  it("leaves coordinators, former and retired workers, user threads and unknown threads whole", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    child(f, "coordinator-child", "coordinator");
    child(f, "someone-else", "nobody");
    for (const threadId of ["coordinator", "coordinator-child", "someone-else", "deleted"])
      expect(await sessionEnv(f, threadId)).toEqual([]);
    // A worker replaced by a new generation: someone resuming the old thread gets it whole.
    const num = f.store.membership(d.threadId!)!.workerNum;
    f.store.updateWorker(project.id, num, { threadId: "new-generation", generation: 2 });
    expect(f.store.membership(d.threadId!)?.former).toBe(true);
    expect(await sessionEnv(f, d.threadId!)).toEqual([]);
    // A retired worker: someone talking to it afterwards gets it whole.
    const [r] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    f.store.updateWorker(project.id, f.store.membership(r.threadId!)!.workerNum, { state: "retired" });
    expect(await sessionEnv(f, r.threadId!)).toEqual([]);
  });

  it("W617: keeps the optional MCP servers and skills a worker's brief or checkout instructions name", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    const { workerNum } = f.store.membership(d.threadId!)!;
    const brief = (text: string) => f.store.setBriefText(project.id, f.store.latestAssignment(project.id, workerNum)!.num, text);
    const servers = (settings: { deniedMcpServers?: { serverName: string }[] }) => settings.deniedMcpServers?.map((s) => s.serverName) ?? [];

    // Named nowhere: every optional server and skill leaves the session.
    brief("Fix the vault fee rows. The simplify-review skill may help.");
    const bare = await settingsOf(f, d.threadId!);
    expect(servers(bare)).toEqual(["axiom", "equisafe-dev", "sentry"]);
    for (const hidden of ["claude-api", "simplify", "run", "bb-global-skills:chat-memory", "bb-global-skills:initiative-worker"])
      expect(bare.skillOverrides[hidden]).toBe("user-invocable-only");

    // The brief names Sentry and /run; the checkout's CLAUDE.md names Axiom, its AGENTS.md equisafe.dev.
    brief("Find the error in Sentry, then /run the app.");
    const { environmentId } = f.threads.get(d.threadId!)!;
    const root = f.envs.get(environmentId!)?.path ?? `/code/${environmentId}`;
    f.files.set(`${root}/CLAUDE.md`, "Logs live in Axiom.");
    const named = await settingsOf(f, d.threadId!);
    expect(servers(named)).toEqual(["equisafe-dev"]);
    expect(named.skillOverrides).not.toHaveProperty(["run"]);
    f.files.set(`${root}/AGENTS.md`, "Publish documents on equisafe.dev.");
    const all = await settingsOf(f, d.threadId!);
    // Nothing to deny: the key stays out, so a provider older than W617 still takes the value.
    expect(all).not.toHaveProperty("deniedMcpServers");

    // Its reviewer reads the worker's brief, through its own checkout.
    child(f, "review", d.threadId!);
    expect(await settingsOf(f, "review")).toEqual(all);
  });

  it("W617: Sentry loads when the brief names it, not when only the checkout's instructions do", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    const { workerNum } = f.store.membership(d.threadId!)!;
    const brief = (text: string) => f.store.setBriefText(project.id, f.store.latestAssignment(project.id, workerNum)!.num, text);
    const root = f.envs.get(f.threads.get(d.threadId!)!.environmentId!)!.path;
    const servers = async () => (await settingsOf(f, d.threadId!)).deniedMcpServers?.map((s: { serverName: string }) => s.serverName) ?? [];
    f.files.set(`${root}/CLAUDE.md`, "Logs and traces live in Axiom, errors in Sentry, documents on equisafe.dev.");

    brief("Fix the vault fee rows.");
    expect(await servers()).toEqual(["sentry"]);
    brief("Fix the vault fee rows Sentry issue EQS-4XY reports.");
    expect(await servers()).toEqual([]);
  });

  it("W617: a qualified MCP tool name names its server", () => {
    const denied = (text: string) => workerClaudeSettings(text, "", null).deniedMcpServers?.map((s) => s.serverName) ?? [];
    expect(denied("Query mcp__axiom__queryDataset, then mcp__sentry__search_issues.")).toEqual(["equisafe-dev"]);
    expect(denied("Publish with mcp__equisafe-dev__create_artifact.")).toEqual(["axiom", "sentry"]);
    expect(denied("Not axiomatic, nor sentry-like.")).toEqual(["axiom", "equisafe-dev", "sentry"]);
  });

  it("W617: a checkout read that fails or stalls keeps its last good read, or every optional server and skill", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, workerInput(f.task(project.id).ref));
    const { workerNum } = f.store.membership(d.threadId!)!;
    f.store.setBriefText(project.id, f.store.latestAssignment(project.id, workerNum)!.num, "Fix the vault fee rows.");
    const root = f.envs.get(f.threads.get(d.threadId!)!.environmentId!)!.path;
    const servers = async () => (await settingsOf(f, d.threadId!)).deniedMcpServers?.map((s: { serverName: string }) => s.serverName) ?? [];

    // Never read: the session keeps everything the checkout could name. Only the brief names Sentry.
    f.fileFaults.set(`${root}/CLAUDE.md`, "error");
    const unknown = await settingsOf(f, d.threadId!);
    expect(unknown.deniedMcpServers).toEqual([{ serverName: "sentry" }]);
    expect(unknown.skillOverrides).not.toHaveProperty(["run"]);
    expect(unknown.permissions.deny).toContain("Workflow");

    // Read once, then failing or stalling: the last good read stands.
    f.fileFaults.clear();
    f.files.set(`${root}/CLAUDE.md`, "Logs live in Axiom.");
    expect(await servers()).toEqual(["equisafe-dev", "sentry"]);
    f.files.delete(`${root}/CLAUDE.md`);
    f.fileFaults.set(`${root}/CLAUDE.md`, "error");
    expect(await servers()).toEqual(["equisafe-dev", "sentry"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.fileFaults.set(`${root}/CLAUDE.md`, "stall");
      const stalled = servers();
      await vi.advanceTimersByTimeAsync(CHECKOUT_READ_MS);
      expect(await stalled).toEqual(["equisafe-dev", "sentry"]);
    } finally {
      vi.useRealTimers();
    }
    // A file that is gone (404) is read as gone.
    f.fileFaults.clear();
    expect(await servers()).toEqual(["axiom", "equisafe-dev", "sentry"]);
  });
});
