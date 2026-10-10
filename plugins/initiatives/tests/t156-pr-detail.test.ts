import { describe, expect, it, vi } from "vitest";

// The detail must never wait on GitHub: nothing may spawn `gh` while it reads.
const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), execFile }));

const { projectFixture } = await import("./fake-native");
const { parsePullRequests, attachLinks } = await import("../lib/merge-queue");
const { AssignedPrs, recordPrs } = await import("../lib/pr-records");
const { MergeQueueCache } = await import("../lib/merge-queue-server");
const { pickPr, searchPrs } = await import("../lib/pr-search");
const { mentionsNumber, readPrDetail, DETAIL_LIMITS } = await import("../lib/pr-detail");
const { PrNotes } = await import("../lib/pr-notes");
const { blankPrRecord } = await import("../lib/pr-stages");
const { memoryStore } = await import("./helpers");
import type { PrDetail } from "../lib/pr-detail";
import type { QueuedPullRequest } from "../lib/merge-queue";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const call = async (f: Fx, tool: string, input: unknown, threadId = "coordinator") =>
  JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);
const url = (n: number, repo = "erwinkn/bb") => `https://github.com/${repo}/pull/${n}`;
const pr = (number: number, extra: Partial<QueuedPullRequest> = {}, repo = "erwinkn/bb"): QueuedPullRequest => ({
  ...parsePullRequests(repo, JSON.stringify([{ number, url: url(number, repo), title: `PR ${number}`, headRefName: `feat/${number}`, baseRefName: "main" }]))[0]!,
  ...extra,
});

