import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { brief } from "./helpers";
import { report, fixture, projectFixture } from "./fake-native";
import { buildOverview } from "../lib/overview";
import { DEFAULT_PROFILES } from "../lib/schema";
import { ProjectsService } from "../lib/service";
import { Store } from "../lib/store";
import { commandSchema } from "../lib/commands";
import type { ThreadDto } from "../lib/bb";

describe("projects and delegation", () => {
  it("adopts a coordinator and spawns fresh workers as native children", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [result] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    expect(result.state).toBe("running");
    const spawned = f.spawn.mock.calls.at(-1)![0];
    expect(spawned.parentThreadId).toBe("coordinator");
    expect(spawned.pluginMetadata.role).toBe("worker");
    const worker = f.store.workers(project.id)[0]!;
    expect(worker.nativeParent).toBe(true);
    expect(worker.threadId).toBe(result.threadId);
    expect(f.store.task(project.id, t1.num)!.status).toBe("in_progress");
  });

  it("pausing gates new delegation but never touches running work", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    f.service.setPaused(project.id, true);
    await expect(
      f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] }),
    ).rejects.toThrow(/paused/);
    f.service.setPaused(project.id, false);
    await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    expect(f.spawn).toHaveBeenCalled();
  });

  it("keeps a report on a cancelled assignment without reopening it", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const assignment = f.store.assignmentByOp(
      f.spawn.mock.calls.at(-1)![0].pluginMetadata.op,
    )!;
    await f.service.stopAssignment(project.id, assignment.ref, "cancel it");
    const late = await f.service.report(d.threadId!, report());
    expect(late.state).toBe("cancelled");
    const after = f.store.assignment(project.id, assignment.num)!;
    expect(after.state).toBe("cancelled");
    expect(after.report?.outcome).toBe("succeeded");
  });
});

describe("native queueing", () => {
  it("continues a worker through BB's queue and follows the dispatch receipt", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const worker = f.store.workers(project.id)[0]!;
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    const t2 = f.task(project.id, "Follow-up");
    f.queueSend("qm-9");
    const [d2] = await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    expect(d2.state).toBe("queued");
    const sent = f.send.mock.calls.at(-1)![0];
    expect(sent.mode).toBe("queue-if-active");
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.queuedMessageId).toBe("qm-9");
    // BB dispatched it: the ledger follows the native event.
    f.runtime.onMessageDispatched("qm-9");
    expect(f.store.assignment(project.id, 2)!.state).toBe("running");
  });

  it("cancels an assignment whose queued brief the user removed", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const worker = f.store.workers(project.id)[0]!;
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    const t2 = f.task(project.id, "Queued work");
    f.queueSend("qm-1");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    f.runtime.onMessageCancelled("qm-1");
    const a2 = f.store.assignment(project.id, 2)!;
    expect(a2.state).toBe("cancelled");
    expect(f.store.task(project.id, t2.num)!.status).toBe("planned");
  });

  it("deletes its own queued brief on stop and never touches foreign rows", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const worker = f.store.workers(project.id)[0]!;
    await f.service.report(d.threadId!, report());
    f.idle(d.threadId!);
    const t2 = f.task(project.id, "Queued work");
    f.queueSend("qm-own");
    await f.service.delegate(project.id, {
      route: "continue",
      worker: worker.ref,
      tasks: [t2.ref],
    });
    // A foreign queued row on the same thread: not ours, never removed.
    f.queued.set(worker.threadId!, [
      { id: "qm-own", content: [{ type: "text", text: "brief" }] },
      { id: "qm-foreign", content: [{ type: "text", text: "user typed" }] },
    ]);
    await f.service.stopAssignment(project.id, "A2", "stop it");
    expect((f.queued.get(worker.threadId!) ?? []).map((r) => r.id)).toEqual([
      "qm-foreign",
    ]);
    expect(f.store.assignment(project.id, 2)!.state).toBe("cancelled");
  });
});

