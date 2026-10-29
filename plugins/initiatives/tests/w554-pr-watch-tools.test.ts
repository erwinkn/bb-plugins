// W554: initiative_pr_watch and initiative_pr_unwatch, as agents call them. GitHub is the merge
// queue's watchQuery, answered here; the watcher's passes are tested in w548-pr-watch.test.ts.
import { describe, expect, it, vi } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { parsePullRequests, type MergeQueue } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import { PR_ID_QUERY } from "../lib/pr-watch";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const call = async (f: Fx, tool: string, input: unknown, threadId = "coordinator") =>
  JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);
const refused = async (f: Fx, tool: string, input: unknown, threadId = "coordinator") => {
  try {
    await f.harness.callAgentTool(tool, input, { threadId });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${tool} accepted ${JSON.stringify(input)}`);
};
const url = (n: number) => `https://github.com/eq/market/pull/${n}`;

/** An Adventure with two workers, and GitHub answering for open PRs #12 (failing, conflicting) and #13 (merged). */
async function setup() {
  const { f, project } = await projectFixture();
  for (const label of ["One", "Two"]) await call(f, "initiative_spawn", { label, purpose: label, text: "Do it." });
  const [w1, w2] = [1, 2].map((num) => f.store.worker(project.id, num)!);
  const watchQuery = vi.spyOn(f.mergeQueue, "watchQuery").mockImplementation(async (query, variables) => {
    if (query === PR_ID_QUERY) return { repository: { pullRequest: { id: `PR_${variables.number}` } } };
    const number = Number(String(variables.i0).slice(3));
    return { p0: {
      id: variables.i0, number, title: `PR ${number}`, state: number === 13 ? "MERGED" : "OPEN", headRefOid: "abc1234567890", mergeable: "CONFLICTING",
      reviewDecision: "REVIEW_REQUIRED", reviewThreads: { totalCount: 0, nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE", isRequired: false }] } } } }] },
      comments: { nodes: [] }, reviews: { nodes: [] },
    } };
  });
  return { f, project, w1, w2, watchQuery };
}
const configured = async (f: Fx, threadId: string) =>
  Object.fromEntries((await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)! }))).tools.map((t) => [t.name, t.inputSchema as { properties: Record<string, unknown> }]));

