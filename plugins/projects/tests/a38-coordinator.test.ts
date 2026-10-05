import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { delegateSchema } from "../lib/commands";
import { projectFixture, report } from "./fake-native";

describe("A38 user-initiated coordinator replacement", () => {
  it("queues a durable handover while the incumbent is still working", async () => {
    const { f, project } = await projectFixture();
    // A busy incumbent must never take the direct swap path: the request
    // lands in the journaled handover and waits for its natural quiescence.
    f.threads.set("coordinator", {
      ...f.threads.get("coordinator")!,
      status: "active",
    });
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Try a different model",
    });
    expect("state" in result ? result.state : null).toBe("pending");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.handover(project.id)?.reason).toBe(
      "Try a different model",
    );
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(
      "coordinator",
    );
  });

  it("replaces directly when the incumbent is idle, moving its children before archiving it", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
    });
    const workerThread = d.threadId!;
    f.idle("coordinator");
    const order: string[] = [];
    f.update.mockImplementation(async (args: any) => {
      order.push(`update:${args.threadId}`);
      const t0 = f.threads.get(args.threadId)!;
      const { threadId, ...patch } = args;
      f.threads.set(threadId, { ...t0, ...patch });
      return f.threads.get(threadId);
    });
    f.archive.mockImplementation(async (args: any) => {
      order.push(`archive:${args.threadId}`);
      const t0 = f.threads.get(args.threadId)!;
      f.threads.set(args.threadId, { ...t0, archivedAt: Date.now() });
      return f.threads.get(args.threadId);
    });
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    const successor = result.threadId;
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
    // The worker moved to the successor before the predecessor archived.
    expect(order).toEqual([
      `update:${workerThread}`,
      "archive:coordinator",
    ]);
    expect(f.threads.get(workerThread)!.parentThreadId).toBe(successor);
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
    expect(
      f.store.workers(project.id).find((w) => w.threadId === workerThread)!
        .nativeParent,
    ).toBe(true);
    // The handover never got involved: no durable row for a direct swap.
    expect(f.store.handover(project.id)).toBeNull();
  });

  it("keeps children another initiative owns attached and the predecessor live", async () => {
    const { f, project } = await projectFixture();
    // A child that belongs to a different initiative is never detached just
    // to let the archive pass: it stays attached and the predecessor stays
    // live, holding the boundary honestly.
    f.threads.set(
      "other-coordinator",
      makeThreadResponse({
        id: "other-coordinator",
        projectId: "proj_a",
        // Strict home proof requires the adopted coordinator's environment;
        // env_a is proj_a's proven default checkout.
        environmentId: "env_a",
      }),
    );
    const { project: other } = await f.service.createProject({
      name: "Other",
      objective: "Different initiative",
      memberProjectIds: ["proj_a"],
      coordinator: { kind: "adopt", threadId: "other-coordinator" },
    });
    f.threads.set(
      "foreign-child",
      makeThreadResponse({
        id: "foreign-child",
        projectId: "proj_a",
        parentThreadId: "coordinator",
      }),
    );
    f.store.associateProjectThread({
      projectId: other.id,
      opId: "op_foreign",
      threadId: "foreign-child",
      label: "Foreign thread",
      bbProjectId: "proj_a",
    });
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    // A thread another initiative owns is never detached just to let the
    // archive pass: it stays attached and the predecessor stays live.
    expect(f.threads.get("foreign-child")!.parentThreadId).toBe("coordinator");
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    // The hold survives further convergence — the foreign child keeps the
    // predecessor live and visible until its own initiative moves it.
    await f.service.convergeFormerCoordinators(project.id);
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    // The association to the other initiative survives.
    expect(
      f.store.membership("foreign-child", true)?.project.id,
    ).toBe(other.id);
  });

  it("attaches an adopted worker with no native parent under the successor", async () => {
    const { f, project } = await projectFixture();
    f.threads.set(
      "adopted",
      makeThreadResponse({ id: "adopted", projectId: "proj_a" }),
    );
    await f.service.adoptWorker(project.id, {
      threadId: "adopted",
      role: "work",
      label: "adopted helper",
      detachNativeParent: true,
    });
    // The caller asked to keep it detached — adoption leaves it unparented
    // and the flag stays false until the coordinator switch attaches it.
    expect(f.store.workers(project.id)[0]!.nativeParent).toBe(false);
    expect(f.threads.get("adopted")!.parentThreadId).toBeNull();
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    // A logical worker's home is the coordinator thread — the transfer
    // covers it even though the predecessor never parented it.
    expect(f.threads.get("adopted")!.parentThreadId).toBe(result.threadId);
    expect(f.store.workers(project.id)[0]!.nativeParent).toBe(true);
  });

  it("transfers a user-owned child to the successor, claimed and still adhoc", async () => {
    const { f, project } = await projectFixture();
    const own = await f.spawn({
      projectId: "proj_a",
      parentThreadId: "coordinator",
    });
    f.threads.set(own.id, { ...own, title: "User's own thread" });
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    // Every current member root moves to the new coordinator — including the
    // user's own conversations — before the predecessor can archive.
    expect(f.threads.get(own.id)!.parentThreadId).toBe(result.threadId);
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
    // Ownership is unchanged: an ordinary project-thread row, never a worker.
    const membership = f.store.membership(own.id, true);
    expect(membership?.kind).toBe("adhoc");
    expect(membership?.project.id).toBe(project.id);
    expect(f.store.workers(project.id)).toHaveLength(0);
    expect(f.store.assignments(project.id)).toHaveLength(0);
    expect(
      f.store.projectThreads(project.id).some((r) => r.threadId === own.id),
    ).toBe(true);
  });

  it("moves member roots without flattening a nested user subtree", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Worker with a side thread",
    });
    const workerThread = d.threadId!;
    // A user conversation nested under the worker is claimed as a nested
    // member — a deliberate arrangement the transfer must not flatten.
    const nested = await f.spawn({
      projectId: "proj_a",
      parentThreadId: workerThread,
    });
    expect(f.service.associateNativeChild(f.threads.get(nested.id)!)).toBe(
      true,
    );
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    // Roots move; subtrees ride along.
    expect(f.threads.get(workerThread)!.parentThreadId).toBe(result.threadId);
    expect(f.threads.get(nested.id)!.parentThreadId).toBe(workerThread);
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
  });

  it("keeps the predecessor live until every child transfer is positively confirmed, then converges", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
    });
    const workerThread = d.threadId!;
    f.idle("coordinator");
    // The first transfer attempt fails; the second converges via the sweep
    // path the same function backs.
    let fail = true;
    f.update.mockImplementation(async (args: any) => {
      if (fail) throw new Error("BB refused the parent update");
      const t0 = f.threads.get(args.threadId)!;
      const { threadId, ...patch } = args;
      f.threads.set(threadId, { ...t0, ...patch });
      return f.threads.get(threadId);
    });
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    const successor = result.threadId;
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(successor);
    // The switch is durable but the predecessor stays live and visible:
    // archiving it would orphan the unmoved child.
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    expect(f.threads.get(workerThread)!.parentThreadId).toBe("coordinator");
    fail = false;
    await f.service.convergeFormerCoordinators(project.id);
    expect(f.threads.get(workerThread)!.parentThreadId).toBe(successor);
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
  });
});