describe("uncertain operations", () => {
  it("marks a lost create response uncertain and reconciles it by receipt", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    // Spawn works in BB but the response is lost on the wire: simulate by
    // throwing after spawning manually.
    f.spawn.mockImplementationOnce(async (args: Record<string, any>) => {
      const id = "native-lost";
      const t = makeThreadResponse({
        id,
        projectId: args.projectId,
        createdAt: Date.now(),
        status: "active",
        originPluginId: "initiatives",
      });
      f.threads.set(id, t);
      f.metadata.set(id, args.pluginMetadata ?? {});
      throw Object.assign(new Error("connection reset"), { status: 0 });
    });
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    expect(d.state).toBe("dispatching");
    const a = f.store.assignments(project.id)[0]!;
    expect(a.opState).toBe("uncertain");
    // Reconcile finds the native thread by its plugin metadata op receipt.
    const settled = await f.service.reconcile();
    expect(settled).toEqual([`${a.ref}: running`]);
    const after = f.store.assignment(project.id, a.num)!;
    expect(after.opState).toBe("done");
    expect(after.threadId).toBe("native-lost");
    expect(f.store.workers(project.id)[0]!.threadId).toBe("native-lost");
  });

  it("keeps an unconfirmed delegation visible and blocks its worker", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    f.spawn.mockRejectedValueOnce(
      Object.assign(new Error("gateway timeout"), { status: 502 }),
    );
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const worker = f.store.workers(project.id)[0]!;
    expect(d.note).toMatch(/did not confirm/);
    // Not silently discarded: it stays in the unconfirmed list.
    const o = buildOverview(f.store, project.id, new Map(), f.store.now());
    expect(o.unconfirmed.map((u) => u.assignment)).toEqual(["A1"]);
    await expect(
      f.service.delegate(project.id, {
        route: "continue",
        worker: worker.ref,
        tasks: [t1.ref],
      }),
    ).rejects.toThrow(/unconfirmed operation/);
    // Explicit settlement after inspection.
    const settled = await f.service.settleUncertain(project.id, "A1", {
      notSent: true,
    });
    expect(settled.state).toBe("failed");
    expect(f.store.task(project.id, t1.num)!.status).toBe("planned");
  });
});

describe("reports and acceptance", () => {
  it("records a report, holds tasks for acceptance, and skips a notify for native children", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    await f.service.report(d.threadId!, report());
    const a = f.store.assignments(project.id)[0]!;
    expect(a.state).toBe("reported");
    expect(f.store.task(project.id, t1.num)!.status).toBe(
      "awaiting_acceptance",
    );
    // Native parenting already delivers the notice; no plugin copy is sent.
    expect(f.send).not.toHaveBeenCalled();
  });

  it("sends one direct coordinator note for an unparented worker", async () => {
    const { f, project } = await projectFixture();
    f.threads.set(
      "foreign-worker",
      makeThreadResponse({
        id: "foreign-worker",
        projectId: "proj_a",
        parentThreadId: null,
      }),
    );
    const adopted = await f.service.adoptWorker(project.id, {
      threadId: "foreign-worker",
      role: "work",
      label: "Search",
      tasks: [f.task(project.id).ref],
      // Kept detached at the caller's request: its report notice must reach
      // the coordinator through Projects because BB's own parent notice
      // does not exist.
      detachNativeParent: true,
    });
    expect(adopted.worker.nativeParent).toBe(false);
    await f.service.report("foreign-worker", report());
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![0].threadId).toBe("coordinator");
  });

  it("accepts verified work and leaves retirement to an explicit action", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    await f.service.report(d.threadId!, report());
    const result = await f.service.acceptTask(project.id, t1.ref, {});
    expect(result.task.status).toBe("done");
    expect(result.workerNote).toMatch(/Retire W1/);
    expect(
      f.store.assignments(project.id)[0]!.state,
    ).toBe("accepted");
    // No automatic archive: the worker's thread stays live until the
    // coordinator explicitly retires it after confirming idle.
    expect(f.archive).not.toHaveBeenCalled();
  });
});

