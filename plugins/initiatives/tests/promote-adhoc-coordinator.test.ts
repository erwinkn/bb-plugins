import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { fixture, projectFixture } from "./fake-native";
import { buildOverview } from "../lib/overview";

type Fx = ReturnType<typeof fixture>;

/** An adhoc thread of the Initiative: a user thread under its coordinator, claimed by the sweep. */
async function adhocChild(f: Fx, parentThreadId = "coordinator") {
  const spawned = await f.spawn({ projectId: "proj_a", parentThreadId });
  f.threads.set(spawned.id, { ...spawned, title: "Side quest", status: "idle" });
  return f.threads.get(spawned.id)!;
}

const promote = (f: Fx, threadId: string, name = "Spin-off") =>
  f.service.createProject({
    name,
    objective: "Grew out of a side thread",
    memberProjectIds: ["proj_a"],
    coordinator: { kind: "adopt", threadId },
  });

const treeNodes = (f: Fx, projectId: string) =>
  f.tree().projects.find((p) => p.id === projectId)?.nodes ?? [];

describe("promoting an adhoc thread to coordinator of a new Initiative", () => {
  it("moves a project_threads child out of its Initiative and makes it the new coordinator", async () => {
    const { f, project } = await projectFixture();
    const child = await adhocChild(f);
    expect(f.service.associateNativeChild(child)).toBe(true);
    expect(f.store.membership(child.id)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
    expect(treeNodes(f, project.id).some((n) => n.threadId === child.id)).toBe(true);

    const { project: created } = await promote(f, child.id);

    // Native parentage is cleared, the old Initiative forgets the thread.
    expect(f.threads.get(child.id)!.parentThreadId).toBeNull();
    expect(f.store.projectThreads(project.id).map((r) => r.threadId)).not.toContain(child.id);
    expect(buildOverview(f.store, project.id, new Map(), Date.now()).threads.map((t) => t.threadId)).not.toContain(child.id);
    expect(treeNodes(f, project.id).some((n) => n.threadId === child.id)).toBe(false);
    expect(f.store.db.prepare(`SELECT 1 FROM project_threads WHERE thread_id = ?`).get(child.id)).toBeUndefined();

    // It now coordinates the new Initiative, tagged and attached to its memory.
    expect(f.store.membership(child.id)).toMatchObject({ kind: "coordinator", project: { id: created.id }, former: false });
    expect(created.coordinatorThreadId).toBe(child.id);
    expect(f.metadata.get(child.id)).toMatchObject({ role: "coordinator", projectId: created.id });
    expect(f.pluginRpc).toHaveBeenCalledWith(
      expect.objectContaining({ method: "attach", input: { threadId: child.id, key: created.id } }),
    );

    // The old Initiative says what happened, and is not blocked on the departed child.
    const logs = f.store.db.prepare(`SELECT summary FROM activity WHERE project_id = ?`).all(project.id) as { summary: string }[];
    expect(logs.map((l) => l.summary)).toContain(`Promoted Side quest to coordinator of Spin-off`);
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.threads.get("coordinator")!.archivedAt).not.toBeNull();
    expect(f.store.membership(child.id)).toMatchObject({ kind: "coordinator", project: { id: created.id } });
  });

  it("also promotes an adhoc thread claimed through project_nested_threads", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const nested = await adhocChild(f, parent.id);
    expect(
      f.store.associateNestedThread({ projectId: project.id, threadId: nested.id, label: "Deep", bbProjectId: "proj_a" }),
    ).toBe(true);
    expect(f.store.membership(nested.id)?.kind).toBe("adhoc");

    const { project: created } = await promote(f, nested.id);

    expect(f.threads.get(nested.id)!.parentThreadId).toBeNull();
    expect(f.store.db.prepare(`SELECT 1 FROM project_nested_threads WHERE thread_id = ?`).get(nested.id)).toBeUndefined();
    expect(f.store.membership(nested.id)).toMatchObject({ kind: "coordinator", project: { id: created.id } });
    // The sibling claim is untouched.
    expect(f.store.projectThreads(project.id).map((r) => r.threadId)).toContain(parent.id);
  });

  it("promotes an adhoc thread whose old Initiative is archived", async () => {
    const { f, project } = await projectFixture();
    const child = await adhocChild(f);
    f.service.associateNativeChild(child);
    f.store.db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).run(Date.now(), project.id);
    expect(f.store.membership(child.id)).toBeNull();

    const { project: created } = await promote(f, child.id);

    expect(f.store.membership(child.id)).toMatchObject({ kind: "coordinator", project: { id: created.id } });
    expect(f.store.projectThreads(project.id)).toHaveLength(0);
    expect(f.threads.get(child.id)!.parentThreadId).toBeNull();
  });

  it("carries nested claims of the promoted thread's descendants and its token usage", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const grand = await adhocChild(f, parent.id);
    const sibling = await adhocChild(f);
    for (const t of [grand, sibling])
      f.store.associateNestedThread({ projectId: project.id, threadId: t.id, label: t.id, bbProjectId: "proj_a" });
    f.store.db
      .prepare(`INSERT INTO usage (thread_id, project_id, worker_num, last_seq, closed_totals, updated_at) VALUES (?, ?, -1, 3, '{}', 1)`)
      .run(parent.id, project.id);
    f.store.db
      .prepare(`INSERT INTO usage (thread_id, project_id, worker_num, last_seq, closed_totals, updated_at) VALUES (?, ?, -1, 2, '{}', 1)`)
      .run(grand.id, project.id);
    f.store.db
      .prepare(`INSERT INTO usage_turn_cursors VALUES (?, ?, 3, 1, 1)`)
      .run(parent.id, project.id);

    const { project: created } = await promote(f, parent.id);

    // The descendant leaves with its parent, as a direct child of the new coordinator, claimed
    // without a gap; an unrelated nested claim stays.
    expect(f.store.projectThreads(created.id).map((r) => r.threadId)).toEqual([grand.id]);
    expect(f.store.membership(grand.id, true)).toMatchObject({ kind: "adhoc", project: { id: created.id } });
    expect(f.store.db.prepare(`SELECT 1 FROM project_nested_threads WHERE thread_id = ?`).get(grand.id)).toBeUndefined();
    expect(f.store.membership(sibling.id)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
    expect(f.store.db.prepare(`SELECT project_id, worker_num FROM usage WHERE thread_id = ?`).get(parent.id)).toEqual({
      project_id: created.id,
      worker_num: 0,
    });
    expect(f.store.db.prepare(`SELECT project_id FROM usage_turn_cursors WHERE thread_id = ?`).get(parent.id)).toEqual({
      project_id: created.id,
    });
    expect(f.store.db.prepare(`SELECT project_id, worker_num FROM usage WHERE thread_id = ?`).get(grand.id)).toEqual({
      project_id: created.id,
      worker_num: -1,
    });
  });

  it("keeps the claim shape: direct children join project_threads, deeper ones stay nested", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const child = await adhocChild(f, parent.id);
    const deep = await adhocChild(f, child.id);
    for (const t of [child, deep])
      f.store.associateNestedThread({ projectId: project.id, threadId: t.id, label: t.id, bbProjectId: "proj_a" });

    const { project: created } = await promote(f, parent.id);

    expect(f.store.projectThreads(created.id).map((r) => r.threadId)).toEqual([child.id]);
    expect(f.store.nestedProjectThreads(created.id).map((r) => r.threadId)).toEqual([deep.id]);
    expect(f.store.nestedProjectThreads(project.id)).toHaveLength(0);
    expect(f.store.membership(deep.id, true)).toMatchObject({ kind: "adhoc", project: { id: created.id } });
    // Nothing is left for a sweep of the new Initiative to reclaim or double-count.
    await f.service.associateNativeChildren(created.id);
    expect(f.store.projectThreads(created.id)).toHaveLength(1);
    expect(f.store.nestedProjectThreads(created.id)).toHaveLength(1);
  });

  it("carries a live descendant under an archived intermediate claim, keeping its end fact", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const middle = await adhocChild(f, parent.id);
    const deep = await adhocChild(f, middle.id);
    for (const t of [middle, deep])
      f.store.associateNestedThread({ projectId: project.id, threadId: t.id, label: t.id, bbProjectId: "proj_a" });
    f.threads.set(middle.id, { ...f.threads.get(middle.id)!, archivedAt: Date.now() });
    expect(f.store.endNestedThread(middle.id, { status: "idle", archived: true } as never)).toBe(true);
    // BB lists archived children unless asked otherwise; the test double hides them.
    f.intercept(async (path, args, call) => {
      const rows = (await call()) as { id: string }[];
      const query = args as { parentThreadId?: string };
      if (path !== "threads.list" || !query.parentThreadId) return rows;
      const archived = [...f.threads.values()].filter((t) => t.parentThreadId === query.parentThreadId && t.archivedAt);
      return [...rows, ...archived];
    });

    const { project: created } = await promote(f, parent.id);
    f.intercept();

    // The archived claim is a nested row with its end fact, not a live project thread.
    expect(f.store.projectThreads(created.id)).toHaveLength(0);
    expect(f.store.nestedProjectThreads(created.id).map((r) => r.threadId).sort()).toEqual([deep.id, middle.id].sort());
    expect(f.store.nestedProjectThreads(created.id).find((r) => r.threadId === middle.id)?.ended).not.toBeNull();
    expect(f.store.membership(deep.id, true)).toMatchObject({ kind: "adhoc", project: { id: created.id } });
    expect(f.store.nestedProjectThreads(project.id)).toHaveLength(0);
  });

  it("aborts without writing anything when a level of the subtree cannot be read", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const deep = await adhocChild(f, parent.id);
    f.store.associateNestedThread({ projectId: project.id, threadId: deep.id, label: "deep", bbProjectId: "proj_a" });
    f.intercept(async (path, args, call) => {
      if (path === "threads.list" && (args as { parentThreadId?: string }).parentThreadId === parent.id)
        throw new Error("rpc timeout");
      return call();
    });

    await expect(promote(f, parent.id)).rejects.toThrow(/rpc timeout/);
    f.intercept();

    expect(f.store.membership(parent.id)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
    expect(f.store.membership(deep.id, true)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
    expect(f.threads.get(parent.id)!.parentThreadId).toBe("coordinator");
    expect(f.store.projects().filter((p) => p.coordinatorThreadId === parent.id)).toHaveLength(0);
  });

  it("carries a child the old Initiative's sweep claims while the subtree is being read", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const late = await adhocChild(f, parent.id);
    expect(f.store.membership(late.id, true)).toBeNull();
    let claimed = false;
    f.intercept(async (path, args, call) => {
      const rows = await call();
      if (path === "threads.list" && (args as { parentThreadId?: string }).parentThreadId === parent.id && !claimed) {
        claimed = true;
        f.store.associateNestedThread({ projectId: project.id, threadId: late.id, label: "late", bbProjectId: "proj_a" });
      }
      return rows;
    });

    const { project: created } = await promote(f, parent.id);
    f.intercept();

    expect(claimed).toBe(true);
    expect(f.store.membership(late.id, true)).toMatchObject({ kind: "adhoc", project: { id: created.id } });
    expect(f.store.nestedProjectThreads(project.id)).toHaveLength(0);
  });

  it("moves a live descendant the old sweep reparented under its coordinator just before the commit", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const middle = await adhocChild(f, parent.id);
    const deep = await adhocChild(f, middle.id);
    for (const t of [middle, deep])
      f.store.associateNestedThread({ projectId: project.id, threadId: t.id, label: t.id, bbProjectId: "proj_a" });
    f.threads.set(middle.id, { ...f.threads.get(middle.id)!, archivedAt: Date.now() });
    f.store.endNestedThread(middle.id, { status: "idle", archived: true } as never);
    let reparented = false;
    let reads = 0;
    f.intercept(async (path, args, call) => {
      const rows = (await call()) as { id: string }[];
      const query = args as { parentThreadId?: string; threadId?: string };
      if (path === "threads.list" && query.parentThreadId)
        return [...rows, ...[...f.threads.values()].filter((t) => t.parentThreadId === query.parentThreadId && t.archivedAt)];
      // The in-flight sweep lands its reparent before the promoted thread's parent is read.
      // (The first read is the adoption's own; the second is the one that clears the parent.)
      if (path === "threads.get" && query.threadId === parent.id && ++reads === 2) {
        reparented = true;
        f.threads.set(deep.id, { ...f.threads.get(deep.id)!, parentThreadId: "coordinator" });
      }
      return rows;
    });

    await promote(f, parent.id);
    f.intercept();

    expect(reparented).toBe(true);
    expect(f.threads.get(deep.id)!.parentThreadId).toBe(parent.id);
  });

  it("leaves an intermediate claim upgraded to a worker mid-walk, with its whole subtree, behind", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const middle = await adhocChild(f, parent.id);
    const deep = await adhocChild(f, middle.id);
    const sibling = await adhocChild(f, parent.id);
    for (const t of [middle, deep, sibling])
      f.store.associateNestedThread({ projectId: project.id, threadId: t.id, label: t.id, bbProjectId: "proj_a" });
    for (const t of [middle, deep])
      f.store.db
        .prepare(`INSERT INTO usage (thread_id, project_id, worker_num, last_seq, closed_totals, updated_at) VALUES (?, ?, -1, 2, '{}', 1)`)
        .run(t.id, project.id);
    // The old Initiative adopts `middle` as a worker after the walk read it, before the commit.
    let upgraded = false;
    f.intercept(async (path, args, call) => {
      const rows = await call();
      if (path === "threads.list" && (args as { parentThreadId?: string }).parentThreadId === middle.id && !upgraded) {
        upgraded = true;
        f.intercept();
        await f.service.adoptWorker(project.id, { threadId: middle.id, role: "work", label: "middle" });
      }
      return rows;
    });

    const { project: created } = await promote(f, parent.id);
    f.intercept();

    expect(upgraded).toBe(true);
    expect(f.store.membership(middle.id)).toMatchObject({ kind: "worker", project: { id: project.id } });
    expect(f.store.membership(deep.id, true)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
    expect(f.store.db.prepare(`SELECT project_id FROM usage WHERE thread_id = ?`).all(middle.id, ).map((r: any) => r.project_id)).toEqual([project.id]);
    expect(f.store.db.prepare(`SELECT project_id FROM usage WHERE thread_id = ?`).get(deep.id)).toEqual({ project_id: project.id });
    // The sibling had nothing to do with it and moves.
    expect(f.store.membership(sibling.id, true)).toMatchObject({ kind: "adhoc", project: { id: created.id } });
  });

  it("leaves a nested descendant already upgraded to a worker, and its subtree and usage, with its Initiative", async () => {
    const { f, project } = await projectFixture();
    const parent = await adhocChild(f);
    f.service.associateNativeChild(parent);
    const upgraded = await adhocChild(f, parent.id);
    const helper = await adhocChild(f, upgraded.id);
    for (const t of [upgraded, helper])
      f.store.associateNestedThread({ projectId: project.id, threadId: t.id, label: t.id, bbProjectId: "proj_a" });
    // Adopting keeps the nested claim row of `upgraded`, as it does for any adhoc thread.
    await f.service.adoptWorker(project.id, { threadId: upgraded.id, role: "work", label: "upgraded" });
    f.store.db
      .prepare(`INSERT INTO usage (thread_id, project_id, worker_num, last_seq, closed_totals, updated_at) VALUES (?, ?, 7, 2, '{}', 1)`)
      .run(upgraded.id, project.id);

    await promote(f, parent.id);

    expect(f.store.db.prepare(`SELECT project_id, worker_num FROM usage WHERE thread_id = ?`).get(upgraded.id)).toEqual({
      project_id: project.id,
      worker_num: 7,
    });
    expect(f.store.membership(upgraded.id)).toMatchObject({ kind: "worker", project: { id: project.id } });
    // The worker's own helper stays claimed by the old Initiative.
    expect(f.store.membership(helper.id, true)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
  });

  it("clears the native parent of a thread no sweep has claimed yet", async () => {
    const { f } = await projectFixture();
    const child = await adhocChild(f);
    expect(f.store.membership(child.id, true)).toBeNull();

    await promote(f, child.id);

    expect(f.threads.get(child.id)!.parentThreadId).toBeNull();
  });

  it("leaves the thread untouched when validation fails after the claim check", async () => {
    const { f, project } = await projectFixture();
    const child = await adhocChild(f);
    f.service.associateNativeChild(child);
    f.threads.set(child.id, { ...f.threads.get(child.id)!, projectId: "proj_other" });

    await expect(promote(f, child.id)).rejects.toThrow(/primary member project/);

    expect(f.threads.get(child.id)!.parentThreadId).toBe("coordinator");
    expect(f.store.membership(child.id)).toMatchObject({ kind: "adhoc", project: { id: project.id } });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("still refuses an active coordinator and a current or former worker of another Initiative", async () => {
    const { f, project } = await projectFixture();
    // Active coordinator.
    await expect(promote(f, "coordinator")).rejects.toThrow(/already belongs to Search/);

    // Current worker.
    const worker = await f.spawn({ projectId: "proj_a", parentThreadId: "coordinator" });
    f.threads.set(worker.id, { ...worker, status: "idle" });
    await f.service.adoptWorker(project.id, { threadId: worker.id, role: "work", label: "Worker" });
    expect(f.store.membership(worker.id)?.kind).toBe("worker");
    // A worker's role is immutable, so the role-lineage check refuses it before the claim check.
    await expect(promote(f, worker.id)).rejects.toThrow(/descends from work worker W1/);

    // Former worker generation.
    f.store.db
      .prepare(`INSERT INTO generations (project_id, worker_num, generation, thread_id, started_at) VALUES (?, 1, 0, 'former-worker', 1)`)
      .run(project.id);
    f.threads.set(
      "former-worker",
      makeThreadResponse({ id: "former-worker", projectId: "proj_a", environmentId: "env_a" }),
    );
    expect(f.store.membership("former-worker")).toMatchObject({ kind: "worker", former: true });
    await expect(promote(f, "former-worker")).rejects.toThrow(/descends from work worker W1/);

    // Nothing was written: the Initiative still has its coordinator and the thread's claim.
    expect(f.store.membership(worker.id)?.project.id).toBe(project.id);
    expect(f.store.membership("former-worker")?.former).toBe(true);
  });
});
