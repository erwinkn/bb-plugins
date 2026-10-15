import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { adventureWorkers, modelLabel, type OverviewSlice } from "../lib/adventure-workers";
import { adventureRows, withoutRef } from "../lib/adventure-rows";
import {
  createWorkerFacts,
  FACTS_INTERVAL_MS,
  WANTED_MS,
} from "../lib/adventure-workers-server";
import { registerProjectMode } from "../lib/project-mode-server";
import { READ_TIMEOUT_MS } from "../lib/read-timeout";
import { thread } from "./fixtures";

type Current = OverviewSlice["workers"]["current"][number];
const worker = (ref: string, patch: Partial<Current> = {}): Current => ({
  ref,
  profile: null,
  runtime: "idle",
  open: null,
  stopReason: null,
  latestReport: null,
  ...patch,
});

describe("adventureWorkers", () => {
  it("groups each worker by the Workers tab's rules", () => {
    const groups = adventureWorkers({
      workers: {
        current: [
          worker("W1", { runtime: "active", open: {} }),
          worker("W2", { runtime: "active" }),
          worker("W3", { open: {} }),
          worker("W4", { latestReport: { outcome: "done" } }),
          worker("W5", { latestReport: { outcome: "blocked" } }),
          worker("W6"),
          worker("W7", { runtime: "failed", latestReport: { outcome: "done" } }),
          worker("W8"),
          worker("W9", { stopReason: "Superseded", latestReport: { outcome: "done" } }),
        ],
      },
      blockers: [
        // An open blocker outranks a running thread.
        { owner: { worker: "W1" } },
        // An answered one no longer needs you.
        { owner: { worker: "W5" }, answer: { note: "Go" } },
      ],
      workerWaiting: { W8: { on: { title: "Reviewer" } }, W6: { on: null } },
    }).map((w) => `${w.ref}:${w.group}`);
    expect(groups).toEqual([
      "W1:needs",
      "W2:working",
      "W3:stopped",
      "W4:done",
      "W5:stopped",
      "W6:idle",
      "W7:stopped",
      "W8:working",
      "W9:stopped",
    ]);
  });

  it("names the model and its reasoning as the Workers tab does", () => {
    expect(modelLabel("claude-code / claude-opus-5-5 / high / tier unspecified")).toBe("Opus 5.5 · high");
    expect(modelLabel("codex / gpt-6.1-sol / xhigh")).toBe("Sol 6.1 · xhigh");
    expect(modelLabel("pi / some-model")).toBe("some-model");
    expect(modelLabel(null)).toBeNull();
  });
});

