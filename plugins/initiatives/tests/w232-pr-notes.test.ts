import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { MIGRATIONS } from "../lib/store";
import { PR_NOTE_MIGRATIONS } from "../lib/pr-notes";
import { parsePullRequests, type MergeQueue, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES, type PrStage } from "../lib/pr-stages";
import { AssignedPrs } from "../lib/pr-records";
import { linkStacks, prSummary } from "../lib/pr-map";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const call = async (f: Fx, tool: string, input: unknown, threadId = "coordinator") =>
  JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);
const url = (n: number, repo = "erwinkn/bb") => `https://github.com/${repo}/pull/${n}`;
const pr = (number: number, head: string, base: string, stage: PrStage = "ready-for-erwin", extra: Partial<QueuedPullRequest> = {}): QueuedPullRequest => ({
  ...parsePullRequests("erwinkn/bb", JSON.stringify([{ number, url: url(number), title: `PR ${number}`, headRefName: head, baseRefName: base }]))[0]!,
  stage, stageSource: "coordinator", ...extra,
});
const queue = (pullRequests: QueuedPullRequest[]): MergeQueue => ({
  projectId: "p", login: "erwinkn", repos: [], skipped: [], stages: PR_STAGES.map((s) => ({ ...s })), pullRequests,
});
/** A worker on its own thread, with a brief that names `brief`. */
const spawn = async (f: Fx, projectId: string, brief: string) => {
  await call(f, "initiative_spawn", { label: "PR work", purpose: "pr", text: brief });
  const assignment = f.store.assignments(projectId).at(-1)!;
  const worker = f.store.worker(projectId, assignment.workerNum)!;
  return { assignment, worker, threadId: worker.threadId! };
};

describe("W229 P1: the PR migrations follow the deployed memory ones", () => {
  it("upgrades a database the SDK runner migrated through index 76, keeping its PR stages", async () => {
    expect(MIGRATIONS.slice(72, 77).map((sql) => /^CREATE TABLE (memory_\w+)/.exec(sql)?.[1])).toEqual(["memory_settings", "memory_log", "memory_cursors", "memory_nodes", "memory_trees"]);
    expect(MIGRATIONS[77]).toMatch(/^CREATE TABLE pr_records/);
    expect(MIGRATIONS[78]).toMatch(/^INSERT INTO pr_records/);
    expect(MIGRATIONS.slice(79, 79 + PR_NOTE_MIGRATIONS.length)).toEqual(PR_NOTE_MIGRATIONS);
    const host = createFakePluginHost();
    const db = host.bb.storage.database();
    try {
      host.bb.storage.migrate(db, MIGRATIONS.slice(0, 77));
      db.prepare("INSERT INTO pr_stages (project_id, url, stage, note, set_at) VALUES (?, ?, ?, ?, ?)").run("p", url(1), "in-review", "keep", 123);
      host.bb.storage.migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT stage, note, stage_set_at, updated_at FROM pr_records").get()).toEqual({ stage: "in-review", note: "keep", stage_set_at: 123, updated_at: 123 });
      expect(db.prepare("SELECT count(*) AS n FROM pr_notes").get()).toEqual({ n: 0 });
    } finally {
      await host.harness.dispose();
    }
  });
});

