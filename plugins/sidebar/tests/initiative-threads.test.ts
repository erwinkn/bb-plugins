import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  hiddenInitiativeThreads,
  initiativeThreadIds,
} from "../lib/initiative-threads";
import {
  MIN_WALK_INTERVAL_MS,
  registerProjectMode,
} from "../lib/project-mode-server";
import type { ProjectTree } from "../lib/project-tree-schema";
import { thread, threadsList, type ThreadLink } from "./fixtures";

const node = (
  threadId: string | null,
  role: "coordinator" | "work" | "review" | "adhoc",
  worker: string | null = null,
) => ({
  threadId,
  label: role,
  role,
  worker,
  parentWorker: null,
  state: "active",
  bbProjectId: "project-1",
});
const tree: ProjectTree = {
  version: 1,
  projects: [
    {
      id: "init-1",
      name: "Initiative",
      objective: "",
      paused: false,
      coordinatorThreadId: "coordinator",
      memberProjectIds: ["project-1"],
      inFlight: 0,
      remaining: 0,
      opinions: 0,
      revisit: 0,
      retired: 0,
      nodes: [
        node("coordinator", "coordinator"),
        node("worker", "work", "W1"),
        node(null, "work", "W2"),
        node("discussion", "adhoc"),
      ],
    },
  ],
};

it("names the coordinator, workers and member threads, and skips nodes without a thread", () => {
  expect(initiativeThreadIds(tree).sort()).toEqual([
    "coordinator",
    "discussion",
    "worker",
  ]);
});

it("hides a worker, its child and grandchild, and the coordinator; keeps a similar unrelated thread", () => {
  const threads = [
    thread({ id: "coordinator", title: "Coordinator" }),
    thread({ id: "worker", title: "W1 build the thing" }),
    thread({ id: "reviewer", parentThreadId: "worker" }),
    thread({ id: "fixer", parentThreadId: "reviewer" }),
    thread({ id: "discussion", title: "Discussion" }),
    // Same shape as a worker's child (a child of a plain thread), same
    // project and title, but no Initiative anywhere in its ancestry.
    thread({ id: "plain-parent", title: "W1 build the thing" }),
    thread({ id: "plain-child", parentThreadId: "plain-parent" }),
  ];
  expect(
    [...hiddenInitiativeThreads(threads, new Set(initiativeThreadIds(tree)))].sort(),
  ).toEqual(["coordinator", "discussion", "fixer", "reviewer", "worker"]);
});

it("hides the descendants of a named parent whose own row is missing", () => {
  const threads = [
    thread({ id: "child", parentThreadId: "worker" }),
    thread({ id: "grandchild", parentThreadId: "child" }),
    thread({ id: "plain" }),
    thread({ id: "orphan", parentThreadId: "gone" }),
  ];
  expect(
    [...hiddenInitiativeThreads(threads, new Set(["worker"]))].sort(),
  ).toEqual(["child", "grandchild"]);
});

