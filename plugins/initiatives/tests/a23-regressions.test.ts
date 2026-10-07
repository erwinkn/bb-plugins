import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expectWarned } from "./helpers";
import { projectFixture, report } from "./fake-native";

// A23: regressions for the seven A22 review findings. Each pins an invariant
// the independent review reproduced as broken.

/** Coordinator project with one completed work assignment and a next task. */
async function queuedFixture() {
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
  const t2 = f.task(project.id, "Next task");
  return { f, project, d, worker, t2 };
}

describe("cancellation keeps the native receipt and reservation", () => {
  it("retains the queue receipt and task reservation when BB refuses the delete", async () => {
    const { f, project, worker, t2 } = await queuedFixture();
    f.queueSend("own-q");
    await f.perform(
      project.id,
      {
        action: "delegate",
        route: "continue",
        role: "work",
        worker: worker.ref,
        tasks: [t2.ref],
      },
      "coordinator",
      "coordinator",
    );
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => {
      throw new Error("BB unavailable");
    });
    await f.service.stopAssignment(project.id, "A2", "user cancelled");
    await f.service.reconcile();
    const a = f.store.assignment(project.id, 2)!;
    expect({
      state: a.state,
      queue: a.queuedMessageId,
      op: a.opState,
    }).toEqual({ state: "cancelled", queue: "own-q", op: "uncertain" });
    expect(f.queued.get(worker.threadId!)!.map((q) => q.id)).toEqual(["own-q"]);
    expect(f.store.task(project.id, t2.num)!.status).toBe("blocked");
    // The reservation warns a replacement delegation while the row is runnable (T136).
    await expectWarned(f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref] }), /T2 is also with W1 \(A2, cancelled\)/);
  });

  it("deletes a lost-response send found queued, keeping the op uncertain", async () => {
    const { f, project, worker, t2 } = await queuedFixture();
    f.send.mockImplementationOnce(async (args) => {
      f.queued.set(worker.threadId!, [{ id: "lost-q", content: args.input }]);
      throw new Error("lost response");
    });
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    await f.service.stopAssignment(project.id, "A2", "cancel uncertain send");
    await f.service.reconcile();
    const a = f.store.assignment(project.id, 2)!;
    expect(f.queued.get(worker.threadId!)).toHaveLength(0);
    expect(a.queuedMessageId).toBeNull();
    expect(a.opState).toBe("uncertain");
    expect(f.store.task(project.id, t2.num)!.status).toBe("blocked");
  });

  it("does not accept a replacement assignment until the cancelled send is positively settled", async () => {
    const { f, project, worker, t2 } = await queuedFixture();
    f.send.mockImplementationOnce(async (args) => {
      f.queued.set(worker.threadId!, [{ id: "lost-q", content: args.input }]);
      throw new Error("lost response");
    });
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    await f.service.stopAssignment(project.id, "A2", "cancel uncertain send");
    await f.service.reconcile();
    // The row is deleted but a dispatch could have raced it: one clean sweep
    // keeps the reservation (T136: unsettled, and new work on it is warned).
    expect(f.store.assignment(project.id, 2)!.opState).toBe("uncertain");
    // The next clean sweep — no queue row, no matching prompt — is positive
    // settlement: the op closes and the task is released.
    await f.service.reconcile();
    const a = f.store.assignment(project.id, 2)!;
    expect(a.opState).toBe("done");
    expect(f.store.task(project.id, t2.num)!.status).toBe("planned");
    const [d3] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
    expect(d3.state).toBe("running");
    expect(d3.warnings ?? []).toEqual([]);
  });

  it("settles immediately when the queued row is positively deleted", async () => {
    const { f, project, worker, t2 } = await queuedFixture();
    f.queueSend("own-q");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.queued.set(worker.threadId!, [
      { id: "own-q", content: f.send.mock.calls.at(-1)![0].input },
    ]);
    await f.service.stopAssignment(project.id, "A2", "cancel queued");
    // The receipted row was positively deleted: receipt cleared, reservation
    // released, task back to planned.
    const a = f.store.assignment(project.id, 2)!;
    expect(a.state).toBe("cancelled");
    expect(a.queuedMessageId).toBeNull();
    expect(a.opState).toBe("done");
    expect(f.queued.get(worker.threadId!)).toHaveLength(0);
    expect(f.store.task(project.id, t2.num)!.status).toBe("planned");
    const [d3] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
    expect(d3.state).toBe("running");
  });
});

