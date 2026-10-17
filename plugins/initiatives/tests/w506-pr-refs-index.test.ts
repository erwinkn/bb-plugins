import { describe, expect, it, vi } from "vitest";
import { expectWarned, memoryStore } from "./helpers";
import { projectFixture, report as fakeReport } from "./fake-native";
import { AssignedPrs, type PrWork } from "../lib/pr-records";
import { prsNamed } from "../lib/pr-refs";
import { renderAssignment, reviewerCommand, workLoopBlock, ownBriefText } from "../lib/brief";
import { prsReferenced, reportPrs } from "../lib/task-status";
import { reportSchema } from "../lib/schema";
import type { Store } from "../lib/store";

const url = (n: number, repo = "erwinkn/bb") => `https://github.com/${repo}/pull/${n}`;
const profile = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" as const };
const report = (summary: string, more: Record<string, unknown> = {}) =>
  reportSchema.parse({ outcome: "succeeded", summary, handoff: { summary, workspaceRevision: "main", files: [] }, ...more });

/**
 * The scan W506 replaced (W224, W492), verbatim but for reading the database directly: every
 * brief and report an Initiative stores, read again on each call.
 */
function scanned(store: Store, projectId: string) {
  const rows = (store.db.prepare(`SELECT num, worker_num, role, brief_text, report FROM assignments
    WHERE project_id = ? AND (brief_text LIKE '%github.com/%/pull/%' OR report LIKE '%github.com/%/pull/%' OR brief_text LIKE '%/%#%' OR report LIKE '%/%#%') ORDER BY num`)
    .all(projectId) as Record<string, unknown>[]).map((row) => ({ num: row.num as number, workerNum: row.worker_num as number, role: row.role as string,
    brief: ownBriefText((row.brief_text as string | null) ?? ""), report: (row.report as string | null) ?? null }));
  const storedReportPrs = (text: string | null) => {
    if (!text) return [];
    try {
      return reportPrs(JSON.parse(text));
    } catch {
      return [];
    }
  };
  const latest = new Map<string, Omit<PrWork, "links">>();
  const referenced = new Map<string, Omit<PrWork, "links">>();
  const byWorker = new Map<number, Set<string>>();
  const workers = new Map<string, Set<string>>();
  const assignments = new Map<string, Set<string>>();
  for (const row of rows) {
    const work = { worker: `W${row.workerNum}`, assignment: `A${row.num}`, role: row.role };
    for (const url of prsNamed(`${row.brief}\n${row.report ?? ""}`)) {
      latest.set(url, work);
      workers.set(url, (workers.get(url) ?? new Set<string>()).add(`W${row.workerNum}`));
      assignments.set(url, (assignments.get(url) ?? new Set<string>()).add(`A${row.num}`));
    }
    for (const url of new Set([...prsReferenced(row.brief), ...storedReportPrs(row.report)])) {
      referenced.set(url, work);
      byWorker.set(row.workerNum, (byWorker.get(row.workerNum) ?? new Set()).add(url));
    }
  }
  const value = new Map([...latest].map(([url, work]) =>
    [url, { ...work, links: { workers: [...workers.get(url)!], assignments: [...assignments.get(url)!] } }]));
  return { value, byWorker, referenced };
}

/** Every answer AssignedPrs gives, next to what the old scan gave. */
function compare(store: Store, projectId: string) {
  const assigned = new AssignedPrs(store);
  const old = scanned(store, projectId);
  const workerNums = store.db.prepare("SELECT DISTINCT worker_num FROM assignments WHERE project_id = ?").pluck().all(projectId) as number[];
  const urls = [...old.referenced.keys(), ...old.value.keys(), url(999)];
  return {
    now: {
      read: [...assigned.read(projectId)],
      ofWorker: workerNums.map((w) => [w, [...assigned.ofWorker(projectId, w)]]),
      referencing: urls.map((u) => [u, assigned.referencing(projectId, u)]),
    },
    old: {
      read: [...old.value],
      ofWorker: workerNums.map((w) => [w, [...(old.byWorker.get(w) ?? [])]]),
      referencing: urls.map((u) => [u, old.referenced.get(u) ?? null]),
    },
  };
}

