import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { buildOverview, threadsToWatch } from "../lib/overview";

describe("Control Room native member projection", () => {
  it("projects actual native parents for all recorded members, with no assignment duplication", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const [dispatch] = await f.service.delegate(project.id, {
      route: "fresh",
      tasks: [task.ref],
    });
    f.store.associateNestedThread({
      projectId: project.id,
      threadId: "nested",
      label: "Worker subthread",
      bbProjectId: "proj_a",
    });
    f.threads.set(
      "nested",
      makeThreadResponse({
        id: "nested",
        projectId: "proj_a",
        parentThreadId: dispatch.threadId,
        title: "Worker subthread",
      }),
    );
    f.store.associateProjectThread({
      projectId: project.id,
      opId: "user",
      threadId: "mine",
      label: "My investigation",
      bbProjectId: "proj_a",
    });
    f.threads.set(
      "mine",
      makeThreadResponse({
        id: "mine",
        projectId: "proj_a",
        parentThreadId: "coordinator",
        title: "My investigation",
      }),
    );
    const o = await f.overview(project.id);
    expect(new Set(o.memberThreads.map((t) => t.threadId)).size).toBe(
      o.memberThreads.length,
    );
    expect(
      o.memberThreads.find((t) => t.threadId === dispatch.threadId),
    ).toMatchObject({
      parentThreadId: "coordinator",
      parentKnown: true,
      ownership: "worker",
      environmentId: "env_a",
    });
    expect(o.memberThreads.find((t) => t.threadId === "nested")).toMatchObject({
      parentThreadId: dispatch.threadId,
      parentKnown: true,
      nativeTitle: "Worker subthread",
    });
    expect(o.memberThreads.find((t) => t.threadId === "mine")).toMatchObject({
      parentThreadId: "coordinator",
      ownership: "user",
      parentKnown: true,
    });
    expect(threadsToWatch(f.store, project.id)).toContain("nested");
    expect(o.inFlight[0]?.since).toBeGreaterThan(0);
  });
  it("keeps unknown native parents explicit rather than inventing attachment", async () => {
    const { f, project } = await projectFixture();
    f.store.associateNestedThread({
      projectId: project.id,
      threadId: "unavailable",
      label: "Retained child",
      bbProjectId: "proj_a",
    });
    const o = buildOverview(f.store, project.id, new Map(), f.store.now());
    expect(
      o.memberThreads.find((t) => t.threadId === "unavailable"),
    ).toMatchObject({
      parentThreadId: null,
      parentKnown: false,
      runtime: "unknown",
      bbProjectId: "proj_a",
    });
  });
  it("exposes persisted task update ages without new storage or telemetry", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id);
    const o = await f.overview(project.id);
    expect(o.remaining.find((t) => t.ref === task.ref)?.updatedAt).toBe(
      task.updatedAt,
    );
    expect((await f.tree()).version).toBe(1);
  });
});
