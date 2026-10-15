import { describe, expect, it } from "vitest";
import {
  lastActivity,
  orderedProjects,
  owningProject,
  projectStatus,
  projectThreads,
} from "../lib/project-mode-status";
import type { ProjectTree } from "../lib/project-tree-schema";
import { thread } from "./fixtures";
const project: ProjectTree["projects"][number] = {
  id: "p",
  name: "Search",
  objective: "Search",
  paused: false,
  memberProjectIds: ["repo"],
  coordinatorThreadId: "c",
  inFlight: 0,
  remaining: 1,
  opinions: 0,
  revisit: 0,
  retired: 0,
  nodes: [
    {
      threadId: "c",
      role: "coordinator",
      worker: null,
      parentWorker: null,
      label: "Coordinator",
      bbProjectId: "repo",
      state: "coordinating",
    },
    {
      threadId: "w",
      role: "work",
      worker: "W1",
      parentWorker: null,
      label: "Worker",
      bbProjectId: "repo",
      state: "idle",
    },
  ],
};
describe("aggregate project status", () => {
  it("prioritizes user attention over work and drafts", () => {
    const threads = [
      thread({ id: "c", isUnread: true }),
      thread({ id: "w", indicator: "runtime" }),
    ];
    expect(projectStatus(project, threads, ["thread:c"])).toBe("unread");
    expect(
      projectStatus(
        project,
        [thread({ id: "c", indicator: "unread-success" })],
        [],
      ),
    ).toBe("unread");
    expect(
      projectStatus({ ...project, opinions: 1 }, threads.slice(1), []),
    ).toBe("attention");
    expect(
      projectStatus(
        project,
        [thread({ id: "w", hasPendingInteraction: true })],
        [],
      ),
    ).toBe("unread");
  });
  it("treats revisit reminders as metadata, not attention", () => {
    const revisiting = { ...project, revisit: 3 };
    expect(
      projectStatus(revisiting, [thread({ id: "c" }), thread({ id: "w" })], []),
    ).toBe("done");
    expect(
      projectStatus(revisiting, [thread({ id: "w", indicator: "runtime" })], []),
    ).toBe("working");
    expect(projectStatus(revisiting, [], ["thread:w"])).toBe("draft");
    expect(projectStatus({ ...revisiting, opinions: 1 }, [], [])).toBe(
      "attention",
    );
    expect(
      projectStatus(revisiting, [thread({ id: "c", isUnread: true })], []),
    ).toBe("unread");
    expect(
      projectStatus(
        revisiting,
        [thread({ id: "w", hasPendingInteraction: true })],
        [],
      ),
    ).toBe("unread");
  });
  it("T114 ranks what waits on the user above unread, work and drafts, and clears with it", () => {
    const busy = [thread({ id: "c", isUnread: true }), thread({ id: "w", indicator: "runtime" })];
    // A blocked report counts even with no open question; older trees fall back to opinions.
    expect(projectStatus({ ...project, opinions: 0, needsYou: 1 }, busy, ["thread:c"])).toBe("attention");
    expect(projectStatus({ ...project, opinions: 2 }, busy, [])).toBe("attention");
    expect(projectStatus({ ...project, opinions: 0, needsYou: 0 }, busy, [])).toBe("unread");
  });
  it("lets ordinary worker completion wait for the coordinator", () => {
    expect(
      projectStatus(project, [thread({ id: "w", isUnread: true })], []),
    ).toBe("done");
  });
  it("counts nested live work while excluding archived and unrelated threads", () => {
    const threads = projectThreads(project, [
      thread({ id: "c" }),
      thread({ id: "child", parentThreadId: "c" }),
      thread({
        id: "grandchild",
        parentThreadId: "child",
        indicator: "background-command",
      }),
      thread({
        id: "archived",
        parentThreadId: "c",
        isArchived: true,
        indicator: "runtime",
      }),
      thread({ id: "unrelated", indicator: "runtime" }),
    ]);
    expect(threads.map((t) => t.id)).toEqual(["c", "child", "grandchild"]);
    expect(projectStatus(project, threads, ["thread:c"])).toBe("working");
    expect(projectStatus(project, threads.slice(0, 2), ["thread:c"])).toBe(
      "draft",
    );
  });
  it("recognizes attachment-only observed drafts and new repository drafts", () => {
    expect(projectStatus(project, [], ["thread:w"])).toBe("draft");
    expect(projectStatus(project, [], ["new:repo"])).toBe("draft");
  });
});

describe("last activity", () => {
  it("is the newest update among the Initiative's threads", () => {
    expect(
      lastActivity([
        thread({ id: "c", updatedAt: 300 }),
        thread({ id: "w", updatedAt: 900 }),
        thread({ id: "r", updatedAt: 500 }),
      ]),
    ).toBe(900);
  });
  it("is null without threads", () => {
    expect(lastActivity([])).toBeNull();
  });
});

describe("ordered projects", () => {
  const p = (id: string): ProjectTree["projects"][number] => ({
    ...project,
    id,
  });
  it("keeps the saved order over the tree's order", () => {
    const rows = orderedProjects([p("a"), p("b"), p("c")], ["c", "a"]);
    expect(rows.map((row) => row.id)).toEqual(["c", "a", "b"]);
  });
  it("falls back to tree order without a saved order", () => {
    const rows = orderedProjects([p("a"), p("b")], null);
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });
  it("skips ids absent from the tree and collapses duplicates", () => {
    const rows = orderedProjects([p("a"), p("b")], [
      "gone",
      "b",
      "b",
      "a",
    ]);
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
  });
});

describe("owningProject", () => {
  // B's coordinator and worker hang under A's coordinator natively.
  const b = {
    ...project,
    id: "b",
    coordinatorThreadId: "c-b",
    nodes: [
      { ...project.nodes[0]!, threadId: "c-b" },
      { ...project.nodes[1]!, threadId: "w-b", worker: "W2" },
    ],
  };
  // BB's list omits the archived reviewer between w and helper.
  const native = [
    thread({ id: "c" }),
    thread({ id: "w", parentThreadId: "c" }),
    thread({ id: "c-b", parentThreadId: "c" }),
    thread({ id: "w-b", parentThreadId: "c-b" }),
    thread({ id: "helper", parentThreadId: "reviewer" }),
    thread({ id: "loop-a", parentThreadId: "loop-b" }),
    thread({ id: "loop-b", parentThreadId: "loop-a" }),
    thread({ id: "plain" }),
  ];
  const owner = (id: string | null, links?: Map<string, string | null>) =>
    owningProject([project, b], native, id, links);
  it("prefers the Adventure that names a thread over one it descends from", () => {
    expect(owner("w-b").owner).toBe("b");
    expect(owner("c-b").owner).toBe("b");
    expect(owner("w").owner).toBe("p");
  });
  it("names the thread whose link it lacks, and follows the host's links past it", () => {
    expect(owner("helper")).toEqual({ owner: null, unknown: "reviewer" });
    expect(owner("helper", new Map([["reviewer", "w"]]))).toEqual({ owner: "p", unknown: null });
  });
  it("answers null outside every Adventure, through a parent cycle too", () => {
    expect(owner("plain")).toEqual({ owner: null, unknown: null });
    expect(owner("loop-a")).toEqual({ owner: null, unknown: null });
    expect(owner(null)).toEqual({ owner: null, unknown: null });
  });
});
