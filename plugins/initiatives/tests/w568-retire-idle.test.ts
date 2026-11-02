import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";

// W568: an operator's bulk retire of idle workers across Adventures, and the coordinator memory's priority.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const DAY = 86_400_000;

/** A worker whose work is reported and closed, its thread quiet since `idleMs` ago; its PR merged unless `pr` is false (R11: no PR, its context is kept). */
async function finished(f: Fx, projectId: string, idleMs: number, pr = true) {
  const task = f.task(projectId);
  const [d] = await f.service.delegate(projectId, { route: "fresh", tasks: [task.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.setTaskStatus(projectId, task.ref, "done", "Closed as done.", "the user");
  quietSince(f, d.threadId!, idleMs);
  if (pr) holds(f, projectId, d.worker, `https://github.com/o/${projectId}/pull/${d.worker.slice(1)}`, "MERGED");
  return { ref: d.worker, threadId: d.threadId!, num: Number(d.worker.slice(1)), task: task.ref };
}
/** The worker holds the PR in its Adventure's records, in that state (null: not known yet). */
function holds(f: Fx, projectId: string, worker: string, url: string, state: "OPEN" | "MERGED" | "CLOSED" | null) {
  f.store.db.prepare("INSERT INTO pr_records (project_id, url, worker, updated_at) VALUES (?, ?, ?, 1)").run(projectId, url, worker);
  if (state) f.store.db.prepare("INSERT INTO pr_states (url, state, checked_at) VALUES (?, ?, 1)").run(url, state);
}
const holdsOpen = (f: Fx, projectId: string, worker: string) => (f.store.prsHeld(projectId).get(worker) ?? []).some((pr) => pr.open);
const quietSince = (f: Fx, threadId: string, idleMs: number) => f.threads.set(threadId, { ...f.idle(threadId), updatedAt: Date.now() - idleMs });
const retireIdle = async (f: Fx, ...flags: string[]) => {
  const r = await f.harness.runCli(["retire-idle", ...flags]);
  if (r.exitCode !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout!);
};

async function scene() {
  const { f, project } = await projectFixture();
  const idle = await finished(f, project.id, 3 * DAY);
  const fresh = await finished(f, project.id, 2 * 3_600_000);
  const busy = await finished(f, project.id, 3 * DAY);
  f.threads.set(busy.threadId, { ...f.threads.get(busy.threadId)!, status: "active" });
  const holder = await finished(f, project.id, 3 * DAY);
  const url = "https://github.com/o/r/pull/12";
  holds(f, project.id, holder.ref, url, "OPEN");
  const watcher = await finished(f, project.id, 3 * DAY);
  const watched = "https://github.com/o/r/pull/13";
  f.store.db.prepare("INSERT INTO pr_watches (url, project_id, since, state, gen, updated_at, watcher_thread_id) VALUES (?, ?, 1, '{}', 1, 1, ?)").run(watched, project.id, watcher.threadId);
  // R11: an analysis without a PR keeps its context; a reviewer (D449: fresh each round) may go.
  const analysis = await finished(f, project.id, 3 * DAY, false);
  const [review] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [idle.task] });
  await f.service.report(review.threadId!, report());
  quietSince(f, review.threadId!, 4 * DAY);
  const reviewer = { ref: review.worker, threadId: review.threadId!, num: Number(review.worker.slice(1)) };
  // Open work: delegated, no report yet.
  const [working] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id, "Ranking").ref] });
  quietSince(f, working.threadId!, 3 * DAY);
  // A second Adventure with one idle worker of its own.
  const { project: other } = await f.service.createProject({ name: "Other", objective: "Another objective", memberProjectIds: ["proj_a"], coordinator: { kind: "new" } });
  const elsewhere = await finished(f, other.id, 5 * DAY);
  return { f, project, other, idle, fresh, busy, holder, watcher, analysis, reviewer, working: working.worker, elsewhere, url, watched };
}