describe("adventureRows", () => {
  const project = {
    id: "p1",
    name: "Search",
    objective: "",
    paused: false,
    coordinatorThreadId: "c",
    memberProjectIds: ["project-1"],
    inFlight: 0,
    remaining: 0,
    opinions: 0,
    revisit: 0,
    retired: 0,
    nodes: [
      { threadId: "c", label: "Coordinator", role: "coordinator" as const, worker: null, parentWorker: null, state: "coordinating", bbProjectId: "project-1" },
      { threadId: "w1", label: "One", role: "work" as const, worker: "W1", parentWorker: null, state: "active", bbProjectId: "project-1" },
      { threadId: "w2", label: "Two", role: "review" as const, worker: "W2", parentWorker: null, state: "active", bbProjectId: "project-1" },
      { threadId: "w9", label: "Gone", role: "work" as const, worker: "W9", parentWorker: null, state: "active", bbProjectId: "project-1" },
      { threadId: "member", label: "Member", role: "adhoc" as const, worker: null, parentWorker: null, state: "member", bbProjectId: "project-1" },
      { threadId: "orphan", label: "Orphan", role: "adhoc" as const, worker: null, parentWorker: null, state: "member", bbProjectId: "project-1" },
      { threadId: "past", label: "Past", role: "adhoc" as const, worker: null, parentWorker: null, state: "member", bbProjectId: "project-1" },
    ],
  };
  const native = [
    thread({ id: "c" }),
    thread({ id: "w1", parentThreadId: "c", updatedAt: 100 }),
    // A worker nested natively under another worker is a row of its own.
    thread({ id: "w2", parentThreadId: "w1", updatedAt: 300, indicator: "waiting-for-input" }),
    thread({ id: "w9", isArchived: true }),
    thread({ id: "child", parentThreadId: "w1", updatedAt: 50 }),
    thread({ id: "old-child", parentThreadId: "w1", isArchived: true }),
    // A former worker's thread hangs off the coordinator; it is not listed.
    thread({ id: "former", parentThreadId: "c", updatedAt: 90 }),
    thread({ id: "past", parentThreadId: "former", updatedAt: 80 }),
    thread({ id: "member", parentThreadId: "c", updatedAt: 60 }),
    thread({ id: "member-child", parentThreadId: "member", updatedAt: 65 }),
    thread({ id: "orphan", parentThreadId: "archived-parent", updatedAt: 70 }),
  ];

  it("lists live workers once, with their live children, then the member threads", () => {
    const { workers, others } = adventureRows(project, native, [], undefined, "updated");
    expect(workers.map((w) => [w.ref, w.node.children.map((c) => c.thread.id)])).toEqual([
      ["W2", []],
      ["W1", ["child"]],
    ]);
    expect(others.map((n) => [n.thread.id, n.children.map((c) => c.thread.id)])).toEqual([
      ["orphan", []],
      ["member", ["member-child"]],
    ]);
  });

  it("lists the live coordinator without the threads it spawned, or none once it is archived", () => {
    const { coordinator } = adventureRows(project, native, [], undefined, "updated");
    expect(coordinator?.thread.id).toBe("c");
    expect(coordinator?.children).toEqual([]);
    const archived = native.map((t) => (t.id === "c" ? { ...t, isArchived: true } : t));
    expect(adventureRows(project, archived, [], undefined, "updated").coordinator).toBeNull();
  });

  it("lets BB's live status win over the server's group, and orders by worker id on request", () => {
    const { workers } = adventureRows(
      project,
      [...native.filter((t) => t.id !== "w1"), thread({ id: "w1", parentThreadId: "c", indicator: "runtime" })],
      [],
      [
        { ref: "W1", profile: "p", group: "done" },
        { ref: "W2", profile: null, group: "idle" },
      ],
      "worker",
    );
    expect(workers.map((w) => `${w.ref}:${w.group}:${w.profile}`)).toEqual(["W2:needs:null", "W1:working:p"]);
  });

  it("counts a worker with a running descendant as working, below needs you", () => {
    const { workers } = adventureRows(
      project,
      [...native, thread({ id: "deep", parentThreadId: "child", indicator: "runtime" })],
      [],
      [
        { ref: "W1", profile: null, group: "stopped" },
        { ref: "W2", profile: null, group: "needs" },
      ],
      "worker",
    );
    expect(workers.map((w) => `${w.ref}:${w.group}`)).toEqual(["W2:needs", "W1:working"]);
  });

  it("counts a running worker nested under another as the other's running descendant", () => {
    const { workers } = adventureRows(
      project,
      [...native.filter((t) => t.id !== "w2"), thread({ id: "w2", parentThreadId: "w1", indicator: "runtime" })],
      [],
      [
        { ref: "W1", profile: null, group: "stopped" },
        { ref: "W2", profile: null, group: "stopped" },
      ],
      "worker",
    );
    expect(workers.map((w) => `${w.ref}:${w.group}`)).toEqual(["W2:working", "W1:working"]);
  });

  it("follows liveness through an archived thread in between", () => {
    const { workers } = adventureRows(
      project,
      [
        ...native,
        thread({ id: "old-rev", parentThreadId: "w1", isArchived: true, indicator: "runtime" }),
        thread({ id: "helper", parentThreadId: "old-rev", indicator: "runtime" }),
      ],
      [],
      [{ ref: "W1", profile: null, group: "stopped" }],
      "worker",
    );
    expect(workers.find((w) => w.ref === "W1")?.group).toBe("working");
  });

  it("drops only a leading worker id from a title", () => {
    expect(withoutRef("W12 Fix login", "W12")).toBe("Fix login");
    expect(withoutRef("W123 Fix login", "W12")).toBe("W123 Fix login");
    expect(withoutRef("Fix W12", "W12")).toBe("Fix W12");
    expect(withoutRef("W12 ", "W12")).toBe("W12 ");
  });
});