describe("A38 coordinator home validation", () => {
  it("refuses a worktree checkout as the coordinator's environment", async () => {
    const { f, project } = await projectFixture();
    f.envs.set("env_wt", {
      id: "env_wt",
      projectId: "proj_a",
      path: "/code/repo-wt",
      hostId: "host_a",
      name: null,
      isWorktree: true,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.idle("coordinator");
    await expect(
      f.service.replaceCoordinator(project.id, {
        reason: "Move to a worktree",
        environment: { type: "reuse", environmentId: "env_wt" },
      }),
    ).rejects.toThrow(/worktree/);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(
      "coordinator",
    );
  });

  it("refuses a checkout that belongs to a different BB project", async () => {
    const { f, project } = await projectFixture();
    f.envs.set("env_other", {
      id: "env_other",
      projectId: "proj_elsewhere",
      path: "/code/other",
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.idle("coordinator");
    await expect(
      f.service.replaceCoordinator(project.id, {
        reason: "Wrong checkout",
        environment: { type: "reuse", environmentId: "env_other" },
      }),
    ).rejects.toThrow(/belongs to/);
  });

  it("refuses a coordinator environment that is not ready", async () => {
    const { f, project } = await projectFixture();
    f.envs.set("env_down", {
      id: "env_down",
      projectId: "proj_a",
      path: "/code/down",
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "provisioning",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.idle("coordinator");
    await expect(
      f.service.replaceCoordinator(project.id, {
        reason: "Not ready",
        environment: { type: "reuse", environmentId: "env_down" },
      }),
    ).rejects.toThrow(/not ready/);
  });
});

describe("A38 named workers", () => {
  it("requires a logical label and purpose for a fresh delegate", () => {
    expect(() =>
      delegateSchema.parse({ action: "delegate", route: "fresh" }),
    ).toThrow(/label/);
    expect(() =>
      delegateSchema.parse({
        action: "delegate",
        route: "fresh",
        label: "Search implementation",
      }),
    ).toThrow(/purpose/);
    expect(
      delegateSchema.parse({
        action: "delegate",
        route: "fresh",
        label: "Search implementation",
        area: "search pipeline",
      }).label,
    ).toBe("Search implementation");
    // Continue and fork reuse identity: no label requirement there.
    expect(() =>
      delegateSchema.parse({
        action: "delegate",
        route: "continue",
        worker: "W1",
      }),
    ).not.toThrow();
    expect(() =>
      delegateSchema.parse({
        action: "delegate",
        route: "fork",
        worker: "W1",
      }),
    ).not.toThrow();
  });

  it("titles a fresh worker's native thread with its W# identity and purpose", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
    });
    const spawned = f.spawn.mock.calls.at(-1)![0];
    const worker = f.store.workers(project.id)[0]!;
    expect(worker.ref).toBe("W1");
    expect(worker.label).toBe("Search implementation");
    expect(worker.area).toBe("search pipeline");
    expect(spawned.title).toBe(
      "W1 Search implementation — search pipeline",
    );
    expect(spawned.parentThreadId).toBe("coordinator");
    expect(worker.nativeParent).toBe(true);
    expect(d.threadId).toBeTruthy();
  });

  it("names a delegated worktree's environment after the worker's identity", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
      environment: { type: "worktree" },
    });
    const spawned = f.spawn.mock.calls.at(-1)![0];
    // BB names managed worktree branches itself; the supported surface is
    // the environment display name.
    expect(spawned.environment.workspace.type).toBe("managed-worktree");
    const created = [...f.threads.values()].at(-1)!;
    const envId = created.environmentId!;
    expect(f.envUpdate).toHaveBeenCalledWith({
      environmentId: envId,
      name: "W1 Search implementation",
    });
    expect(f.envs.get(envId)?.name).toBe("W1 Search implementation");
  });

  it("forks under the same logical identity and reparents the fork to the coordinator", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d1] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
    });
    const source = f.store.workers(project.id)[0]!;
    // The fork takes a different task — the first one already has a running
    // assignment on the source worker.
    const t2 = f.task(project.id, "Second task");
    const [d2] = await f.service.delegate(project.id, {
      route: "fork",
      worker: source.ref,
      tasks: [t2.ref],
      forkAtSeq: 1,
    });
    const forked = f.store
      .workers(project.id)
      .find((w) => w.num !== source.num)!;
    // A fork is a new generation of the same worker? No: fork creates a new
    // worker record derived from the source — but the identity (label/area)
    // is inherited, never re-derived.
    expect(forked.label).toBe("Search implementation");
    expect(forked.area).toBe("search pipeline");
    expect(forked.forkedFrom).toBe(source.num);
    expect(f.fork).toHaveBeenCalledTimes(1);
    expect(f.fork.mock.calls[0][0].sourceThreadId).toBe(source.threadId);
    // The fork's native title leads with its own W# and carries the
    // inherited label plus purpose — not the source's stale title.
    expect(f.fork.mock.calls[0][0].title).toBe(
      `${forked.ref} Search implementation — search pipeline`,
    );
    // Native fork carries no parent argument; the plugin reparents after
    // the create is confirmed.
    const forkThread = f.threads.get(d2.threadId!)!;
    expect(forkThread.parentThreadId).toBe("coordinator");
    expect(forked.nativeParent).toBe(true);
  });

  it("passes an explicit permission mode through to the native spawn", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
      permissionMode: "full",
    });
    expect(f.spawn.mock.calls.at(-1)![0].permissionMode).toBe("full");
  });

  it("applies an explicit rename on continue to the record, title and brief", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
    });
    await f.service.report(d.threadId!, report());
    await f.service.acceptTask(project.id, t.ref, {});
    f.idle(d.threadId!);
    const t2 = f.task(project.id, "Second task");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: "W1",
      tasks: [t2.ref],
      label: "Search hardening",
      area: "index pipeline",
    });
    const renamed = f.store.workers(project.id)[0]!;
    expect(renamed.label).toBe("Search hardening");
    expect(renamed.area).toBe("index pipeline");
    // The native title tracks the logical identity so the sidebar stays
    // consistent even where it renders raw titles.
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: d.threadId,
        title: "W1 Search hardening — index pipeline",
      }),
    );
    expect(f.send.mock.calls.at(-1)![0].input[0].text).toMatch(
      /W1 Search hardening/,
    );
  });

  it("commits a staged continue rename only when the queued brief dispatches", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Old label",
      area: "old purpose",
    });
    await f.service.report(d.threadId!, report());
    await f.service.acceptTask(project.id, t.ref, {});
    f.idle(d.threadId!);
    const t2 = f.task(project.id, "Second task");
    f.queueSend("q-rename");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: "W1",
      tasks: [t2.ref],
      label: "New label",
      area: "new purpose",
    });
    // Queued is not delivered: the ledger keeps the old identity even though
    // the brief and native title already name the staged one.
    expect(f.store.worker(project.id, 1)).toMatchObject({
      label: "Old label",
      area: "old purpose",
    });
    expect(f.threads.get(d.threadId!)!.title).toMatch(/New label/);
    f.runtime.onMessageDispatched("q-rename");
    expect(f.store.worker(project.id, 1)).toMatchObject({
      label: "New label",
      area: "new purpose",
    });
  });

  it("keeps delivery evidence and commits the rename when the native title update fails", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Old label",
      area: "old purpose",
    });
    await f.service.report(d.threadId!, report());
    await f.service.acceptTask(project.id, t.ref, {});
    f.idle(d.threadId!);
    const t2 = f.task(project.id, "Second task");
    // BB refuses the cosmetic title update; the brief send itself lands.
    f.update.mockRejectedValueOnce(new Error("title refused"));
    await f.service.delegate(project.id, {
      route: "continue",
      worker: "W1",
      tasks: [t2.ref],
      label: "New label",
      area: "new purpose",
    });
    const a = f.store.assignments(project.id).at(-1)!;
    expect(a.briefDelivered).toBe(true);
    expect(a.pendingIdentity).toBeNull();
    expect(f.store.worker(project.id, 1)).toMatchObject({
      label: "New label",
      area: "new purpose",
    });
  });
});

