// A36 boundary regression: the retirement guard must refuse UNKNOWN root
// native evidence before either native archive or Stop. A34 made
// lifecycleWellFormed() only disable the already-archived early return; a
// `{}` (or partially malformed) GET response then fell through the
// missing-status and missing-counter checks and issued a destructive
// archive against a still-active worker thread.
//
// retireThread() now requires the whole root DTO to be well-formed —
// lifecycle fields, a known foreground status, and finite non-negative
// queue/background counters — before any guard branch runs. Unknown
// evidence throws; only valid positive quiet/archive/delete/404 evidence
// converges. Descendant and busy safeguards are unchanged.
//
// Probes ported verbatim from the A35 delta review
// (delta-probes.test.ts, 'A35 lifecycle cleanup callers' describe).

import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture, report } from "./fake-native";

async function retirementReady() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const [d] = await f.service.delegate(project.id, {
    route: "fresh",
    tasks: [task.ref],
  });
  await f.service.report(d.threadId!, report());
  await f.service.closeTask(project.id, task.ref, "done");
  return {
    f,
    project,
    threadId: d.threadId!,
    worker: f.store.workers(project.id)[0]!,
  };
}

const corrupt = (row: any, kind: string) => {
  if (kind === "empty DTO") return {};
  if (kind === "missing archivedAt") delete row.archivedAt;
  if (kind === "missing deletedAt") delete row.deletedAt;
  if (kind === "NaN archivedAt") row.archivedAt = NaN;
  if (kind === "string deletedAt") row.deletedAt = "not-a-time";
  return row;
};

// T91: retirement also reads the root thread's own row from its project listing. BB lists
// the (quiet) root there; these stubs model only descendants, so add that root row.
const withRootRow = (x: Awaited<ReturnType<typeof retirementReady>>, descendants: (args: any) => Promise<any[]>) =>
  async (args: any) => args.parentThreadId ? descendants(args) : [{
    ...x.f.threads.get(x.threadId), queuedWork: "none", hasPendingInteraction: false,
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0 },
  }];

describe("A35 lifecycle cleanup callers", () => {
  it("retire does not issue destructive archive for an empty GET response while native root is active", async () => {
    const x = await retirementReady();
    x.f.harness.sdk.stub("threads.get", async () => ({}) as any);
    let rejected = false;
    try {
      await x.f.service.retireWorker(x.project.id, x.worker.ref, "done");
    } catch {
      rejected = true;
    }
    // The caller has no positive evidence the still-active native root is safe.
    expect(
      x.f.archive,
      "an unreadable GET must never trigger native archive",
    ).not.toHaveBeenCalled();
    // Old A33 already marked this worker retired on malformed GET. This
    // assertion isolates the newly introduced native archive mutation.
  });
  it.each([
    "missing archivedAt",
    "missing deletedAt",
    "NaN archivedAt",
    "string deletedAt",
  ])("retire holds an active root despite %s", async (kind) => {
    const x = await retirementReady();
    x.f.harness.sdk.stub(
      "threads.get",
      async () => corrupt({ ...x.f.threads.get(x.threadId)! }, kind),
    );
    await expect(
      x.f.service.retireWorker(x.project.id, x.worker.ref, "done"),
    ).rejects.toThrow();
    expect(x.f.archive).not.toHaveBeenCalled();
  });
  it.each([
    "missing archivedAt",
    "missing deletedAt",
    "NaN archivedAt",
    "string deletedAt",
  ])("malformed descendant %s blocks retirement", async (kind) => {
    const x = await retirementReady();
    x.f.idle(x.threadId);
    const child = makeThreadResponse({
      id: "child",
      parentThreadId: x.threadId,
      status: "idle",
    });
    const row = corrupt(
      {
        ...child,
        queuedWork: "none",
        hasPendingInteraction: false,
        activity: {
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activeWorkflowCount: 0,
        },
      },
      kind,
    );
    x.f.harness.sdk.stub(
      "threads.list",
      withRootRow(x, async (args: any) =>
        args.parentThreadId === x.threadId && !args.archived ? [row] : []),
    );
    await expect(
      x.f.service.retireWorker(x.project.id, x.worker.ref, "done"),
    ).rejects.toThrow(/unreadable lifecycle/);
    expect(x.f.archive).not.toHaveBeenCalled();
  });
  it.each(["quiet", "archive", "delete"])(
    "valid %s descendant permits retirement",
    async (kind) => {
      const x = await retirementReady();
      x.f.idle(x.threadId);
      const child = makeThreadResponse({
        id: "child",
        parentThreadId: x.threadId,
        status: kind === "quiet" ? "idle" : "active",
        archivedAt: kind === "archive" ? 1 : null,
        deletedAt: kind === "delete" ? 1 : null,
      });
      const row = {
        ...child,
        queuedWork: "none",
        hasPendingInteraction: false,
        activity: {
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activeWorkflowCount: 0,
        },
      };
      x.f.harness.sdk.stub(
        "threads.list",
        withRootRow(x, async (args: any) =>
          args.parentThreadId === x.threadId &&
          Boolean(args.archived) === (kind === "archive")
            ? [row]
            : []),
      );
      await x.f.service.retireWorker(x.project.id, x.worker.ref, "done");
      expect(x.f.archive).toHaveBeenCalledTimes(1);
      expect(x.f.store.worker(x.project.id, x.worker.num)!.state).toBe(
        "retired",
      );
    },
  );
  it("walks archived children to protect their restored active grandchildren", async () => {
    const x = await retirementReady();
    x.f.idle(x.threadId);
    const child = makeThreadResponse({
      id: "child",
      parentThreadId: x.threadId,
      archivedAt: 1,
      status: "idle",
    });
    const grand = makeThreadResponse({
      id: "grand",
      parentThreadId: child.id,
      status: "active",
    });
    x.f.harness.sdk.stub("threads.list", withRootRow(x, async (args: any) =>
      [child, grand]
        .filter(
          (t) =>
            t.parentThreadId === args.parentThreadId &&
            Boolean(t.archivedAt) === Boolean(args.archived),
        )
        .map((t) => ({
          ...t,
          queuedWork: "none",
          hasPendingInteraction: false,
          activity: {
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activeWorkflowCount: 0,
          },
        }))),
    );
    await expect(
      x.f.service.retireWorker(x.project.id, x.worker.ref, "done"),
    ).rejects.toThrow(/active/);
    expect(x.f.archive).not.toHaveBeenCalled();
  });
});