it("hides nothing while no Initiative thread is known", () => {
  expect(hiddenInitiativeThreads([thread({ id: "a" })], new Set()).size).toBe(0);
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

it("answers at once from a warmed snapshot while Initiatives reads slowly, and announces the change", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let release: (value: ProjectTree) => void = () => {};
  let reads = 0;
  const h = createFakePluginHost({
    sdk: {
      threads: { list: threadsList([]) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: () => {
          reads += 1;
          return reads === 1
            ? Promise.resolve(tree)
            : new Promise<ProjectTree>((resolve) => (release = resolve));
        },
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    // Cold: answers immediately as loading, and starts the first read.
    expect(await h.harness.callRpc("initiativeThreads", null)).toEqual({
      available: false,
      threadIds: [],
      status: "loading",
    });
    await vi.waitFor(() => expect(h.harness.inspection.realtimeSignals).toHaveLength(1));
    const warmed = (await h.harness.callRpc("initiativeThreads", null)) as {
      threadIds: string[];
      status: string;
    };
    expect(warmed.status).toBe("ready");
    expect([...warmed.threadIds].sort()).toEqual([
      "coordinator",
      "discussion",
      "worker",
    ]);
    // A ledger change inside the interval waits for it, then starts the
    // second read, which hangs: calls still answer at once from the
    // snapshot, and the stalled read starts no other.
    await h.harness.callRpc("initiativesChanged", {});
    expect(reads).toBe(1);
    await advance(MIN_WALK_INTERVAL_MS);
    await vi.waitFor(() => expect(reads).toBe(2));
    const during = (await h.harness.callRpc("initiativeThreads", null)) as {
      status: string;
    };
    expect(during.status).toBe("ready");
    expect(reads).toBe(2);
    release({ ...tree, projects: [{ ...tree.projects[0]!, nodes: [] }] });
    await vi.waitFor(() => expect(h.harness.inspection.realtimeSignals).toHaveLength(3));
    expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
      available: true,
      threadIds: ["coordinator"],
      status: "ready",
    });
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("serves the thread ids from the Initiatives tree, and none while it is not running", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let running = true;
  const h = createFakePluginHost({
    sdk: {
      threads: { list: threadsList([]) },
      plugins: {
        list: async () => ({
          plugins: running
            ? [{ id: "initiatives", enabled: true, status: "running" }]
            : [],
        }),
        callRpc: async () => {
          if (!running) throw new Error('unknown plugin "initiatives"');
          return tree;
        },
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        available: true,
        status: "ready",
      }),
    );
    const answer = await h.harness.callRpc("initiativeThreads", null);
    expect([...(answer as { threadIds: string[] }).threadIds].sort()).toEqual([
      "coordinator",
      "discussion",
      "worker",
    ]);
    running = false;
    await advance(MIN_WALK_INTERVAL_MS);
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toEqual({
        available: false,
        threadIds: [],
        status: "ready",
      }),
    );
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("returns every descendant of an Initiative thread, archived intermediates included", async () => {
  const h = createFakePluginHost({
    sdk: {
      threads: {
        list: threadsList([
          { id: "reviewer", parent: "worker", archived: true },
          { id: "fixer", parent: "reviewer" },
          { id: "fixer-child", parent: "fixer" },
          { id: "plain-child", parent: "plain" },
        ]),
      },
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: async () => tree,
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "ready",
      }),
    );
    const answer = (await h.harness.callRpc("initiativeThreads", null)) as {
      threadIds: string[];
    };
    expect([...answer.threadIds].sort()).toEqual([
      "coordinator",
      "discussion",
      "fixer",
      "fixer-child",
      "reviewer",
      "worker",
    ]);
  } finally {
    await h.harness.dispose();
  }
});

it("reports a failed first read as failed, not as a confirmed empty snapshot, and recovers", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let failing = true;
  const h = createFakePluginHost({
    sdk: {
      threads: { list: threadsList([]) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: async () => {
          if (failing) throw new Error("tree exploded");
          return tree;
        },
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
      status: "loading",
    });
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toEqual({
        available: false,
        threadIds: [],
        status: "failed",
      }),
    );
    // Clients waiting on the first read are told it failed.
    expect(h.harness.inspection.realtimeSignals.length).toBeGreaterThanOrEqual(1);
    failing = false;
    await advance(MIN_WALK_INTERVAL_MS);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        available: true,
        status: "ready",
      }),
    );
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("keeps the last snapshot when a later read fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let failing = false;
  const h = createFakePluginHost({
    sdk: {
      threads: { list: threadsList([]) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: async () => {
          if (failing) throw new Error("tree exploded");
          return tree;
        },
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "ready",
      }),
    );
    failing = true;
    for (let i = 0; i < 3; i++) {
      await advance(MIN_WALK_INTERVAL_MS);
      await h.harness.callRpc("initiativeThreads", null);
      await advance(10);
    }
    expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
      available: true,
      status: "ready",
      threadIds: expect.arrayContaining(["worker"]),
    });
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

// A host whose Initiatives tree names `count` workers, and whose thread store
// the test controls. Each `threads.list` call is counted and tracked while it
// is in flight; an aborted call rejects, as the host's does.
const manyWorkers = (count: number): ProjectTree => ({
  ...tree,
  projects: [
    {
      ...tree.projects[0]!,
      coordinatorThreadId: null,
      nodes: Array.from({ length: count }, (_, i) => node(`w${i}`, "work", `W${i}`)),
    },
  ],
});
function walkHost(opts: {
  tree: ProjectTree;
  list: (q: { parentThreadId?: string; offset?: number }) => Promise<{ id: string }[]>;
}) {
  const stats = { started: 0, inFlight: 0, maxInFlight: 0, treeReads: 0 };
  const h = createFakePluginHost({
    sdk: {
      threads: {
        list: async (
          q: { parentThreadId?: string; offset?: number; signal?: AbortSignal } = {},
        ) => {
          stats.started += 1;
          stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
          try {
            return await new Promise<{ id: string }[]>((resolve, reject) => {
              q.signal?.addEventListener("abort", () => reject(q.signal!.reason));
              opts.list(q).then(resolve, reject);
            });
          } finally {
            stats.inFlight -= 1;
          }
        },
      },
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: async () => {
          stats.treeReads += 1;
          return opts.tree;
        },
      },
    },
  });
  registerProjectMode(h.bb);
  return { h, stats };
}

it("finds a reviewer restored while the walk runs, with its whole subtree", async () => {
  const links: ThreadLink[] = [
    { id: "reviewer", parent: "worker", archived: true },
    { id: "fixer", parent: "reviewer" },
  ];
  const list = threadsList(links);
  const { h } = walkHost({
    tree,
    // The reviewer is restored right after the first read of its parent.
    list: async (q) => {
      const page = await list(q);
      if (q.parentThreadId === "worker") links[0]!.archived = false;
      return page;
    },
  });
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "ready",
      }),
    );
    const answer = (await h.harness.callRpc("initiativeThreads", null)) as {
      threadIds: string[];
    };
    expect(answer.threadIds).toEqual(expect.arrayContaining(["worker", "reviewer", "fixer"]));
  } finally {
    await h.harness.dispose();
  }
});

