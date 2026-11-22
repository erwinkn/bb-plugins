import { describe, expect, it, vi } from "vitest";
import { projectFixture, report } from "./fake-native";

const start = (f: Awaited<ReturnType<typeof projectFixture>>["f"], projectId: string) =>
  f.store.db.prepare("SELECT state FROM coordinator_starts WHERE project_id=?").get(projectId) as { state: string } | undefined;

describe("W621 archiving an Initiative", () => {
  it("archives however many assignments sit reported, stopped, failed or cancelled", async () => {
    const { f, project } = await projectFixture();
    const states = ["reported", "stopped", "failed", "cancelled"] as const;
    for (const state of states) {
      await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
      const a = f.store.assignments(project.id).at(-1)!;
      f.store.updateAssignment(project.id, a.num, { state });
    }
    expect(f.store.assignments(project.id).map((a) => a.state)).toEqual([...states]);
    const archived = await f.service.archiveProject(project.id);
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.stopped).toEqual([]);
    expect(f.store.assignments(project.id).map((a) => a.state)).toEqual([...states]);
  });

  // W636: live work never blocks archiving; archiving stops it.
  it("stops running work, then archives", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const a = f.store.assignments(project.id)[0]!;
    f.store.updateAssignment(project.id, a.num, { state: "running" });
    const archived = await f.service.archiveProject(project.id);
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.stopped).toEqual([`${a.ref} stopped`]);
    expect(f.store.assignment(project.id, a.num)!.state).toBe("cancelled");
    expect(f.stop).toHaveBeenCalledWith({ threadId: a.threadId });
    expect(f.store.project(project.id)!.archivedAt).not.toBeNull();
  });

  it("archives when a Stop throws, cancelling the work it left open", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const a = f.store.assignments(project.id)[0]!;
    f.store.updateAssignment(project.id, a.num, { state: "running" });
    // A Stop that fails outside its own error handling leaves the work open.
    const stopWork = f.service.stopWork.bind(f.service);
    f.service.stopWork = async () => { throw new Error("host unreachable"); };
    try {
      const archived = await f.service.archiveProject(project.id);
      expect(archived.archivedAt).toEqual(expect.any(Number));
      expect(archived.stopped).toEqual([`${a.ref}: host unreachable`, `${a.ref} cancelled; its thread was not stopped`]);
    } finally {
      f.service.stopWork = stopWork;
    }
    const after = f.store.assignment(project.id, a.num)!;
    expect(after.state).toBe("cancelled");
    expect(after.stopReason).toBe("Stopped: the Initiative was archived");
  });

  it("withdraws a pending handover and closes an unconfirmed coordinator start", async () => {
    for (const state of ["pending", "uncertain"]) {
      const { f, project } = await projectFixture();
      f.service.requestHandover(project.id, { reason: "fresh context" }, "user");
      expect(f.store.pendingHandover(project.id)).not.toBeNull();
      f.store.db
        .prepare("INSERT OR REPLACE INTO coordinator_starts (project_id, op_id, state, thread_id, reason, created_at) VALUES (?, ?, ?, NULL, 'test', ?)")
        .run(project.id, `op_${state}`, state, Date.now());
      const archived = await f.service.archiveProject(project.id);
      expect(archived.archivedAt).toEqual(expect.any(Number));
      expect(f.store.pendingHandover(project.id)).toBeNull();
      expect(start(f, project.id)!.state).toBe("failed");
      // The sweep no longer looks for an archived Initiative's coordinator receipt.
      expect(await f.service.reconcile()).toEqual([]);
      expect(start(f, project.id)!.state).toBe("failed");
    }
  });

  // Review r2 asked to skip archived Initiatives in every sweep. The sweep is what finishes
  // archive's cancel: a brief still sitting in a native queue would otherwise run later.
  it("keeps sweeping a cancelled brief out of the native queue after archive", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(d.threadId!, report());
    await f.service.setTaskStatus(project.id, t1.ref, "done", "Closed as done.", "the user");
    f.idle(d.threadId!);
    const worker = f.store.workers(project.id)[0]!;
    f.queueSend("q");
    await f.service.delegate(project.id, { route: "continue", worker: worker.ref, tasks: [f.task(project.id, "Next").ref] });
    f.queued.set(worker.threadId!, [{ id: "q", content: f.send.mock.calls.at(-1)![0].input }]);
    // The delete archive's cancel attempts fails: the brief stays queued.
    f.harness.sdk.stub("threads.queuedMessages.delete", async () => { throw new Error("offline"); });
    await f.service.archiveProject(project.id);
    expect(f.store.assignment(project.id, 2)!.state).toBe("cancelled");
    expect(f.queued.get(worker.threadId!)).toHaveLength(1);
    f.harness.sdk.stub("threads.queuedMessages.delete", async ({ threadId, queuedMessageId }: any) => {
      f.queued.set(threadId, f.queued.get(threadId)!.filter((row) => row.id !== queuedMessageId));
    });
    await f.service.reconcile();
    expect(f.queued.get(worker.threadId!)).toEqual([]);
  });

  // Review r3: a sweep already past its query and a spawn still in flight must not reopen an
  // archive-closed start or install a coordinator on the archived Initiative.
  it("never confirms a coordinator once archive closed its start", async () => {
    const { f, project } = await projectFixture();
    const before = f.store.project(project.id)!.coordinatorThreadId;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const spawned = f.spawn.getMockImplementation()!;
    f.spawn.mockImplementationOnce(async (args) => {
      await spawned(args); // The thread exists in BB, carrying this start's receipt.
      await released;
      throw new Error("connection reset"); // Not a definite rejection: the outcome is uncertain.
    });
    const replacing = f.service.replaceCoordinator(project.id, { reason: "Fresh context" }).catch((error: Error) => error);
    await vi.waitFor(() => expect(start(f, project.id)?.state).toBe("pending"));
    // The sweep reads the open start, then pauses while proving the receipt's checkout.
    const service = f.service as any;
    const prove = service.coordinatorReceiptHomeProblem.bind(service);
    let entered!: () => void;
    const proving = new Promise<void>((resolve) => (entered = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    service.coordinatorReceiptHomeProblem = async (...args: unknown[]) => {
      entered();
      await resumed;
      return prove(...args);
    };
    const sweeping = f.service.reconcile();
    await proving;
    await f.service.archiveProject(project.id);
    expect(start(f, project.id)!.state).toBe("failed");
    release();
    expect(await replacing).toBeInstanceOf(Error);
    expect(start(f, project.id)!.state).toBe("failed");
    resume();
    expect(await sweeping).toEqual([]);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(before);
    expect(start(f, project.id)!.state).toBe("failed");
  });

  it("confirms no coordinator receipt for an archived Initiative", async () => {
    const { f, project } = await projectFixture();
    const before = f.store.project(project.id)!;
    await f.service.archiveProject(project.id);
    f.store.db
      .prepare("INSERT OR REPLACE INTO coordinator_starts (project_id, op_id, state, thread_id, reason, created_at) VALUES (?, 'op_late', 'uncertain', NULL, 'test', ?)")
      .run(project.id, Date.now());
    expect(f.store.confirmCoordinatorReceipt(project.id, "op_late", "late", before.memberProjectIds[0]!, "late")).toBe("superseded");
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(before.coordinatorThreadId);
  });

  it("refuses a second archive", async () => {
    const { f, project } = await projectFixture();
    await f.service.archiveProject(project.id);
    await expect(f.service.archiveProject(project.id)).rejects.toThrow(/Unknown Initiative/);
  });
});
