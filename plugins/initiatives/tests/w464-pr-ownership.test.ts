// W464 (R2): each PR belongs to one Initiative at most. Equisafe and Equisafe UI share
// equisafe/infra here; only their own PRs and the unassigned ones show in each.
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { memoryStore } from "./helpers";
import { projectFixture } from "./fake-native";
import { MIGRATIONS, Store } from "../lib/store";
import { PR_OWNER_MIGRATIONS, PrOwners, MISS_TTL_MS, ledgerThreads } from "../lib/pr-owners";
import { MergeQueueCache, REMOTE_TTL_MS, type GraphQl } from "../lib/merge-queue-server";
import { detailsAnswer, queryKind, searchPage } from "./gh-fixtures";
import { prSummary, prsByRef } from "../lib/pr-map";
import { blankPrRecord, type PrRecord } from "../lib/pr-stages";

const url = (n: number) => `https://github.com/equisafe/infra/pull/${n}`;
const ghPr = (number: number, headRefName: string) => ({
  number, title: `PR ${number}`, url: url(number), isDraft: false, reviewDecision: "", mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", headRefName, baseRefName: "main", createdAt: new Date(Date.UTC(2026, 9, 1) + number * 60_000).toISOString(),
  updatedAt: "2026-10-01T00:00:00Z",
});
// #1 from W1's thread, #2 from a child of W1's thread, #3 from the user's own branch, #4 from Equisafe UI's W1.
const OPEN = [ghPr(1, "bb/w1-api-thr_w1"), ghPr(2, "bb/review-thr_child"), ghPr(3, "fix/typo"), ghPr(4, "bb/w1-ui-thr_ui1")];

/** Two Initiatives over equisafe/infra, a worker in each, and a child thread under Equisafe's W1. */
function setup(open = OPEN, held?: Promise<void>, gone = new Set<string>()) {
  const { store, db, clock } = memoryStore();
  for (const [id, name] of [["eq", "Equisafe"], ["ui", "Equisafe UI"]] as const) {
    store.createProject({ id, name, objective: "o", memberProjectIds: ["proj_infra"], coordinatorThreadId: `thr_c_${id}` });
    const worker = store.createWorker({ projectId: id, role: "work", label: "W", area: "a", bbProjectId: "proj_infra" });
    const thread = id === "eq" ? "thr_w1" : "thr_ui1";
    store.updateWorker(id, worker.num, { threadId: thread, generation: 1 });
    store.openGeneration(id, worker.num, 1, thread);
  }
  store.createProject({ id: "bb", name: "bb-plugins", objective: "o", memberProjectIds: ["proj_bb"], coordinatorThreadId: "thr_c_bb" });
  const parents: Record<string, string | null> = { thr_child: "thr_w1", thr_w1: "thr_c_eq", thr_c_eq: null };
  const parentOf = vi.fn(async (id: string) => parents[id] ?? null);
  const changed = vi.fn();
  const fetched = vi.fn();
  /** Each Initiative's PR records, by URL. */
  const records = new Map<string, Map<string, PrRecord>>();
  const owners = new PrOwners(db, ledgerThreads(store, parentOf), changed, () => clock.now);
  const gh = vi.fn<GraphQl>(async (query, variables) => (queryKind(query) === "details" ? detailsAnswer(variables) : searchPage(open)));
  // `held` holds bb-plugins' remote lookup; a project in `gone` answers 404.
  const project = vi.fn(async (id: string) => {
    if (gone.has(id)) throw new Error("404 project not found");
    return id === "proj_bb" ? (await held, { name: "bb-plugins", gitRemoteUrl: "git@github.com:erwinkn/bb-plugins.git" }) : { name: "infra", gitRemoteUrl: "git@github.com:equisafe/infra.git" };
  });
  const cache = new MergeQueueCache({
    memberProjectIds: (id) => store.project(id)!.memberProjectIds,
    project,
    workers: () => new Map(), prRecords: (id) => records.get(id) ?? new Map(), assignedPrs: () => new Map(), notes: () => new Map(),
    owners: (prs) => owners.owners(prs),
  }, gh, () => clock.now, fetched);
  /** Each listed PR: its number, and "own" or "unassigned". */
  const list = async (projectId: string) => {
    await cache.read(projectId);
    await cache.settled();
    return (await cache.read(projectId)).pullRequests.map((pr) => [pr.number, pr.unassigned ? "unassigned" : "own"]).sort();
  };
  return { store, db, clock, owners, parents, parentOf, changed, fetched, records, project, gone, cache, list };
}