it("many snapshot reads with no change start one walk per interval", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { h, stats } = walkHost({ tree: manyWorkers(5), list: async () => [] });
  try {
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.started).toBe(5));
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    await advance(MIN_WALK_INTERVAL_MS / 2);
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    expect(stats.treeReads).toBe(1);
    expect(stats.started).toBe(5);
    // The first read after the interval walks again, once.
    await advance(MIN_WALK_INTERVAL_MS / 2);
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.treeReads).toBe(2));
    expect(stats.started).toBe(10);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("coalesces ledger changes into one walk once the interval allows it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { h, stats } = walkHost({ tree: manyWorkers(2), list: async () => [] });
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.treeReads).toBe(1));
    for (let i = 0; i < 20; i++) await h.harness.callRpc("initiativesChanged", {});
    await advance(MIN_WALK_INTERVAL_MS / 2);
    expect(stats.treeReads).toBe(1);
    await advance(MIN_WALK_INTERVAL_MS / 2);
    await vi.waitFor(() => expect(stats.treeReads).toBe(2));
    await advance(MIN_WALK_INTERVAL_MS * 2);
    expect(stats.treeReads).toBe(2);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("a timed-out walk starts no further queries, and repeated walks never exceed the concurrency limit", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const replies: (() => void)[] = [];
  const { h, stats } = walkHost({
    tree: manyWorkers(30),
    // Every read hangs until the test answers it, and a full page would
    // ask for the next one.
    list: () =>
      new Promise((resolve) =>
        replies.push(() => resolve(Array.from({ length: 200 }, (_, i) => ({ id: `c${i}` })))),
      ),
  });
  try {
    for (let round = 0; round < 3; round++) {
      await h.harness.callRpc("initiativesChanged", {});
      await h.harness.callRpc("initiativeThreads", null);
      await advance(MIN_WALK_INTERVAL_MS);
      await vi.waitFor(() => expect(stats.inFlight).toBe(8));
      await advance(60_000); // The walk's deadline.
      await vi.waitFor(() => expect(stats.inFlight).toBe(0));
      const started = stats.started;
      for (const reply of replies.splice(0)) reply(); // Late answers.
      await advance(1_000);
      expect(stats.started).toBe(started);
    }
    expect(stats.maxInFlight).toBe(8);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("a failed page stops the sibling readers before the next walk may start", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let failFirst = true;
  const { h, stats } = walkHost({
    tree: manyWorkers(30),
    list: async (q) => {
      if (failFirst && q.parentThreadId === "w0") {
        failFirst = false;
        throw new Error("page exploded");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return [];
    },
  });
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.started).toBeGreaterThan(0));
    await advance(5_000);
    // The seven siblings were aborted, and none started another read.
    expect(stats.inFlight).toBe(0);
    expect(stats.started).toBe(8);
    await advance(MIN_WALK_INTERVAL_MS);
    await h.harness.callRpc("initiativeThreads", null);
    await advance(MIN_WALK_INTERVAL_MS);
    expect(stats.maxInFlight).toBeLessThanOrEqual(8);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "ready",
      }),
    );
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});
