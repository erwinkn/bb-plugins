import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  BRANCH_PULL_REQUESTS_CHANGED,
  isBranchPullRequestEnvironment,
} from "../lib/branch-pull-request";
import {
  createEligibilityCache,
  LISTS_TTL_MS,
  SLOW_CALL_MS,
  stampedTable,
} from "../lib/branch-pull-request-server";

describe("isBranchPullRequestEnvironment", () => {
  it("accepts a dedicated worktree on a feature branch only", () => {
    // Lets reads started by an event land.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// Outlasts the server's 100 ms signal coalescing, so a missing signal is real.
const signalsSettled = () => new Promise((resolve) => setTimeout(resolve, 150));
const worktree = { isWorktree: true, branchName: "feature", defaultBranch: "main" };
    expect(isBranchPullRequestEnvironment(worktree)).toBe(true);
    // A shared project checkout's branch moves independently of its threads.
    expect(isBranchPullRequestEnvironment({ ...worktree, isWorktree: false })).toBe(false);
    expect(isBranchPullRequestEnvironment({ ...worktree, branchName: "main" })).toBe(false);
    expect(isBranchPullRequestEnvironment({ ...worktree, branchName: null })).toBe(false);
    expect(isBranchPullRequestEnvironment({ ...worktree, defaultBranch: null })).toBe(true);
  });
});

describe("branch pull request eligibility RPC", () => {
  it("marks threads on a shared checkout or default branch as ineligible", async () => {
    const environmentOf: Record<string, string | null> = {
      "thr-shared": "env-shared",
      "thr-default": "env-default",
      "thr-worktree": "env-worktree",
      "thr-sibling": "env-worktree",
      "thr-none": null,
      "thr-missing": "env-worktree",
    };
    const environments: Record<string, { isWorktree: boolean; branchName: string | null; defaultBranch: string | null }> = {
      "env-shared": { isWorktree: false, branchName: "dev", defaultBranch: "dev" },
      "env-default": { isWorktree: true, branchName: "main", defaultBranch: "main" },
      "env-worktree": { isWorktree: true, branchName: "feature", defaultBranch: "main" },
    };
    const environmentReads: string[] = [];
    const h = createFakePluginHost({
      pluginId: "sidebar",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr-missing") throw new Error("gone");
            return { id: threadId, environmentId: environmentOf[threadId] ?? null };
          },
        },
        environments: {
          get: async ({ environmentId }: { environmentId: string }) => {
            environmentReads.push(environmentId);
            return { id: environmentId, ...environments[environmentId] };
          },
        },
      },
    });
    plugin(h.bb);
    try {
      const result = (await h.harness.behavior.callRpc("branchPullRequestEligibility", {
        threadIds: [...Object.keys(environmentOf), "thr-shared"],
      })) as { eligible: Record<string, boolean> };
      // No environment and a deleted thread stay absent: their rows keep
      // showing whatever branch PR BB reports.
      expect(result.eligible).toEqual({
        "thr-shared": false,
        "thr-default": false,
        "thr-worktree": true,
        "thr-sibling": true,
      });
      // Threads on the same environment share one lookup.
      expect(environmentReads.filter((id) => id === "env-worktree")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  // The cause of the "rpc input validation failed" log lines: the sidebar sent
  // every listed thread (the open archive list alone holds thousands) in one
  // call, past the contract's cap.
  it("rejects more than 1,000 ids and accepts exactly 1,000", async () => {
    const h = createFakePluginHost({
      pluginId: "sidebar",
      sdk: {
        threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: null }) },
        environments: { get: async () => ({}) },
      },
    });
    plugin(h.bb);
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `thr-${i}`);
    try {
      await expect(
        h.harness.behavior.callRpc("branchPullRequestEligibility", { threadIds: ids(1001) }),
      ).rejects.toThrow(/input validation failed/);
      await expect(
        h.harness.behavior.callRpc("branchPullRequestEligibility", { threadIds: ids(1000) }),
      ).resolves.toEqual({ eligible: {} });
      await expect(
        h.harness.behavior.callRpc("branchPullRequestEligibility", { threadIds: [""] }),
      ).rejects.toThrow(/input validation failed/);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

type World = {
  threads: Record<string, { environmentId: string | null; archived?: boolean }>;
  environments: Record<
    string,
    { isWorktree: boolean; branchName: string | null; defaultBranch: string | null; status?: string }
  >;
  listsFail?: boolean;
  threadReadsFail?: boolean;
  environmentReadsFail?: boolean;
  /** Thread list pages wait for this. */
  listGate?: Promise<void>;
  /** Environment reads see the world when called and answer once this resolves. */
  environmentGate?: Promise<void>;
};

// A BB with lists and per-id reads over `world`, each read taking `latencyMs`.
// Like BB, the environment list leaves destroyed environments out.
function eligibilityHost(world: World, { latencyMs = 0 } = {}) {
  const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs));
  const environment = (id: string) => ({ id, status: "ready", ...world.environments[id] });
  const thread = (id: string) =>
    makeThreadResponse({
      id,
      environmentId: world.threads[id].environmentId,
      archivedAt: world.threads[id].archived ? 1 : null,
    });
  return createFakePluginHost({
    pluginId: "sidebar",
    sdk: {
      threads: {
        list: async ({ archived = false, limit = 50, offset = 0 } = {}) => {
          await world.listGate;
          await wait();
          if (world.listsFail) throw new Error("lists down");
          return Object.keys(world.threads)
            .filter((id) => !world.threads[id].archived === !archived)
            .slice(offset, offset + limit)
            .map(thread);
        },
        get: async ({ threadId }: { threadId: string }) => {
          await wait();
          if (world.threadReadsFail) throw new Error("reads down");
          if (!world.threads[threadId]) throw Object.assign(new Error("gone"), { status: 404 });
          return thread(threadId);
        },
      },
      environments: {
        list: async ({ limit = 50, offset = 0 } = {}) => {
          await wait();
          if (world.listsFail) throw new Error("lists down");
          return Object.keys(world.environments)
            .map(environment)
            .filter((e) => e.status !== "destroyed")
            .slice(offset, offset + limit);
        },
        get: async ({ environmentId }: { environmentId: string }) => {
          const failed = world.environmentReadsFail;
          const seen = world.environments[environmentId] && environment(environmentId);
          await world.environmentGate;
          await wait();
          if (failed) throw new Error("reads down");
          if (!seen) throw new Error("gone");
          return seen;
        },
      },
    },
  });
}