describe("T156 PR search", () => {
  const prs = [
    pr(2251, { title: "SWC prep: circular imports", worker: { ref: "W351", threadId: null, assignment: "A900", role: "work", source: "assignment" } }),
    pr(2254, { title: "SWC: Swagger types", head: "chore/swagger", links: { workers: ["W12"], assignments: ["A41"] } }),
    pr(22, { title: "Old one", category: "CI" }),
    pr(2251, {}, "erwinkn/other"),
  ];
  const numbers = (query: string) => searchPrs(prs, query).map((p) => `${p.repo === "erwinkn/bb" ? "" : "other"}#${p.number}`);

  it("matches PR numbers in every form, as a prefix while typing", () => {
    expect(numbers("2251")).toEqual(["#2251", "other#2251"]);
    expect(numbers("#2251")).toEqual(["#2251", "other#2251"]);
    expect(numbers("225")).toEqual(["#2251", "#2254", "other#2251"]);
    expect(numbers("22")).toEqual(["#2251", "#2254", "#22", "other#2251"]);
    expect(numbers("erwinkn/bb#2251")).toEqual(["#2251"]);
    expect(numbers("https://github.com/erwinkn/other/pull/2251/files")).toEqual(["other#2251"]);
    expect(numbers("")).toHaveLength(4);
  });

  it("matches worker and assignment refs linked to a PR, exactly; no task refs (D506)", () => {
    expect(numbers("W351")).toEqual(["#2251"]);
    expect(numbers("a900")).toEqual(["#2251"]);
    expect(numbers("W12")).toEqual(["#2254"]);
    expect(numbers("A41")).toEqual(["#2254"]);
    expect(numbers("W35")).toEqual([]);
    expect(numbers("T156")).toEqual([]);
  });

  it("matches title, branch and category text, every word", () => {
    expect(numbers("swc")).toEqual(["#2251", "#2254"]);
    expect(numbers("swc swagger")).toEqual(["#2254"]);
    expect(numbers("chore/swag")).toEqual(["#2254"]);
    expect(numbers("ci")).toEqual(["#2251", "#22"]);
    expect(numbers("swc W351")).toEqual(["#2251"]);
  });

  it("matches a ref only whole in the text as well, so Enter opens nothing for a shorter one (W360 #1)", () => {
    const linked = [pr(7, { stageNote: "W351 reviewing", waitingOn: "A301: move the lock", links: { workers: ["W351"], assignments: ["A301"] } }), pr(8, { title: "Ask W77 (A9)" })];
    const found = (query: string) => searchPrs(linked, query).map((p) => p.number);
    expect([found("W35"), found("A30"), found("W7"), found("lock")]).toEqual([[], [], [], [7]]);
    expect([found("W351"), found("a301"), found("W77"), found("A9")]).toEqual([[7], [7], [8], [8]]);
    expect(pickPr(linked, searchPrs(linked, "W35"), "W35")).toBeNull();
    expect(pickPr(linked, searchPrs(linked, "W77"), "W77")?.number).toBe(8);
  });

  it("picks the one PR a number or URL names, never when several share it", () => {
    expect(pickPr(prs, [], "22")?.number).toBe(22);
    expect(pickPr(prs, [], " #2254 ")?.number).toBe(2254);
    expect(pickPr(prs, [], "2251")).toBeNull();
    expect(pickPr(prs, [], "erwinkn/other#2251")?.repo).toBe("erwinkn/other");
    expect(pickPr(prs, [], "225")).toBeNull();
    expect(pickPr(prs, [], "swc")).toBeNull();
  });

  it("picks the only PR shown for a query that names no PR, never for an ambiguous ref (W358 #2)", () => {
    expect(pickPr(prs, [prs[1]!], "swagger")?.number).toBe(2254);
    expect(pickPr(prs, prs.slice(0, 2), "swc")).toBeNull();
    // 2251 names two PRs: a filter hiding one doesn't make the other the pick.
    expect(pickPr(prs, [prs[0]!], "2251")).toBeNull();
    expect(pickPr(prs, [prs[0]!], "#2251")).toBeNull();
    // A ref naming one PR picks it, shown or not.
    expect(pickPr(prs, [], "erwinkn/bb#2251")).toBe(prs[0]);
  });

  it("takes short repo refs, in search and on Enter, and ambiguous ones match every owner's (W356 #4)", () => {
    expect(numbers("bb#2251")).toEqual(["#2251"]);
    expect(numbers("other#2251")).toEqual(["other#2251"]);
    expect(numbers("BB#2254")).toEqual(["#2254"]);
    expect(pickPr(prs, [], "bb#2251")?.repo).toBe("erwinkn/bb");
    expect(pickPr(prs, [], "other#2251")?.repo).toBe("erwinkn/other");
    // A repo#N is exact, not a prefix; a short name two owners share names both, so Enter opens neither.
    expect(numbers("bb#225")).toEqual([]);
    const forks = [...prs, pr(2251, {}, "fork/bb")];
    expect(searchPrs(forks, "bb#2251").map((p) => p.repo)).toEqual(["erwinkn/bb", "fork/bb"]);
    expect(pickPr(forks, [], "bb#2251")).toBeNull();
    expect(pickPr(forks, [forks.at(-1)!], "bb#2251")).toBeNull();
    expect(pickPr(forks, [], "fork/bb#2251")?.repo).toBe("fork/bb");
    const market = [pr(2251, {}, "equisafe/equisafe-market"), pr(2251, {}, "equisafe/infra")];
    expect(searchPrs(market, "equisafe-market#2251").map((p) => p.repo)).toEqual(["equisafe/equisafe-market"]);
    expect(pickPr(market, [], "equisafe-market#2251")?.repo).toBe("equisafe/equisafe-market");
  });
});

