import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expectWarned } from "./helpers";
import { projectFixture, report } from "./fake-native";
import {
  currentProjectThreads,
  projectStatus,
  selectedProject,
} from "../../sidebar/lib/project-mode-status";

/**
 * A26: receipts prove delivery, never execution. A cancelled brief that can
 * still run keeps its task and workspace reservations until native evidence
 * settles it — a quiet thread, a removed queue row, or an ended turn.
 */
async function continuation() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id);
  const [d] = await f.service.delegate(project.id, {
    route: "fresh",
    tasks: [t1.ref],
  });
  await f.service.report(d.threadId!, report());
  await f.service.closeTask(project.id, t1.ref, "done");
  f.idle(d.threadId!);
  const worker = f.store.workers(project.id)[0]!;
  const t2 = f.task(project.id, "Next");
  return { f, project, worker, t2 };
}

async function lostSend() {
  const x = await continuation();
  x.f.send.mockImplementationOnce(async (args: any) => {
    x.f.queued.set(x.worker.threadId!, [
      { id: "lost-q", content: args.input },
    ]);
    throw new Error("lost response");
  });
  await x.f.service
    .delegate(x.project.id, {
      route: "continue",
      worker: x.worker.ref,
      tasks: [x.t2.ref],
    })
    .catch(() => undefined);
  return x;
}

// T136: new work on a reserved task is warned about, never refused; the reservation itself
// is the cancelled operation staying unsettled.
const held = async (f: any, project: any, t: any) => {
  expect(["pending", "uncertain"]).toContain(f.store.assignments(project.id).filter((a: any) => a.taskNums.includes(t.num) && a.state === "cancelled").at(-1)!.opState);
  const [r] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
  expect(r.warnings?.join(" ")).toMatch(new RegExp(`${t.ref} is also with`));
};

describe("cancelled reservations hold until native execution settles", () => {
  it("keeps the task reserved when a cancelled lost send is found executing", async () => {
    const { f, project, worker, t2 } = await lostSend();
    await f.service.stopAssignment(project.id, "A2", "cancel");
    const input = f.queued.get(worker.threadId!)![0]!.content;
    f.queued.set(worker.threadId!, []);
    f.threads.set(worker.threadId!, {
      ...f.threads.get(worker.threadId!)!,
      status: "active",
    });
    f.harness.sdk.stub("threads.promptHistory", async () => [{ input }]);
    await f.service.reconcile();
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.state).toBe("cancelled");
    expect(a2.briefDelivered).toBe(true);
    // The op stays outstanding while the turn can still run.
    expect(a2.opState).toBe("uncertain");
    await held(f, project, t2);
    // The turn ends: the reservation releases positively.
    await f.runtime.onThreadIdle(f.idle(worker.threadId!));
    expect(f.store.assignment(project.id, 2)!.opState).toBe("done");
    const replacement = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
    expect(replacement[0]!.state).toBe("running");
  });

  it("keeps an overlapping-workspace reservation after a cancelled queue dispatch event", async () => {
    const { f, project, worker, t2 } = await continuation();
    f.queueSend("own-q");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => {
      throw new Error("offline");
    });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    f.queued.set(worker.threadId!, []);
    f.threads.set(worker.threadId!, {
      ...f.threads.get(worker.threadId!)!,
      status: "active",
    });
    f.runtime.onMessageDispatched("own-q");
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.state).toBe("cancelled");
    expect(a2.briefDelivered).toBe(true);
    expect(a2.opState).toBe("uncertain");
    const other = f.task(project.id, "Overlapping work");
    // T136: the shared checkout is a warning, not a hold.
    await expectWarned(f.service.delegate(project.id, { route: "fresh", tasks: [other.ref] }), /W1 is also writing in this checkout \(A2, cancelled\)/);
    // Idle settles the dispatched turn and frees the workspace: no more warning.
    await f.runtime.onThreadIdle(f.idle(worker.threadId!));
    const third = f.task(project.id, "Later work");
    const [later] = await f.service.delegate(project.id, { route: "fresh", tasks: [third.ref] });
    expect(later.warnings?.some(w => w.includes("A2"))).toBeFalsy();
  });

  it("does not release a queued cancellation on delete 404 when its brief may have dispatched", async () => {
    const { f, project, worker, t2 } = await continuation();
    f.queueSend("own-q");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => {
      f.queued.set(worker.threadId!, []);
      f.threads.set(worker.threadId!, {
        ...f.threads.get(worker.threadId!)!,
        status: "active",
      });
      throw Object.assign(new Error("already dispatched"), { status: 404 });
    });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.queuedMessageId).toBe("own-q");
    expect(a2.opState).toBe("uncertain");
    await held(f, project, t2);
    // The 404 row really did dispatch: a sweep sees the marker and holds the
    // reservation until that turn ends.
    const input = f.send.mock.calls.at(-1)![0].input;
    f.harness.sdk.stub("threads.promptHistory", async () => [{ input }]);
    await f.service.reconcile();
    expect(f.store.assignment(project.id, 2)!.opState).toBe("uncertain");
    await held(f, project, t2);
  });

  it("a report on a cancelled running brief is evidence, not quiescence", async () => {
    const { f, project, worker, t2 } = await continuation();
    f.queueSend("own-q");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => {
      throw new Error("offline");
    });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    f.threads.set(worker.threadId!, {
      ...f.threads.get(worker.threadId!)!,
      status: "active",
    });
    f.runtime.onMessageDispatched("own-q");
    // The report lands while the turn can still execute: it stores as
    // evidence on the cancelled assignment, but the reservation holds —
    // a report is proof of delivery, never of native quiescence.
    await f.service.report(worker.threadId!, {
      ...report(),
      assignment: "A2",
    });
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.state).toBe("cancelled");
    expect(a2.report?.outcome).toBe("succeeded");
    expect(a2.opState).toBe("uncertain");
    expect(f.store.task(project.id, t2.num)!.status).toBe("blocked");
    await held(f, project, t2);
    // Only the turn's end settles it.
    await f.runtime.onThreadIdle(f.idle(worker.threadId!));
    expect(f.store.assignment(project.id, 2)!.opState).toBe("done");
    await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
  });

  it("settles a cancelled queued send when a sweep proves nothing ran", async () => {
    const { f, project, worker, t2 } = await continuation();
    f.queueSend("own-q");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    await f.service.stopAssignment(project.id, "A2", "cancel");
    f.queued.set(worker.threadId!, []);
    await f.service.reconcile();
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.opState).toBe("done");
    expect(a2.queuedMessageId).toBeNull();
    await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
  });
});