describe("explicit retirement", () => {
  async function retiredReady() {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    await f.service.report(d.threadId!, report());
    await f.service.acceptTask(project.id, t1.ref, {});
    return { f, project, worker: f.store.workers(project.id)[0]!, d };
  }

  it("archives an idle worker thread on explicit retire", async () => {
    const { f, project, worker, d } = await retiredReady();
    f.idle(d.threadId!);
    await f.service.retireWorker(project.id, worker.ref, "done");
    expect(f.archive).toHaveBeenCalledWith({ threadId: d.threadId });
    expect(f.store.worker(project.id, worker.num)!.state).toBe("retired");
  });

  it("refuses while the thread is busy, queued, or has live descendants", async () => {
    const { f, project, worker, d } = await retiredReady();
    f.threads.set(d.threadId!, {
      ...f.threads.get(d.threadId!)!,
      status: "active",
    });
    await expect(
      f.service.retireWorker(project.id, worker.ref, "done"),
    ).rejects.toThrow(/still running/);
    f.idle(d.threadId!);
    f.threads.set(d.threadId!, {
      ...f.threads.get(d.threadId!)!,
      queuedMessageCount: 1,
    });
    await expect(
      f.service.retireWorker(project.id, worker.ref, "done"),
    ).rejects.toThrow(/queued messages/);
    f.threads.set(d.threadId!, {
      ...f.threads.get(d.threadId!)!,
      queuedMessageCount: 0,
    });
    f.threads.set("child-1", {
      ...makeThreadResponse({
        id: "child-1",
        parentThreadId: d.threadId,
        status: "active",
      }),
      activity: {
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activeWorkflowCount: 0,
      },
      queuedWork: "none",
      hasPendingInteraction: false,
    } as ThreadDto);
    await expect(
      f.service.retireWorker(project.id, worker.ref, "done"),
    ).rejects.toThrow(/descendants/);
    // Once the child archives, retire succeeds.
    f.threads.set("child-1", {
      ...f.threads.get("child-1")!,
      status: "idle",
      archivedAt: Date.now(),
    });
    await f.service.retireWorker(project.id, worker.ref, "done");
    expect(f.store.worker(project.id, worker.num)!.state).toBe("retired");
  });

  it("refuses while an assignment is still open", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    const worker = f.store.workers(project.id)[0]!;
    await expect(
      f.service.retireWorker(project.id, worker.ref, "done"),
    ).rejects.toThrow(/still has A1 open/);
    expect(f.archive).not.toHaveBeenCalled();
  });
});