describe("T156 PR links in the queue", () => {
  it("links every assignment naming a PR and its worker, each once", () => {
    const assigned = new AssignedPrs({ assignmentsStamp: () => "1", prMentions: () => [
      { num: 3, workerNum: 2, role: "work", brief: `Fix ${url(7)}`, report: null },
      { num: 4, workerNum: 5, role: "review", brief: `Review ${url(7)}`, report: null },
      { num: 5, workerNum: 2, role: "work", brief: `Unrelated, then ${url(7)} again`, report: JSON.stringify({ summary: `Opened ${url(9)}` }) },
    ] });
    expect(assigned.read("p").get(url(7))).toEqual({ worker: "W2", assignment: "A5", role: "work", links: { workers: ["W2", "W5"], assignments: ["A3", "A4", "A5"] } });
    const [seven, nine, other] = attachLinks([pr(7), pr(9), pr(10)], assigned.read("p"), new Map());
    expect([seven!.links.assignments, nine!.links.assignments, other!.links]).toEqual([["A3", "A4", "A5"], ["A5"], { workers: [], assignments: [] }]);
  });

  it("links thousands of assignments naming one base PR in linear time (W358 #1)", () => {
    // Copying the accumulated links per assignment took ~3 s at 10k.
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ num: i + 1, workerNum: (i % 50) + 1, role: "work", brief: `Built on ${url(1)}`, report: null }));
    const start = performance.now();
    const work = new AssignedPrs({ assignmentsStamp: () => "1", prMentions: () => rows }).read("p").get(url(1))!;
    expect(performance.now() - start).toBeLessThan(1000);
    expect([work.assignment, work.links.assignments.length, work.links.workers.length]).toEqual(["A20000", 20_000, 50]);
  });
});

