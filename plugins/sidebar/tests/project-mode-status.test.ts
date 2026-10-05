import { describe, expect, it } from "vitest";
import {
  currentProjectThreads,
  orderedProjects,
  projectStatus,
  projectThreads,
  selectedProject,
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
    ).toBe("unread");
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
      "unread",
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

describe("selected project", () => {
  const other: ProjectTree["projects"][number] = {
    ...project,
    id: "p2",
    coordinatorThreadId: "c2",
    memberProjectIds: ["other-repo"],
    nodes: [],
  };
  const projects = [project, other];
  it("prefers a coordinator or worker match over project membership", () => {
    // A thread that is both another project's coordinator and inside this
    // project's member ids resolves to its own project.
    const threads = [thread({ id: "c2", projectId: "repo" })];
    expect(selectedProject(projects, threads, "c2", null)?.id).toBe("p2");
    expect(selectedProject(projects, threads, "w", null)?.id).toBe("p");
  });
  it("selects through the viewed thread's native project", () => {
    const threads = [thread({ id: "plain", projectId: "other-repo" })];
    expect(selectedProject(projects, threads, "plain", null)?.id).toBe("p2");
  });
  it("falls back to the route's project context", () => {
    expect(selectedProject(projects, [], null, "repo")?.id).toBe("p");
    expect(selectedProject(projects, [], null, null)).toBeNull();
    expect(selectedProject(projects, [], "missing", null)).toBeNull();
  });
});

describe("current project threads", () => {
  const built = (threads: Parameters<typeof currentProjectThreads>[1]) =>
    currentProjectThreads(project, threads, [], "updated", "descending");
  it("lists live workers without the coordinator, in node order", () => {
    const nodes = built([
      thread({ id: "c", indicator: "runtime" }),
      thread({ id: "w" }),
    ]);
    expect(nodes.map((n) => n.thread.id)).toEqual(["w"]);
    expect(nodes[0].status).toBe("done");
  });
  it("skips archived and missing worker threads quietly", () => {
    const archived = built([
      thread({ id: "w", isArchived: true }),
      thread({ id: "c" }),
    ]);
    expect(archived).toEqual([]);
    const missing = built([thread({ id: "c" })]);
    expect(missing).toEqual([]);
  });
  it("keeps live descendants and walks past settled ones", () => {
    const nodes = built([
      thread({ id: "c" }),
      thread({ id: "w" }),
      // Former generations hang off the coordinator and are never reached.
      thread({
        id: "former",
        parentThreadId: "c",
        indicator: "runtime",
      }),
      thread({ id: "done", parentThreadId: "w" }),
      thread({
        id: "grandchild",
        parentThreadId: "done",
        indicator: "runtime",
      }),
      thread({
        id: "attention",
        parentThreadId: "w",
        hasPendingInteraction: true,
      }),
    ]);
    expect(nodes.map((n) => n.thread.id)).toEqual(["w"]);
    // The settled child is skipped; its working descendant is flattened onto
    // the worker and the attention row keeps its real status.
    expect(nodes[0].children.map((n) => n.thread.id)).toEqual([
      "attention",
      "grandchild",
    ]);
    expect(nodes[0].children[0].status).toBe("attention");
    expect(nodes[0].children[1].status).toBe("working");
  });
  it("keeps workers as roots even when one is a native child of another", () => {
    const forked = {
      ...project,
      nodes: [
        ...project.nodes,
        {
          threadId: "w2",
          role: "work" as const,
          worker: "W2",
          parentWorker: "W1",
          label: "Reviewer",
          bbProjectId: "repo",
          state: "active",
        },
      ],
    };
    const nodes = currentProjectThreads(
      forked,
      [
        thread({ id: "c" }),
        thread({ id: "w" }),
        thread({ id: "w2", parentThreadId: "w" }),
      ],
      [],
      "updated",
      "descending",
    );
    expect(nodes.map((n) => n.thread.id)).toEqual(["w", "w2"]);
    expect(nodes[0].children).toEqual([]);
  });
  it("carries the ledger's W# and label as node identity", () => {
    const nodes = currentProjectThreads(
      {
        ...project,
        nodes: [
          ...project.nodes,
          {
            threadId: "w2",
            role: "review" as const,
            worker: "W2",
            parentWorker: null,
            label: "Reviewer",
            bbProjectId: "repo",
            state: "active",
          },
        ],
      },
      [
        thread({ id: "c" }),
        thread({ id: "w", title: "A mutable native title" }),
        thread({ id: "w2", parentThreadId: "w", indicator: "runtime" }),
        // A nested child with no ledger row keeps no identity — its row
        // falls back to the native title.
        thread({ id: "plain", parentThreadId: "w", indicator: "runtime" }),
      ],
      [],
      "updated",
      "descending",
    );
    // Every ledger worker is a root with its stable identity; the mutable
    // native title never reaches the row's display identity.
    expect(nodes.map((n) => n.identity)).toEqual([
      { worker: "W1", label: "Worker" },
      { worker: "W2", label: "Reviewer" },
    ]);
    const nested = nodes[0].children.map((n) => n.identity);
    expect(nested).toEqual([null]);
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
