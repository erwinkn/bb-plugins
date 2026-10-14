import { describe, expect, it } from "vitest";

const { projectFixture } = await import("./fake-native");
const { recordPrs, COORDINATOR } = await import("../lib/pr-records");
const { readPrDetail, DETAIL_LIMITS } = await import("../lib/pr-detail");
const { PrNotes } = await import("../lib/pr-notes");
const { memoryStore } = await import("./helpers");
import type { PrDetail } from "../lib/pr-detail";
import type { PrToolInput } from "../lib/pr-stages";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const call = async (f: Fx, tool: string, input: unknown, threadId = "coordinator") =>
  JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);
const url = (n: number) => `https://github.com/erwinkn/bb/pull/${n}`;

const setup = () => {
  const { store, db } = memoryStore();
  store.createProject({ id: "p", name: "P", objective: "Review", memberProjectIds: [], coordinatorThreadId: null });
  const notes = new PrNotes(db);
  const record = (input: PrToolInput, at: number, author = "coordinator") =>
    recordPrs(store, notes, "p", input, at, author === "coordinator" ? COORDINATOR : { author, worker: null, threadId: null });
  const history = (n = 7) => store.prStageChanges("p", url(n), 100).items.map(({ n: _, ...change }) => change);
  return { store, db, notes, record, history };
};

describe("T157 PR stage history", () => {
  it("records each stage change with who made it and when, as initiative_pr writes it", () => {
    const { record, history } = setup();
    record({ prs: [{ url: url(7), stage: "working" }] }, 1000);
    record({ prs: [{ url: "erwinkn/bb#7", stage: "in-review", note: "W357 reviewing" }] }, 2000);
    record({ prs: [{ url: url(7), stage: "ready-for-erwin" }] }, 3000, "user");
    expect(history()).toEqual([
      { at: 1000, author: "coordinator", from: null, to: "working", note: null },
      { at: 2000, author: "coordinator", from: "working", to: "in-review", note: "W357 reviewing" },
      { at: 3000, author: "user", from: "in-review", to: "ready-for-erwin", note: null },
    ]);
  });

  it("skips the same stage and note set again, keeps a new note, and records a clear once", () => {
    const { record, history, store } = setup();
    record({ prs: [{ url: url(7), stage: "in-review", note: "W1 reviewing" }] }, 1000);
    record({ prs: [{ url: url(7), stage: "in-review", note: "W1 reviewing" }] }, 2000);
    // Fields besides the stage leave its history alone.
    record({ prs: [{ url: url(7), category: "CI", waitingOn: "W1", notes: [{ text: "Pushed" }] }] }, 2500);
    record({ prs: [{ url: url(7), stage: "in-review", note: "W2 reviewing" }] }, 3000);
    record({ prs: [{ url: url(7), stage: "clear" }] }, 4000);
    record({ prs: [{ url: url(7), stage: "clear" }] }, 5000);
    // Clearing a PR that never had a stage changes nothing either.
    record({ prs: [{ url: url(8), stage: "clear" }] }, 5000);
    expect(history()).toEqual([
      { at: 1000, author: "coordinator", from: null, to: "in-review", note: "W1 reviewing" },
      { at: 3000, author: "coordinator", from: "in-review", to: "in-review", note: "W2 reviewing" },
      { at: 4000, author: "coordinator", from: "in-review", to: null, note: null },
    ]);
    expect(history(8)).toEqual([]);
    expect(store.prStageChanges("p", url(7), 2)).toMatchObject({ items: [{ n: 2 }, { n: 3 }], total: 3 });
  });

  it("records a worker's stage on its own PR under its W#, and nothing for a call that fails", async () => {
    const { f, project } = await projectFixture();
    await call(f, "initiative_spawn", { label: "SWC", purpose: "pr", text: `Implement ${url(7)} and ${url(9)}.` });
    const worker = f.store.worker(project.id, f.store.assignments(project.id).at(-1)!.workerNum)!;
    // v9: a worker keeps its own PR's stage.
    await call(f, "initiative_pr", { prs: [{ url: url(9), stage: "in-review" }] }, worker.threadId!);
    expect(f.store.prStageChanges(project.id, url(9), 50).items).toMatchObject([{ author: worker.ref }]);
    // The whole call rolls back: the stage it set and its history.
    await expect(call(f, "initiative_pr", { prs: [{ url: url(7), stage: "in-review" }, { url: url(8), worker: "W99" }] })).rejects.toThrow(/Unknown worker W99/);
    expect(f.store.prStageChanges(project.id, url(7), 50)).toEqual({ items: [], total: 0 });
    await call(f, "initiative_pr", { prs: [{ url: url(7), stage: "in-review", note: "W1 reviewing" }] });
    const detail = await f.harness.callRpc("prDetail", { projectId: project.id, url: url(7) }) as PrDetail;
    expect(detail.stages).toEqual({ items: [{ n: 1, at: expect.any(Number), author: "coordinator", from: null, to: "in-review", note: "W1 reviewing" }], total: 1 });
  });

  it("reads a PR's newest changes, oldest first, through the table's key, fast among thousands of PRs", () => {
    const { store, db, notes, record } = setup();
    const stages = ["working", "ready-for-review", "in-review"] as const;
    for (let i = 0; i < 120; i++) record({ prs: [{ url: url(7), stage: stages[i % 3] }] }, i);
    // Each recordPrs reads every record: append the other PRs' changes directly.
    db.transaction(() => {
      for (let pr = 1000; pr < 3000; pr++)
        for (let i = 0; i < 5; i++) store.addPrStageChange("p", url(pr), { at: i, author: "coordinator", from: i ? stages[(i - 1) % 3] : null, to: stages[i % 3], note: null });
    })();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM pr_stage_changes WHERE project_id = ? AND url = ? ORDER BY n DESC LIMIT ?").all("p", url(7), 50);
    expect(JSON.stringify(plan)).toMatch(/USING INDEX sqlite_autoindex_pr_stage_changes_1 \(project_id=\? AND url=\?\)/);
    const started = performance.now();
    const detail = readPrDetail(store, notes, "p", url(7), null);
    expect(performance.now() - started).toBeLessThan(100);
    expect(detail.stages.total).toBe(120);
    expect(detail.stages.items).toHaveLength(DETAIL_LIMITS.stages);
    expect(detail.stages.items.map((c) => c.n)).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i));
    expect(detail.stages.items.at(-1)).toMatchObject({ at: 119, from: "ready-for-review", to: "in-review" });
  });
});

describe("T157 setAt", () => {
  it("keeps when the stage was set across the same stage and note, and moves it with a change", () => {
    const { record, store } = setup();
    const setAt = () => store.prRecords("p").get(url(7))?.setAt ?? null;
    record({ prs: [{ url: url(7), stage: "in-review", note: "W1" }] }, 1000);
    record({ prs: [{ url: url(7), stage: "in-review", note: "W1" }] }, 2000);
    expect(setAt()).toBe(1000);
    record({ prs: [{ url: url(7), stage: "in-review", note: "W2" }] }, 3000);
    expect(setAt()).toBe(3000);
    record({ prs: [{ url: url(7), stage: "ready-for-erwin", note: "W2" }] }, 4000);
    expect(setAt()).toBe(4000);
    record({ prs: [{ url: url(7), stage: "clear" }] }, 5000);
    expect(setAt()).toBeNull();
  });
});