describe("W568 retire-idle", () => {
  it("lists, by Adventure, whom it would retire and why it keeps each other worker, and changes nothing on a dry run", async () => {
    const s = await scene();
    const archived = s.f.archive.mock.calls.length;
    const out = await retireIdle(s.f, "--dry-run");
    expect(out.totals).toEqual({ wouldRetire: 3, skipped: 6, noPrKept: 1 });
    const byId = Object.fromEntries(out.adventures.map((a: { id: string }) => [a.id, a]));
    expect(byId[s.project.id].wouldRetire).toEqual([{ worker: s.reviewer.ref, idle: "4 d" }, { worker: s.idle.ref, idle: "3 d" }]);
    expect(byId[s.other.id].wouldRetire).toEqual([{ worker: s.elsewhere.ref, idle: "5 d" }]);
    expect(Object.fromEntries(byId[s.project.id].skipped.map((k: { worker: string; reason: string }) => [k.worker, k.reason]))).toEqual({
      [s.fresh.ref]: "active 2 h ago",
      [s.busy.ref]: expect.stringMatching(/still running/),
      [s.holder.ref]: `holds or watches open PR ${s.url}`,
      [s.watcher.ref]: `holds or watches open PR ${s.watched}`,
      [s.working]: expect.stringMatching(/^A\d+ is open \(/),
      [s.analysis.ref]: "no PR, kept",
    });
    expect(s.f.archive.mock.calls.length).toBe(archived);
    expect(s.f.store.workers(s.project.id).filter((w) => w.state === "retired")).toEqual([]);
  });

  it("retires the idle workers through the usual retire, longest idle first, within its limit, and wakes nobody", async () => {
    const s = await scene();
    const sends = s.f.send.mock.calls.length;
    const first = await retireIdle(s.f, "--limit=1");
    // The busy one is refused, not counted against the limit, and then listed as kept.
    expect(first.totals).toEqual({ retired: 1, failed: 0, skipped: 5, noPrKept: 1, left: 3 });
    expect(first.note).toMatch(/3 more idle workers are left/);
    expect(s.f.store.worker(s.other.id, s.elsewhere.num)!.state).toBe("retired");
    const second = await retireIdle(s.f);
    expect(second.totals).toEqual({ retired: 2, failed: 0, skipped: 6, noPrKept: 1, left: 0 });
    const mine = second.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.retired).toEqual([{ worker: s.reviewer.ref, idle: "4 d" }, { worker: s.idle.ref, idle: "3 d" }]);
    expect(mine.skipped).toContainEqual({ worker: s.busy.ref, reason: expect.stringMatching(/still running/) });
    expect(s.f.store.worker(s.project.id, s.idle.num)!.state).toBe("retired");
    expect(s.f.threads.get(s.idle.threadId)!.archivedAt).not.toBeNull();
    expect(s.f.store.activity(s.project.id, -1).map((a) => a.summary)).toContain(`${s.idle.ref} retired: idle for 3 d (retire-idle by the user)`);
    for (const kept of [s.fresh, s.busy, s.holder, s.watcher, s.analysis]) expect(s.f.store.worker(s.project.id, kept.num)!.state).not.toBe("retired");
    // Nothing was sent to any thread.
    expect(s.f.send.mock.calls.length).toBe(sends);
    await s.f.service.settleBackgroundStops();
  });

  it("keeps a worker's context until every PR it holds is merged or closed (R11), a PR of unknown state counting as open", async () => {
    const s = await scene();
    // The holder's PR is closed (dropped); the idle worker took a second PR, whose state is not known yet.
    s.f.store.db.prepare("UPDATE pr_states SET state = 'CLOSED' WHERE url = ?").run(s.url);
    const unknown = "https://github.com/o/r/pull/20";
    holds(s.f, s.project.id, s.idle.ref, unknown, null);
    const out = await retireIdle(s.f, "--idle=48");
    const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.retired).toEqual([{ worker: s.reviewer.ref, idle: "4 d" }, { worker: s.holder.ref, idle: "3 d" }]);
    expect(mine.skipped).toContainEqual({ worker: s.idle.ref, reason: `holds or watches open PR ${unknown}` });
    expect(mine.skipped).toContainEqual({ worker: s.analysis.ref, reason: "no PR, kept" });
    expect(s.f.store.worker(s.project.id, s.holder.num)!.state).toBe("retired");
    expect(s.f.store.worker(s.project.id, s.idle.num)!.state).not.toBe("retired");
    await s.f.service.settleBackgroundStops();
  });

  it("keeps a worker whose thread turned busy since the scan, never retiring it later", async () => {
    const s = await scene();
    s.f.intercept(async (path, args, call) => {
      // The scan reads it quiet; the retire's own read finds it running.
      if (path === "threads.get" && (args as { threadId: string }).threadId === s.idle.threadId && s.f.threads.get(s.idle.threadId)!.status === "idle") {
        const answer = await call();
        s.f.threads.set(s.idle.threadId, { ...s.f.threads.get(s.idle.threadId)!, status: "active" });
        return answer;
      }
      return call();
    });
    const out = await retireIdle(s.f);
    const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.failed).toEqual([]);
    expect(mine.skipped).toContainEqual({ worker: s.idle.ref, reason: expect.stringMatching(/still running/) });
    expect(s.f.store.retireRequests()).toEqual([]);
    expect(s.f.store.worker(s.project.id, s.idle.num)!.state).not.toBe("retired");
    await s.f.service.settleBackgroundStops();
  });

  it("keeps a worker that took a PR or was active since the scan, read again in the write queue", async () => {
    const s = await scene();
    const url = "https://github.com/o/r/pull/14";
    let reads = 0;
    s.f.intercept(async (path, args, call) => {
      const answer = await call();
      // After the scan's read of each: one holds an open PR by its retire's first read, the other's thread changed.
      if (path === "threads.get" && (args as { threadId: string }).threadId === s.idle.threadId && ++reads === 2) {
        s.f.store.db.prepare("INSERT INTO pr_records (project_id, url, worker, updated_at) VALUES (?, ?, ?, 1)").run(s.project.id, url, s.idle.ref);
        s.f.store.db.prepare("INSERT INTO pr_states (url, state, checked_at) VALUES (?, 'OPEN', 1)").run(url);
      }
      if (path === "threads.get" && (args as { threadId: string }).threadId === s.elsewhere.threadId && s.f.threads.get(s.elsewhere.threadId)!.updatedAt < Date.now() - DAY)
        s.f.threads.set(s.elsewhere.threadId, { ...s.f.threads.get(s.elsewhere.threadId)!, updatedAt: Date.now() });
      return answer;
    });
    const out = await retireIdle(s.f);
    // Only the reviewer, which the races leave alone, retires.
    expect(out.totals).toMatchObject({ retired: 1, failed: 0 });
    const byId = Object.fromEntries(out.adventures.map((a: { id: string }) => [a.id, a]));
    expect(byId[s.project.id].skipped).toContainEqual({ worker: s.idle.ref, reason: `holds or watches open PR ${url}, since the scan` });
    expect(byId[s.other.id].skipped).toContainEqual({ worker: s.elsewhere.ref, reason: "active 0 min ago, since the scan" });
    expect(s.f.store.worker(s.project.id, s.idle.num)!.state).not.toBe("retired");
    expect(s.f.store.worker(s.other.id, s.elsewhere.num)!.state).not.toBe("retired");
  });

  it("keeps a worker that took or watched a PR while its quiet proof was being read, just before the archive", async () => {
    const s = await scene();
    const owned = "https://github.com/o/r/pull/15";
    const watched = "https://github.com/o/r/pull/16";
    const archived = s.f.archive.mock.calls.length;
    s.f.intercept(async (path, _args, call) => {
      const answer = await call();
      // initiative_pr and PR watches bypass the write queue: they land while the list row is read.
      if (path === "threads.list" && !holdsOpen(s.f, s.project.id, s.idle.ref)) {
        s.f.store.db.prepare("INSERT INTO pr_records (project_id, url, worker, updated_at) VALUES (?, ?, ?, 1)").run(s.project.id, owned, s.idle.ref);
        s.f.store.db.prepare("INSERT INTO pr_states (url, state, checked_at) VALUES (?, 'OPEN', 1)").run(owned);
        s.f.store.db.prepare("INSERT INTO pr_watches (url, project_id, since, state, gen, updated_at, watcher_thread_id) VALUES (?, ?, 1, '{}', 1, 1, ?)").run(watched, s.other.id, s.elsewhere.threadId);
      }
      return answer;
    });
    const out = await retireIdle(s.f);
    // Only the reviewer, which the races leave alone, retires.
    expect(out.totals).toMatchObject({ retired: 1, failed: 0 });
    const byId = Object.fromEntries(out.adventures.map((a: { id: string }) => [a.id, a]));
    expect(byId[s.other.id].skipped).toContainEqual({ worker: s.elsewhere.ref, reason: `holds or watches open PR ${watched}, since the scan` });
    expect(byId[s.project.id].skipped).toContainEqual({ worker: s.idle.ref, reason: `holds or watches open PR ${owned}, since the scan` });
    for (const w of [s.idle, s.elsewhere]) expect(s.f.archive).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: w.threadId }));
    expect(s.f.archive.mock.calls.length).toBe(archived + 1);
  });

  it("keeps a worker that took a PR since the scan even when BB already archived its thread", async () => {
    const s = await scene();
    const url = "https://github.com/o/r/pull/17";
    let reads = 0;
    s.f.intercept(async (path, args, call) => {
      // The scan reads it quiet; by the retire's read, BB archived it and it took a PR.
      if (path === "threads.get" && (args as { threadId: string }).threadId === s.idle.threadId && ++reads === 2) {
        s.f.threads.set(s.idle.threadId, { ...s.f.threads.get(s.idle.threadId)!, archivedAt: Date.now() - 3 * DAY });
        s.f.store.db.prepare("INSERT INTO pr_records (project_id, url, worker, updated_at) VALUES (?, ?, ?, 1)").run(s.project.id, url, s.idle.ref);
        s.f.store.db.prepare("INSERT INTO pr_states (url, state, checked_at) VALUES (?, 'OPEN', 1)").run(url);
      }
      return call();
    });
    const out = await retireIdle(s.f);
    expect(reads).toBe(2);
    const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.skipped).toContainEqual({ worker: s.idle.ref, reason: `holds or watches open PR ${url}, since the scan` });
    expect(s.f.store.worker(s.project.id, s.idle.num)!.state).not.toBe("retired");
    await s.f.service.settleBackgroundStops();
  });

  it("never calls the archive while the worker holds an open PR, wherever after the proof's last read the claim lands", async () => {
    // The claim lands `hops` microtasks after the root's last read answers: before, during or
    // after the decision. Either the worker is kept, or the claim came after the archive call.
    for (let hops = 0; hops < 16; hops++) {
      const s = await scene();
      const url = "https://github.com/o/r/pull/18";
      let reads = 0;
      let heldAtArchive: boolean | null = null;
      s.f.intercept(async (path, args, call) => {
        const threadId = (args as { threadId?: string }).threadId;
        if (path === "threads.archive" && threadId === s.idle.threadId) heldAtArchive = holdsOpen(s.f, s.project.id, s.idle.ref);
        const answer = await call();
        // The scan's read, the proof's first read, its last read.
        if (path === "threads.get" && threadId === s.idle.threadId && ++reads === 3) {
          let left = hops;
          const later = () => {
            if (left-- > 0) return queueMicrotask(later);
            s.f.store.db.prepare("INSERT INTO pr_records (project_id, url, worker, updated_at) VALUES (?, ?, ?, 1)").run(s.project.id, url, s.idle.ref);
            s.f.store.db.prepare("INSERT INTO pr_states (url, state, checked_at) VALUES (?, 'OPEN', 1)").run(url);
          };
          queueMicrotask(later);
        }
        return answer;
      });
      const out = await retireIdle(s.f);
      expect(reads).toBe(3);
      const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
      if (heldAtArchive === null)
        expect(mine.skipped, `hops ${hops}`).toContainEqual({ worker: s.idle.ref, reason: `holds or watches open PR ${url}, since the scan` });
      else expect(heldAtArchive, `hops ${hops}`).toBe(false);
      await s.f.service.settleBackgroundStops();
    }
  });

  it("keeps a worker whose thread changed while its quiet proof was being read, though it stayed idle", async () => {
    const s = await scene();
    let reads = 0;
    let touched = false;
    s.f.intercept(async (path, args, call) => {
      if (path === "threads.get" && (args as { threadId: string }).threadId === s.idle.threadId) reads++;
      const answer = await call();
      // Its retire's first read done (the scan's was the first): a turn that started and ended
      // while BB's list row was read leaves it idle again, but changed just now.
      if (path === "threads.list" && reads === 2 && !touched) {
        touched = true;
        s.f.threads.set(s.idle.threadId, { ...s.f.threads.get(s.idle.threadId)!, updatedAt: Date.now() });
      }
      return answer;
    });
    const out = await retireIdle(s.f);
    expect(touched).toBe(true);
    const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.skipped).toContainEqual({ worker: s.idle.ref, reason: "active 0 min ago, since the scan" });
    expect(s.f.store.worker(s.project.id, s.idle.num)!.state).not.toBe("retired");
  });

  it("applies the same condition on a dry run's proof: a PR taken since the scan is a skip", async () => {
    const s = await scene();
    const url = "https://github.com/o/r/pull/19";
    let reads = 0;
    s.f.intercept(async (path, args, call) => {
      if (path === "threads.get" && (args as { threadId: string }).threadId === s.idle.threadId && ++reads === 2) {
        s.f.store.db.prepare("INSERT INTO pr_records (project_id, url, worker, updated_at) VALUES (?, ?, ?, 1)").run(s.project.id, url, s.idle.ref);
        s.f.store.db.prepare("INSERT INTO pr_states (url, state, checked_at) VALUES (?, 'OPEN', 1)").run(url);
      }
      return call();
    });
    const out = await retireIdle(s.f, "--dry-run");
    const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.wouldRetire).toEqual([{ worker: s.reviewer.ref, idle: "4 d" }]);
    expect(mine.skipped).toContainEqual({ worker: s.idle.ref, reason: `holds or watches open PR ${url}, since the scan` });
    expect(out.totals.wouldRetire).toBe(2);
  });

  it("gives on a dry run the refusal retiring would meet, such as a native child still running", async () => {
    const s = await scene();
    const child = "thr_w568child";
    s.f.threads.set(child, { ...s.f.threads.get(s.idle.threadId)!, id: child, parentThreadId: s.idle.threadId, status: "active", updatedAt: Date.now() });
    const out = await retireIdle(s.f, "--dry-run");
    const mine = out.adventures.find((a: { id: string }) => a.id === s.project.id);
    expect(mine.wouldRetire).toEqual([{ worker: s.reviewer.ref, idle: "4 d" }]);
    expect(mine.skipped).toContainEqual({ worker: s.idle.ref, reason: expect.stringMatching(/native descendants/) });
    expect(s.f.archive).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: s.idle.threadId }));
  });

  it("refuses any thread but a live coordinator's, and flags without their value", async () => {
    const s = await scene();
    const r = await s.f.harness.runCli(["retire-idle", "--dry-run"], { threadId: s.idle.threadId });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/terminal or from a coordinator/);
    // A thread no Adventure knows.
    const stranger = await s.f.harness.runCli(["retire-idle", "--dry-run"], { threadId: "thr_unrelated" });
    expect(stranger.exitCode).toBe(1);
    expect(stranger.stderr).toMatch(/terminal or from a coordinator/);
    const coordinator = await s.f.harness.runCli(["retire-idle", "--dry-run"], { threadId: s.project.coordinatorThreadId! });
    expect(coordinator.exitCode).toBe(0);
    for (const flags of [["--everything"], ["--idle"], ["--limit"], ["--idle=abc"], ["--include-prs"]]) {
      const bad = await s.f.harness.runCli(["retire-idle", ...flags]);
      expect(bad.exitCode, flags.join(" ")).toBe(1);
    }
    expect(s.f.store.workers(s.project.id).filter((w) => w.state === "retired")).toEqual([]);
  });
});

describe("W568 coordinator memory first", () => {
  it("tells Chat memory each live Adventure's coordinator memory goes first, once per Adventure, and again after a failure", async () => {
    const { f, project } = await projectFixture();
    const prioritized = () => f.pluginRpc.mock.calls.filter(([a]) => a.method === "prioritize").map(([a]) => a.input);
    f.pluginRpc.mockClear();
    f.pluginRpc.mockImplementationOnce(async () => { throw new Error("chat memory is reloading"); });
    await f.service.prioritizeCoordinatorMemories();
    await f.service.prioritizeCoordinatorMemories();
    await f.service.prioritizeCoordinatorMemories();
    expect(prioritized()).toEqual([{ key: project.id, priority: 1 }, { key: project.id, priority: 1 }]);
  });
});