describe("a late report never discards native uncertainty", () => {
  it("keeps the receipt and reservation when deleting the runnable brief fails", async () => {
    const { f, project, worker, t2 } = await continuation();
    f.queueSend("own-q");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => {
      throw new Error("offline");
    });
    await f.service.stopAssignment(project.id, "A2", "cancel");
    await f.service.report(worker.threadId!, {
      ...report(),
      assignment: "A2",
    });
    // The report is stored evidence on the cancelled assignment; the failed
    // delete keeps its receipt, its uncertainty and the reservation.
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.state).toBe("cancelled");
    expect(a2.report?.outcome).toBe("succeeded");
    expect(a2.queuedMessageId).toBe("own-q");
    expect(a2.opState).toBe("uncertain");
    expect(f.queued.get(worker.threadId!)).toHaveLength(1);
    await held(f, project, t2);
    // The failure is visible, not swallowed.
    expect(
      f.store
        .activity(project.id, 200)
        .some((row) => row.summary.includes("could not be deleted")),
    ).toBe(true);
    // Once the native row is positively gone, a sweep settles the op.
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => ({}));
    f.queued.set(worker.threadId!, []);
    await f.service.reconcile();
    const settled = f.store.assignment(project.id, 2)!;
    expect(settled.queuedMessageId).toBeNull();
    expect(settled.opState).toBe("done");
    await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
  });
});

describe("reconciliation is monotonic against newer evidence", () => {
  it("a stale queue snapshot cannot downgrade a newer running state", async () => {
    const { f, project, worker } = await lostSend();
    let first = true;
    f.harness.sdk.stub("threads.queuedMessages.list", async () => {
      const stale = [...f.queued.get(worker.threadId!)!];
      f.queued.set(worker.threadId!, []);
      if (first) {
        first = false;
        f.store.confirmAssignmentDelivery(project.id, 2);
      }
      return stale;
    });
    await f.service.reconcile();
    expect(f.store.assignment(project.id, 2)).toMatchObject({
      state: "running",
      queuedMessageId: null,
      briefDelivered: true,
    });
  });

  it("a stale queue snapshot cannot reattach a receipt a report cleared", async () => {
    const { f, project, worker } = await lostSend();
    let first = true;
    f.harness.sdk.stub("threads.queuedMessages.list", async () => {
      const stale = [...f.queued.get(worker.threadId!)!];
      if (first) {
        first = false;
        await f.service.report(worker.threadId!, {
          ...report(),
          assignment: "A2",
        });
        f.queued.set(worker.threadId!, []);
      }
      return stale;
    });
    await f.service.reconcile();
    expect(f.store.assignment(project.id, 2)).toMatchObject({
      state: "reported",
      queuedMessageId: null,
      briefDelivered: true,
    });
  });

  it("a reported task can be given out again after stale reconciliation", async () => {
    const { f, project, worker, t2 } = await lostSend();
    let first = true;
    f.harness.sdk.stub("threads.queuedMessages.list", async () => {
      const stale = [...f.queued.get(worker.threadId!)!];
      if (first) {
        first = false;
        await f.service.report(worker.threadId!, {
          ...report(),
          assignment: "A2",
        });
        f.queued.set(worker.threadId!, []);
      }
      return stale;
    });
    await f.service.reconcile();
    f.idle(worker.threadId!);
    const replacement = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
    expect(replacement[0]!.state).toBe("running");
  });
});