describe("W229 P2/P3 fixes", () => {
  it("never makes a PR on a cycle of branches available, whatever the input order", () => {
    const working = pr(1, "a", "b", "working");
    const ready = pr(2, "b", "a");
    for (const order of [[working, ready], [ready, working]])
      expect(linkStacks(order).map((p) => [p.number, p.available]).sort()).toEqual([[1, false], [2, false]]);
    // All ready, still a cycle: no bottom to review first.
    expect(linkStacks([pr(1, "a", "b"), pr(2, "b", "a")]).some((p) => p.available)).toBe(false);
    // A ready PR above the cycle waits too; an ordinary ready stack is available.
    expect(linkStacks([pr(1, "a", "b"), pr(2, "b", "a"), pr(3, "c", "a")]).find((p) => p.number === 3)!.available).toBe(false);
    expect(linkStacks([pr(4, "d", "main"), pr(5, "e", "d")]).map((p) => p.available)).toEqual([true, true]);
  });

  it("keeps a review's PR, named in its brief, after its report says nothing of it", () => {
    const assigned = new AssignedPrs({ assignmentsStamp: () => "1", prMentions: () => [
      { num: 1, workerNum: 1, role: "work", brief: "Implement", report: JSON.stringify({ summary: `Opened ${url(1)}` }) },
      { num: 2, workerNum: 2, role: "review", brief: `Review ${url(1)}`, report: JSON.stringify({ summary: "Two findings; needs attention" }) },
    ] });
    expect(assigned.read("p").get(url(1))).toEqual({ worker: "W2", assignment: "A2", role: "review" });
    expect([...assigned.ofWorker("p", 1)]).toEqual([url(1)]);
  });

  it("reserves Uncategorized for the PRs without a category", async () => {
    const { f } = await projectFixture();
    await expect(call(f, "initiative_pr", { prs: [{ url: url(1), category: "uncategorized" }] })).rejects.toThrow(/"Uncategorized" is where PRs without a category show/);
    await call(f, "initiative_pr", { prs: [{ url: url(1), category: "CI" }] });
    await expect(call(f, "initiative_pr", { rename: [{ from: "CI", to: "Uncategorized" }] })).rejects.toThrow(/Uncategorized/);
    const summary = prSummary(queue(linkStacks([pr(1, "a", "main", "working", { category: "CI" }), pr(2, "b", "main", "working")])));
    expect(summary.byCategory).toEqual({ CI: { working: ["#1"] }, Uncategorized: { working: ["#2"] } });
  });

  it("counts free-form categories like constructor and __proto__ as plain names", async () => {
    const { f } = await projectFixture();
    const result = await call(f, "initiative_pr", { prs: [{ url: url(1), category: "constructor" }, { url: url(2), category: "__proto__" }] });
    expect(result.categories).toEqual(JSON.parse('{"__proto__":1,"constructor":1}'));
    const summary = prSummary(queue(linkStacks([pr(1, "a", "main", "working", { category: "__proto__" })])));
    expect(Object.keys(summary.byCategory)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(summary.byCategory)).toBe(Object.prototype);
  });

  it("stores a worker ref as the worker's own (W001 is W1)", async () => {
    const { f, project } = await projectFixture();
    await spawn(f, project.id, "Do it.");
    const result = await call(f, "initiative_pr", { prs: [{ url: url(1), worker: "w001" }] });
    expect(result.prs[0]).toMatchObject({ worker: "W1" });
    expect(f.store.prRecords(project.id).get(url(1))!.worker).toBe("W1");
  });
});

