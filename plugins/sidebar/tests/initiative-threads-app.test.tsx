// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { READ_TIMEOUT_MS } from "../lib/read-timeout";
import { registerProjectMode } from "../lib/project-mode-server";
import { parseState, updateState } from "../lib/client-state";
import {
  persistedQueries,
  seedInitiativeCache,
  thread,
  threadsList,
  type ThreadLink,
} from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const { SAFETY_POLL_MS } = await import("../lib/queries");
const projects = [{ id: "project-1", name: "One", isPersonal: false }];
const threads = [
  thread({ id: "plain", title: "Plain thread" }),
  thread({ id: "coordinator", title: "Coordinator" }),
  thread({ id: "worker", title: "Worker", isPinned: true }),
  thread({ id: "reviewer", title: "Reviewer", parentThreadId: "worker" }),
  thread({ id: "plain-child", title: "Plain child", parentThreadId: "plain" }),
];
const props = {
  activeThreadId: "plain",
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
const mounted: ReturnType<typeof renderSlot>[] = [];
const mount = (rpc: Record<string, (input: unknown) => unknown>) => {
  const slot = renderSlot(
    app.threadLists[0],
    props,
    { sidebarThreads: { threads, projects }, rpc },
  );
  mounted.push(slot);
  return slot;
};
// A query settles over a few macrotasks: its retry, then the batched notify.
const tick = () =>
  act(async () => {
    for (let hop = 0; hop < 8; hop++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
const rows = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-sidebar-thread-id]")).map(
    (node) => node.getAttribute("data-sidebar-thread-id"),
  );
const base = {
  listArchived: async () => [],
};

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

it("hides Initiative threads, a pinned worker and their descendants from the Threads view", async () => {
  const slot = mount({
    ...base,
    initiativeThreads: async () => ({
      available: true,
      threadIds: ["coordinator", "worker"],
      status: "ready",
    }),
  });
  await tick();
  expect(rows(slot)).toContain("plain");
  expect(rows(slot)).toContain("plain-child");
  for (const id of ["coordinator", "worker", "reviewer"])
    expect(rows(slot)).not.toContain(id);
});

it("shows every thread while Initiatives is not available", async () => {
  const slot = mount({
    ...base,
    initiativeThreads: async () => ({ available: false, threadIds: [], status: "ready" }),
  });
  await tick();
  expect(rows(slot).sort()).toEqual(
    ["coordinator", "plain", "plain-child", "reviewer", "worker"].sort(),
  );
});

it("hides from the cache before the server answers", async () => {
  seedInitiativeCache(["worker", "coordinator"]);
  const slot = mount({
    ...base,
    initiativeThreads: () => new Promise(() => {}),
  });
  await tick();
  expect(rows(slot)).not.toContain("worker");
  expect(rows(slot)).not.toContain("reviewer");
  expect(rows(slot)).toContain("plain");
});

it("hides the descendants of a named worker whose own row is missing", async () => {
  const rowsWithoutWorker = [
    thread({ id: "plain", title: "Plain thread" }),
    thread({ id: "child", title: "Child", parentThreadId: "worker" }),
    thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
  ];
  const slot = renderSlot(
    app.threadLists[0],
    props,
    {
      sidebarThreads: { threads: rowsWithoutWorker, projects },
      rpc: {
        ...base,
        initiativeThreads: async () => ({
          available: true,
          threadIds: ["worker"],
          status: "ready",
        }),
      },
    },
  );
  mounted.push(slot);
  await tick();
  expect(rows(slot)).toEqual(["plain"]);
});

it("shows a loading placeholder, not the threads, until the first answer arrives", async () => {
  let answer: (value: unknown) => void = () => {};
  const slot = mount({
    ...base,
    initiativeThreads: () => new Promise((resolve) => (answer = resolve)),
  });
  await tick();
  expect(rows(slot)).toEqual([]);
  expect(slot.getByText("Loading threads…")).toBeTruthy();
  await act(async () => {
    answer({ available: true, threadIds: ["worker"], status: "ready" });
  });
  await tick();
  expect(rows(slot)).toContain("plain");
  expect(rows(slot)).not.toContain("worker");
  expect(slot.queryByText("Loading threads…")).toBeNull();
});

it("keeps waiting while the server reports its first read as loading, then lists after its signal", async () => {
  let answers = 0;
  const slot = mount({
    ...base,
    initiativeThreads: async () =>
      ++answers === 1
        ? { available: false, threadIds: [], status: "loading" }
        : { available: true, threadIds: ["worker"], status: "ready" },
  });
  await tick();
  expect(rows(slot)).toEqual([]);
  await slot.behavior.emitRealtime("initiative-threads-changed", {});
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(rows(slot)).not.toContain("worker");
  expect(rows(slot)).toContain("plain");
});

it("treats a cached empty set as known, so the list shows without waiting", async () => {
  seedInitiativeCache();
  const slot = mount({ ...base, initiativeThreads: () => new Promise(() => {}) });
  await tick();
  expect(rows(slot)).toContain("worker");
});

it("keeps the cached set during a slow background refresh", async () => {
  seedInitiativeCache(["worker"]);
  const slot = mount({
    ...base,
    initiativeThreads: () => new Promise(() => {}),
  });
  await tick();
  expect(slot.queryByText("Loading threads…")).toBeNull();
  expect(rows(slot)).not.toContain("worker");
  expect(rows(slot)).toContain("plain");
});

it("recovers from a stalled read: the next read is made and its answer applies", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    seedInitiativeCache();
    const read = vi.fn((_input: unknown) =>
      read.mock.calls.length === 1
        ? new Promise(() => {})
        : { available: true, threadIds: ["worker"], status: "ready" },
    );
    const slot = mount({ ...base, initiativeThreads: read });
    await tick();
    expect(rows(slot)).toContain("worker");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 250);
    });
    await vi.waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await tick();
    expect(rows(slot)).not.toContain("worker");
  } finally {
    vi.useRealTimers();
  }
});