const eligibility = async (h: ReturnType<typeof eligibilityHost>, threadIds: string[]) =>
  ((await h.harness.behavior.callRpc("branchPullRequestEligibility", { threadIds })) as {
    eligible: Record<string, boolean>;
  }).eligible;
const reads = (h: ReturnType<typeof eligibilityHost>) =>
  Object.fromEntries(
    ["threads.list", "threads.get", "environments.list", "environments.get"].map((path) => [
      path,
      h.harness.inspection.sdk.callsTo(path).length,
    ]),
  );
const changeSignals = (h: ReturnType<typeof eligibilityHost>) =>
  h.harness.inspection.realtimeSignals.filter(
    (signal) => signal.channel === BRANCH_PULL_REQUESTS_CHANGED,
  ).length;
// Lets reads started by an event land.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// Outlasts the server's 100 ms signal coalescing, so a missing signal is real.
const signalsSettled = () => new Promise((resolve) => setTimeout(resolve, 150));
const worktree = { isWorktree: true, branchName: "feature", defaultBranch: "main" };

describe("branch pull request eligibility cache", () => {
  afterEach(() => vi.useRealTimers());

  // The handler read every thread and its environment one by one: ~570 reads
  // and ~0.85 s for 370 live ids, ~2 s for 1,000. The lists answer 1,000 ids
  // in a few pages, and later calls make no read at all.
  it("answers 1,000 active ids from a few list pages, then from memory", async () => {
    const world: World = { threads: {}, environments: {} };
    for (let i = 0; i < 300; i++)
      world.environments[`env-${i}`] = { ...worktree, branchName: i % 3 ? `b-${i}` : "main" };
    for (let i = 0; i < 1000; i++) world.threads[`thr-${i}`] = { environmentId: `env-${i % 300}` };
    const ids = Object.keys(world.threads);
    const h = eligibilityHost(world, { latencyMs: 2 });
    plugin(h.bb);
    try {
      let startedAt = performance.now();
      const cold = await eligibility(h, ids);
      const coldMs = performance.now() - startedAt;
      expect(Object.keys(cold)).toHaveLength(1000);
      expect(cold["thr-1"]).toBe(true);
      expect(cold["thr-0"]).toBe(false);
      // 1,000 threads in five full pages and an empty one, 300 environments in two.
      expect(reads(h)).toEqual({
        "threads.list": 6,
        "threads.get": 0,
        "environments.list": 2,
        "environments.get": 0,
      });
      startedAt = performance.now();
      expect(await eligibility(h, ids)).toEqual(cold);
      const warmMs = performance.now() - startedAt;
      expect(reads(h)).toEqual({
        "threads.list": 6,
        "threads.get": 0,
        "environments.list": 2,
        "environments.get": 0,
      });
      // One by one at 2 ms a read, the same call took over 150 ms.
      expect(coldMs).toBeLessThan(150);
      expect(warmMs).toBeLessThan(20);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("answers exactly as the reads one by one did", async () => {
    const world: World = {
      threads: {
        "thr-shared": { environmentId: "env-shared" },
        "thr-default": { environmentId: "env-default" },
        "thr-worktree": { environmentId: "env-worktree" },
        "thr-none": { environmentId: null },
        "thr-destroyed": { environmentId: "env-destroyed" },
        "thr-provisioning": { environmentId: "env-provisioning" },
        "thr-archived": { environmentId: "env-worktree", archived: true },
        "thr-lost-env": { environmentId: "env-lost" },
      },
      environments: {
        "env-shared": { isWorktree: false, branchName: "dev", defaultBranch: "dev" },
        "env-default": { isWorktree: true, branchName: "main", defaultBranch: "main" },
        "env-worktree": worktree,
        "env-destroyed": { ...worktree, status: "destroyed" },
        "env-provisioning": { ...worktree, branchName: null, status: "provisioning" },
      },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    const ids = [...Object.keys(world.threads), "thr-deleted"];
    const expected = {
      "thr-shared": false,
      "thr-default": false,
      "thr-worktree": true,
      "thr-destroyed": true,
      "thr-provisioning": false,
      "thr-archived": true,
    };
    try {
      expect(await eligibility(h, ids)).toEqual(expected);
      // Off the lists: the archived and deleted threads, the destroyed,
      // provisioning and lost environments.
      expect(reads(h)["threads.get"]).toBe(2);
      expect(reads(h)["environments.get"]).toBe(3);
      expect(await eligibility(h, ids)).toEqual(expected);
      // A destroyed environment is kept; one provisioning or lost is read again.
      expect(reads(h)["threads.get"]).toBe(4);
      expect(reads(h)["environments.get"]).toBe(5);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("follows thread events and announces the answers they change", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": worktree },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      // A new thread on a new environment: its environment is read once. No
      // client knew an answer for it, so nothing is announced.
      world.threads["thr-b"] = { environmentId: "env-b" };
      world.environments["env-b"] = worktree;
      await h.harness.emitThreadEvent("thread.created", {
        thread: makeThreadResponse({ id: "thr-b", environmentId: "env-b" }),
      });
      await flush();
      expect(await eligibility(h, ["thr-a", "thr-b"])).toEqual({ "thr-a": true, "thr-b": true });
      expect(reads(h)).toMatchObject({ "threads.get": 0, "environments.get": 1 });
      await signalsSettled();
      expect(changeSignals(h)).toBe(0);
      // A turn that ends reads its environment again: the agent checked out
      // the default branch.
      world.environments["env-a"] = { ...worktree, branchName: "main" };
      await h.harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr-a", environmentId: "env-a" }),
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
      // An archived thread is read one by one again.
      world.threads["thr-b"].archived = true;
      await h.harness.emitThreadEvent("thread.archived", {
        thread: makeThreadResponse({ id: "thr-b", environmentId: "env-b", archivedAt: 1 }),
      });
      expect(await eligibility(h, ["thr-b"])).toEqual({ "thr-b": true });
      expect(reads(h)["threads.get"]).toBe(1);
      expect(reads(h)["threads.list"]).toBe(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("answers stale lists at once, reads them again and announces a change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": worktree },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      world.environments["env-a"] = { ...worktree, branchName: "main" };
      vi.setSystemTime(Date.now() + LISTS_TTL_MS - 1000);
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      expect(reads(h)["threads.list"]).toBe(1);
      vi.setSystemTime(Date.now() + 2000);
      // The stale answer comes first; the fresh one follows the signal.
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
      expect(reads(h)).toMatchObject({ "threads.list": 2, "threads.get": 0, "environments.get": 0 });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("reads one by one while the lists fail, trying them again after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": worktree },
    };
    world.listsFail = true;
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      expect(reads(h)).toMatchObject({ "threads.list": 1, "threads.get": 2, "environments.get": 1 });
      vi.setSystemTime(Date.now() + LISTS_TTL_MS + 1);
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      expect(reads(h)["threads.list"]).toBe(2);
      expect(h.harness.inspection.logEntries.filter((log) => /lists for branch PRs failed/.test(log.message))).toHaveLength(2);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("never lets a read older than the last list bring back a row it dropped", () => {
    const table = stampedTable<boolean>();
    table.write("env", true, true, 1);
    // Two lists without it: unusable, then gone.
    table.retain(new Set(), 2);
    expect(table.get("env")).toBeUndefined();
    expect(table.last("env")).toBe(true);
    table.retain(new Set(), 3);
    expect(table.last("env")).toBeUndefined();
    // A read begun before the last list lands late.
    table.write("env", true, true, 2);
    expect(table.last("env")).toBeUndefined();
    table.write("env", false, true, 4);
    expect(table.get("env")).toBe(false);
    // An event's value outranks the list page read before it.
    table.write("thr", true, true, 6);
    table.write("thr", false, true, 5);
    expect(table.get("thr")).toBe(true);
  });

  // A failed read must never announce: clients asking again would read the
  // failing environment again, and announce again, for as long as it fails.
  it("reads an environment again after a failed refresh, announcing nothing", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" }, "thr-p": { environmentId: "env-p" } },
      environments: {
        "env-a": worktree,
        "env-p": { ...worktree, branchName: null, status: "provisioning" },
      },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      const ids = ["thr-a", "thr-p"];
      expect(await eligibility(h, ids)).toEqual({ "thr-a": true, "thr-p": false });
      world.environments["env-a"] = { ...worktree, branchName: "main" };
      world.environmentReadsFail = true;
      await h.harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr-a", environmentId: "env-a" }),
        lastAssistantText: null,
      });
      await flush();
      // Unevaluated while its reads fail, beside an environment read each call.
      for (let i = 0; i < 3; i++) expect(await eligibility(h, ids)).toEqual({});
      await signalsSettled();
      expect(changeSignals(h)).toBe(0);
      // The first read that works finds the default branch: one signal, for
      // that change, and none for the calls after it.
      world.environmentReadsFail = false;
      for (let i = 0; i < 3; i++) {
        expect(await eligibility(h, ids)).toEqual({ "thr-a": false, "thr-p": false });
        await signalsSettled();
      }
      expect(changeSignals(h)).toBe(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("reads an environment once more when asked again during a read", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": worktree },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    const idle = () =>
      h.harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr-a", environmentId: "env-a" }),
        lastAssistantText: null,
      });
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      let open!: () => void;
      world.environmentGate = new Promise((resolve) => (open = resolve));
      await idle();
      // The branch moves after the first read saw the world; two more turns end.
      world.environments["env-a"] = { ...worktree, branchName: "main" };
      await idle();
      await idle();
      expect(reads(h)["environments.get"]).toBe(1);
      world.environmentGate = undefined;
      open();
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      expect(reads(h)["environments.get"]).toBe(2);
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("tells clients when a call's own read finds a new answer", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": { ...worktree, branchName: null, status: "provisioning" } },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
      await flush();
      await signalsSettled();
      expect(changeSignals(h)).toBe(0);
      world.environments["env-a"] = worktree;
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      // Ready now, so kept: the next call reads nothing.
      const before = reads(h)["environments.get"];
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      expect(reads(h)["environments.get"]).toBe(before);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("tells clients when a thread with a known answer moves to an environment not read yet", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": { ...worktree, branchName: "main" } },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
      world.threads["thr-a"].environmentId = "env-c";
      world.environments["env-c"] = worktree;
      await h.harness.emitThreadEvent("thread.active", {
        thread: makeThreadResponse({ id: "thr-a", environmentId: "env-c" }),
      });
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("reads the environment again after a failed turn", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": worktree },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      world.environments["env-a"] = { ...worktree, branchName: "main" };
      await h.harness.emitThreadEvent("thread.failed", {
        thread: makeThreadResponse({ id: "thr-a", environmentId: "env-a" }),
        error: null,
      });
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("tells clients when a thread moves to a kept environment", async () => {
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": { ...worktree, branchName: "main" }, "env-b": worktree },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": false });
      world.threads["thr-a"].environmentId = "env-b";
      await h.harness.emitThreadEvent("thread.active", {
        thread: makeThreadResponse({ id: "thr-a", environmentId: "env-b" }),
      });
      await vi.waitFor(() => expect(changeSignals(h)).toBe(1));
      expect(await eligibility(h, ["thr-a"])).toEqual({ "thr-a": true });
      expect(reads(h)).toMatchObject({ "threads.get": 0, "environments.get": 0 });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("announces nothing when the lists drop rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" }, "thr-b": { environmentId: "env-b" } },
      environments: { "env-a": worktree, "env-b": { ...worktree, status: "destroyed" } },
    };
    const h = eligibilityHost(world);
    plugin(h.bb);
    try {
      expect(await eligibility(h, ["thr-a", "thr-b"])).toEqual({ "thr-a": true, "thr-b": true });
      // Archived without an event; its destroyed environment is gone from BB.
      world.threads["thr-b"].archived = true;
      delete world.environments["env-b"];
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(Date.now() + LISTS_TTL_MS + 1);
        await eligibility(h, ["thr-a"]);
        await flush();
      }
      expect(reads(h)["threads.list"]).toBe(4);
      await signalsSettled();
      expect(changeSignals(h)).toBe(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("abandons a stalled read of the lists, so the next refresh runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world: World = {
      threads: { "thr-a": { environmentId: "env-a" } },
      environments: { "env-a": worktree },
    };
    const h = eligibilityHost(world);
    const cache = createEligibilityCache(h.bb, { listsDeadlineMs: 20 });
    const answer = async () => (await cache.eligibility(["thr-a"])).eligible;
    try {
      expect(await answer()).toEqual({ "thr-a": true });
      world.environments["env-a"] = { ...worktree, branchName: "main" };
      let open!: () => void;
      world.listGate = new Promise((resolve) => (open = resolve));
      vi.setSystemTime(Date.now() + LISTS_TTL_MS + 1);
      expect(await answer()).toEqual({ "thr-a": true });
      await vi.waitFor(() =>
        expect(
          h.harness.inspection.logEntries.filter((log) => /lists for branch PRs failed/.test(log.message)),
        ).toHaveLength(1),
      );
      world.listGate = undefined;
      vi.setSystemTime(Date.now() + LISTS_TTL_MS + 1);
      expect(await answer()).toEqual({ "thr-a": true });
      await vi.waitFor(async () => expect(await answer()).toEqual({ "thr-a": false }));
      expect(reads(h)["threads.list"]).toBe(3);
      open();
    } finally {
      cache.dispose();
      await h.harness.lifecycle.dispose();
    }
  });

  it("logs one line for a slow call", async () => {
    const h = eligibilityHost(
      {
        threads: { "thr-a": { environmentId: "env-a" } },
        environments: { "env-a": worktree },
        listsFail: true,
      },
      { latencyMs: SLOW_CALL_MS },
    );
    plugin(h.bb);
    try {
      await eligibility(h, ["thr-a"]);
      const slow = h.harness.inspection.logEntries.filter((log) => /branchPullRequestEligibility took/.test(log.message));
      expect(slow).toHaveLength(1);
      expect(slow[0].message).toMatch(/ids=1 threadReads=1 environmentReads=1 listsAgeMs=none/);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
