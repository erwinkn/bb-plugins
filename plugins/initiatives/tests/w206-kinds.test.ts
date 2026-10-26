import { describe, expect, it } from "vitest";
import { advertisedSchema, spawnToolAdvertised } from "../lib/agent-tools";
import { delegateSchema } from "../lib/commands";
import { workerKindProfile } from "../lib/policy";
import { canonicalWorkKind, DEFAULT_PROFILES, DEFAULT_POLICY, PROFILE_KEYS, policySchema, storedPolicySchema, WORKER_KIND_PROFILE, WORKER_KINDS, workerKindSchema, type Profile } from "../lib/schema";
import { parseProfileDefaults } from "../lib/settings";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { buildOverview } from "../lib/overview";
import { clearCatalogCache } from "../lib/bb";
import { fixture, projectFixture, report } from "./fake-native";

// W206/W209/W538: a coordinator spawns a role (worker, fast, very-fast); Settings map it to a model. Explorer and experimenter are retired (R9): refused on input, worker when stored.
const opus: Profile = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
const sonnet: Profile = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "high" };
const exp: Profile = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "xhigh" };
const haiku: Profile = { providerId: "claude-code", model: "claude-haiku-5-5", reasoningLevel: "high" };
const luna: Profile = { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "xhigh" };
const sol: Profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" };
// The retired experiment and investigation keys stay in the settings: they must be ignored, not error.
const settings = { executionProfiles: JSON.stringify({ implementation: opus, straightforward: sonnet, experiment: exp, investigation: luna, reviewOfClaude: sol, reviewOfGpt: sol }) };

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown) => JSON.parse(await f.harness.callAgentTool(name, input, { threadId: "coordinator" }) as string);
const spawnInput = (label: string, extra: Record<string, unknown> = {}) => ({ label, purpose: label, text: `Do ${label}.`, permissionMode: "full", ...extra });
/** Lets every profile's model appear in the native catalog. */
const available = (f: Fx) => {
  for (const profile of [sonnet, haiku, luna, sol, exp]) f.execution.set(`probe-${profile.model}`, { model: profile.model, reasoningLevel: profile.reasoningLevel });
  clearCatalogCache();
};
const spawned = (f: Fx) => f.spawn.mock.calls.at(-1)![0];

