// @vitest-environment jsdom
// D441 (W229's second P1): no read waits on GitHub. Each case W229 probed (cold, stale,
// forced, in flight, and a cold `gh api user`) answers at once with gh held open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MergeQueueCache, MIN_FORCED_REFRESH_MS, REFRESH_MS, type GhRunner } from "../lib/merge-queue-server";
import { PR_STAGES } from "../lib/pr-stages";
import { parsePullRequests, type MergeQueue } from "../lib/merge-queue";
import { appReads } from "../lib/dashboard-data";
import { projectFixture } from "./fake-native";


await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { slots.splice(0).forEach((s) => s.unmount()); cleanup(); appReads.clear(); vi.restoreAllMocks(); });

const raw = [{ number: 1, title: "Cached PR", url: "https://github.com/o/r/pull/1", headRefName: "a", baseRefName: "main" }];
const page = JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
/** Settles within this many macrotasks or reports that it is still waiting. */
const promptly = <T,>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20))]);

/** A cache whose gh calls of one kind (`hold`) wait until released. */
const setup = () => {
  let now = 1_000_000;
  const held = new Map<string, { release: () => void; promise: Promise<void> }>();
  const hold = (kind: string) => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    held.set(kind, { release, promise });
    return release;
  };
  const gh = vi.fn<GhRunner>(async (args) => {
    const kind = args[1] === "user" ? "user" : args[1] === "graphql" ? "graphql" : "list";
    await held.get(kind)?.promise;
    return kind === "user" ? "o" : kind === "graphql" ? page : JSON.stringify(raw);
  });
  const cache = new MergeQueueCache({
    memberProjectIds: () => ["b"], project: async () => ({ name: "R", gitRemoteUrl: "https://github.com/o/r" }),
    workers: () => new Map(), prRecords: () => new Map(), assignedPrs: () => new Map(), notes: () => new Map(),
  }, gh, () => now);
  const calls = (kind: "graphql" | "list") => gh.mock.calls.filter(([args]) => (kind === "graphql" ? args[1] === "graphql" : args[0] === "pr")).length;
  return { cache, gh, hold, calls, advance: (ms: number) => { now += ms; }, releaseAll: () => held.forEach((h) => h.release()) };
};

describe("D441: MergeQueueCache reads never wait on gh", () => {
  it("cold: answers with a fetching, empty snapshot while the login, list and details are held", async () => {
    const s = setup();
    s.hold("user");
    const q = await promptly(s.cache.read("p"));
    expect(q).not.toBe("waiting");
    expect(q).toMatchObject({ login: null, pullRequests: [], repos: [{ repo: "o/r", fetchedAt: null, fetching: true }] });
    s.releaseAll();
    s.hold("graphql");
    // The login landed; the list lands while graphql is still held: the read still answers at once.
    await waitFor(() => expect(s.calls("graphql")).toBe(1));
    expect(await promptly(s.cache.read("p"))).toMatchObject({ login: "o", repos: [{ fetching: true }] });
    s.releaseAll();
    await s.cache.settled();
    expect((await s.cache.read("p")).pullRequests.map((pr) => pr.title)).toEqual(["Cached PR"]);
  });

  it("stale: serves the cached PRs and refreshes behind them; a concurrent read joins that one fetch", async () => {
    const s = setup();
    await s.cache.read("p");
    await s.cache.settled();
    s.advance(REFRESH_MS);
    s.hold("graphql");
    s.hold("list");
    const [first, second] = await Promise.all([promptly(s.cache.read("p")), promptly(s.cache.read("other-initiative"))]);
    for (const q of [first, second]) expect(q).toMatchObject({ pullRequests: [{ title: "Cached PR" }], repos: [{ fetching: true }] });
    await waitFor(() => expect(s.calls("graphql")).toBe(2));
    // In flight: more reads join it, never start another and never wait.
    expect(await promptly(s.cache.read("p", { refresh: true }))).toMatchObject({ repos: [{ fetching: true }] });
    expect([s.calls("list"), s.calls("graphql")]).toEqual([2, 2]);
    s.releaseAll();
    await s.cache.settled();
    expect((await s.cache.read("p")).repos[0]!.fetching).toBe(false);
  });

  it("forced: a manual refresh returns the cache at once and refreshes behind it", async () => {
    const s = setup();
    await s.cache.read("p");
    await s.cache.settled();
    s.advance(MIN_FORCED_REFRESH_MS);
    s.hold("graphql");
    const q = await promptly(s.cache.read("p", { refresh: true }));
    expect(q).toMatchObject({ pullRequests: [{ title: "Cached PR" }], repos: [{ fetching: true }] });
    await waitFor(() => expect(s.calls("graphql")).toBe(2));
    s.releaseAll();
    await s.cache.settled();
  });
});