it("stops waiting when the first read fails, and corrects itself on the next success", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    // The read and its quiet retry both fail.
    const read = vi.fn((_input: unknown) =>
      read.mock.calls.length <= 2
        ? Promise.reject(new Error("down"))
        : { available: true, threadIds: ["worker"], status: "ready" },
    );
    const slot = mount({ ...base, initiativeThreads: read });
    await tick();
    expect(rows(slot)).toContain("worker");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS + 250);
    });
    await vi.waitFor(() => expect(rows(slot)).not.toContain("worker"));
  } finally {
    vi.useRealTimers();
  }
});

/** The persisted thread-id set, as JSON, or null when none is stored. */
it("stays settled after a failed first read while a later read is in flight", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    // The read and its quiet retry fail; the poll's read never answers.
    const read = vi.fn((_input: unknown) =>
      read.mock.calls.length <= 2 ? Promise.reject(new Error("down")) : new Promise(() => {}),
    );
    const slot = mount({ ...base, initiativeThreads: read });
    await tick();
    expect(rows(slot)).toContain("plain");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS + 250);
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(slot.queryByText("Loading threads…")).toBeNull();
    expect(rows(slot)).toContain("plain");
  } finally {
    vi.useRealTimers();
  }
});

const cached = () => {
  const stored = persistedQueries()["initiative-threads"]?.[0];
  return stored ? JSON.stringify(stored) : null;
};
/** Delivers the server's realtime signals to the sidebar, as BB does. */
const relay = (
  h: Awaited<ReturnType<typeof serverHost>>,
  slot: ReturnType<typeof renderSlot>,
) => {
  let sent = 0;
  return async () => {
    const signals = h.harness.inspection.realtimeSignals;
    while (sent < signals.length) {
      const { channel, payload } = signals[sent++]!;
      await slot.behavior.emitRealtime(channel, payload);
    }
  };
};

// The real server behind the RPC, with a host whose Initiatives tree read
// and thread store the test controls.
async function serverHost(opts: {
  tree: () => unknown;
  links?: ThreadLink[];
  list?: ReturnType<typeof threadsList>;
}) {
  const links = opts.links ?? [];
  const h = createFakePluginHost({
    sdk: {
      threads: { list: opts.list ?? threadsList(links) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: async () => opts.tree(),
      },
    },
  });
  registerProjectMode(h.bb);
  return h;
}
const treeOf = (...ids: string[]) => ({
  version: 1,
  projects: [
    {
      id: "init-1",
      name: "Initiative",
      objective: "",
      paused: false,
      coordinatorThreadId: null,
      memberProjectIds: ["project-1"],
      inFlight: 0,
      remaining: 0,
      opinions: 0,
      revisit: 0,
      retired: 0,
      nodes: ids.map((threadId) => ({
        threadId,
        label: "w",
        role: "work",
        worker: "W1",
        parentWorker: null,
        state: "active",
        bbProjectId: "project-1",
      })),
    },
  ],
});

it("a warm client keeps its ids and cache when a cold server's first read fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const h = await serverHost({
    tree: () => {
      throw new Error("tree exploded");
    },
  });
  try {
    seedInitiativeCache(["worker"]);
    const slot = mount({
      ...base,
      initiativeThreads: () => h.harness.callRpc("initiativeThreads", null),
    });
    await tick();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS + 1_000);
    });
    await tick();
    expect(rows(slot)).not.toContain("worker");
    expect(rows(slot)).not.toContain("reviewer");
    expect(rows(slot)).toContain("plain");
    expect(cached()).toBe('["worker"]');
  } finally {
    await h.harness.dispose();
    vi.useRealTimers();
  }
});