describe("coordinator handover", () => {
  it("runs a recorded replacement at the predecessor's natural idle", async () => {
    const { f, project } = await projectFixture();
    f.service.requestHandover(
      project.id,
      { reason: "Fresh context", checkpoint: "T1 in flight" },
      "coordinator",
    );
    expect(f.spawn).not.toHaveBeenCalled();
    // While the predecessor still works, the drain holds.
    f.threads.set("coordinator", {
      ...f.threads.get("coordinator")!,
      status: "active",
    });
    await f.service.drainHandover(project.id);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.handover(project.id)!.detail).toMatch(/still working/);
    // Natural idle: the replacement spawns with the checkpoint seed.
    f.idle("coordinator");
    await f.service.drainHandover(project.id);
    const spawned = f.spawn.mock.calls.at(-1)![0];
    expect(spawned.prompt).toContain("T1 in flight");
    expect(f.store.handover(project.id)).toBeNull();
    const current = f.store.project(project.id)!;
    expect(current.coordinatorThreadId).toBe("native-1");
    expect(f.store.membership("coordinator")!.former).toBe(true);
  });

  it("holds while the predecessor's latest turn was interrupted", async () => {
    const { f, project } = await projectFixture();
    f.service.requestHandover(project.id, {}, "user");
    f.idle("coordinator");
    f.history.length = 0;
    f.history.push({
      type: "turn/completed",
      seq: 1,
      createdAt: 1,
      data: { status: "interrupted" },
    });
    await f.service.drainHandover(project.id);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.handover(project.id)!.detail).toMatch(/interrupted/);
    // A newer completed turn releases it.
    f.history.push({
      type: "turn/completed",
      seq: 2,
      createdAt: 2,
      data: { status: "completed" },
    });
    await f.service.drainHandover(project.id);
    expect(f.spawn).toHaveBeenCalled();
    expect(f.store.handover(project.id)).toBeNull();
  });

  it("cancels a recorded handover and refuses double replacement", async () => {
    const { f, project } = await projectFixture();
    f.service.requestHandover(project.id, { reason: "Fresh" }, "user");
    f.service.cancelHandover(project.id, "user");
    expect(f.store.handover(project.id)).toBeNull();
    await f.service.drainHandover(project.id);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe("native failure and archive events", () => {
  it("records a failed turn on the open assignment without inventing recovery", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const thread = f.threads.get(d.threadId!)!;
    await f.runtime.onThreadFailed(thread, "provider crashed");
    const a = f.store.assignments(project.id)[0]!;
    expect(a.state).toBe("running");
    expect(a.stopReason).toMatch(/provider crashed/);
  });

  it("settles open work when its thread is archived outside Initiatives", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const thread = f.threads.get(d.threadId!)!;
    f.runtime.onThreadArchived(thread);
    const a = f.store.assignments(project.id)[0]!;
    expect(a.state).toBe("cancelled");
    expect(f.store.workers(project.id)[0]!.state).toBe("retired");
    expect(f.store.task(project.id, t1.num)!.status).toBe("planned");
  });
});

describe("overview", () => {
  it("counts open work as in flight and delivered reports as awaiting acceptance", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const t2 = f.service.createTask(
      project.id,
      {
        title: "Second task",
        summary: "Docs only",
        brief: brief("proj_a", ["docs"]),
      },
      "coordinator",
    );
    const [d1] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    const [d2] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t2.ref],
    });
    await f.service.report(d2.threadId!, report());
    const live = new Map(
      [...f.threads.values()].map((t) => [
        t.id,
        {
          status: t.status,
          archived: t.archivedAt !== null,
          title: t.title,
        },
      ]),
    );
    f.idle(d2.threadId!);
    live.set(d2.threadId!, {
      status: "idle",
      archived: false,
      title: null,
    });
    const o = buildOverview(f.store, project.id, live, f.store.now());
    // Only the still-open assignment is in flight; the delivered report waits
    // for acceptance instead — old accepted work never counts.
    expect(o.inFlight.map((i) => i.assignment)).toEqual(["A1"]);
    expect(o.awaitingAcceptance.map((i) => i.assignment)).toEqual(["A2"]);
    await f.service.acceptTask(project.id, t2.ref, {});
    const after = buildOverview(f.store, project.id, live, f.store.now());
    expect(after.inFlight.map((i) => i.assignment)).toEqual(["A1"]);
    expect(after.awaitingAcceptance).toHaveLength(0);
  });

  it("labels cached input honestly and leaves unknowns unknown", async () => {
    const { f, project } = await projectFixture();
    const o = buildOverview(f.store, project.id, new Map(), f.store.now());
    expect(o.usage.notes.join(" ")).toMatch(
      /combines cache reads and cache writes/,
    );
    expect(o.usage.notes.join(" ")).toMatch(/never a cache-hit/);
    expect(o.usage.coordinator.totals).toBeNull();
  });
});