function fixture() {
  const { store, db } = memoryStore();
  for (const id of ["p", "q"]) store.createProject({ id, name: id.toUpperCase(), objective: "Ship", memberProjectIds: ["proj"], coordinatorThreadId: null });
  const workers = [1, 2, 3].map((n) => store.createWorker({ projectId: "p", role: n === 2 ? "review" : "work", label: `W${n}`, area: "a", bbProjectId: "proj" }));
  const other = store.createWorker({ projectId: "q", role: "work", label: "Q", area: "a", bbProjectId: "proj" });
  let op = 0;
  const assign = (projectId: string, workerNum: number, role: "work" | "review", briefText: string) =>
    store.createAssignment({
      projectId, workerNum, taskNums: [], route: "fresh", role, workKind: "implementation", threadId: null, generation: 1, profile,
      bbProjectId: "proj", environmentId: null, state: "running", opId: `op_${++op}`, opState: "done", briefText, reviewOf: null, rationale: null,
    });
  // A rule's PR sits in the shared appendix: it is no one's work.
  const appendix = workLoopBlock("Guidance.", reviewerCommand(profile as never), `Standing rules:\nR1. Keep ${url(3)} and erwinkn/bb#33 as the reference.`);
  const rendered = (text: string) => renderAssignment({ assignmentRef: "A1", workerRef: "W1", workerLabel: "W1", workerPurpose: "a", role: "work", tasks: [],
    reviewOf: [], reviewed: null, priorReports: [], text, appendix, opId: "op_x" });
  return { store, db, workers, other, assign, rendered };
}