const asSidebar = (t: any) => ({
  ...t,
  isArchived: t.archivedAt !== null,
  isUnread: false,
  isPinned: false,
  hasPendingInteraction: false,
  indicator: t.status === "active" ? "runtime" : "none",
  indicatorLabel: null,
  sectionId: null,
  originKind: null,
  environment: null,
  activity: {},
  updatedAt: 100,
});
const flatten = (rows: any[]): string[] =>
  rows.flatMap((r) => [r.thread.id, ...flatten(r.children)]);

describe("nested native children carry lightweight membership", () => {
  it("shows nested active children and hides archived or deleted roots", async () => {
    const { f, project } = await projectFixture();
    const parent = await f.spawn({
      projectId: "proj_a",
      parentThreadId: "coordinator",
    });
    const nested = await f.spawn({
      projectId: "proj_a",
      parentThreadId: parent.id,
    });
    await f.runtime.sweep();
    const rows = () =>
      flatten(
        currentProjectThreads(
          f.tree().projects[0]!,
          [...f.threads.values()].map(asSidebar),
          [],
          "updated",
          "descending",
        ),
      );
    expect(rows()).toEqual([parent.id, nested.id]);
    f.threads.set(nested.id, { ...nested, archivedAt: Date.now() });
    expect(rows()).toEqual([parent.id]);
    f.threads.delete(parent.id);
    expect(rows()).toEqual([]);
    // The direct child's row stays as history; no task or worker was made.
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
    expect(f.store.assignments(project.id)).toHaveLength(0);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("selecting a nested child keeps its durable project when membership overlaps", async () => {
    const { f, project } = await projectFixture();
    f.threads.set(
      "coordinator-b",
      makeThreadResponse({
        id: "coordinator-b",
        projectId: "proj_a",
        environmentId: "env_a",
      }),
    );
    const { project: other } = await f.service.createProject({
      name: "Other",
      objective: "other",
      memberProjectIds: ["proj_a"],
      coordinator: { kind: "adopt", threadId: "coordinator-b" },
    });
    const parent = await f.spawn({
      projectId: "proj_a",
      parentThreadId: "coordinator-b",
    });
    const nested = await f.spawn({
      projectId: "proj_a",
      parentThreadId: parent.id,
    });
    await f.runtime.sweep();
    const all = f.tree().projects;
    const ordered = [
      all.find((p) => p.id === project.id)!,
      all.find((p) => p.id === other.id)!,
    ];
    // Both projects share proj_a, so memberProjectIds alone cannot pick.
    expect(
      flatten(
        currentProjectThreads(
          ordered[1]!,
          [...f.threads.values()].map(asSidebar),
          [],
          "updated",
          "descending",
        ),
      ),
    ).toContain(nested.id);
    expect(
      selectedProject(
        ordered,
        [...f.threads.values()].map(asSidebar),
        nested.id,
        "proj_a",
      )?.id,
    ).toBe(other.id);
    expect(f.store.membership(nested.id)?.project.id).toBe(other.id);
  });

  it("a same-project adhoc association upgrades to coordinator; a foreign one blocks", async () => {
    const { f, project } = await projectFixture();
    const child = await f.spawn({
      projectId: "proj_a",
      parentThreadId: "coordinator",
    });
    f.service.associateNativeChild(child);
    f.idle("coordinator");
    f.idle(child.id);
    await f.service.replaceCoordinator(project.id, {
      reason: "promote explicitly",
      adoptThreadId: child.id,
    });
    expect(f.store.membership(child.id)?.kind).toBe("coordinator");
    // A child of the new coordinator associates to the same project; another
    // project sharing the BB repository cannot claim it.
    const foreign = await f.spawn({
      projectId: "proj_a",
      parentThreadId: child.id,
    });
    f.service.associateNativeChild(foreign);
    f.threads.set(
      "coordinator-b",
      makeThreadResponse({
        id: "coordinator-b",
        projectId: "proj_a",
        environmentId: "env_a",
      }),
    );
    const { project: other } = await f.service.createProject({
      name: "Other",
      objective: "other",
      memberProjectIds: ["proj_a"],
      coordinator: { kind: "adopt", threadId: "coordinator-b" },
    });
    await expect(
      f.service.adoptWorker(other.id, {
        threadId: foreign.id,
        role: "work",
        label: "steal",
      }),
    ).rejects.toThrow(/already belongs/);
    expect(f.store.membership(foreign.id)?.project.id).toBe(project.id);
  });

  it("archived or deleted associated threads do not read as working", async () => {
    const { f, project } = await projectFixture();
    const child = await f.spawn({
      projectId: "proj_a",
      parentThreadId: "coordinator",
    });
    await f.runtime.sweep();
    const status = () =>
      projectStatus(
        f.tree().projects[0]!,
        [...f.threads.values()].map(asSidebar),
        [],
      );
    f.threads.delete(child.id);
    expect(status()).toBe("done");
    // The association row is retained as history.
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
  });
});