describe("review independence", () => {
  it("reviews Claude-implemented work with the GPT reviewer by default, and honors a same-family override", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t1.ref],
    });
    await f.service.report(d.threadId!, report());
    const [r] = await f.service.delegate(project.id, {
      route: "fresh",
      role: "review",
      reviewOf: [t1.ref],
    });
    expect(r.state).toBe("running");
    const spawned = f.spawn.mock.calls.at(-1)![0];
    // Claude did the work (implementation default), so the reviewer is GPT.
    expect(spawned.model).toBe(DEFAULT_PROFILES.reviewOfClaude.model);
    // A different family is a recommendation; an explicit same-family
    // reviewer still starts as a fresh read-only review.
    const [same] = await f.service.delegate(project.id, {
      route: "fresh",
      role: "review",
      reviewOf: [t1.ref],
      profile: {
        providerId: "claude-code",
        model: "claude-opus-5-5",
        reasoningLevel: "high",
      },
    });
    expect(same.state).toBe("running");
    expect(f.spawn.mock.calls.at(-1)![0].model).toBe("claude-opus-5-5");
    expect(f.store.assignments(project.id).at(-1)).toMatchObject({
      role: "review",
      route: "fresh",
      access: "read-only",
    });
  });
});

describe("legacy history", () => {
  it("never replays a pending legacy inbox row and never deletes it", async () => {
    const { f, project } = await projectFixture();
    // A stale notice left behind by the removed delivery controllers.
    f.store.db
      .prepare(
        `INSERT INTO inbox (project_id, event_key, kind, priority, summary, payload, state, created_at)
         VALUES (?, 'report:A9:1', 'report', 'urgent', 'W9 reported', '{}', 'pending', 1)`,
      )
      .run(project.id);
    await f.runtime.sweep();
    expect(f.send).not.toHaveBeenCalled();
    const row = f.store.inbox(project.id)[0]!;
    expect(row.state).toBe("pending"); // history preserved, not delivered
  });
});

describe("user-owned threads", () => {
  it("requires a first message and creates a linked ad-hoc thread", async () => {
    const { f, project } = await projectFixture();
    const created = await f.service.createUserThread(project.id, {
      request: { projectId: "proj_a", providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "full", executionInputSources: {}, environment: { type: "reuse", environmentId: "env_a" }, input: [{ type: "text", text: "Look at the failing test", mentions: [] }] },
      title: "Investigation",
    });
    expect(created.threadId).toBe("native-1");
    const record = f.store.projectThreads(project.id)[0]!;
    expect(record.threadId).toBe("native-1");
    expect(record.state).toBe("active");
    const spawned = f.spawn.mock.calls.at(-1)![0];
    expect(spawned.pluginMetadata.role).toBe("adhoc");
    // The initiative's tree is the coordinator's: a user thread spawns as a
    // native child of the current coordinator while staying user-owned.
    expect(spawned.parentThreadId).toBe("coordinator");
    expect(f.threads.get("native-1")!.parentThreadId).toBe("coordinator");
    // No managed assignment exists for it.
    expect(f.store.assignments(project.id)).toHaveLength(0);
  });
});

describe("explicit assignment access", () => {
  it.each([
    ["read-only", "read-only"],
    ["read-only", "write"],
    ["write", "read-only"],
  ] as const)("allows distinct overlapping tasks with %s then %s", async (firstAccess, secondAccess) => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id, "First audit");
    const second = f.task(project.id, "Second audit");
    await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], access: firstAccess });
    const [result] = await f.service.delegate(project.id, { route: "fresh", tasks: [second.ref], access: secondAccess });
    expect(result.state).toBe("running");
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.store.assignments(project.id).map((a) => a.access)).toEqual([firstAccess, secondAccess]);
  });
});