describe("D441: nor on BB, nor past the details budget (W229)", () => {
  const sources = (project: () => Promise<{ name: string; gitRemoteUrl: string | null }>) => ({
    memberProjectIds: () => ["b"], project, workers: () => new Map(), prRecords: () => new Map(), assignedPrs: () => new Map(), notes: () => new Map(),
  });
  const answer = async (args: string[]) => args[1] === "user" ? "o" : args[1] === "graphql" ? page : JSON.stringify(raw);

  it("serves the last member remote to every read while BB is asked again, and asks once", async () => {
    let now = 1;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const project = vi.fn(async () => {
      if (project.mock.calls.length > 1) await held;
      return { name: "R", gitRemoteUrl: "https://github.com/o/r" };
    });
    const cache = new MergeQueueCache(sources(project), answer, () => now);
    await cache.read("p");
    await cache.settled();
    now += 5 * 60_000;
    for (let i = 0; i < 3; i++) expect(await promptly(cache.read("p"))).toMatchObject({ repos: [{ repo: "o/r" }], pullRequests: [{ title: "Cached PR" }] });
    expect(project).toHaveBeenCalledTimes(2);
    release();
    await cache.settled();
  });

  it("gives each details page only the time left of the 20s budget, and starts none once it is spent", async () => {
    let now = 1;
    /** A gh whose pages take these many ms, killed like the real one once its time is up. */
    const run = async (durations: number[]) => {
      const timeouts: (number | undefined)[] = [];
      const gh: GhRunner = async (args, timeoutMs) => {
        if (args[1] !== "graphql") return answer(args);
        const took = durations[timeouts.push(timeoutMs) - 1]!;
        now += Math.min(took, timeoutMs!);
        if (took > timeoutMs!) throw new Error("gh timed out");
        return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: true, endCursor: `c${timeouts.length}` }, nodes: [] } } });
      };
      const start = now;
      const cache = new MergeQueueCache(sources(async () => ({ name: "R", gitRemoteUrl: "https://github.com/o/r" })), gh, () => now);
      await cache.read("p");
      await cache.settled();
      return { timeouts, took: now - start, repo: (await cache.read("p")).repos[0]! };
    };
    // Two pages spend the budget: no third starts, and the pages read count.
    expect(await run([10_000, 10_000, 1])).toMatchObject({ timeouts: [20_000, 10_000], took: 20_000, repo: { detailsError: null, error: null } });
    // A first page ends a millisecond short: the second gets that millisecond, not another 20s.
    expect(await run([19_999, 5_000])).toMatchObject({ timeouts: [20_000, 1], took: 20_000, repo: { detailsError: "gh timed out", error: null } });
  });
});

describe("D441: the server handlers answer at once", () => {
  it("initiative_read {view:prs} and the mergeQueue RPC return while the GitHub fetch never ends", async () => {
    // Every fetch hangs, and no gh process is spawned: a handler that awaited one would never resolve.
    const fetches: string[] = [];
    vi.spyOn(MergeQueueCache.prototype as unknown as { fetch: (entry: { name: string }) => Promise<void> }, "fetch")
      .mockImplementation((entry) => { fetches.push(entry.name); return new Promise(() => {}); });
    const { f, project } = await projectFixture();
    f.intercept(async (path, _input, next) => {
      const out = await next();
      return path === "projects.get" ? { ...(out as object), gitRemoteUrl: "https://github.com/o/r.git" } : out;
    });
    const read = await promptly(f.harness.callAgentTool("initiative_read", { view: "prs" }, { threadId: "coordinator" }) as Promise<string>);
    expect(read).not.toBe("waiting");
    expect(JSON.parse(read as string)).toMatchObject({ repos: [{ repo: "o/r", fetchedAt: null, fetching: true }], loading: expect.stringMatching(/first read of o\/r/), open: 0 });
    // Cold, joining the fetch in flight, and forced: each answers at once.
    for (const refresh of [false, true]) {
      const queue = await promptly(f.harness.callRpc("mergeQueue", { projectId: project.id, refresh }) as Promise<MergeQueue>);
      expect(queue).toMatchObject({ repos: [{ repo: "o/r", fetching: true }] });
    }
    expect(fetches).toEqual(["o/r"]);
  });
});

describe("D441: the dashboard", () => {
  const cached: MergeQueue = {
    projectId: "p", login: "o", skipped: [], stages: PR_STAGES.map((s) => ({ ...s })),
    repos: [{ repo: "o/r", fetchedAt: 1, error: null, fetching: false, detailsFetchedAt: 1, detailsError: null }],
    pullRequests: parsePullRequests("o/r", JSON.stringify(raw)),
  };
  const cold: MergeQueue = { ...cached, login: null, pullRequests: [], repos: [{ ...cached.repos[0]!, fetchedAt: null, detailsFetchedAt: null, fetching: true }] };

  it("shows skeleton rows for a cold snapshot, and the rows once the fetch is announced", async () => {
    const { f, project } = await projectFixture();
    const summary = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    let current = cold;
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id, routeTab: "prs" }, { rpc: { overview: async () => summary, mergeQueue: async () => current } });
    slots.push(slot);
    await slot.findByText("Loading pull requests from GitHub…");
    expect(slot.getByRole("region", { name: "Merge queue" }).getAttribute("aria-busy")).toBe("true");
    current = cached;
    await slot.emitRealtime("merge-queue-changed", { repo: "o/r" });
    await slot.findByText("Cached PR");
    expect(slot.queryByText("Loading pull requests from GitHub…")).toBeNull();
  });

  it("keeps the rows during a manual refresh, which returns at once and shows Refreshing… until the fetch ends", async () => {
    const { f, project } = await projectFixture();
    const summary = await f.harness.callRpc("overview", { projectId: project.id, detail: "summary" });
    let current = cached;
    const mergeQueue = vi.fn(async (input: unknown) => {
      if ((input as { refresh?: boolean }).refresh) current = { ...cached, repos: [{ ...cached.repos[0]!, fetching: true }] };
      return current;
    });
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id, routeTab: "prs" }, { rpc: { overview: async () => summary, mergeQueue } });
    slots.push(slot);
    await slot.findByText("Cached PR");
    const button = slot.getByRole("button", { name: "Refresh merge queue" }) as HTMLButtonElement;
    fireEvent.click(button);
    await slot.findByText("Refreshing…");
    expect(button.disabled).toBe(true);
    expect(slot.getByText("Cached PR")).toBeTruthy();
    current = { ...cached, repos: [{ ...cached.repos[0]!, fetchedAt: 2 }] };
    await slot.emitRealtime("merge-queue-changed", { repo: "o/r" });
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