describe("W464 PR ownership (R2)", () => {
  it("gives a worker's PR to its Initiative at once, and a worker descendant's once BB names its parents", async () => {
    const t = setup();
    // #2's thread is no worker: unassigned until the lookup behind the read finds W1 above it.
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "unassigned"], [3, "unassigned"]]);
    await t.owners.settled();
    expect(t.parentOf).toHaveBeenCalledWith("thr_child");
    // r2 #3: the walk stops at the first worker; the worker's own parent is never read.
    expect(t.parentOf).not.toHaveBeenCalledWith("thr_w1");
    expect(t.changed).toHaveBeenCalledTimes(1);
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"]]);
    // Recorded once, as automatic.
    expect(t.db.prepare("SELECT url, project_id, source FROM pr_owners ORDER BY url").all()).toEqual([
      { url: url(1), project_id: "eq", source: "auto" },
      { url: url(2), project_id: "eq", source: "auto" },
      { url: url(4), project_id: "ui", source: "auto" },
    ]);
  });

  it("shows an unassigned PR in both Initiatives and an assigned one only in its owner", async () => {
    const t = setup();
    await t.list("eq");
    await t.owners.settled();
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"]]);
    expect(await t.list("ui")).toEqual([[3, "unassigned"], [4, "own"]]);
  });

  it("lets a manual move beat the automatic owner, and keeps a manual Unassign", async () => {
    const t = setup();
    await t.list("eq");
    await t.owners.settled();
    t.owners.move(url(1), "ui", 5);
    // Before any read of Equisafe UI too: a manual row is never replaced by an automatic one.
    t.owners.move(url(4), null, 5);
    expect(await t.list("eq")).toEqual([[2, "own"], [3, "unassigned"], [4, "unassigned"]]);
    expect(await t.list("ui")).toEqual([[1, "own"], [3, "unassigned"], [4, "unassigned"]]);
    expect(t.db.prepare("SELECT project_id, source FROM pr_owners WHERE url = ?").get(url(4))).toEqual({ project_id: null, source: "manual" });
    t.owners.move(url(4), "ui", 6);
    expect(await t.list("ui")).toEqual([[1, "own"], [3, "unassigned"], [4, "own"]]);
  });

  it("leaves an archived owner's PRs unassigned, and looks a thread up again after a while", async () => {
    const t = setup();
    await t.list("eq");
    await t.owners.settled();
    t.store.updateProject("ui", { archivedAt: 9 });
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"], [4, "unassigned"]]);
    // A thread with no worker above it: not looked up again within MISS_TTL_MS…
    const fresh = setup();
    const prs = [{ url: url(9), head: "bb/x-thr_orphan" }];
    expect(fresh.owners.owners(prs).size).toBe(0);
    await fresh.owners.settled();
    expect(fresh.owners.owners(prs).size).toBe(0);
    expect(fresh.parentOf).toHaveBeenCalledTimes(1);
    // …and after it, when it may have joined a worker since.
    fresh.clock.now += MISS_TTL_MS;
    fresh.owners.owners(prs);
    await fresh.owners.settled();
    expect(fresh.parentOf).toHaveBeenCalledTimes(2);
  });

  it("keeps agent reads to the Initiative's own PRs, listing the unassigned ones apart", async () => {
    const t = setup();
    await t.list("eq");
    await t.owners.settled();
    const queue = await t.cache.read("ui");
    const summary = prSummary(queue);
    expect(summary).toMatchObject({ open: 1, unassigned: 1, unassignedPrs: ["#3 PR 3"] });
    expect(Object.keys(summary.byCategory.Uncategorized!).length).toBe(1);
    expect(JSON.stringify(summary.byCategory)).not.toContain("#3");
    expect(summary.owners).toMatch(/initiative_pr/);
    // Refs read the unassigned PRs too, marked; another Initiative's are not in the queue.
    const read = prsByRef(queue, ["#3", "#4", "#1"]);
    expect(read.prs["#3"]).toMatchObject({ unassigned: true });
    expect(read.prs["#4"]).not.toHaveProperty("unassigned");
    expect(read.missingRefs).toEqual(["#1"]);
  });

  it("reads an Initiative's repositories from its members' remotes", async () => {
    const t = setup();
    expect(await t.cache.reposOf("eq")).toEqual(["equisafe/infra"]);
    expect(await t.cache.reposOf("bb")).toEqual(["erwinkn/bb-plugins"]);
  });

  it("leaves a PR unassigned while its owner doesn't list its repository, so it never vanishes (r1 #1)", async () => {
    const t = setup();
    t.owners.move(url(3), "bb", 5);
    await t.list("eq");
    await t.owners.settled();
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"]]);
    expect(await t.list("ui")).toEqual([[3, "unassigned"], [4, "own"]]);
  });

  it("stages a PR another Initiative owns by that Initiative's records, so a stack above it waits (r1 #2)", async () => {
    // #6 (Equisafe's, ready) sits on #5 (Equisafe UI's, which UI recorded as being worked on).
    const t = setup([{ ...ghPr(5, "bb/w1-ui-thr_ui1"), reviewDecision: "APPROVED" }, { ...ghPr(6, "bb/w1-api-thr_w1"), baseRefName: "bb/w1-ui-thr_ui1", reviewDecision: "APPROVED" }]);
    t.records.set("ui", new Map([[url(5), { ...blankPrRecord(url(5), 1), stage: "working", setAt: 1 }]]));
    await t.list("eq");
    const eq = await t.cache.read("eq");
    expect(eq.pullRequests.map((pr) => [pr.number, pr.stage, pr.available])).toEqual([[6, "ready-for-erwin", false]]);
    // r3 #2: what #6 waits on stays nameable, and the agent's stacks start from #6.
    expect(eq.beneath!.map((pr) => [pr.number, pr.stage])).toEqual([[5, "working"]]);
    expect(prSummary(eq).stacks).toEqual(["(on #5) #6"]);
    // Once UI says #5 is ready for the user, #6 is available in Equisafe.
    t.records.set("ui", new Map([[url(5), { ...blankPrRecord(url(5), 1), stage: "ready-for-erwin", setAt: 1 }]]));
    expect((await t.cache.read("eq")).pullRequests.map((pr) => [pr.number, pr.available])).toEqual([[6, true]]);
  });

  it("never waits on another Initiative's remote; its owner holds the PR until the lookup lands and is announced (r2 #1)", async () => {
    let release!: () => void;
    const t = setup(OPEN, new Promise<void>((resolve) => { release = resolve; }));
    await t.list("eq");
    await t.owners.settled();
    t.owners.move(url(3), "bb", 5);
    // bb-plugins' repositories aren't known yet: the read answers at once, and #3 stays bb-plugins'.
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"]]);
    expect(t.cache.cachedRepos("bb")).toBeNull();
    t.fetched.mockClear();
    release();
    await vi.waitFor(() => expect(t.fetched).toHaveBeenCalledWith("erwinkn/bb-plugins"));
    // Known now, and without equisafe/infra: #3 is unassigned again rather than nowhere.
    expect(t.cache.cachedRepos("bb")).toEqual(["erwinkn/bb-plugins"]);
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"]]);
  });

  it("leaves a PR unassigned when its owner's project can't be read, asking BB again only later (r6)", async () => {
    const t = setup(OPEN, undefined, new Set(["proj_gone"]));
    // Equisafe UI owned #3 by hand; then its member project was deleted (and the plugin restarted).
    t.store.updateProject("ui", { memberProjectIds: ["proj_gone"] });
    t.owners.move(url(3), "ui", 5);
    await t.list("eq");
    await t.owners.settled();
    await vi.waitFor(() => expect(t.cache.cachedRepos("ui")).toEqual([]));
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"], [4, "unassigned"]]);
    // Reads don't ask again within REMOTE_TTL_MS…
    const asked = () => t.project.mock.calls.filter(([id]) => id === "proj_gone").length;
    const before = asked();
    for (let i = 0; i < 3; i++) await t.list("eq");
    expect(asked()).toBe(before);
    // …and do after it: a project back by then owns its PRs again.
    t.clock.now += REMOTE_TTL_MS;
    t.gone.delete("proj_gone");
    await vi.waitFor(() => expect(t.cache.cachedRepos("ui")).toEqual(["equisafe/infra"]));
    expect(asked()).toBe(before + 1);
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"]]);
  });

  it("keeps an owner's last good repositories through failed refreshes (r7)", async () => {
    const t = setup();
    t.owners.move(url(3), "ui", 5);
    await t.list("ui");
    expect(t.cache.cachedRepos("ui")).toEqual(["equisafe/infra"]);
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"]]);
    // proj_infra's lookups fail from now on: two refreshes in a row, each after REMOTE_TTL_MS.
    t.gone.add("proj_infra");
    for (let i = 0; i < 2; i++) {
      const calls = t.project.mock.calls.length;
      t.clock.now += REMOTE_TTL_MS;
      t.cache.cachedRepos("ui");
      await vi.waitFor(() => expect(t.project.mock.calls.length).toBeGreaterThan(calls));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(t.cache.cachedRepos("ui")).toEqual(["equisafe/infra"]);
    }
    // #3 stays Equisafe UI's: still out of Equisafe's list.
    expect((await t.cache.read("eq")).pullRequests.map((pr) => pr.number).sort()).toEqual([1, 2]);
  });

  it("announces an owner's first lookup when it fails, then waits REMOTE_TTL_MS (r8)", async () => {
    const t = setup(OPEN, undefined, new Set(["proj_bb"]));
    await t.list("eq");
    await t.owners.settled();
    t.owners.move(url(3), "bb", 5);
    t.fetched.mockClear();
    // bb-plugins' project answers 404: #3 is held while its first lookup runs…
    expect(await t.cache.read("eq").then((q) => q.pullRequests.map((pr) => pr.number).sort())).toEqual([1, 2]);
    // …and the failure is announced, so the dashboard reads again and shows #3 unassigned.
    await vi.waitFor(() => expect(t.fetched).toHaveBeenCalledWith(""));
    expect(t.cache.cachedRepos("bb")).toEqual([]);
    expect(await t.list("eq")).toEqual([[1, "own"], [2, "own"], [3, "unassigned"]]);
    // No new lookup, so no new announcement, within REMOTE_TTL_MS.
    for (let i = 0; i < 3; i++) t.cache.cachedRepos("bb");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.fetched.mock.calls.filter(([repo]) => repo === "")).toHaveLength(1);
  });

  it("keeps a stack bottom-up when another Initiative owns its root (r2 #2)", async () => {
    // #1 (Equisafe UI's) ← #2 ← #3, #3 opened before #2 and retargeted onto it since.
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString();
    const ready = { reviewDecision: "APPROVED" };
    const t = setup([
      { ...ghPr(1, "bb/w1-ui-thr_ui1"), ...ready, createdAt: at(0) },
      { ...ghPr(2, "b"), ...ready, baseRefName: "bb/w1-ui-thr_ui1", createdAt: at(20) },
      { ...ghPr(3, "c"), ...ready, baseRefName: "b", createdAt: at(10) },
    ]);
    t.owners.move(url(2), "eq", 1);
    t.owners.move(url(3), "eq", 1);
    await t.list("eq");
    const queue = await t.cache.read("eq");
    expect(queue.pullRequests.map((pr) => pr.number).sort()).toEqual([2, 3]);
    expect(prSummary(queue).next.map((n) => n.pr)).toEqual(["#2", "#3"]);
  });

  it("keeps a listed unassigned parent out of beneath (r4)", async () => {
    // Equisafe's #6 sits on unassigned #5: #5 is listed, under Unassigned, not beneath.
    const t = setup([{ ...ghPr(5, "five"), isDraft: true }, { ...ghPr(6, "bb/w1-api-thr_w1"), baseRefName: "five" }]);
    await t.list("eq");
    const eq = await t.cache.read("eq");
    expect(eq.pullRequests.map((pr) => [pr.number, pr.unassigned]).sort()).toEqual([[5, true], [6, false]]);
    expect(eq.beneath).toEqual([]);
  });

  it("takes a worker the ledger knows over a cached miss (r1 #4)", async () => {
    const t = setup();
    const prs = [{ url: url(9), head: "bb/x-thr_late" }];
    expect(t.owners.owners(prs).size).toBe(0);
    await t.owners.settled();
    // The thread becomes Equisafe UI's worker: no waiting out the miss.
    const worker = t.store.createWorker({ projectId: "ui", role: "work", label: "Late", area: "a", bbProjectId: "proj_infra" });
    t.store.updateWorker("ui", worker.num, { threadId: "thr_late", generation: 1 });
    expect(t.owners.owners(prs).get(url(9))).toMatchObject({ projectId: "ui", source: "auto" });
  });

  it("follows a descendant's parents to the root, however deep, and stops on a cycle (r1 #5)", async () => {
    const t = setup();
    // thr_d12 → … → thr_d1 → thr_w1: twelve levels below Equisafe's worker.
    for (let i = 1; i <= 12; i++) t.parents[`thr_d${i}`] = i === 1 ? "thr_w1" : `thr_d${i - 1}`;
    t.parents.thr_loop_a = "thr_loop_b";
    t.parents.thr_loop_b = "thr_loop_a";
    const prs = [{ url: url(10), head: "bb/deep-thr_d12" }, { url: url(11), head: "bb/loop-thr_loop_a" }];
    t.owners.owners(prs);
    await t.owners.settled();
    const found = t.owners.owners(prs);
    expect(found.get(url(10))).toMatchObject({ projectId: "eq", source: "auto" });
    expect(found.has(url(11))).toBe(false);
  });

  it("keeps a manual choice made while a parent lookup was still running", async () => {
    const t = setup();
    let release!: () => void;
    t.parentOf.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve("thr_w1"); }));
    const prs = [{ url: url(2), head: "bb/review-thr_child" }];
    expect(t.owners.owners(prs).size).toBe(0);
    t.owners.move(url(2), null, 5);
    release();
    await t.owners.settled();
    expect(t.owners.owners(prs).size).toBe(0);
    expect(t.db.prepare("SELECT project_id, source FROM pr_owners WHERE url = ?").get(url(2))).toEqual({ project_id: null, source: "manual" });
  });

  it("pages through every unassigned PR with unassigned:true (r1 #3)", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...ghPr(100 + i, `fix/${i}`), title: `A long title for unassigned PR ${i} `.repeat(4) }));
    const t = setup(many);
    const queue = (await t.list("eq"), await t.cache.read("eq"));
    const summary = prSummary(queue);
    expect(summary.unassignedPrs!.length).toBeLessThan(400);
    expect(summary.truncated).toMatch(/unassigned PRs left out/);
    expect(summary.owners).toMatch(/"unassigned":true/);
    const seen = new Set<string>();
    for (let offset: number | null = 0; offset !== null; ) {
      const page = prSummary(queue, { unassigned: true, offset, limit: 30 });
      expect(page.unassignedPrs).toBeUndefined();
      for (const ref of Object.keys(page.state)) seen.add(ref);
      offset = page.page.nextOffset;
    }
    expect(seen.size).toBe(400);
  });
});