describe("W206 spawn by role", () => {
  it("maps each kind to its settings profile and records it on the worker", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    for (const [kind, expected] of [["worker", opus], ["fast", sonnet], ["very-fast", haiku]] as const) {
      await tool(f, "initiative_spawn", spawnInput(kind, { kind }));
      expect(spawned(f)).toMatchObject(expected);
    }
    expect(f.store.workers(project.id).map(w => w.kind)).toEqual(["worker", "fast", "very-fast"]);
  });

  it("defaults to a plain worker when kind is missing", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    await tool(f, "initiative_spawn", spawnInput("plain"));
    expect(spawned(f)).toMatchObject(opus);
    expect(f.store.worker(project.id, 1)!.kind).toBe("worker");
    expect(workerKindProfile(DEFAULT_POLICY)).toEqual(DEFAULT_PROFILES.implementation);
  });

  it("an explicit profile wins over kind", async () => {
    const { f } = await projectFixture(settings);
    available(f);
    await tool(f, "initiative_spawn", spawnInput("explicit", { kind: "fast", profile: sol }));
    expect(spawned(f)).toMatchObject(sol);
  });

  it("per-Initiative policy profiles override the settings for a kind", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    f.store.updateProject(project.id, { policy: { profiles: { straightforward: sol } } });
    await tool(f, "initiative_spawn", spawnInput("override", { kind: "fast" }));
    expect(spawned(f)).toMatchObject(sol);
    await tool(f, "initiative_spawn", spawnInput("other", { kind: "worker" }));
    expect(spawned(f)).toMatchObject(opus);
  });

  it.each(["explorer", "experimenter", "analyst", "investigator"])("%s is refused with the valid kinds, and a stored one reads as worker", async (old) => {
    const { f, project } = await projectFixture(settings);
    available(f);
    await expect(tool(f, "initiative_spawn", spawnInput("old", { kind: old }))).rejects.toThrow(/kind: Invalid option: expected one of "worker"\|"fast"\|"very-fast"/);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.workers(project.id)).toEqual([]);
    const run = (kind: string) => f.harness.runCli(["command", JSON.stringify({ action: "delegate", route: "fresh", label: "L", area: "A", note: "N", kind, permissionMode: "full" }), project.id]);
    const cli = await run(old);
    expect(cli.exitCode).not.toBe(0);
    expect(JSON.stringify(cli)).toMatch(/worker.*fast.*very-fast/);
    const batch = await tool(f, "initiative_batch", { actions: [{ tool: "spawn", ...spawnInput("old", { kind: old }) }] });
    expect(batch).toMatchObject({ succeeded: 0, failed: 1 });
    expect(JSON.stringify(batch)).toMatch(/worker.*fast.*very-fast/);
    expect(workerKindSchema.safeParse(old).success).toBe(false);
    // History, not input: a worker stored with the old kind loads as a worker.
    await tool(f, "initiative_spawn", spawnInput("plain"));
    f.store.db.prepare("UPDATE workers SET kind = ?").run(old);
    expect(f.store.workers(project.id).map(w => w.kind)).toEqual(["worker"]);
    expect(buildOverview(f.store, project.id, new Map(), Date.now()).workers.current[0]!.kind).toBe("worker");
  });

  it("worker is Opus 5.5 high, fast is Sonnet 5.5 high, and the retired profile keys are gone", () => {
    expect(DEFAULT_PROFILES.implementation).toEqual(opus);
    expect(DEFAULT_PROFILES.straightforward).toEqual(sonnet);
    expect(DEFAULT_PROFILES).not.toHaveProperty("investigation");
    expect(DEFAULT_PROFILES).not.toHaveProperty("experiment");
    expect(PROFILE_KEYS).not.toContain("investigation");
    expect(PROFILE_KEYS).not.toContain("experiment");
    expect(workerKindProfile(DEFAULT_POLICY, "worker")).toEqual(opus);
  });

  it("a config or Initiative policy still carrying the retired profile keys is accepted and the keys ignored", () => {
    expect(parseProfileDefaults(JSON.stringify({ implementation: sol, experiment: exp, investigation: luna }))).toEqual({ implementation: sol });
    expect(policySchema.parse({ profiles: { investigation: luna, straightforward: sol } }).profiles).toEqual({ straightforward: sol });
    expect(storedPolicySchema.parse({ profiles: { experiment: exp } }).profiles).toEqual({});
    expect(workerKindProfile({ profiles: {} }, "worker")).toEqual(opus);
  });

  it("advertises exactly the three kinds", () => {
    const kind = (advertisedSchema(spawnToolAdvertised).properties as { kind: { enum: string[] } }).kind;
    expect(kind.enum).toEqual(["worker", "fast", "very-fast"]);
  });

  it("a stored task and assignment with a retired work kind read as implementation", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    const task = f.task(project.id);
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], label: "L", area: "A", permissionMode: "full" });
    f.store.db.prepare("UPDATE tasks SET work_kind = 'investigation'").run();
    f.store.db.prepare("UPDATE assignments SET work_kind = 'experiment'").run();
    expect(f.store.tasks(project.id).map(t => t.workKind)).toEqual(["implementation"]);
    expect(f.store.assignments(project.id).map(a => a.workKind)).toEqual(["implementation"]);
    expect(canonicalWorkKind("bogus")).toBe("implementation");
  });

  it("a stored retired work kind reads as implementation", () => {
    expect(canonicalWorkKind("investigation")).toBe("implementation");
    expect(canonicalWorkKind("experiment")).toBe("implementation");
    expect(canonicalWorkKind("mechanical")).toBe("mechanical");
  });

  it("very-fast resolves to Haiku 5.5 high by default, and to a configured override", async () => {
    expect(DEFAULT_PROFILES.mechanical).toEqual(haiku);
    expect(workerKindProfile(DEFAULT_POLICY, "very-fast")).toEqual(haiku);
    expect(workerKindProfile({ profiles: { mechanical: sol } }, "very-fast")).toEqual(sol);
    // The shared settings above carry no mechanical key: the default fills in.
    const defaulted = await projectFixture(settings);
    available(defaulted.f);
    await tool(defaulted.f, "initiative_spawn", spawnInput("vf", { kind: "very-fast" }));
    expect(spawned(defaulted.f)).toMatchObject(haiku);
    const custom = await projectFixture({ executionProfiles: JSON.stringify({ mechanical: sol }) });
    available(custom.f);
    await tool(custom.f, "initiative_spawn", spawnInput("vf", { kind: "very-fast" }));
    expect(spawned(custom.f)).toMatchObject(sol);
    expect(custom.f.store.workers(custom.project.id).map(w => w.kind)).toEqual(["very-fast"]);
  });

  it("a batch spawn takes kind", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    const result = await tool(f, "initiative_batch", { actions: [
      { tool: "spawn", ...spawnInput("quick", { kind: "fast" }) },
      { tool: "spawn", ...spawnInput("digest", { kind: "very-fast" }) },
    ] });
    expect(result).toMatchObject({ succeeded: 2, failed: 0 });
    expect(f.store.workers(project.id).map(w => [w.kind, w.model])).toEqual([["fast", "claude-sonnet-5-5"], ["very-fast", "claude-haiku-5-5"]]);
  });

  it("the CLI command accepts kind and rejects an unknown one", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    const run = (kind: string) => f.harness.runCli(["command", JSON.stringify({ action: "delegate", route: "fresh", label: "L", area: "A", note: "N", kind, permissionMode: "full" }), project.id]);
    expect((await run("very-fast")).exitCode).toBe(0);
    expect(spawned(f)).toMatchObject(haiku);
    expect((await run("implementation")).exitCode).not.toBe(0);
  });

  it("kind is for a new work worker, not a review or a message", () => {
    const base = { action: "delegate", label: "L", area: "A" };
    expect(delegateSchema.safeParse({ ...base, route: "fresh", kind: "fast" }).success).toBe(true);
    expect(delegateSchema.safeParse({ ...base, route: "fresh", role: "review", kind: "fast" }).success).toBe(false);
    expect(delegateSchema.safeParse({ ...base, route: "continue", worker: "W1", kind: "fast" }).success).toBe(false);
  });

  it("a review keeps its profile by the reviewed worker's family and records no kind", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    const [impl] = await tool(f, "initiative_spawn", spawnInput("impl", { kind: "fast" }));
    await f.service.report(impl.threadId, report());
    f.idle(impl.threadId);
    // v9: leads no longer spawn reviewers; the service keeps the path for work given out before.
    await f.service.delegate(project.id, { route: "fresh", label: "Review", area: "review", note: "Review W1.", role: "review", reviews: "W1", permissionMode: "full" });
    expect(spawned(f)).toMatchObject(sol);
    expect(f.store.worker(project.id, 2)).toMatchObject({ role: "review", kind: null });
  });

  it("shows the kind beside the worker in the overview", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    await tool(f, "initiative_spawn", spawnInput("quick", { kind: "fast" }));
    const o = buildOverview(f.store, project.id, new Map(), Date.now());
    expect(o.workers.current[0]!.kind).toBe("fast");
  });

  it("every kind has a stored profile key", () => {
    expect(WORKER_KINDS.map(kind => WORKER_KIND_PROFILE[kind])).toEqual(["implementation", "straightforward", "mechanical"]);
  });
});

