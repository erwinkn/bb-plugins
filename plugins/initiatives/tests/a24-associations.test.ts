import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { fixture, projectFixture } from "./fake-native";

const child = (
  f: ReturnType<typeof fixture>,
  parentThreadId: string | null,
  extra: Record<string, unknown> = {},
) =>
  f.spawn({
    projectId: "proj_a",
    parentThreadId,
    ...extra,
  });

describe("native coordinator children join the project", () => {
  it("associates an ordinary native child on idle, as a thread only", async () => {
    const { f, project } = await projectFixture();
    const spawned = await child(f, "coordinator");
    f.threads.set(spawned.id, { ...spawned, title: "Explore auth" });
    await f.runtime.onThreadIdle({
      ...f.threads.get(spawned.id)!,
      status: "idle",
    });
    const rows = f.store.projectThreads(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.threadId).toBe(spawned.id);
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.label).toBe("Explore auth");
    // Membership resolves for tools and the Sidebar, with no worker role.
    const membership = f.store.membership(spawned.id);
    expect(membership?.kind).toBe("adhoc");
    expect(membership?.project.id).toBe(project.id);
    // The tree emits it as an adhoc node; nothing else was created.
    const node = f
      .tree()
      .projects[0]!.nodes.find((n) => n.threadId === spawned.id);
    expect(node?.role).toBe("adhoc");
    expect(f.store.workers(project.id)).toHaveLength(0);
    expect(f.store.assignments(project.id)).toHaveLength(0);
  });

  it("discovers children the plugin missed when the sweep runs", async () => {
    const { f, project } = await projectFixture();
    const spawned = await child(f, "coordinator");
    await f.service.associateNativeChildren(project.id);
    expect(
      f.store.projectThreads(project.id).map((r) => r.threadId),
    ).toEqual([spawned.id]);
  });

  it("never double-lists a thread once explicit membership claims it", async () => {
    const { f, project } = await projectFixture();
    const spawned = await child(f, "coordinator");
    expect(f.service.associateNativeChild(spawned)).toBe(true);
    // Adopted as a worker: the membership wins, the adhoc row stops listing.
    await f.service.adoptWorker(project.id, {
      threadId: spawned.id,
      role: "work",
      label: "adopted helper",
    });
    const nodes = f
      .tree()
      .projects[0]!.nodes.filter((n) => n.threadId === spawned.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.role).toBe("work");
    // The historical association row is kept.
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
  });

  it("leaves an explicitly parented worker without an adhoc row", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    const [d] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [t.ref],
    });
    // The delegated worker is already a native child of the coordinator.
    expect(
      f.service.associateNativeChild(f.threads.get(d.threadId!)!),
    ).toBe(false);
    expect(f.store.projectThreads(project.id)).toHaveLength(0);
    expect(
      f.tree().projects[0]!.nodes.filter((n) => n.threadId === d.threadId),
    ).toHaveLength(1);
  });

  it("nested children get lightweight membership without a thread row", async () => {
    const { f, project } = await projectFixture();
    const parent = await child(f, "coordinator");
    expect(f.service.associateNativeChild(parent)).toBe(true);
    const nested = await child(f, parent.id);
    expect(f.service.associateNativeChild(nested)).toBe(true);
    // No project-thread row: the nested child is not a user project thread.
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
    // But selection and tools resolve the durable project through the
    // lightweight nested membership.
    const membership = f.store.membership(nested.id);
    expect(membership?.kind).toBe("adhoc");
    expect(membership?.project.id).toBe(project.id);
    expect(f.store.nestedProjectThreads(project.id)).toHaveLength(1);
    // No task, assignment or worker was created for it.
    expect(f.store.assignments(project.id)).toHaveLength(0);
    expect(f.store.workers(project.id)).toHaveLength(0);
  });

  it("attaches a claimed member root stranded without a native parent", async () => {
    const { f, project } = await projectFixture();
    // A member claimed before the coordinator-tree invariant, or one whose
    // parent vanished, joins under the current coordinator on the sweep.
    const created = await f.service.createUserThread(project.id, {
      request: { projectId: "proj_a", providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "full", executionInputSources: {}, environment: { type: "reuse", environmentId: "env_a" }, input: [{ type: "text", text: "Investigate the flaky test", mentions: [] }] },
      title: "Investigation",
    });
    const threadId = created.threadId!;
    f.threads.set(threadId, {
      ...f.threads.get(threadId)!,
      parentThreadId: null,
    });
    await f.service.associateNativeChildren(project.id);
    expect(f.threads.get(threadId)!.parentThreadId).toBe("coordinator");
    // It keeps its user-owned membership — no worker, no assignment.
    expect(f.store.membership(threadId)?.kind).toBe("adhoc");
    expect(f.store.workers(project.id)).toHaveLength(0);
    expect(f.store.assignments(project.id)).toHaveLength(0);
  });

  it("leaves a member nested under a live thread in its arrangement", async () => {
    const { f, project } = await projectFixture();
    const parent = await child(f, "coordinator");
    const nested = await child(f, parent.id);
    await f.service.associateNativeChildren(project.id);
    // The user-arranged nesting is native placement, not stranding.
    expect(f.threads.get(nested.id)!.parentThreadId).toBe(parent.id);
  });

  it("keeps association across coordinator replacement, including former-era children", async () => {
    const { f, project } = await projectFixture();
    const early = await child(f, "coordinator");
    f.service.requestHandover(project.id, { reason: "handoff" }, "coordinator");
    f.idle("coordinator");
    await f.service.drainHandover(project.id);
    const gen2 = f.store.project(project.id)!.coordinatorThreadId!;
    expect(gen2).not.toBe("coordinator");
    // A child of the former coordinator discovered late still associates, and
    // a child of the replacement associates — both land in one sweep.
    const late = await child(f, gen2);
    await f.service.associateNativeChildren(project.id);
    expect(f.store.projectThreads(project.id).map((r) => r.threadId)).toEqual(
      expect.arrayContaining([early.id, late.id]),
    );
    // The former coordinator itself stays historical — never an adhoc node.
    expect(
      f.tree().projects[0]!.nodes.some((n) => n.threadId === "coordinator"),
    ).toBe(false);
  });

  it("skips archived children and never reopens a deleted row", async () => {
    const { f, project } = await projectFixture();
    const archived = await child(f, "coordinator");
    f.threads.set(archived.id, { ...archived, archivedAt: Date.now() });
    await f.service.associateNativeChildren(project.id);
    expect(f.store.projectThreads(project.id)).toHaveLength(0);
    expect(f.service.associateNativeChild(f.threads.get(archived.id)!)).toBe(
      false,
    );
  });

  it("keeps a claimed thread on its first project", async () => {
    const { f, project } = await projectFixture();
    f.threads.set(
      "coordinator-b",
      makeThreadResponse({
        id: "coordinator-b",
        projectId: "proj_a",
        // Strict home proof: the adopted coordinator must resolve its
        // environment to proj_a's proven default checkout.
        environmentId: "env_a",
      }),
    );
    const { project: other } = await f.service.createProject({
      name: "Other",
      objective: "Unrelated",
      memberProjectIds: ["proj_a"],
      coordinator: { kind: "adopt", threadId: "coordinator-b" },
    });
    const spawned = await child(f, "coordinator");
    f.service.associateNativeChild(spawned);
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
    // Re-parented under the other project's coordinator: the first claim wins.
    f.threads.set(spawned.id, { ...spawned, parentThreadId: "coordinator-b" });
    expect(
      f.service.associateNativeChild(f.threads.get(spawned.id)!),
    ).toBe(false);
    expect(f.store.projectThreads(other.id)).toHaveLength(0);
  });
});