describe("W464 moving PRs with initiative_pr and the prOwner RPC", () => {
  type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
  const call = async (f: Fx, tool: string, input: unknown, threadId = "coordinator") =>
    JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);
  const owner = (f: Fx, n: number) => f.store.db.prepare("SELECT project_id, source FROM pr_owners WHERE url = ?").get(url(n));
  /**
   * proj_a and proj_ui are equisafe/infra, Equisafe UI's member; bb-plugins lists erwinkn/bb-plugins.
   * `held` holds proj_ui's lookup.
   */
  const twoInitiatives = (f: Fx, held?: Promise<void>) => {
    let asked!: () => void;
    const lookedUp = new Promise<void>((resolve) => { asked = resolve; });
    f.intercept(async (path, args, call) => {
      if (path !== "projects.get") return call();
      if (args.projectId === "proj_ui") {
        asked();
        await held;
      }
      return {
        id: args.projectId, name: args.projectId, sources: [],
        gitRemoteUrl: args.projectId === "proj_bb" ? "https://github.com/erwinkn/bb-plugins.git" : "git@github.com:equisafe/infra.git",
      };
    });
    f.store.createProject({ id: "ui", name: "Equisafe UI", objective: "o", memberProjectIds: ["proj_ui"], coordinatorThreadId: null });
    f.store.createProject({ id: "bbp", name: "bb-plugins", objective: "o", memberProjectIds: ["proj_bb"], coordinatorThreadId: null });
    /** Resolves once Equisafe UI's lookup started. */
    return lookedUp;
  };

  it("moves by name or id, unassigns with null, and refuses an unknown Initiative", async () => {
    const { f, project } = await projectFixture();
    twoInitiatives(f);
    expect(await call(f, "initiative_pr", { prs: [{ url: url(1), initiative: "equisafe ui" }] })).toEqual({ prs: [{ url: url(1), initiative: "Equisafe UI" }] });
    expect(owner(f, 1)).toEqual({ project_id: "ui", source: "manual" });
    await call(f, "initiative_pr", { prs: [{ url: url(1), initiative: project.id, stage: "in-review" }] });
    expect(owner(f, 1)).toEqual({ project_id: project.id, source: "manual" });
    expect(f.store.prRecords(project.id).get(url(1))?.stage).toBe("in-review");
    expect(await call(f, "initiative_pr", { prs: [{ url: url(1), initiative: null }] })).toEqual({ prs: [{ url: url(1), initiative: null }] });
    expect(owner(f, 1)).toEqual({ project_id: null, source: "manual" });
    // One invalid entry rolls the whole call back.
    await expect(call(f, "initiative_pr", { prs: [{ url: url(2), initiative: "ui" }, { url: url(3), initiative: "Nope" }] })).rejects.toThrow(/No open Adventure is named "Nope"/);
    expect(owner(f, 2)).toBeUndefined();
    expect(await f.harness.callRpc("prOwner", { projectId: project.id, url: "equisafe/infra#5", initiative: "ui" })).toEqual({ url: url(5), initiative: "Equisafe UI" });
    expect(owner(f, 5)).toEqual({ project_id: "ui", source: "manual" });
    // r1 #1: never to an Initiative that doesn't list the PR's repository, where it would show nowhere.
    await expect(call(f, "initiative_pr", { prs: [{ url: url(6), initiative: "bb-plugins" }] })).rejects.toThrow(/bb-plugins doesn't list equisafe\/infra/);
    await expect(f.harness.callRpc("prOwner", { projectId: project.id, url: url(6), initiative: "bbp" })).rejects.toThrow(/doesn't list equisafe\/infra/);
    expect(owner(f, 6)).toBeUndefined();
    // The dashboard's choices carry each Initiative's repositories.
    const queue = await f.harness.callRpc("mergeQueue", { projectId: project.id }) as { initiatives: { id: string; repos: string[] }[] };
    expect(Object.fromEntries(queue.initiatives.map((t) => [t.id, t.repos]))).toEqual({ [project.id]: ["equisafe/infra"], ui: ["equisafe/infra"], bbp: ["erwinkn/bb-plugins"] });
  });

  it("checks a destination again after waiting on its repositories: renames, member changes, archives (r3 #1)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { f, project } = await projectFixture();
    const lookedUp = twoInitiatives(f, held);
    // bb-plugins' repositories are known; Equisafe UI's lookup is held.
    await expect(call(f, "initiative_pr", { prs: [{ url: url(9), initiative: "bb-plugins" }] })).rejects.toThrow(/doesn't list/);
    const renamed = call(f, "initiative_pr", { prs: [{ url: url(1), initiative: "Equisafe UI" }] });
    await lookedUp;
    const regrouped = f.harness.callRpc("prOwner", { projectId: project.id, url: url(2), initiative: "ui" });
    // Meanwhile Equisafe UI is renamed, and another Initiative takes its old name.
    f.store.updateProject("ui", { name: "Old UI" });
    f.store.updateProject("bbp", { name: "Equisafe UI" });
    release();
    // The destination is the Initiative named when the call came, by id; its new name is reported.
    expect(await renamed).toEqual({ prs: [{ url: url(1), initiative: "Old UI" }] });
    expect(owner(f, 1)).toEqual({ project_id: "ui", source: "manual" });
    expect(await regrouped).toEqual({ url: url(2), initiative: "Old UI" });

    // A member change while the lookup waits: checked as it is after the wait.
    let again!: () => void;
    const second = await projectFixture();
    twoInitiatives(second.f, new Promise<void>((resolve) => { again = resolve; }));
    await second.f.harness.callRpc("mergeQueue", { projectId: second.project.id });
    const moved = call(second.f, "initiative_pr", { prs: [{ url: url(3), initiative: "Equisafe UI" }] });
    const viaRpc = second.f.harness.callRpc("prOwner", { projectId: second.project.id, url: url(4), initiative: "ui" });
    second.f.store.updateProject("ui", { memberProjectIds: ["proj_bb"] });
    again();
    await expect(moved).rejects.toThrow(/Equisafe UI doesn't list equisafe\/infra/);
    await expect(viaRpc).rejects.toThrow(/doesn't list equisafe\/infra/);
    expect(owner(second.f, 3)).toBeUndefined();
    expect(owner(second.f, 4)).toBeUndefined();

    // An archive while it waits: refused.
    let last!: () => void;
    const third = await projectFixture();
    twoInitiatives(third.f, new Promise<void>((resolve) => { last = resolve; }));
    const archived = call(third.f, "initiative_pr", { prs: [{ url: url(5), initiative: "Equisafe UI" }] });
    third.f.store.updateProject("ui", { archivedAt: 1 });
    last();
    await expect(archived).rejects.toThrow(/No open Adventure/);
    expect(owner(third.f, 5)).toBeUndefined();
  });

  it("lets a worker move its own PRs only", async () => {
    const { f, project } = await projectFixture();
    twoInitiatives(f);
    await call(f, "initiative_spawn", { label: "PR work", purpose: "pr", text: `Fix ${url(7)}.` });
    const worker = f.store.worker(project.id, f.store.assignments(project.id).at(-1)!.workerNum)!;
    expect(await call(f, "initiative_pr", { prs: [{ url: url(7), initiative: "Equisafe UI" }] }, worker.threadId!)).toEqual({ prs: [{ url: url(7), initiative: "Equisafe UI" }] });
    // W492: a PR another worker holds stays its own.
    f.store.savePrRecord(project.id, { ...blankPrRecord(url(8), 1), worker: "W99" });
    await expect(call(f, "initiative_pr", { prs: [{ url: url(8), initiative: "Equisafe UI" }] }, worker.threadId!)).rejects.toThrow(/keeps only its own PRs.*W99 holds it/);
    expect(owner(f, 8)).toBeUndefined();
  });
});

describe("W464 migration", () => {
  it("adds one empty table over a database the previous build migrated, and the previous build still runs over it", async () => {
    const host = createFakePluginHost();
    const db = host.bb.storage.database();
    try {
      const previous = MIGRATIONS.slice(0, MIGRATIONS.indexOf(PR_OWNER_MIGRATIONS[0]!));
      host.bb.storage.migrate(db, previous);
      db.prepare("INSERT INTO pr_records (project_id, url, stage, updated_at) VALUES ('p', ?, 'in-review', 1)").run(url(1));
      const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[];
      const before = tables();
      host.bb.storage.migrate(db, MIGRATIONS);
      // Later migrations (W468's report_notices, W506's PR refs, W548's PR watches) are appended after it.
      expect(tables()).toEqual([...before, "pr_owners", "report_notices", "assignment_pr_refs", "assignment_pr_scans", "pr_watches", "pr_wakes"].sort());
      expect(db.prepare("SELECT count(*) FROM pr_owners").pluck().get()).toBe(0);
      expect(db.prepare("SELECT stage FROM pr_records").pluck().all()).toEqual(["in-review"]);
      // Rollback: the previous build's statements are all recorded, so it applies nothing and never reads pr_owners.
      db.prepare("INSERT INTO pr_owners (url, project_id, source, set_at) VALUES (?, 'p', 'manual', 1)").run(url(1));
      host.bb.storage.migrate(db, previous);
      expect(new Store(db).prRecords("p").get(url(1))?.stage).toBe("in-review");
    } finally {
      await host.harness.dispose();
    }
  });
});