describe("W206 coordinator guidance", () => {
  it("names the kinds instead of raw profiles", () => {
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Pick kind on spawn: worker (default; everything else, including investigations, read-only exploration and prototypes: say so in the brief), fast (small, well-specified changes) or very-fast (mechanical: lookups, scans, renames, simple scripted checks).");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).not.toMatch(/explorer|experimenter/);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).not.toContain("analyst");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).not.toContain("Pass profile");
  });

  it.each([
    ["the raw-profile line", "Pass profile {providerId"],
    ["the worker/fast/investigator kinds line", "or investigator (summarizing"],
    ["the explorer and experimenter kinds line", "or explorer (read lots and report; no building or running). Hand slow"],
    ["the analyst kinds line with the Haiku/Sonnet sentence", "or analyst (read lots and report; no building or running). Fast work gets"],
  ])("a saved copy of the default with %s upgrades; edited text stays", async (_, needle) => {
    const previous = PREVIOUS_DEFAULTS.coordinator.find(text => text.includes(needle))!;
    expect(previous).toBeDefined();
    const f = fixture({ coordinatorInstructions: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration().coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);
    await f.preferences.handle.experimental_set({ coordinatorInstructions: "Erwin's own coordinator text." });
    expect(f.preferences.configuration().coordinatorInstructions).toBe("Erwin's own coordinator text.");
  });
});