describe("T156 mentions of a PR number", () => {
  it.each([
    ["see #2251 first", true], ["(#2251)", true], ["PR#2251", true], ["equisafe-market#2251", true],
    ["Equisafe/equisafe-market#2251", true], ["#22510", false], ["other#2251", false], ["#2252", false], ["2251", false],
    // After a rejected "#N", the next one's prefix starts where it ended (W358 #4).
    ["other#2251#2251", true], ["a#2251PR#2251", true], ["other#2251equisafe-market#2251", true], ["other#2251other#2251", false],
  ])("%s → %s", (text, expected) => {
    expect(mentionsNumber(text, "equisafe/equisafe-market", 2251)).toBe(expected);
  });

  it("reads a long word once: a regex starting at each of its characters took seconds on 10k reports", () => {
    const text = `${"a".repeat(50_000)} #2251`;
    const start = performance.now();
    expect(mentionsNumber(text, "equisafe/equisafe-market", 2251)).toBe(true);
    expect(mentionsNumber(`x${text.replace(" ", "")}`, "equisafe/equisafe-market", 2251)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("agrees with the regex it replaced, which resumed after each match (W358 #4)", () => {
    const regex = (text: string, repo: string, n: number) => {
      const [owner, name] = repo.toLowerCase().split("/");
      for (const m of text.matchAll(new RegExp(`([\\w./-]*)#${n}(?!\\d)`, "g"))) {
        const prefix = m[1]!.toLowerCase();
        if (!prefix || prefix === "pr" || prefix === name || prefix === `${owner}/${name}`) return true;
      }
      return false;
    };
    let state = 358;
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
    const tokens = ["a", "PR", "bb", "erwinkn/bb", "other/bb", "/", ".", "-", "_", ":", " ", "\n", "é", "😀", "#2251", "#22510", "#225", "#", "1", "0", ")", "(", "https://github.com/"];
    const texts = Array.from({ length: 20_000 }, () => Array.from({ length: 2 + Math.floor(random() * 12) }, () => tokens[Math.floor(random() * tokens.length)]).join(""));
    expect(texts.filter((text) => mentionsNumber(text, "erwinkn/bb", 2251) !== regex(text, "erwinkn/bb", 2251))).toEqual([]);
  });
});

describe("T156 prDetail RPC", () => {
  it("collects the record, notes, work, workers, decisions and updates from local state only, and no tasks (D506)", async () => {
    const { f, project } = await projectFixture();
    const task = await call(f, "initiative_task", { action: "create", title: "Fast builds", text: "Ship SWC, erwinkn/bb#7." });
    await call(f, "initiative_spawn", { label: "SWC", purpose: "pr", text: `Implement ${url(7)}.`, tasks: [task.ref] });
    const work = f.store.assignments(project.id).at(-1)!;
    const worker = f.store.worker(project.id, work.workerNum)!;
    await call(f, "initiative_decision", { action: "decision", decision: { description: "Keep the controller test hook.", madeBy: "agent" } }, worker.threadId!);
    await call(f, "initiative_report", { outcome: "done", summary: `Pushed ${url(7)} at abc123.`, report: "Done." }, worker.threadId!);
    // Another worker's brief only mentions #7: tied, but as a mention.
    await call(f, "initiative_spawn", { label: "Stack", purpose: "stack", text: "Rebase the stack #6 ← #7 ← #8." });
    // D2 blocks the PR's task, so it was only tied through that task; D3 is a note's source.
    await call(f, "initiative_decision", { action: "question", question: "Ship SWC first?", context: "Order", blocksTaskIds: [task.ref] });
    await call(f, "initiative_decision", { action: "question", question: "Squash merges?", context: "History" });
    await call(f, "initiative_pr", { prs: [{ url: url(7), stage: "in-review", note: "Under D1", category: "CI", notes: [{ kind: "question", text: "Squash?", link: "D3" }] }] });
    await call(f, "initiative_update", { text: "#7 is in review." });
    await call(f, "initiative_update", { text: "Nothing about it." });
    execFile.mockClear();

    const detail = await f.harness.callRpc("prDetail", { projectId: project.id, url: "erwinkn/bb#7" }) as PrDetail;
    expect(execFile).not.toHaveBeenCalled();
    expect(detail.url).toBe(url(7));
    expect(detail.record).toMatchObject({ stage: "in-review", note: "Under D1", category: "CI" });
    expect(detail.notes.items.map((n) => [n.author, n.kind])).toEqual([["W1", "note"], ["coordinator", "question"]]);
    expect(detail.assignments.items.map((a) => [a.ref, a.worker, a.via])).toEqual([
      ["A2", "W2", ["mention"]],
      ["A1", "W1", ["note", "brief", "report"]],
    ]);
    expect(detail.assignments.items[1]).toMatchObject({ outcome: "succeeded", summary: `Pushed ${url(7)} at abc123.` });
    expect(detail.workers.map((w) => w.ref)).toEqual(["W2", "W1"]);
    expect("tasks" in detail).toBe(false);
    expect(detail.decisions.items.map((d) => [d.ref, d.via])).toEqual([["D3", ["note"]], ["D1", ["record", "assignment"]]]);
    expect(detail.updates).toEqual({ items: [{ ref: "U1", summary: "#7 is in review.", createdAt: expect.any(Number) }], total: 1 });

    // A PR nothing names reads empty; a malformed URL is refused.
    const empty = await f.harness.callRpc("prDetail", { projectId: project.id, url: url(99) }) as PrDetail;
    expect([empty.record, empty.notes.total, empty.assignments.total, empty.workers, empty.decisions.total]).toEqual([null, 0, 0, [], 0]);
    await expect(f.harness.callRpc("prDetail", { projectId: project.id, url: "not a PR" })).rejects.toThrow(/Expected a GitHub PR URL/);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("T156 prDetail reads (W356 #1, #3)", () => {
  const profile = { providerId: "codex", model: "gpt", reasoningLevel: "high" as const };
  const setup = () => {
    const { store, db } = memoryStore();
    store.createProject({ id: "p", name: "P", objective: "Review", memberProjectIds: [], coordinatorThreadId: null });
    const worker = store.createWorker({ projectId: "p", role: "work", label: "Worker", area: "", bbProjectId: "proj" });
    const assign = (brief: string) => store.createAssignment({
      projectId: "p", workerNum: worker.num, taskNums: [], route: "fresh", role: "work", workKind: "implementation", threadId: "thr_old", generation: 1,
      profile, bbProjectId: "proj", environmentId: null, state: "reported", opId: `op_${brief.length}_${Math.random()}`, opState: "done",
      briefText: brief, reviewOf: null, rationale: null,
    });
    return { store, db, worker, assign, notes: new PrNotes(db) };
  };

  it("counts every linked assignment from a projection and reads whole only those it returns", () => {
    const { store, db, assign, notes } = setup();
    for (let i = 1; i <= 75; i++) assign(`Implement ${url(2251)} part ${i}`);
    assign(`Implement ${url(2252)}`);
    const reads = vi.spyOn(store, "assignment");
    const detail = readPrDetail(store, notes, "p", url(2251), null);
    expect(reads).toHaveBeenCalledTimes(DETAIL_LIMITS.assignments);
    expect([detail.assignments.total, detail.assignments.items.length, detail.assignments.items[0]!.ref]).toEqual([75, 60, "A75"]);
    db.close();
  });

  it("counts decisions from a projection and reads whole only those it returns, never removed or non-decisions (W360 #2)", () => {
    const { store, db, notes } = setup();
    store.addDecision({
      projectId: "p", topic: "review", status: "active", scope: "", title: "PR #2251", body: { description: `PR #2251: ${"Decision context. ".repeat(300)}` },
      humanAttention: "none", blocks: [], deadline: null, provenance: { author: "coordinator", threadId: null, assignment: null }, madeBy: "user", supersedes: null,
    });
    const columns = (db.prepare("PRAGMA table_info(knowledge)").all() as { name: string }[]).map((c) => c.name);
    const clone = db.prepare(`INSERT INTO knowledge (${columns.join(", ")}) SELECT ${columns.map((c) => (c === "num" ? "?" : c)).join(", ")} FROM knowledge WHERE project_id = 'p' AND num = 1`);
    db.transaction(() => { for (let n = 2; n <= 10_000; n++) clone.run(n); })();
    store.updateDecision("p", 10_000, { status: "removed" });
    // Neither made by anyone nor a question: not a decision a list shows.
    db.prepare("UPDATE knowledge SET decision_owner = NULL WHERE project_id = 'p' AND num = 9999").run();
    const reads = vi.spyOn(store, "decisionItem");
    const start = performance.now();
    const detail = readPrDetail(store, notes, "p", url(2251), null);
    const ms = performance.now() - start;
    console.log(`prDetail with 10,000 decisions naming the PR: ${ms.toFixed(1)} ms`);
    expect(reads).toHaveBeenCalledTimes(DETAIL_LIMITS.decisions);
    expect([detail.decisions.total, detail.decisions.items.length, detail.decisions.items[0]!.ref, detail.decisions.items[0]!.via]).toEqual([9_998, 40, "D9998", ["mention"]]);
    // Was 1.35–1.46 s reading all 10,000 whole.
    expect(ms).toBeLessThan(1_000);
    db.close();
  });

  it("links the branch's worker but none of its other assignments", () => {
    const { store, db, worker, assign, notes } = setup();
    store.updateWorker("p", worker.num, { threadId: "thr_abc123", state: "active" });
    assign(`Fix ${url(11)}`);
    const detail = readPrDetail(store, notes, "p", url(2251), "bb/thr_abc123");
    expect([detail.assignments.total, detail.decisions.total]).toEqual([0, 0]);
    expect(detail.workers.map((w) => w.ref)).toEqual([worker.ref]);
    db.close();
  });

  it("keeps the record's assignment, which names no PR, and drops a ref to a missing one", () => {
    const { store, db, assign, notes } = setup();
    assign("Implement it");
    store.savePrRecord("p", { ...blankPrRecord(url(2251), 1), stage: "working", assignment: "A1", worker: "W1" });
    store.savePrRecord("p", { ...blankPrRecord(url(9), 1), stage: "working", assignment: "A99" });
    const detail = readPrDetail(store, notes, "p", url(2251), null);
    expect(detail.assignments.items.map((a) => [a.ref, a.via])).toEqual([["A1", ["record"]]]);
    expect(readPrDetail(store, notes, "p", url(9), null).assignments).toEqual({ items: [], total: 0 });
    db.close();
  });
});

describe("T156 mergeQueue links (W356 #2)", () => {
  it("links the assignment a record names without a worker, from the records the poll reads (W360 #4)", async () => {
    const { store, db } = memoryStore();
    store.createProject({ id: "p", name: "P", objective: "Review", memberProjectIds: [], coordinatorThreadId: null });
    const worker = store.createWorker({ projectId: "p", role: "work", label: "Worker", area: "", bbProjectId: "proj" });
    // Its brief names no PR: only the record ties A1 to #7.
    store.createAssignment({
      projectId: "p", workerNum: worker.num, taskNums: [], route: "fresh", role: "work", workKind: "implementation", threadId: "thr_old", generation: 1,
      profile: { providerId: "codex", model: "gpt", reasoningLevel: "high" }, bbProjectId: "proj", environmentId: null, state: "reported", opId: "op1", opState: "done",
      briefText: "Implement it", reviewOf: null, rationale: null,
    });
    const notes = new PrNotes(db);
    recordPrs(store, notes, "p", { prs: [{ url: url(7), assignment: "A1", worker: null }] }, 1);
    const gh = async (args: string[]) => args[1] === "user" ? "erwinkn"
      : args[0] === "pr" ? JSON.stringify([{ number: 7, title: "PR 7", url: url(7), headRefName: "feat/7", baseRefName: "main" }])
      : JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    const assigned = new AssignedPrs(store);
    const cache = new MergeQueueCache({
      memberProjectIds: () => ["proj"], project: async () => ({ name: "bb", gitRemoteUrl: "https://github.com/erwinkn/bb.git" }),
      workers: () => new Map(), prRecords: () => store.prRecords("p"), assignedPrs: () => assigned.read("p"), notes: () => notes.summaries("p"),
    }, gh);
    await cache.read("p");
    await cache.settled();
    const reads = vi.spyOn(store, "assignment");
    const { pullRequests } = await cache.read("p");
    expect([pullRequests[0]!.worker, pullRequests[0]!.links]).toEqual([null, { workers: [], assignments: ["A1"] }]);
    expect(searchPrs(pullRequests, "A1").map((p) => p.number)).toEqual([7]);
    expect(reads).not.toHaveBeenCalled();
    db.close();
  });

  it("links the assignments naming a PR without reading any assignment whole", async () => {
    const { f, project } = await projectFixture();
    f.intercept(async (path, _input, next) => {
      const out = await next();
      return path === "projects.get" ? { ...(out as object), gitRemoteUrl: "https://github.com/erwinkn/bb.git" } : out;
    });
    execFile.mockImplementation((_cmd: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
      const out = args[1] === "user" ? "erwinkn"
        : args[1] === "graphql" ? JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } })
        : JSON.stringify([{ number: 7, title: "PR 7", url: url(7), headRefName: "feat/7", baseRefName: "main" }]);
      done(null, out, "");
    });
    await call(f, "initiative_spawn", { label: "SWC", purpose: "pr", text: `Implement ${url(7)}.` });
    const work = f.store.assignments(project.id).at(-1)!;
    const read = async () => (await f.harness.callRpc("mergeQueue", { projectId: project.id })) as { pullRequests: QueuedPullRequest[] };
    await vi.waitFor(async () => expect((await read()).pullRequests).toHaveLength(1));
    const reads = vi.spyOn(f.store, "assignment");
    const [seven] = (await read()).pullRequests;
    expect(seven!.links).toEqual({ workers: [`W${work.workerNum}`], assignments: [work.ref] });
    expect(reads).not.toHaveBeenCalled();
    execFile.mockReset();
  });
});