describe("terminal assignments never reopen on late reports", () => {
  it("keeps cancellation stable across an identical late report retry", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
    });
    await f.service.stopAssignment(project.id, d.assignment, "cancel");
    // The delivered turn really did stop; positive quiet settles the op.
    f.idle(d.threadId!);
    await f.service.report(d.threadId!, report());
    const retry = await f.service.report(d.threadId!, report());
    expect(retry.state).toBe("cancelled");
    expect(f.store.task(project.id, t.num)!.status).toBe("planned");
    expect(f.store.assignment(project.id, 1)!.stopReason).toMatch(/cancel/);
  });

  it("keeps fresh late-report evidence without reopening the terminal state", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
    });
    await f.service.stopAssignment(project.id, d.assignment, "cancel");
    // The delivered turn really did stop; positive quiet settles the op.
    f.idle(d.threadId!);
    await f.service.report(d.threadId!, report());
    const later = await f.service.report(d.threadId!, {
      ...report(),
      summary: "Second send of the same result",
    });
    const a = f.store.assignment(project.id, 1)!;
    expect(later.state).toBe("cancelled");
    expect(a.state).toBe("cancelled");
    expect(a.report?.summary).toBe("Second send of the same result");
    expect(a.stopReason).toMatch(/cancel/);
    expect(f.store.task(project.id, t.num)!.status).toBe("planned");
    // T136: closing is the coordinator's call; the cancelled report stays as filed.
    await f.service.closeTask(project.id, t.ref, "done");
    expect(f.store.assignment(project.id, 1)!.state).toBe("cancelled");
  });

  it("settles a cancelled uncertain dispatch when its report proves it ran", async () => {
    const { f, project, worker, t2 } = await queuedFixture();
    f.send.mockImplementationOnce(async () => {
      throw new Error("lost response");
    });
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    await f.service.stopAssignment(project.id, "A2", "cancel uncertain send");
    // The send did land and the worker reported: positive evidence.
    const r = await f.service.report(worker.threadId!, {
      ...report(),
      assignment: "A2",
    });
    const a = f.store.assignment(project.id, 2)!;
    expect(r.state).toBe("cancelled");
    expect(a.opState).toBe("done");
    expect(a.briefDelivered).toBe(true);
  });
});

describe("report routing follows the current native parent", () => {
  it("sends one direct notice when the worker's thread is no longer parented", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
    });
    // The stored nativeParent flag stays true; natively the thread is detached.
    f.threads.set(d.threadId!, {
      ...f.threads.get(d.threadId!)!,
      parentThreadId: null,
    });
    await f.service.report(d.threadId!, report());
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].threadId).toBe("coordinator");
  });

  it("still sends the report while the thread stays parented with turn notices (D417)", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
    });
    f.parentNotices(d.threadId!, "turns");
    await f.service.report(d.threadId!, report());
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].threadId).toBe("coordinator");
  });

  it("tells the current coordinator directly when the live parent is foreign", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
    });
    // The worker's live parent is another thread (e.g. a previous
    // coordinator): BB's own completion notice goes there, never reaching the
    // current coordinator — so one direct message must.
    f.threads.set(d.threadId!, {
      ...f.threads.get(d.threadId!)!,
      parentThreadId: "someone-else",
    });
    await f.service.report(d.threadId!, report());
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].threadId).toBe("coordinator");
  });
});

describe("reviewers are always fresh", () => {
  it("lets the reviewer re-review its batch but never implement or fork", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [implementation] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
    await f.service.report(implementation.threadId!, report());
    f.idle(implementation.threadId!);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      role: "review",
      reviewOf: [t.ref],
    });
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    // W190: the same reviewer may re-review its batch, read-only; it never implements.
    const [again] = await f.service.delegate(project.id, {
      route: "continue",
      role: "review",
      worker: d.worker,
      reviewOf: [t.ref],
    });
    expect(f.store.assignment(project.id, Number(again!.assignment.slice(1)))).toMatchObject({ role: "review", access: "read-only" });
    await expect(
      f.service.delegate(project.id, { route: "continue", role: "work", worker: d.worker, tasks: [t.ref] }),
    ).rejects.toThrow(/Reviewers never implement/);
    await expect(
      f.service.delegate(project.id, {
        route: "fork",
        role: "review",
        worker: d.worker,
        reviewOf: [t.ref],
        forkAtSeq: 1,
      } as never),
    ).rejects.toThrow(/fresh|Fork/);
  });

  it("still permits continuing a work worker", async () => {
    const { f, project, worker, t2 } = await queuedFixture();
    f.queueSend("own-q");
    const [d2] = await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    expect(d2.state).toBe("queued");
  });

  it("refuses to adopt an existing thread as a reviewer", async () => {
    const { f, project } = await projectFixture();
    f.threads.set(
      "loose",
      makeThreadResponse({ id: "loose", projectId: "proj_a" }),
    );
    await expect(
      f.service.adoptWorker(project.id, {
        threadId: "loose",
        role: "review",
        label: "Adopted reviewer",
      }),
    ).rejects.toThrow(/fresh/);
  });
});