describe("assignment access guards and persistence", () => {
  const restart = (f: ReturnType<typeof fixture>) =>
    new ProjectsService(f.service.bb, new Store(f.store.db), f.preferences);

  it("exposes read-only coordination in the canonical schema and retained-session CLI", async () => {
    const { f, project } = await projectFixture();
    const tool = f.harness.registrations.agentTools.find((t) => t.name === "initiative_delegate")!;
    const schema = tool.inputSchema as any;
    expect(schema.properties.access.enum).toEqual(["read-only", "write"]);
    expect(schema.properties.access.description).toContain("not a filesystem sandbox");
    expect(schema.properties.access.description).toContain("full native permissions");
    expect(schema.required ?? []).not.toContain("access");
    const task = f.task(project.id);
    const result = await f.harness.runCli(["command", JSON.stringify({
      action: "delegate", route: "fresh", tasks: [task.ref], label: "Audit", area: "Search audit", access: "read-only", permissionMode: "full",
    }), project.id]);
    expect(result.exitCode).toBe(0);
    expect(f.store.assignments(project.id)[0]).toMatchObject({ access: "read-only", role: "work" });
    expect(f.spawn.mock.calls[0][0].permissionMode).toBe("full");
    const prompt = f.spawn.mock.calls[0][0].prompt;
    expect(prompt).toContain("Access: read-only");
    expect(prompt).toContain("Do not write source or install state, even with full native permissions");
    expect(prompt).toContain("actual revision/source state checked");
    expect(prompt).toContain("not a filesystem sandbox");
  });

  it.each(["read", true, null, ""])('rejects invalid explicit access %j', (access) => {
    expect(commandSchema.safeParse({ action: "delegate", route: "fresh", tasks: ["T1"], label: "Audit", area: "src", access }).success).toBe(false);
  });

  it.each([
    [undefined, undefined], ["write", "write"], [undefined, "write"], ["write", undefined],
  ] as const)("keeps overlapping writers blocked with %s then %s", async (firstAccess, secondAccess) => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id);
    const second = f.task(project.id, "Other work");
    await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], access: firstAccess });
    await expect(restart(f).delegate(project.id, { route: "fresh", tasks: [second.ref], access: secondAccess })).rejects.toThrow(/overlapping paths/);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.store.assignments(project.id)[0].access).toBe("write");
  });

  it("does not infer read-only from investigation kind, labels or task text", async () => {
    const { f, project } = await projectFixture();
    const audit = f.service.createTask(project.id, {
      title: "Read-only audit", summary: "Only investigate; do not change anything", brief: brief(), workKind: "investigation",
    }, "coordinator");
    await f.service.delegate(project.id, { route: "fresh", tasks: [audit.ref], label: "Read-only auditor", area: "Investigation" });
    const other = f.task(project.id);
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [other.ref] })).rejects.toThrow(/overlapping paths/);
    expect(f.store.assignments(project.id)[0].access).toBe("write");
  });

  it("allows overlapping writers in different environments", async () => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id);
    const second = f.task(project.id);
    await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], environment: { type: "reuse", environmentId: "env_a" }, access: "write" });
    await f.service.delegate(project.id, { route: "fresh", tasks: [second.ref], environment: { type: "reuse", environmentId: "env_b" }, access: "write" });
    expect(f.store.assignments(project.id).map((a) => a.environmentId)).toEqual(["env_a", "env_b"]);
  });

  it("read-only still obeys Pause and same-task ownership", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    f.service.setPaused(project.id, true);
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], access: "read-only" })).rejects.toThrow(/paused/);
    expect(f.spawn).not.toHaveBeenCalled();
    f.service.setPaused(project.id, false);
    await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], access: "read-only" });
    await expect(f.service.delegate(project.id, { route: "fresh", tasks: [task.ref], access: "read-only" })).rejects.toThrow(/already has A1/);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps reviewers read-only even when write is requested", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [implementation] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await f.service.report(implementation.threadId!, report());
    const [review] = await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [task.ref], access: "write" });
    expect(f.store.assignments(project.id).at(-1)).toMatchObject({ role: "review", access: "read-only" });
    expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("Access: read-only");
    await f.service.report(review.threadId!, report());
    f.idle(review.threadId!);
    const other = f.task(project.id);
    await expect(f.service.delegate(project.id, { route: "continue", worker: review.worker, tasks: [other.ref], access: "read-only" })).rejects.toThrow(/reviewer/);
  });

  it.each(["continue", "fork"] as const)("%s persists an explicit audit declaration in a retained context", async (route) => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id);
    const [source] = await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], access: "read-only" });
    await f.service.report(source.threadId!, report());
    await f.service.acceptTask(project.id, first.ref, {});
    f.idle(source.threadId!);
    const writer = f.task(project.id);
    await f.service.delegate(project.id, { route: "fresh", tasks: [writer.ref] });
    const next = f.task(project.id);
    await restart(f).delegate(project.id, { route, worker: source.worker, tasks: [next.ref], access: "read-only", environment: { type: "reuse", environmentId: "env_a" } });
    expect(new Store(f.store.db).assignments(project.id).at(-1)).toMatchObject({ route, access: "read-only", role: "work" });
    const prompt = route === "continue" ? f.send.mock.calls.at(-1)![0].input[0].text : f.fork.mock.calls.at(-1)![0].input[0].text;
    expect(prompt).toContain("Access: read-only");
  });

  it.each(["continue", "fork"] as const)("%s omission defaults to a writer instead of inheriting audit access", async (route) => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id);
    const [source] = await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], access: "read-only" });
    await f.service.report(source.threadId!, report());
    await f.service.acceptTask(project.id, first.ref, {});
    f.idle(source.threadId!);
    const next = f.task(project.id);
    await restart(f).delegate(project.id, { route, worker: source.worker, tasks: [next.ref], environment: { type: "reuse", environmentId: "env_a" } });
    expect(new Store(f.store.db).assignments(project.id).at(-1)).toMatchObject({ route, access: "write" });
    const other = f.task(project.id);
    await expect(restart(f).delegate(project.id, { route: "fresh", tasks: [other.ref] })).rejects.toThrow(/overlapping paths/);
  });

  it.each(["read-only", "write"] as const)("queued %s access survives restart and dispatch", async (access) => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id);
    const [source] = await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], access });
    await f.service.report(source.threadId!, report());
    await f.service.acceptTask(project.id, first.ref, {});
    f.idle(source.threadId!);
    const next = f.task(project.id);
    f.queueSend("audit-queue");
    await f.service.delegate(project.id, { route: "continue", worker: source.worker, tasks: [next.ref], access });
    const service = restart(f);
    expect(service.store.assignment(project.id, 2)).toMatchObject({ access, state: "queued", queuedMessageId: "audit-queue" });
    const other = f.task(project.id);
    const dispatch = service.delegate(project.id, { route: "fresh", tasks: [other.ref] });
    if (access === "write") await expect(dispatch).rejects.toThrow(/overlapping paths/);
    else expect((await dispatch)[0].state).toBe("running");
    f.runtime.onMessageDispatched("audit-queue");
    expect(new Store(f.store.db).assignment(project.id, 2)).toMatchObject({ access, state: "running", queuedMessageId: null });
  });

  it.each(["read-only", "write"] as const)("uncertain %s reservations survive restart and cancellation", async (access) => {
    const { f, project } = await projectFixture();
    const first = f.task(project.id);
    f.spawn.mockImplementationOnce(async () => { throw Object.assign(new Error("connection reset"), { status: 0 }); });
    const [source] = await f.service.delegate(project.id, { route: "fresh", tasks: [first.ref], access });
    const service = restart(f);
    expect(service.store.assignment(project.id, 1)).toMatchObject({ access, state: "dispatching", opState: "uncertain" });
    await expect(service.delegate(project.id, { route: "fresh", tasks: [first.ref], access: "read-only" })).rejects.toThrow(/already has A1/);
    await expect(service.delegate(project.id, { route: "continue", worker: source.worker, tasks: [first.ref], access: "read-only" })).rejects.toThrow(/unconfirmed operation/);
    // Cancellation cannot erase an unknown execution's declared access.
    service.store.updateAssignment(project.id, 1, { state: "cancelled", cancelRequested: true });
    expect(new Store(f.store.db).assignment(project.id, 1)).toMatchObject({ access, state: "cancelled", opState: "uncertain" });
    const other = f.task(project.id);
    const dispatch = restart(f).delegate(project.id, { route: "fresh", tasks: [other.ref] });
    if (access === "write") await expect(dispatch).rejects.toThrow(/overlapping paths/);
    else expect((await dispatch)[0].state).toBe("running");
  });
});