describe("A46 coordinator transfer corrections", () => {
  it("never moves a worker back to a coordinator a race already superseded", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
      label: "Search implementation",
      area: "search pipeline",
    });
    const workerThread = d.threadId!;
    f.idle("coordinator");
    // First switch: the transfer attempt is refused, the worker stays under
    // the first coordinator, which stays live.
    let fail = true;
    f.update.mockImplementation(async (args: any) => {
      if (fail) throw new Error("BB refused the parent update");
      const t0 = f.threads.get(args.threadId)!;
      const { threadId, ...patch } = args;
      f.threads.set(threadId, { ...t0, ...patch });
      return f.threads.get(threadId);
    });
    const first = await f.service.replaceCoordinator(project.id, {
      reason: "First swap",
    });
    if (!("threadId" in first)) throw new Error("expected a direct swap");
    const middle = first.threadId;
    expect(f.threads.get(workerThread)!.parentThreadId).toBe("coordinator");
    fail = false;
    // A convergence pass starts against `middle`. Its worker reparent hangs
    // long enough for a second user switch to make `middle` a former
    // coordinator too — the stale pass's confirmed receipt must not be the
    // last word.
    let started!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.update.mockImplementation(async (args: any) => {
      if (args.threadId === workerThread && args.parentThreadId === middle) {
        started();
        await hold;
      }
      const t0 = f.threads.get(args.threadId)!;
      const { threadId, ...patch } = args;
      f.threads.set(threadId, { ...t0, ...patch });
      return f.threads.get(threadId);
    });
    const stale = f.service.convergeFormerCoordinators(project.id);
    await gate;
    f.idle(middle);
    // The held reparent registers under `middle`, so its archive now waits
    // on this op — awaiting the swap before releasing would deadlock.
    const secondPromise = f.service.replaceCoordinator(project.id, {
      reason: "Second swap",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const second = await secondPromise;
    if (!("threadId" in second)) throw new Error("expected a direct swap");
    const newest = second.threadId;
    await stale;
    // The second switch's own pass moved the worker under `newest`; the
    // stale pass then re-receipted it there. It must never land back on the
    // superseded `middle`.
    expect(f.threads.get(workerThread)!.parentThreadId).toBe(newest);
  });

  it("keeps the predecessor live while a parentless worker's attach is unproven", async () => {
    const { f, project } = await projectFixture();
    f.threads.set(
      "adopted",
      makeThreadResponse({ id: "adopted", projectId: "proj_a" }),
    );
    // The adoption-time attach is refused: the worker joins parentless.
    f.update.mockImplementationOnce(async () => {
      throw new Error("BB refused the parent update");
    });
    await f.service.adoptWorker(project.id, {
      threadId: "adopted",
      role: "work",
      label: "adopted helper",
    });
    expect(f.threads.get("adopted")!.parentThreadId).toBeNull();
    f.idle("coordinator");
    // The predecessor has no native children at all — an empty child list
    // alone must never be taken as a completed transfer while a current
    // worker's attach is unproven.
    f.update.mockImplementation(async (args: any) => {
      if (args.threadId === "adopted")
        throw new Error("BB refused the parent update");
      const t0 = f.threads.get(args.threadId)!;
      const { threadId, ...patch } = args;
      f.threads.set(threadId, { ...t0, ...patch });
      return f.threads.get(threadId);
    });
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    expect(f.threads.get("adopted")!.parentThreadId).toBeNull();
    expect(f.threads.get("coordinator")!.archivedAt).toBeNull();
    expect(f.store.workers(project.id)[0]!.nativeParent).toBe(false);
  });

  it("rejects a same-project checkout that is not the default source path", async () => {
    const { f, project } = await projectFixture();
    // Same BB project, same host, ready and non-worktree — but a different
    // checkout than the default source's. An arbitrary ready checkout is not
    // a coordinator home.
    f.envs.set("env_other_checkout", {
      id: "env_other_checkout",
      projectId: "proj_a",
      path: "/code/other-checkout",
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    });
    f.idle("coordinator");
    await expect(
      f.service.replaceCoordinator(project.id, {
        reason: "Wrong checkout",
        environment: { type: "reuse", environmentId: "env_other_checkout" },
      }),
    ).rejects.toThrow(/default checkout/);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe(
      "coordinator",
    );
  });

  it("preserves the incumbent's effective execution on a direct swap", async () => {
    const { f, project } = await projectFixture();
    f.threads.set("coordinator", {
      ...f.threads.get("coordinator")!,
      providerId: "codex",
    });
    f.execution.set("coordinator", {
      model: "gpt-6.1-sol",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      serviceTier: "fast",
    });
    f.idle("coordinator");
    const result = await f.service.replaceCoordinator(project.id, {
      reason: "Idle swap",
    });
    if (!("threadId" in result)) throw new Error("expected a direct swap");
    expect(f.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        model: "gpt-6.1-sol",
        reasoningLevel: "xhigh",
        permissionMode: "full",
        serviceTier: "fast",
      }),
    );
  });
});