describe("closed review scopes stay history", () => {
  it("keeps a reported review whose whole scope is decided out of acceptance", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [implementation] = await f.service.delegate(project.id, { route: "fresh", tasks: [t.ref] });
    await f.service.report(implementation.threadId!, report());
    f.idle(implementation.threadId!);
    f.store.updateAssignment(project.id, 1, { state: "accepted" });
    f.store.updateTask(project.id, t.num, {
      status: "done",
      result: "accepted implementation",
    });
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      role: "review",
      reviewOf: [t.ref],
    });
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    await f.service.retireWorker(project.id, d.worker, "old review completed");
    const o = await f.overview(project.id);
    expect(o.awaitingAcceptance).toHaveLength(0);
    expect(o.counts.awaitingAcceptance).toBe(0);
  });

  it("still counts a reported review while part of its scope is open", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const t2 = f.task(project.id, "Second task");
    const [implementation] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref, t2.ref] });
    await f.service.report(implementation.threadId!, report());
    f.idle(implementation.threadId!);
    f.store.updateAssignment(project.id, 1, { state: "accepted" });
    f.store.updateTask(project.id, t1.num, {
      status: "done",
      result: "accepted implementation",
    });
    f.store.updateTask(project.id, t2.num, { status: "in_progress" });
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      role: "review",
      reviewOf: [t1.ref, t2.ref],
    });
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    const o = await f.overview(project.id);
    expect(o.awaitingAcceptance).toHaveLength(1);
    expect(o.awaitingAcceptance[0]!.role).toBe("review");
  });
});

describe("handover carries a durable environment override", () => {
  it("accepts an environment on coordinator-handover", async () => {
    const { commandSchema } = await import("../lib/commands");
    expect(
      commandSchema.safeParse({
        action: "coordinator-handover",
        checkpoint: "continue here",
        environment: { type: "reuse", environmentId: "env_kdfdhsjp6x" },
      }).success,
    ).toBe(true);
  });

  it("drains onto the requested environment while preserving incumbent execution settings", async () => {
    const { f, project } = await projectFixture();
    // The requested environment is the project's default checkout — the only
    // reuse a coordinator replacement accepts.
    f.envs.set("env_kdfdhsjp6x", {
      id: "env_kdfdhsjp6x",
      projectId: "proj_a",
      path: "/code/repo",
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.envs.set("env_pepnyn24rr", {
      id: "env_pepnyn24rr",
      projectId: "proj_a",
      path: "/code/repo",
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.threads.set("coordinator", {
      ...f.threads.get("coordinator")!,
      providerId: "codex",
      environmentId: "env_pepnyn24rr",
    });
    f.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6-astra",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      serviceTier: "fast",
    }));
    f.service.requestHandover(
      project.id,
      {
        checkpoint: "fresh context",
        environment: { type: "reuse", environmentId: "env_kdfdhsjp6x" },
      },
      "coordinator",
    );
    expect(f.store.handover(project.id)!.environment).toEqual({
      type: "reuse",
      environmentId: "env_kdfdhsjp6x",
    });
    await f.service.drainHandover(project.id);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      serviceTier: "fast",
      environment: { type: "reuse", environmentId: "env_kdfdhsjp6x" },
    });
  });

  it("keeps the incumbent's environment when no override is requested", async () => {
    const { f, project } = await projectFixture();
    // The incumbent already runs on the default checkout, so the drain reuses
    // that environment rather than degrading to project-default.
    f.envs.set("env_pepnyn24rr", {
      id: "env_pepnyn24rr",
      projectId: "proj_a",
      path: "/code/repo",
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.threads.set("coordinator", {
      ...f.threads.get("coordinator")!,
      providerId: "codex",
      environmentId: "env_pepnyn24rr",
    });
    f.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6-astra",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      serviceTier: "fast",
    }));
    f.service.requestHandover(
      project.id,
      { checkpoint: "fresh context" },
      "coordinator",
    );
    await f.service.drainHandover(project.id);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      serviceTier: "fast",
      environment: { type: "reuse", environmentId: "env_pepnyn24rr" },
    });
  });
});