it("an uncached client fails open when the cold server's first read fails, without caching", async () => {
  const h = await serverHost({
    tree: () => {
      throw new Error("tree exploded");
    },
  });
  try {
    const slot = mount({
      ...base,
      initiativeThreads: () => h.harness.callRpc("initiativeThreads", null),
    });
    const signals = relay(h, slot);
    await vi.waitFor(async () => {
      await signals();
      await tick();
      expect(rows(slot)).toContain("plain");
    });
    expect(slot.queryByText("Loading threads…")).toBeNull();
    expect(cached()).toBeNull();
  } finally {
    await h.harness.dispose();
  }
});

it("hides a restored fixer under an archived reviewer the ledger never recorded", async () => {
  const h = await serverHost({
    tree: () => treeOf("worker"),
    links: [
      { id: "reviewer", parent: "worker", archived: true },
      { id: "fixer", parent: "reviewer" },
    ],
  });
  try {
    const withFixer = [
      thread({ id: "plain", title: "Plain thread" }),
      thread({ id: "fixer", title: "Fixer", parentThreadId: "reviewer" }),
    ];
    const slot = renderSlot(
      app.threadLists[0],
      props,
      {
        sidebarThreads: { threads: withFixer, projects },
        rpc: {
          ...base,
          initiativeThreads: () => h.harness.callRpc("initiativeThreads", null),
        },
      },
    );
    mounted.push(slot);
    const signals = relay(h, slot);
    await vi.waitFor(async () => {
      await signals();
      await tick();
      expect(rows(slot)).toEqual(["plain"]);
    });
  } finally {
    await h.harness.dispose();
  }
});

it("keeps a reviewer restored mid-walk, and its subtree, in the cache of a client that lists only the fixer", async () => {
  const links: ThreadLink[] = [
    { id: "reviewer", parent: "worker", archived: true },
    { id: "fixer", parent: "reviewer" },
  ];
  const list = threadsList(links);
  const h = await serverHost({
    tree: () => treeOf("worker"),
    // The reviewer is restored right after the first read of its parent.
    list: async (q) => {
      const page = await list(q);
      if (q?.parentThreadId === "worker") links[0]!.archived = false;
      return page;
    },
  });
  try {
    seedInitiativeCache(["worker", "reviewer", "fixer"]);
    let ready = 0;
    const slot = renderSlot(
      app.threadLists[0],
      props,
      {
        sidebarThreads: {
          threads: [
            thread({ id: "plain", title: "Plain thread" }),
            thread({ id: "fixer", title: "Fixer", parentThreadId: "reviewer" }),
          ],
          projects,
        },
        rpc: {
          ...base,
          initiativeThreads: async () => {
            const answer = (await h.harness.callRpc("initiativeThreads", null)) as {
              status: string;
            };
            if (answer.status === "ready") ready += 1;
            return answer;
          },
        },
      },
    );
    mounted.push(slot);
    // The client has applied a confirmed answer from the real server.
    const signals = relay(h, slot);
    await vi.waitFor(async () => {
      await signals();
      expect(ready).toBeGreaterThan(0);
    });
    await tick();
    await tick();
    expect(rows(slot)).toEqual(["plain"]);
    // Writes to storage are throttled to one a second.
    await vi.waitFor(() =>
      expect(JSON.parse(cached()!).sort()).toEqual(["fixer", "reviewer", "worker"]),
    { timeout: 2_000 });
  } finally {
    await h.harness.dispose();
  }
});

it("uses the loaded archived rows' parent links when the server snapshot is stale", async () => {
  const archivedReviewer = {
    id: "reviewer",
    projectId: "project-1",
    title: "Reviewer",
    titleFallback: null,
    parentThreadId: "worker",
    providerId: "codex",
    createdAt: 1,
    updatedAt: 1,
    environmentId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other",
  };
  updateState((current) => ({ ...current, showArchives: true }));
  const slot = renderSlot(
    app.threadLists[0],
    props,
    {
      sidebarThreads: {
        threads: [
          thread({ id: "plain", title: "Plain thread" }),
          thread({ id: "fixer", title: "Fixer", parentThreadId: "reviewer" }),
        ],
        projects,
      },
      rpc: {
        ...base,
        listArchived: async () => [archivedReviewer],
        initiativeThreads: async () => ({
          available: true,
          threadIds: ["worker"],
          status: "ready",
        }),
      },
    },
  );
  mounted.push(slot);
  await tick();
  await tick();
  expect(
    rows(slot).filter((id) => id === "plain" || id === "fixer"),
  ).toEqual(["plain"]);
});

it("caches a confirmed-empty answer that follows a failed first request", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const read = vi.fn((_input: unknown) =>
      read.mock.calls.length <= 2
        ? Promise.reject(new Error("down"))
        : { available: true, threadIds: [], status: "ready" },
    );
    const slot = mount({ ...base, initiativeThreads: read });
    await tick();
    expect(rows(slot)).toContain("worker");
    expect(cached()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS + 250);
    });
    await vi.waitFor(() => expect(cached()).toBe("[]"));
  } finally {
    vi.useRealTimers();
  }
});
