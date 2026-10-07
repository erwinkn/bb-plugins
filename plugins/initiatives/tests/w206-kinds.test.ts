import { describe, expect, it } from "vitest";
import { delegateSchema } from "../lib/commands";
import { workerKindProfile } from "../lib/policy";
import { DEFAULT_PROFILES, DEFAULT_POLICY, WORKER_KIND_PROFILE, WORKER_KINDS, type Profile } from "../lib/schema";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { buildOverview } from "../lib/overview";
import { clearCatalogCache } from "../lib/bb";
import { fixture, projectFixture, report } from "./fake-native";

// W206: a coordinator spawns a role (worker, fast, investigator); Settings map it to a model.
const opus: Profile = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
const sonnet: Profile = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "high" };
const luna: Profile = { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "xhigh" };
const sol: Profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" };
const settings = { executionProfiles: JSON.stringify({ implementation: opus, straightforward: sonnet, investigation: luna, reviewOfClaude: sol, reviewOfGpt: sol }) };

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown) => JSON.parse(await f.harness.callAgentTool(name, input, { threadId: "coordinator" }) as string);
const spawnInput = (label: string, extra: Record<string, unknown> = {}) => ({ label, purpose: label, text: `Do ${label}.`, permissionMode: "full", ...extra });
/** Lets every profile's model appear in the native catalog. */
const available = (f: Fx) => {
  for (const profile of [sonnet, luna, sol]) f.execution.set(`probe-${profile.model}`, { model: profile.model, reasoningLevel: profile.reasoningLevel });
  clearCatalogCache();
};
const spawned = (f: Fx) => f.spawn.mock.calls.at(-1)![0];

describe("W206 spawn by role", () => {
  it("maps each kind to its settings profile and records it on the worker", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    for (const [kind, expected] of [["worker", opus], ["fast", sonnet], ["investigator", luna]] as const) {
      await tool(f, "initiative_spawn", spawnInput(kind, { kind }));
      expect(spawned(f)).toMatchObject(expected);
    }
    expect(f.store.workers(project.id).map(w => w.kind)).toEqual(["worker", "fast", "investigator"]);
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
    await tool(f, "initiative_spawn", spawnInput("other", { kind: "investigator" }));
    expect(spawned(f)).toMatchObject(luna);
  });

  it("a batch spawn takes kind", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    const result = await tool(f, "initiative_batch", { actions: [
      { tool: "spawn", ...spawnInput("quick", { kind: "fast" }) },
      { tool: "spawn", ...spawnInput("digest", { kind: "investigator" }) },
    ] });
    expect(result).toMatchObject({ succeeded: 2, failed: 0 });
    expect(f.store.workers(project.id).map(w => [w.kind, w.model])).toEqual([["fast", "claude-sonnet-5-5"], ["investigator", "gpt-6-luna"]]);
  });

  it("the CLI command accepts kind and rejects an unknown one", async () => {
    const { f, project } = await projectFixture(settings);
    available(f);
    const run = (kind: string) => f.harness.runCli(["command", JSON.stringify({ action: "delegate", route: "fresh", label: "L", area: "A", note: "N", kind, permissionMode: "full" }), project.id]);
    expect((await run("investigator")).exitCode).toBe(0);
    expect(spawned(f)).toMatchObject(luna);
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
    await tool(f, "initiative_spawn", { label: "Review", purpose: "review", text: "Review W1.", role: "review", reviews: "W1", permissionMode: "full" });
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
    expect(WORKER_KINDS.map(kind => WORKER_KIND_PROFILE[kind])).toEqual(["implementation", "straightforward", "investigation"]);
  });
});

describe("W206 coordinator guidance", () => {
  it("names the kinds instead of raw profiles", () => {
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Pick kind on spawn: worker (default), fast (simple, well-specified work) or investigator (summarizing or investigating large text).");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).not.toContain("Pass profile");
  });

  it("a saved copy of the previous default upgrades; edited text stays", async () => {
    const previous = PREVIOUS_DEFAULTS.coordinator.find(text => text.includes("Pass profile {providerId"))!;
    expect(previous).toBeDefined();
    const f = fixture({ coordinatorInstructions: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration().coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);
    await f.preferences.handle.experimental_set({ coordinatorInstructions: "Erwin's own coordinator text." });
    expect(f.preferences.configuration().coordinatorInstructions).toBe("Erwin's own coordinator text.");
  });
});