describe("W506 indexed PR refs", () => {
  it("answer exactly as the scan of every brief and report did", () => {
    const { store, workers: [w1, w2, w3], other, assign, rendered } = fixture();
    const a1 = assign("p", w1!.num, "work", "Placeholder");
    // The rendered brief replaces the placeholder (dispatch), appendix and all.
    store.setBriefText("p", a1.num, rendered(`Fix ${url(1)} and erwinkn/bb#2; not ${url(12)}…, nor erwinkn/bb#13…`));
    // Its report: a URL in another case and with a tail, and owner/repo#12 behind an escaped newline.
    store.updateAssignment("p", a1.num, { state: "reported", report: report(`Opened HTTPS://GitHub.com/ErwinKN/bb/pull/4/files`, {
      finalMessage: `Done.\nerwinkn/bb#5\nAlso ${url(1)}.` }) });
    const a2 = assign("p", w2!.num, "review", `Review ${url(4)}`);
    store.updateAssignment("p", a2.num, { state: "reported", report: report("Two findings; needs attention") });
    const a3 = assign("p", w3!.num, "work", `Built on ${url(1)} and ${url(4)}, after other/repo#6`);
    // A refiled report drops #5 and names #7.
    store.updateAssignment("p", a1.num, { report: report(`Opened ${url(7)}`) });
    store.updateAssignment("p", a3.num, { state: "reported", report: report(`Merged ${url(8, "other/repo")}`, { evidence: [{ kind: "check", label: url(1), result: "passed" }] }) });
    assign("p", w1!.num, "work", "No PR here");
    assign("q", other.num, "work", `Port ${url(1)} and erwinkn/bb#2`);
    // As SQLite matches text, as the scan's prefilter did: a NUL ends the brief, and a report
    // whose JSON escapes its slashes names no PR (neither is written today).
    assign("p", w3!.num, "work", `Context\u0000Fix ${url(14)}`);
    const escaped = assign("p", w3!.num, "work", "No PR");
    store.db.prepare("UPDATE assignments SET report = ? WHERE project_id = 'p' AND num = ?")
      .run(JSON.stringify(report(`Opened ${url(15)}`)).replaceAll("/", "\\/"), escaped.num);
    store.updateAssignment("p", escaped.num, { state: "reported" });
    store.setBriefText("p", escaped.num, "Still no PR");
    for (const projectId of ["p", "q"]) {
      const { now, old } = compare(store, projectId);
      expect(now).toEqual(old);
    }
    const p = compare(store, "p").now;
    // The cases above all landed: #3 (a rule) is nobody's; a clipped number is no reference,
    // though a clipped URL still says who works on it, as before.
    expect(p.read.map(([u]) => u)).toEqual([url(1), url(12), url(7), url(4), url(8, "other/repo")]);
    expect(p.ofWorker).toEqual([[1, [url(1), url(2), url(7)]], [2, [url(4)]], [3, [url(1), url(4), url(6, "other/repo"), url(8, "other/repo")]]]);
    expect(new AssignedPrs(store).referencing("q", url(2))).toEqual({ worker: `W${other.num}`, assignment: "A1", role: "work" });
  });

  it("catch up on the assignments the previous build wrote, once", () => {
    const { store, db, workers: [w1], assign } = fixture();
    const a1 = assign("p", w1!.num, "work", `Fix ${url(1)}`);
    expect(store.catchUpPrRefs()).toBe(0);
    // After a rollback, the previous build adds work and files a report without indexing either.
    db.prepare(`INSERT INTO assignments (project_id, num, worker_num, task_nums, route, role, thread_id, generation, profile, bb_project_id, state, op_id, op_state, brief_text, report, created_at, updated_at)
      VALUES ('p', 2, ?, '[]', 'fresh', 'work', NULL, 1, ?, 'proj', 'reported', 'op_old', 'done', ?, 'not json, but names ${url(10)}', 1, 1)`)
      .run(w1!.num, JSON.stringify(profile), `Old build's brief: ${url(9)}`);
    db.prepare("UPDATE assignments SET report = ?, report_seq = report_seq + 1 WHERE project_id = 'p' AND num = ?").run(JSON.stringify(report(`Opened ${url(11)}`)), a1.num);
    expect(compare(store, "p").now).not.toEqual(compare(store, "p").old);
    expect(store.catchUpPrRefs()).toBe(2);
    expect(compare(store, "p").now).toEqual(compare(store, "p").old);
    // An unreadable report names its URLs as text, none as references.
    expect([...new AssignedPrs(store).ofWorker("p", w1!.num)]).toEqual([url(1), url(11), url(9)]);
    expect(new AssignedPrs(store).read("p").get(url(10))).toMatchObject({ assignment: "A2" });
    expect(store.catchUpPrRefs()).toBe(0);
    // A report the previous build cleared leaves report_seq as it was.
    db.prepare("UPDATE assignments SET report = NULL WHERE project_id = 'p' AND num = ?").run(a1.num);
    expect(store.catchUpPrRefs()).toBe(1);
    expect(compare(store, "p").now).toEqual(compare(store, "p").old);
    expect(new AssignedPrs(store).ofWorker("p", w1!.num).has(url(11))).toBe(false);
  });

  it("read an Initiative of thousands of assignments without their texts", () => {
    const { store, workers: [w1], assign } = fixture();
    store.tx(() => {
      for (let n = 0; n < 2_000; n++) assign("p", w1!.num, "work", `Built on ${url(1)}. ${"Context. ".repeat(500)}`);
    });
    const prepare = vi.spyOn(store.db, "prepare");
    const assigned = new AssignedPrs(store);
    expect(assigned.ofWorker("p", w1!.num).has(url(1))).toBe(true);
    expect(assigned.referencing("p", url(1))).toMatchObject({ assignment: "A2000" });
    expect(assigned.read("p").get(url(1))!.links.assignments).toHaveLength(2_000);
    const sql = prepare.mock.calls.map(([text]) => text);
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.filter((text) => /brief_text|report/.test(text))).toEqual([]);
  });
});

describe("W506 spawns, more work and reports read only the work they check", () => {
  it("never decode the whole ledger", async () => {
    const { f, project } = await projectFixture();
    const all = vi.spyOn(f.store, "assignments");
    const [first] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    // The overlap warning still finds live writers in the same checkout.
    await expectWarned(f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id, "Next").ref] }), /W1 is also writing in this checkout \(A1, running\)/);
    await f.service.report(first!.threadId!, fakeReport());
    f.idle(first!.threadId!);
    const [more] = await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [f.task(project.id, "More").ref] });
    expect(more!.warnings ?? []).toEqual([expect.stringMatching(/W2 is also writing in this checkout/)]);
    expect(all).not.toHaveBeenCalled();
  });
});