describe("W554 PR watch tools", () => {
  it("offers both tools to workers (watching for themselves) and to leads (for a worker too)", async () => {
    const { f, w1 } = await setup();
    const worker = await configured(f, w1.threadId!);
    expect(Object.keys(worker.initiative_pr_watch!.properties)).toEqual(["pr"]);
    expect(Object.keys(worker.initiative_pr_unwatch!.properties)).toEqual(["pr"]);
    const lead = await configured(f, "coordinator");
    expect(Object.keys(lead.initiative_pr_watch!.properties)).toEqual(["pr", "worker"]);
    expect(lead).toHaveProperty("initiative_pr_unwatch");
  });

  it("lets a worker watch a PR for itself, answering with its state now", async () => {
    const { f, project, w1, watchQuery } = await setup();
    const answer = await call(f, "initiative_pr_watch", { pr: "https://github.com/EQ/market/pull/12/files" }, w1.threadId!);
    expect(answer).toMatchObject({
      watching: url(12), title: "PR 12", wakes: "you",
      now: { head: "abc1234567", checks: "failing: tests", mergeable: "conflicting", review: "review_required", unresolvedThreads: "0" },
      attention: expect.stringContaining("Checks failing: tests. It conflicts with its base branch."),
    });
    expect(watchQuery.mock.calls.map(([query]) => query === PR_ID_QUERY ? "id" : "watch")).toEqual(["id", "watch"]);
    const row = f.store.db.prepare("SELECT project_id, watcher_thread_id FROM pr_watches WHERE url = ?").get(url(12));
    expect(row).toEqual({ project_id: project.id, watcher_thread_id: w1.threadId });
    // A worker watches only for itself.
    expect(await refused(f, "initiative_pr_watch", { pr: url(12), worker: "W2" }, w1.threadId!)).toContain("Workers watch for themselves");
    expect(await refused(f, "initiative_pr_watch", { pr: url(13) }, w1.threadId!)).toContain(`${url(13)} is merged: there is nothing to watch.`);
  });

  it("lets a lead watch for itself or for a worker, and says whose watch it replaced", async () => {
    const { f, w1, w2 } = await setup();
    expect(await call(f, "initiative_pr_watch", { pr: "eq/market#12", worker: "W1" })).toMatchObject({ watching: url(12), wakes: "W1" });
    const watcher = () => f.store.db.prepare("SELECT watcher_thread_id FROM pr_watches WHERE url = ?").pluck().get(url(12));
    expect(watcher()).toBe(w1.threadId);
    expect(await call(f, "initiative_pr_watch", { pr: url(12) })).toMatchObject({ wakes: "you", replaced: "W1 watched it before; you do now." });
    expect(watcher()).toBe("coordinator");
    expect(await call(f, "initiative_pr_watch", { pr: url(12) }, w2.threadId!)).toMatchObject({ replaced: "the coordinator watched it before; you do now." });
    expect(await refused(f, "initiative_pr_watch", { pr: url(12), worker: "W9" })).toContain("W9 is no worker of this Adventure.");
    f.store.updateWorker(f.store.projects()[0]!.id, 1, { state: "retired" });
    expect(await refused(f, "initiative_pr_watch", { pr: url(12), worker: "W1" })).toContain("W1 can't take a PR's news (retired)");
  });

  it("unwatches: a worker its own watch only, a lead any of its Adventure's", async () => {
    const { f, w1, w2 } = await setup();
    await call(f, "initiative_pr_watch", { pr: url(12) }, w1.threadId!);
    expect(await refused(f, "initiative_pr_unwatch", { pr: url(12) }, w2.threadId!)).toContain(`W1 watches ${url(12)}; only your lead unwatches it for them.`);
    expect(await call(f, "initiative_pr_unwatch", { pr: url(12) })).toEqual({ url: url(12), unwatched: true, was: "W1" });
    expect(await call(f, "initiative_pr_unwatch", { pr: url(12) }, w1.threadId!)).toEqual({ url: url(12), unwatched: false, note: "Nobody watches it." });
    await call(f, "initiative_pr_watch", { pr: url(12) }, w1.threadId!);
    expect(await call(f, "initiative_pr_unwatch", { pr: url(12) }, w1.threadId!)).toEqual({ url: url(12), unwatched: true });
    // A W548 row (no watcher): a worker's unwatch leaves it; its lead's mutes it for a rollback.
    const muted = () => f.store.db.prepare("SELECT muted FROM pr_watches WHERE url = ?").pluck().get(url(20));
    f.store.db.prepare("INSERT INTO pr_watches (url, project_id, muted, since, state, gen, updated_at) VALUES (?, ?, 0, 1, NULL, 0, 1)").run(url(20), f.store.projects()[0]!.id);
    expect(await call(f, "initiative_pr_unwatch", { pr: url(20) }, w1.threadId!)).toMatchObject({ unwatched: false });
    expect(muted()).toBe(0);
    expect(await call(f, "initiative_pr_unwatch", { pr: url(20) })).toMatchObject({ unwatched: false, note: "Nobody watches it." });
    expect(muted()).toBe(1);
  });

  it("resolves #12 and repo#12 among the PRs the Adventure lists, and refuses an ambiguous or unknown one", async () => {
    const { f, w1 } = await setup();
    const listed = (repo: string, number: number) => parsePullRequests(repo, [{ number, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, headRefName: "x" }])[0]!;
    const queue: MergeQueue = { projectId: "p", login: null, repos: [], skipped: [], stages: PR_STAGES.map((s) => ({ ...s })), pullRequests: [listed("eq/market", 12), listed("eq/infra", 12), listed("eq/market", 14)] };
    vi.spyOn(f.mergeQueue, "read").mockResolvedValue(queue);
    expect(await call(f, "initiative_pr_watch", { pr: "#14" }, w1.threadId!)).toMatchObject({ watching: url(14) });
    expect(await call(f, "initiative_pr_watch", { pr: "market#12" }, w1.threadId!)).toMatchObject({ watching: url(12) });
    expect(await refused(f, "initiative_pr_watch", { pr: "#12" }, w1.threadId!)).toContain('"#12" matches 2 PRs (eq/market#12, eq/infra#12): give its URL.');
    expect(await refused(f, "initiative_pr_watch", { pr: "#99" }, w1.threadId!)).toContain('"#99" matches no PR this Adventure lists: give its URL.');
    expect(await refused(f, "initiative_pr_watch", { pr: "the login PR" }, w1.threadId!)).toContain("names no PR");
  });
});
