import { expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  ARCHIVED_LINKS_MS,
  hiddenInitiativeThreads,
  initiativeThreadIds,
} from "../lib/initiative-threads";
import { READ_TIMEOUT_MS } from "../lib/read-timeout";
import {
  MIN_WALK_INTERVAL_MS,
  registerProjectMode,
} from "../lib/project-mode-server";
import type { ProjectTree } from "../lib/project-tree-schema";
import { thread, threadsGet, threadsList, type ThreadLink } from "./fixtures";

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
  const links: ThreadLink[] = [
    { id: "reviewer", parent: "worker", archived: true },
    { id: "fixer", parent: "reviewer" },
    { id: "fixer-child", parent: "fixer" },
    { id: "plain-child", parent: "plain" },
  ];
  const h = createFakePluginHost({
    sdk: {
      threads: {
        list: threadsList(links),
        get: threadsGet(links),
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
// the test controls. Each `threads.list` call is recorded and tracked while it
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
type ListQuery = {
  parentThreadId?: string;
  archived?: boolean;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
};
function walkHost(opts: {
  tree: ProjectTree;
  list: (q: ListQuery) => Promise<{ id: string; parentThreadId?: string | null }[]>;
  // The threads `threads.get` finds; any other id is a 404.
  links?: ThreadLink[];
  get?: (threadId: string) => Promise<{ id: string; parentThreadId: string | null }>;
}) {
  const stats = {
    started: 0,
    inFlight: 0,
    maxInFlight: 0,
    treeReads: 0,
    queries: [] as ListQuery[],
    gets: [] as string[],
  };
  const h = createFakePluginHost({
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          stats.gets.push(threadId);
          return (opts.get ?? ((id) => threadsGet(opts.links ?? [])({ threadId: id })))(threadId);
        },
        list: async ({ signal, ...q }: ListQuery & { signal?: AbortSignal } = {}) => {
          stats.started += 1;
          stats.queries.push(q);
          stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
          try {
            return await new Promise<{ id: string }[]>((resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason));
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
  const mode = registerProjectMode(h.bb);
  return { h, stats, mode };
}
const ready = async (h: ReturnType<typeof walkHost>["h"]) => {
  await h.harness.callRpc("initiativeThreads", null);
  await vi.waitFor(async () =>
    expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
      status: "ready",
    }),
  );
  return ((await h.harness.callRpc("initiativeThreads", null)) as { threadIds: string[] })
    .threadIds;
};

it("finds a reviewer restored while the walk runs, with its whole subtree", async () => {
  const links: ThreadLink[] = [
    { id: "reviewer", parent: "worker", archived: true },
    { id: "fixer", parent: "reviewer" },
  ];
  const list = threadsList(links);
  const { h } = walkHost({
    tree,
    // The reviewer is restored right after the archived threads are read.
    list: async (q) => {
      const page = await list(q);
      if (q.archived === true) links[0]!.archived = false;
      return page;
    },
  });
  try {
    expect(await ready(h)).toEqual(expect.arrayContaining(["worker", "reviewer", "fixer"]));
  } finally {
    await h.harness.dispose();
  }
});

it("reads the thread list by the page, never one call per thread, and the archived threads only every few hours", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // 300 workers, each with an active reviewer, under which sit 2,500
  // archived fixers; 390 unrelated threads.
  const links: ThreadLink[] = [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `w${i}`, parent: null })),
    ...Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, parent: `w${i}` })),
    ...Array.from({ length: 2_500 }, (_, i) => ({
      id: `f${i}`,
      parent: `r${i % 300}`,
      archived: true,
    })),
    ...Array.from({ length: 390 }, (_, i) => ({ id: `p${i}`, parent: null })),
  ];
  const { h, stats } = walkHost({ tree: manyWorkers(300), list: threadsList(links), links });
  try {
    expect(await ready(h)).toHaveLength(300 + 300 + 2_500);
    // ceil(2,500 / 200) archived pages, then ceil(990 / 200) active ones.
    expect(stats.started).toBe(13 + 5);
    expect(stats.queries.every((q) => q.parentThreadId === undefined)).toBe(true);
    expect(stats.queries.every((q) => q.includeHidden === true && q.limit === 200)).toBe(true);
    // Later walks read the active threads only.
    for (let walk = 0; walk < 3; walk++) {
      await advance(MIN_WALK_INTERVAL_MS);
      await h.harness.callRpc("initiativeThreads", null);
      await vi.waitFor(() => expect(stats.started).toBe(18 + 5 * (walk + 1)));
    }
    expect(stats.queries.slice(18).every((q) => q.archived === false)).toBe(true);
    // Once the archived links are old enough, the next walk reads them again.
    await advance(ARCHIVED_LINKS_MS);
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.started).toBe(33 + 18));
    expect(stats.maxInFlight).toBe(1);
    // Every parent was listed, so no thread was read on its own.
    expect(stats.gets).toEqual([]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("keeps hiding the subtree of a thread archived since, and follows a moved thread", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links: ThreadLink[] = [
    { id: "reviewer", parent: "worker" },
    { id: "fixer", parent: "reviewer" },
    { id: "plain-child", parent: "plain" },
  ];
  const { h } = walkHost({ tree, links, list: threadsList(links) });
  const walk = async () => {
    await advance(MIN_WALK_INTERVAL_MS);
    await h.harness.callRpc("initiativeThreads", null);
    await advance(10);
    return ((await h.harness.callRpc("initiativeThreads", null)) as { threadIds: string[] })
      .threadIds;
  };
  try {
    expect(await ready(h)).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    // The reviewer is archived between two reads of the archived threads.
    links[0]!.archived = true;
    expect(await walk()).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    // The fixer moves under a plain thread.
    links[1]!.parent = "plain";
    const moved = await walk();
    expect(moved).toContain("reviewer");
    expect(moved).not.toContain("fixer");
    expect(moved).not.toContain("plain-child");
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

// A host whose threads the test archives, restores and moves, announcing
// archives and restores as BB does.
function eventHost(links: ThreadLink[], list = threadsList(links)) {
  const host = walkHost({ tree, links, list });
  const { h } = host;
  return {
    ...host,
    archive: async (link: ThreadLink, archived: boolean) => {
      link.archived = archived;
      await h.harness.emitThreadEvent(archived ? "thread.archived" : "thread.unarchived", {
        thread: makeThreadResponse({ id: link.id, parentThreadId: link.parent }),
      });
    },
    walk: async () => {
      await advance(MIN_WALK_INTERVAL_MS);
      await h.harness.callRpc("initiativeThreads", null);
      await advance(10);
      return ((await h.harness.callRpc("initiativeThreads", null)) as { threadIds: string[] })
        .threadIds;
    },
  };
}
const family = (): ThreadLink[] => [
  { id: "worker", parent: null },
  { id: "reviewer", parent: "worker" },
  { id: "fixer", parent: "reviewer" },
  { id: "plain", parent: null },
];

it("records the link of a thread moved and archived between reads from its event", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links = family();
  const { h, stats, archive, walk } = eventHost(links);
  try {
    expect(await ready(h)).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    // Between two walks the reviewer moves under a plain thread and is
    // archived with its fixer; the active reads see neither.
    links[1]!.parent = "plain";
    await archive(links[1]!, true);
    await archive(links[2]!, true);
    const ids = await walk();
    expect(ids).not.toContain("reviewer");
    expect(ids).not.toContain("fixer");
    expect(stats.gets).toEqual([]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("an event wins over a page read before it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links = family();
  const list = threadsList(links);
  let race = false;
  const host = eventHost(links, async (q) => {
    const page = await list(q);
    // The page is read; the reviewer then moves, is archived and announced
    // before the page's answer is applied.
    if (race && q?.archived === false) {
      race = false;
      links[1]!.parent = "plain";
      await host.archive(links[1]!, true);
      await host.archive(links[2]!, true);
    }
    return page;
  });
  try {
    expect(await ready(host.h)).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    race = true;
    const ids = await host.walk();
    expect(ids).not.toContain("reviewer");
    expect(ids).not.toContain("fixer");
  } finally {
    await host.h.harness.dispose();
    vi.useRealTimers();
  }
});

it("reads the archived parent of an active thread on every walk, so a move made in the archive shows", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links = family();
  const { h, stats, archive, walk } = eventHost(links);
  try {
    await ready(h);
    await archive(links[1]!, true);
    await archive(links[2]!, true);
    await walk();
    // The archived reviewer moves under a plain thread, which announces
    // nothing; then only the fixer is restored.
    links[1]!.parent = "plain";
    await archive(links[2]!, false);
    const ids = await walk();
    expect(ids).not.toContain("reviewer");
    expect(ids).not.toContain("fixer");
    expect(stats.gets).toEqual(["reviewer"]);
    await walk();
    expect(stats.gets).toEqual(["reviewer", "reviewer"]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("a move made through the Sidebar updates an archived thread's link and walks again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links = family();
  const { h, stats, mode, archive } = eventHost(links);
  try {
    await ready(h);
    await archive(links[1]!, true);
    await archive(links[2]!, true);
    await advance(MIN_WALK_INTERVAL_MS);
    const before = stats.treeReads;
    links[1]!.parent = "plain";
    mode.threadMoved("reviewer", "plain");
    await vi.waitFor(() => expect(stats.treeReads).toBe(before + 1));
    await vi.waitFor(async () =>
      expect(
        ((await h.harness.callRpc("initiativeThreads", null)) as { threadIds: string[] })
          .threadIds,
      ).not.toContain("fixer"),
    );
    expect(stats.gets).toEqual([]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it.each([
  ["its read answers 404", false],
  ["BB announces it", true],
])("a deleted parent no longer hides its surviving child once %s", async (_name, announce) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links = family();
  const { h, walk } = eventHost(links);
  try {
    expect(await ready(h)).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    const [reviewer] = links.splice(1, 1);
    if (announce)
      await h.harness.emitThreadEvent("thread.deleted", {
        thread: makeThreadResponse({ id: reviewer!.id, parentThreadId: reviewer!.parent }),
      });
    expect(await walk()).not.toContain("fixer");
    await advance(ARCHIVED_LINKS_MS);
    expect(await walk()).not.toContain("fixer");
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("reads the parent a restore shifted past an archived page boundary", async () => {
  // 401 archived threads, the reviewer at index 200. Restoring the first
  // one after the first page moves the reviewer to index 199, so the second
  // page starts past it.
  const links: ThreadLink[] = [
    { id: "worker", parent: null },
    ...Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, parent: null, archived: true })),
    { id: "reviewer", parent: "worker", archived: true },
    ...Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, parent: null, archived: true })),
    { id: "fixer", parent: "reviewer" },
  ];
  const list = threadsList(links);
  const { h, stats } = walkHost({
    tree,
    links,
    list: async (q) => {
      const page = await list(q);
      if (q.archived === true && !q.offset) links[1]!.archived = false;
      return page;
    },
  });
  try {
    expect(await ready(h)).toEqual(expect.arrayContaining(["worker", "reviewer", "fixer"]));
    expect(stats.gets).toEqual(["reviewer"]);
  } finally {
    await h.harness.dispose();
  }
});

it("reads a deleted parent again only with the next archived read", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links: ThreadLink[] = [{ id: "orphan", parent: "deleted" }];
  const { h, stats } = walkHost({ tree, links, list: threadsList(links) });
  try {
    await ready(h);
    expect(stats.gets).toEqual(expect.arrayContaining(["deleted"]));
    const first = stats.gets.length;
    for (let walk = 0; walk < 3; walk++) {
      await advance(MIN_WALK_INTERVAL_MS);
      await h.harness.callRpc("initiativeThreads", null);
    }
    await advance(10);
    expect(stats.gets).toHaveLength(first);
    await advance(ARCHIVED_LINKS_MS);
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.gets).toHaveLength(first * 2));
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("a parent read that fails for another reason fails the walk, and the next walk reads it again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const links: ThreadLink[] = [
    { id: "worker", parent: null },
    { id: "reviewer", parent: "worker", archived: true },
    { id: "fixer", parent: "reviewer" },
  ];
  // The archived read misses the reviewer (as a shifted page would).
  const list = threadsList(links);
  let unavailable = true;
  const { h, stats } = walkHost({
    tree,
    list: async (q) => (await list(q)).filter((row) => row.id !== "reviewer"),
    get: async (threadId) => {
      if (unavailable) {
        unavailable = false;
        throw Object.assign(new Error("unavailable"), { status: 503 });
      }
      return threadsGet(links)({ threadId });
    },
  });
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "failed",
      }),
    );
    await advance(MIN_WALK_INTERVAL_MS);
    expect(await ready(h)).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    expect(stats.gets).toEqual(["reviewer", "reviewer"]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("many snapshot reads with no change start one walk per interval", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { h, stats } = walkHost({ tree: manyWorkers(5), list: async () => [] });
  try {
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    // The first walk reads the archived threads, then the active ones.
    await vi.waitFor(() => expect(stats.started).toBe(2));
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    await advance(MIN_WALK_INTERVAL_MS / 2);
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    expect(stats.treeReads).toBe(1);
    expect(stats.started).toBe(2);
    // The first read after the interval walks again, once.
    await advance(MIN_WALK_INTERVAL_MS / 2);
    for (let i = 0; i < 50; i++) await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(() => expect(stats.treeReads).toBe(2));
    await vi.waitFor(() => expect(stats.started).toBe(3));
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

it("a timed-out walk starts no further reads, even when its late page asks for the next one", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const replies: (() => void)[] = [];
  const { h, stats } = walkHost({
    tree: manyWorkers(3),
    // Every read hangs until the test answers it, and a full page would ask
    // for the next one.
    list: () =>
      new Promise((resolve) =>
        replies.push(() => resolve(Array.from({ length: 200 }, (_, i) => ({ id: `c${i}` })))),
      ),
  });
  try {
    for (let round = 0; round < 3; round++) {
      await advance(MIN_WALK_INTERVAL_MS); // The next walk may start.
      await h.harness.callRpc("initiativeThreads", null);
      await vi.waitFor(() => expect(stats.inFlight).toBe(1));
      await advance(READ_TIMEOUT_MS); // The walk's deadline.
      await vi.waitFor(() => expect(stats.inFlight).toBe(0));
      const started = stats.started;
      for (const reply of replies.splice(0)) reply(); // Late answers.
      await advance(1_000);
      expect(stats.started).toBe(started);
    }
    expect(stats.maxInFlight).toBe(1);
    // No walk finished, so none recorded the archived threads as read.
    expect(stats.queries.every((q) => q.archived === true)).toBe(true);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("a failed archived read is retried by the next walk, and the snapshot recovers", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let failArchived = true;
  const { h, stats } = walkHost({
    tree: manyWorkers(2),
    list: async (q) => {
      if (failArchived && q.archived) {
        failArchived = false;
        throw new Error("page exploded");
      }
      return [];
    },
  });
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "failed",
      }),
    );
    expect(stats.started).toBe(1);
    await advance(MIN_WALK_INTERVAL_MS);
    expect(await ready(h)).toEqual(["w0", "w1"]);
    expect(stats.queries.map((q) => q.archived)).toEqual([true, true, false]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("a failed active read keeps the archived links it follows, and the next walk recovers", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let failActive = true;
  const links: ThreadLink[] = [
    { id: "reviewer", parent: "worker", archived: true },
    { id: "fixer", parent: "reviewer" },
  ];
  const list = threadsList(links);
  const { h, stats } = walkHost({
    tree,
    links,
    list: async (q) => {
      if (failActive && q.archived === false) {
        failActive = false;
        throw new Error("page exploded");
      }
      return list(q);
    },
  });
  try {
    await h.harness.callRpc("initiativeThreads", null);
    await vi.waitFor(async () =>
      expect(await h.harness.callRpc("initiativeThreads", null)).toMatchObject({
        status: "failed",
      }),
    );
    await advance(MIN_WALK_INTERVAL_MS);
    expect(await ready(h)).toEqual(expect.arrayContaining(["reviewer", "fixer"]));
    expect(stats.queries.map((q) => q.archived)).toEqual([true, false, false]);
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});