describe("worker facts cache", () => {
  afterEach(() => vi.useRealTimers());
  const overview = (group: "running" | "idle") => ({
    workers: { current: [worker("W1", { runtime: group === "running" ? "active" : "idle", profile: "codex / gpt-6.1-sol / xhigh" })] },
    blockers: [],
  });
  const setup = () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let answer: unknown = overview("running");
    const read = vi.fn(async (_projectId: string) => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const changed = vi.fn();
    const facts = createWorkerFacts({ log: { warn } } as unknown as BbPluginApi, read, changed);
    return { facts, read, changed, warn, answer: (next: unknown) => (answer = next) };
  };

  it("answers at once, reads a newly wanted Adventure in the background, and announces it", async () => {
    const { facts, read, changed } = setup();
    expect(facts.read(["p1"])).toEqual({});
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(facts.read(["p1"])).toEqual({ p1: [{ ref: "W1", profile: "codex / gpt-6.1-sol / xhigh", group: "working" }] });
    // Known and not announced as changed: no read.
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    facts.dispose();
  });

  it("reads a changed Adventure again once the interval allows, announcing only a different answer", async () => {
    const { facts, read, changed, answer } = setup();
    facts.read(["p1"]);
    await vi.advanceTimersByTimeAsync(0);
    facts.changed("p1");
    facts.changed("p1");
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    // The same answer is not announced again.
    expect(changed).toHaveBeenCalledTimes(1);
    answer(overview("idle"));
    facts.changed();
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(facts.read(["p1"]).p1?.[0]?.group).toBe("idle");
    facts.dispose();
  });

  it("does not wait on another Adventure's interval for a newly opened one", async () => {
    const { facts, read } = setup();
    facts.read(["p1"]);
    await vi.advanceTimersByTimeAsync(0);
    facts.changed("p1");
    facts.read(["p1", "p2"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([id]) => id)).toEqual(["p1", "p2"]);
    facts.dispose();
  });

  it("stops reading an Adventure no client asked about lately, or that left the tree", async () => {
    const { facts, read } = setup();
    facts.read(["p1", "p2"]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WANTED_MS + 1);
    facts.changed();
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    facts.read(["p1"]);
    facts.retain(new Set());
    expect(facts.read([])).toEqual({});
    facts.dispose();
  });

  it("starts no other read while a timed-out one still runs", async () => {
    const { facts, read } = setup();
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    facts.read(["p1", "p2"]);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 3);
    // Asked again and again while p1 hangs: still one read outstanding.
    facts.read(["p1", "p2"]);
    facts.changed();
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS * 3);
    expect(read.mock.calls.map(([id]) => id)).toEqual(["p1"]);
    finish(overview("running"));
    await vi.advanceTimersByTimeAsync(0);
    // Then p2, and p1 again: its timed-out read left it to be read.
    expect(read.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p1"]);
    facts.dispose();
  });

  it("skips a queued Adventure nobody wants any more, or that left the tree, while another read ran", async () => {
    const { facts, read } = setup();
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    facts.read(["p1", "p2", "p3"]);
    await vi.advanceTimersByTimeAsync(0);
    // p2 leaves the tree; p3's interest lapses while p1's read hangs; p4 opens.
    facts.retain(new Set(["p1", "p3", "p4"]));
    vi.setSystemTime(Date.now() + WANTED_MS + 1);
    facts.read(["p1", "p4"]);
    finish(overview("running"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([id]) => id)).toEqual(["p1", "p4"]);
    facts.dispose();
  });

  it("logs a failed read, keeps the last answer and tries again after the interval", async () => {
    const { facts, read, warn, answer } = setup();
    facts.read(["p1"]);
    await vi.advanceTimersByTimeAsync(0);
    answer(new Error("overview exploded"));
    facts.changed("p1");
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("overview exploded"));
    expect(facts.read(["p1"]).p1).toHaveLength(1);
    answer(overview("running"));
    await vi.advanceTimersByTimeAsync(FACTS_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    facts.dispose();
  });
});

it("serves the open Adventures' worker facts beside the tree and reads them again on a change", async () => {
  const tree = {
    version: 1,
    projects: [
      {
        id: "p1", name: "One", objective: "", paused: false, coordinatorThreadId: null,
        memberProjectIds: [], inFlight: 0, remaining: 0, opinions: 0, revisit: 0, retired: 0, nodes: [],
      },
    ],
  };
  const overviews: unknown[] = [];
  const h = createFakePluginHost({
    sdk: {
      plugins: {
        list: async () => ({ plugins: [{ id: "initiatives", enabled: true, status: "running" }] }),
        callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
          if (method === "tree") return tree;
          overviews.push(input);
          return { workers: { current: [worker("W1", { profile: "x / claude-sonnet-5-5 / low" })] }, blockers: [] };
        },
      },
    },
  });
  registerProjectMode(h.bb);
  type Mode = { workers?: Record<string, unknown[]> };
  const read = () => h.harness.callRpc("projectMode", { known: null, workersOf: ["p1"] }) as Promise<Mode>;
  try {
    expect((await read()).workers).toEqual({});
    await vi.waitFor(() =>
      expect(h.harness.inspection.realtimeSignals).toContainEqual({ channel: "initiatives-changed", payload: {} }),
    );
    expect(overviews).toEqual([{ projectId: "p1", detail: "summary" }]);
    expect((await read()).workers).toEqual({ p1: [{ ref: "W1", profile: "x / claude-sonnet-5-5 / low", group: "idle" }] });
    // An Adventure the tree no longer lists is never read.
    await h.harness.callRpc("projectMode", { known: null, workersOf: ["p1", "gone"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overviews).toEqual([{ projectId: "p1", detail: "summary" }]);
    // A read without workersOf answers no facts and asks for none.
    expect(await h.harness.callRpc("projectMode", { known: null })).not.toHaveProperty("workers");
  } finally {
    await h.harness.dispose();
  }
});