describe("D442 notes per PR", () => {
  it("appends the coordinator's notes and questions, numbered per PR, and answers questions", async () => {
    const { f, project } = await projectFixture();
    const first = await call(f, "initiative_pr", { prs: [{ url: url(7), notes: [
      { text: "Caveat: the migration has no rollback test" },
      { kind: "question", text: "Keep the 5m Redis TTL?" },
    ] }] });
    // Receipts stay short: the numbers, nothing echoed.
    expect(first).toEqual({ prs: [{ url: url(7), noted: [1, 2] }] });
    const answered = await call(f, "initiative_pr", { prs: [{ url: url(7), answered: [{ n: 2, text: "Yes, 5m" }], notes: [{ kind: "comment", text: "Erwin approved the shape", link: "https://github.com/erwinkn/bb/pull/7#issuecomment-1" }] }] });
    expect(answered).toEqual({ prs: [{ url: url(7), noted: [3], answered: [2] }] });
    const notes = await f.harness.callRpc("prNotes", { projectId: project.id, url: "erwinkn/bb#7" }) as { n: number; author: string; kind: string; link: string | null; answered: unknown }[];
    expect(notes.map((n) => [n.n, n.author, n.kind, n.link, n.answered])).toEqual([
      [1, "coordinator", "note", "coordinator", null],
      [2, "coordinator", "question", "coordinator", { at: expect.any(Number), by: "coordinator", text: "Yes, 5m" }],
      [3, "coordinator", "comment", "https://github.com/erwinkn/bb/pull/7#issuecomment-1", null],
    ]);
    // Only questions take answers; a note never takes the record's other fields with it.
    await expect(call(f, "initiative_pr", { prs: [{ url: url(7), answered: [{ n: 1 }] }] })).rejects.toThrow(/has no question 1/);
    expect(f.store.prRecords(project.id).has(url(7))).toBe(false);
    const summary = f.service.prNotes.summaries(project.id).get(url(7))!;
    expect([summary.count, summary.recent.map((n) => n.n), summary.open]).toEqual([3, [1, 2, 3], []]);
  });

  it("lets a worker note the PRs its assignments name, and nothing else", async () => {
    const { f, project } = await projectFixture();
    const { threadId } = await spawn(f, project.id, `Fix ${url(7)}.`);
    expect(await call(f, "initiative_pr", { prs: [{ url: url(7), notes: [{ kind: "question", text: "Squash before merge?" }] }] }, threadId))
      .toEqual({ prs: [{ url: url(7), noted: [1] }] });
    await expect(call(f, "initiative_pr", { prs: [{ url: url(8), notes: [{ text: "x" }] }] }, threadId)).rejects.toThrow(/W1 notes only PRs its assignments name/);
    await expect(call(f, "initiative_pr", { prs: [{ url: url(7), stage: "in-review" }] }, threadId)).rejects.toThrow(/Workers only add notes \(\{prs:\[\{url,notes\}\]\}\); stage is the coordinator's to set/);
    await expect(call(f, "initiative_pr", { rename: [{ from: "a", to: "b" }] }, threadId)).rejects.toThrow(/rename/);
    // A PR the coordinator put on the worker counts too.
    await call(f, "initiative_pr", { prs: [{ url: url(8), worker: "W1" }] });
    await call(f, "initiative_pr", { prs: [{ url: url(8), notes: [{ text: "Rebased" }] }] }, threadId);
    const [note] = f.service.prNotes.list(project.id, url(7));
    expect(note).toMatchObject({ author: "W1", kind: "question", link: threadId, answered: null });
    expect(f.service.prNotes.summaries(project.id).get(url(7))!.open).toHaveLength(1);
  });

  it("appends a worker's report summary to the PRs it reports on, else its brief's", async () => {
    const { f, project } = await projectFixture();
    const work = await spawn(f, project.id, `Fix ${url(7)}; unlike ${url(5)}, keep the API.`);
    await call(f, "initiative_report", { outcome: "done", summary: `Fixed; pushed ${url(7)} at abc123.`, report: "Long report." }, work.threadId);
    // The report names #7 only: #5 was context in the brief.
    expect(f.service.prNotes.list(project.id, url(7)).map((n) => [n.author, n.kind, n.text, n.link])).toEqual([
      ["W1", "note", `Fixed; pushed ${url(7)} at abc123.`, work.assignment.ref],
    ]);
    expect(f.service.prNotes.list(project.id, url(5))).toEqual([]);
    // A review whose report names no PR lands on the one its brief gave it.
    const review = await spawn(f, project.id, `Review ${url(9)}.`);
    await call(f, "initiative_report", { outcome: "done", summary: "Two P2 findings; needs attention.", report: "Details." }, review.threadId);
    expect(f.service.prNotes.list(project.id, url(9)).map((n) => [n.author, n.text, n.link])).toEqual([["W2", "Two P2 findings; needs attention.", review.assignment.ref]]);
    // Filing the same report again adds nothing.
    await call(f, "initiative_report", { outcome: "done", summary: "Two P2 findings; needs attention.", report: "Details." }, review.threadId);
    expect(f.service.prNotes.list(project.id, url(9))).toHaveLength(1);
  });

  it("appends a report's summary to every PR it names, past the fifth (W229)", async () => {
    const { f, project } = await projectFixture();
    const urls = [1, 2, 3, 4, 5, 6, 7].map((n) => url(n));
    const work = await spawn(f, project.id, `Implement the stack ${urls.join(" ")}.`);
    await call(f, "initiative_report", { outcome: "done", summary: `Opened ${urls.join(" ")}.`, report: "All seven are ready." }, work.threadId);
    expect(urls.map((u) => f.service.prNotes.list(project.id, u).length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("carries open questions and the latest note into initiative_read {view:prs}", () => {
    const question = { n: 2, at: 2, author: "coordinator", kind: "question" as const, text: "Keep the 5m TTL?", link: null, answered: null };
    const latest = { n: 3, at: 3, author: "W4", kind: "note" as const, text: "x".repeat(300), link: "A12", answered: null };
    const summary = prSummary(queue(linkStacks([pr(1, "a", "main", "in-review", { notes: { count: 3, recent: [question, latest], open: [question] } })])));
    expect(summary.state["#1"]).toEqual({
      questions: ["n2 coordinator: Keep the 5m TTL?"],
      notes: 3,
      latestNote: `W4 (A12): ${"x".repeat(199)}…`,
    });
  });

  it("says when the first read from GitHub is still running", () => {
    const base = queue([]);
    const loading = prSummary({ ...base, repos: [{ repo: "erwinkn/bb", fetchedAt: null, error: null, fetching: true, detailsFetchedAt: null, detailsError: null }] });
    expect(loading.loading).toMatch(/first read of erwinkn\/bb from GitHub is running/);
    expect(loading.repos).toEqual([{ repo: "erwinkn/bb", fetchedAt: null, fetching: true }]);
  });
});
