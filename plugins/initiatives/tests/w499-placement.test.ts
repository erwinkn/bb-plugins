import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";
import { mayShareCheckout } from "../lib/placement";

// W499: initiative_spawn takes host (a name or id) and worktree instead of environment. A host
// that can't be used, or a project without a checkout on it, fails visibly: never another host.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const refused = async (f: Fx, name: string, input: unknown) => {
  try {
    await f.harness.callAgentTool(name, input, { threadId: "coordinator" });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${name} accepted ${JSON.stringify(input)}`);
};
const base = { label: "Fix", purpose: "fix", text: "Fix it." };
const lastSpawn = (f: Fx) => f.spawn.mock.calls.at(-1)![0];

/** A second machine, "mac", with its own checkout of proj_a. */
async function twoHosts() {
  const { f, project } = await projectFixture();
  f.hosts.push({ id: "host_mac", name: "mac", status: "connected", lifecycle: { phase: "active" } });
  f.sources.push({ hostId: "host_mac", isDefault: false, path: "/Users/erwin/repo" });
  return { f, project };
}
const onMac = { type: "host", hostId: "host_mac", workspace: { type: "unmanaged", path: "/Users/erwin/repo" } };

describe("W499 initiative_spawn host and worktree", () => {
  it("runs on the project's checkout of a host named by name or by id, and records it on the A#", async () => {
    const { f, project } = await twoHosts();
    const [byName] = await tool(f, "initiative_spawn", { ...base, host: "mac" });
    expect(lastSpawn(f).environment).toEqual(onMac);
    const [byId] = await tool(f, "initiative_spawn", { ...base, label: "Two", host: "host_mac" });
    expect(lastSpawn(f).environment).toEqual(onMac);
    for (const ref of [byName.assignment, byId.assignment])
      expect(f.store.assignments(project.id).find((a) => a.ref === ref)!.placement).toEqual({ hostId: "host_mac", path: "/Users/erwin/repo" });
  });

  it("refuses an unknown, ambiguous or disconnected host and a host without a checkout, starting nothing", async () => {
    const { f, project } = await twoHosts();
    expect(await refused(f, "initiative_spawn", { ...base, host: "laptop" })).toContain('No host is named "laptop". Hosts: hetzner (host_a), mac (host_mac).');
    f.hosts.push({ id: "host_mac2", name: "mac", status: "connected", lifecycle: { phase: "active" } });
    expect(await refused(f, "initiative_spawn", { ...base, host: "mac" })).toContain('"mac" names 2 hosts: host_mac, host_mac2. Give its id.');
    // Its id still picks it, and a destroyed namesake does not count.
    f.hosts.at(-1)!.lifecycle = { phase: "destroyed" };
    f.hosts.push({ id: "host_off", name: "pi", status: "disconnected", lifecycle: { phase: "active" } });
    expect(await refused(f, "initiative_spawn", { ...base, host: "pi" })).toContain("Host pi (host_off) is disconnected.");
    f.hosts.push({ id: "host_bare", name: "bare", status: "connected", lifecycle: { phase: "active" } });
    expect(await refused(f, "initiative_spawn", { ...base, host: "bare" })).toContain("proj_a has no checkout on host bare (host_bare).");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.workers(project.id)).toEqual([]);
    expect(f.store.assignments(project.id)).toEqual([]);
  });

  it("worktree:true asks BB for a managed worktree on that host; worktree:false is the default host's checkout", async () => {
    const { f, project } = await twoHosts();
    const [mac] = await tool(f, "initiative_spawn", { ...base, host: "mac", worktree: true });
    expect(lastSpawn(f).environment).toEqual({ type: "host", hostId: "host_mac", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
    expect(f.store.assignments(project.id).find((a) => a.ref === mac.assignment)!.placement).toEqual({ hostId: "host_mac", worktree: true });
    await tool(f, "initiative_spawn", { ...base, label: "Two", worktree: false });
    expect(lastSpawn(f).environment).toEqual({ type: "host", hostId: "host_a", workspace: { type: "unmanaged", path: "/code/repo" } });
  });

  it("a BB refusal to create the worktree reaches the caller as it is", async () => {
    const { f } = await twoHosts();
    f.spawn.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Worktree setup hook failed: exit 1"), { status: 400 });
    });
    expect(await refused(f, "initiative_spawn", { ...base, host: "mac", worktree: true })).toContain("Worktree setup hook failed: exit 1");
  });

  it("with neither, keeps the project default as before and records no placement", async () => {
    const { f, project } = await twoHosts();
    await tool(f, "initiative_spawn", base);
    expect(lastSpawn(f).environment).toEqual({ type: "project-default" });
    expect(f.store.assignments(project.id)[0]!.placement).toBeNull();
  });

  it("maps the deprecated environment alias and refuses it beside host or worktree", async () => {
    const { f } = await twoHosts();
    await tool(f, "initiative_spawn", { ...base, environment: { type: "worktree" } });
    expect(lastSpawn(f).environment).toEqual({ type: "host", hostId: "host_a", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
    await tool(f, "initiative_spawn", { ...base, label: "Two", environment: { type: "project-default" } });
    expect(lastSpawn(f).environment).toEqual({ type: "project-default" });
    await tool(f, "initiative_spawn", { ...base, label: "Three", environment: { type: "reuse", environmentId: "env_a" } });
    expect(lastSpawn(f).environment).toEqual({ type: "reuse", environmentId: "env_a" });
    const calls = f.spawn.mock.calls.length;
    for (const extra of [{ host: "mac" }, { worktree: true }, { worktree: false }])
      expect(await refused(f, "initiative_spawn", { ...base, ...extra, environment: { type: "worktree" } })).toContain("Give host and worktree, or the deprecated environment, not both.");
    expect(f.spawn.mock.calls.length).toBe(calls);
  });

  it("the batch spawn action takes the same arguments", async () => {
    const { f } = await twoHosts();
    const out = await tool(f, "initiative_batch", { actions: [{ tool: "spawn", ...base, host: "mac" }, { tool: "spawn", ...base, label: "Two", host: "nope" }] });
    expect(out).toMatchObject({ succeeded: 1, failed: 1 });
    expect(out.results[1].error).toContain('No host is named "nope"');
    expect(lastSpawn(f).environment).toEqual(onMac);
  });

  it("a work message takes no host: it reaches the worker where it runs", async () => {
    const { f, project } = await twoHosts();
    await tool(f, "initiative_spawn", { ...base, host: "mac" });
    const cli = await f.harness.runCli(["command", JSON.stringify({ action: "delegate", route: "continue", worker: "W1", note: "More.", host: "hetzner" }), project.id], { threadId: "coordinator" });
    expect(`${cli.stdout}${cli.stderr}`).toContain("host applies to a new worker");
  });
});

describe("W499 overlap across hosts", () => {
  it("warns about another writer only in the same host's checkout", async () => {
    const { f } = await twoHosts();
    f.envs.set("env_mac", { id: "env_mac", projectId: "proj_a", path: "/Users/erwin/repo", hostId: "host_mac", isWorktree: false, status: "ready" });
    const [first] = await tool(f, "initiative_spawn", { ...base, host: "mac" });
    expect(first.warnings).toBeUndefined();
    const [hetzner] = await tool(f, "initiative_spawn", { ...base, label: "Two", host: "hetzner" });
    expect(hetzner.warnings).toBeUndefined();
    const [again] = await tool(f, "initiative_spawn", { ...base, label: "Three", host: "mac" });
    expect(again.warnings).toEqual(["W1 is also writing in this checkout (A1, running). Sequence the work, or give one of them a worktree (worktree:true)."]);
  });

  it("a recorded worktree is not this checkout, unless both name the same environment", async () => {
    const { f, project } = await twoHosts();
    await tool(f, "initiative_spawn", { ...base, worktree: true });
    // BB has not reported the new worktree yet.
    f.threads.set(f.store.workers(project.id)[0]!.threadId!, { ...f.threads.get(f.store.workers(project.id)[0]!.threadId!)!, environmentId: null });
    f.store.updateWorker(project.id, 1, { environmentId: null });
    f.store.updateAssignment(project.id, 1, { environmentId: null });
    // BB's project default could pick that worktree: warned, conservatively.
    const [automatic] = await tool(f, "initiative_spawn", { ...base, label: "Auto" });
    expect(automatic.warnings).toEqual([expect.stringMatching(/^W1 is also writing in this checkout/)]);
    f.store.updateAssignment(project.id, 2, { state: "cancelled" });
    // The default host's checkout, named, is not W1's new worktree.
    const [shared] = await tool(f, "initiative_spawn", { ...base, label: "Two", worktree: false });
    expect(shared.warnings).toBeUndefined();
    // A known environment can't be told apart from W1's unreported worktree: warned, conservatively.
    const [unknown] = await tool(f, "initiative_spawn", { ...base, label: "Alias", environment: { type: "reuse", environmentId: "env_wt" } });
    expect(unknown.warnings).toEqual([expect.stringMatching(/^W1 is also writing in this checkout/)]);
    // Reported, and a second writer reuses that very worktree through the deprecated alias.
    f.store.updateWorker(project.id, 1, { environmentId: "env_wt" });
    const [same] = await tool(f, "initiative_spawn", { ...base, label: "Three", environment: { type: "reuse", environmentId: "env_wt" } });
    expect(same.warnings).toEqual([expect.stringMatching(/^W1 \(A1, running\), W4 \(A4, running\) are also writing in this checkout/)]);
  });
});

describe("W499 reuse of the recorded placement", () => {
  it("a review reads the reviewed worker's environment, else the host and checkout its work was given", async () => {
    const { f, project } = await twoHosts();
    const [w] = await tool(f, "initiative_spawn", { ...base, host: "mac" });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.envs.set("env_mac", { id: "env_mac", projectId: "proj_a", path: "/Users/erwin/repo", hostId: "host_mac", isWorktree: false, status: "ready" });
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, environmentId: "env_mac" });
    const worker = f.store.workers(project.id)[0]!;
    f.store.updateWorker(project.id, worker.num, { environmentId: null });
    const a1 = f.store.assignments(project.id)[0]!;
    f.store.updateAssignment(project.id, a1.num, { environmentId: null });
    // The landing BB reports, read live when nothing recorded it.
    await f.service.delegate(project.id, { route: "fresh", role: "review", reviews: "W1", label: "Review", area: "Review" });
    expect(lastSpawn(f).environment).toEqual({ type: "reuse", environmentId: "env_mac" });
    // No landing known at all: exactly the recorded host and checkout, even after the project's
    // checkout there moved; never the project default.
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, environmentId: null });
    f.sources[1]!.path = "/Users/erwin/elsewhere";
    await f.service.delegate(project.id, { route: "fresh", role: "review", reviews: "W1", label: "Review 2", area: "Review" });
    expect(lastSpawn(f).environment).toEqual(onMac);
  });

  it("more work keeps the spawn's placement: its catalog is the worker's host, and a later review still refuses an unknown worktree", async () => {
    const { f, project } = await twoHosts();
    const [w] = await tool(f, "initiative_spawn", { ...base, host: "mac", worktree: true });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, environmentId: null, status: "idle" });
    f.store.updateWorker(project.id, 1, { environmentId: null });
    f.store.updateAssignment(project.id, 1, { environmentId: null });
    const catalogs: unknown[] = [];
    clearCatalogCache();
    f.intercept((path, args, call) => {
      if (path === "providers.models") catalogs.push(args);
      return call();
    });
    await tool(f, "initiative_message", { to: "W1", text: "One more thing.", work: true });
    f.intercept();
    expect(catalogs).toEqual([expect.objectContaining({ hostId: "host_mac" })]);
    const a2 = f.store.assignments(project.id).at(-1)!;
    expect(a2.route).toBe("continue");
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    await expect(f.service.delegate(project.id, { route: "fresh", role: "review", reviews: "W1", label: "Review", area: "Review" }))
      .rejects.toThrow("W1's worktree on host host_mac reports no environment yet");
  });

  it("a review of a worktree whose environment is unknown is refused rather than moved", async () => {
    const { f, project } = await twoHosts();
    const [w] = await tool(f, "initiative_spawn", { ...base, host: "mac", worktree: true });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w.threadId);
    f.threads.set(w.threadId, { ...f.threads.get(w.threadId)!, environmentId: null });
    f.store.updateWorker(project.id, 1, { environmentId: null });
    f.store.updateAssignment(project.id, 1, { environmentId: null });
    const calls = f.spawn.mock.calls.length;
    await expect(f.service.delegate(project.id, { route: "fresh", role: "review", reviews: "W1", label: "Review", area: "Review" }))
      .rejects.toThrow("W1's worktree on host host_mac reports no environment yet");
    expect(f.spawn.mock.calls.length).toBe(calls);
  });

  it("a create response without an environment keeps the one already recorded", async () => {
    const { f, project } = await twoHosts();
    f.spawn.mockImplementationOnce(async (args: Record<string, any>) => {
      const thread = await f.spawn.getMockImplementation()!(args);
      const landed = { ...thread, environmentId: null };
      f.threads.set(thread.id, landed);
      return landed;
    });
    await tool(f, "initiative_spawn", { ...base, environment: { type: "reuse", environmentId: "env_a" } });
    expect(f.store.assignments(project.id)[0]!.environmentId).toBe("env_a");
    expect(f.store.workers(project.id)[0]!.environmentId).toBe("env_a");
  });
});

describe("W499 a reported worktree", () => {
  it("is not the checkout of a project-default spawn or of more work for an unreported worktree (as on main)", async () => {
    const { f, project } = await twoHosts();
    f.envs.set("env_wt", { id: "env_wt", projectId: "proj_a", path: "/wt/w1", hostId: "host_a", isWorktree: true, status: "ready" });
    const [w1] = await tool(f, "initiative_spawn", { ...base, worktree: true });
    f.threads.set(w1.threadId, { ...f.threads.get(w1.threadId)!, environmentId: "env_wt" });
    f.store.updateWorker(project.id, 1, { environmentId: "env_wt" });
    f.store.updateAssignment(project.id, 1, { environmentId: "env_wt" });
    const [w2] = await tool(f, "initiative_spawn", { ...base, label: "Two" });
    expect(w2.warnings).toBeUndefined();
  });
});

describe("W499 more work for an unreported worktree", () => {
  it("is not a new worktree: another writer that may share it is still warned about", async () => {
    const { f, project } = await twoHosts();
    const [w1] = await tool(f, "initiative_spawn", { ...base, worktree: true });
    await tool(f, "initiative_report", { outcome: "done", summary: "Done.", report: "Done." }, w1.threadId);
    f.threads.set(w1.threadId, { ...f.threads.get(w1.threadId)!, environmentId: null, status: "idle" });
    f.store.updateWorker(project.id, 1, { environmentId: null });
    f.store.updateAssignment(project.id, 1, { environmentId: null });
    // W2 on BB's project default, its environment not reported either.
    const [w2] = await tool(f, "initiative_spawn", { ...base, label: "Two" });
    f.threads.set(w2.threadId, { ...f.threads.get(w2.threadId)!, environmentId: null });
    f.store.updateWorker(project.id, 2, { environmentId: null });
    f.store.updateAssignment(project.id, 2, { environmentId: null });
    const [more] = await tool(f, "initiative_message", { to: "W1", text: "One more thing.", work: true });
    expect(more.warnings).toEqual([expect.stringMatching(/^W2 is also writing in this checkout/)]);
  });
});

describe("W499 coordinator handover placement", () => {
  it("takes only the default checkout's host and refuses a worktree", async () => {
    const { f, project } = await twoHosts();
    expect(await refused(f, "initiative_manage", { action: "handover", reason: "Fresh context", host: "mac" }))
      .toContain("A coordinator runs on proj_a's default checkout, on host host_a; host mac (host_mac) is not it.");
    expect(await refused(f, "initiative_manage", { action: "handover", reason: "Fresh context", environment: { type: "worktree" } }))
      .toContain("A coordinator runs on the member project's checkout, not a worker worktree.");
    expect(await refused(f, "initiative_manage", { action: "handover", reason: "Fresh context", host: "hetzner", environment: { type: "project-default" } }))
      .toContain("Give host and worktree, or the deprecated environment, not both.");
    expect(f.store.handover(project.id)).toBeNull();
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
    await tool(f, "initiative_manage", { action: "handover", reason: "Fresh context", host: "hetzner" });
    // Pinned as that checkout's environment: the start's home check fails it if the default moves meanwhile.
    expect(f.store.handover(project.id)?.environment).toEqual({ type: "reuse", environmentId: "env_a" });
  });

  it("pins the checkout it checked, even if the default source moves during the request", async () => {
    const { f, project } = await twoHosts();
    f.envs.set("env_mac", { id: "env_mac", projectId: "proj_a", path: "/Users/erwin/repo", hostId: "host_mac", isWorktree: false, status: "ready" });
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
    // The source read beside the host lookup sees hetzner; the default moves to mac right after.
    f.intercept(async (path, _args, call) => {
      const result = await call();
      if (path === "hosts.list") {
        f.sources[0]!.isDefault = false;
        f.sources[1]!.isDefault = true;
        f.intercept();
      }
      return result;
    });
    await tool(f, "initiative_manage", { action: "handover", reason: "Fresh context", host: "hetzner" });
    expect(f.store.handover(project.id)?.environment).toEqual({ type: "reuse", environmentId: "env_a" });
  });

  it("a named host whose checkout has no BB environment can't be pinned and is refused", async () => {
    const { f, project } = await twoHosts();
    f.envs.delete("env_a");
    expect(await refused(f, "initiative_manage", { action: "handover", reason: "Fresh context", host: "hetzner" }))
      .toContain("The coordinator's checkout on host hetzner can't be pinned: the default checkout /code/repo on host_a has no BB environment yet.");
    expect(f.store.handover(project.id)).toBeNull();
  });
});

describe("W499 overlap decision table (mayShareCheckout)", () => {
  // Targets: the new thread. A brand-new worktree never reaches the check (overlapWarnings returns at once).
  const targets = {
    reuse: { environmentId: "env_x", record: null },
    projectDefault: { environmentId: null, record: null },
    checkout: { environmentId: null, record: { hostId: "host_a", path: "/code/repo" } },
    unreportedWorktree: { environmentId: null, record: { hostId: "host_a", worktree: true as const } },
  };
  // Writers: a live worker's known environment (id and facts) and what its spawn recorded.
  const sameCheckout = { hostId: "host_a", path: "/code/repo" };
  const otherHost = { hostId: "host_mac", path: "/code/repo" };
  const otherPath = { hostId: "host_a", path: "/code/other" };
  const writers = {
    sameEnv: { environmentId: "env_x", environment: { isWorktree: false, ...sameCheckout }, spawned: null },
    otherEnv: { environmentId: "env_y", environment: { isWorktree: false, ...sameCheckout }, spawned: null },
    knownWorktree: { environmentId: "env_y", environment: { isWorktree: true, hostId: "host_a", path: "/wt/1" }, spawned: { hostId: "host_a", worktree: true as const } },
    knownSameCheckout: { environmentId: "env_y", environment: { isWorktree: false, ...sameCheckout }, spawned: { hostId: "host_a", path: "/code/repo" } },
    knownOtherHost: { environmentId: "env_y", environment: { isWorktree: false, ...otherHost }, spawned: null },
    knownOtherPath: { environmentId: "env_y", environment: { isWorktree: false, ...otherPath }, spawned: null },
    knownNoFacts: { environmentId: "env_y", environment: null, spawned: null },
    unknownNothing: { environmentId: null, environment: null, spawned: null },
    unknownWorktree: { environmentId: null, environment: null, spawned: { hostId: "host_a", worktree: true as const } },
    unknownSameCheckout: { environmentId: null, environment: null, spawned: { hostId: "host_a", path: "/code/repo" } },
    unknownOtherHost: { environmentId: null, environment: null, spawned: { hostId: "host_mac", path: "/code/repo" } },
  };
  // true: warned (may share). Rows: writers; columns: reuse, projectDefault, checkout, unreportedWorktree.
  const expected: Record<keyof typeof writers, [boolean, boolean, boolean, boolean]> = {
    sameEnv: [true, true, true, true],
    otherEnv: [false, true, true, true],
    knownWorktree: [false, false, false, false],
    knownSameCheckout: [false, true, true, true],
    knownOtherHost: [false, true, false, true],
    knownOtherPath: [false, true, false, true],
    knownNoFacts: [false, true, true, true],
    unknownNothing: [true, true, true, true],
    unknownWorktree: [true, true, false, true],
    unknownSameCheckout: [true, true, true, true],
    unknownOtherHost: [true, true, false, true],
  };
  for (const [writer, row] of Object.entries(expected))
    it(`${writer}: ${row.map((warn, i) => `${Object.keys(targets)[i]} ${warn ? "warned" : "not warned"}`).join(", ")}`, () => {
      const actual = Object.values(targets).map((target) => mayShareCheckout(target, writers[writer as keyof typeof writers]));
      expect(actual).toEqual(row);
    });
});
