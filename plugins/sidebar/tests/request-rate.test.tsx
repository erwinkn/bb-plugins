// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState } from "../lib/client-state";
import { thread } from "./fixtures";

// How many RPCs an open sidebar sends per minute, by method: idle, under a
// busy Adventure's change signals, and in a hidden tab. Printed for the
// record; the bounds keep later changes from quietly fetching more. Before
// TanStack Query (15 s polls, every signal re-reading the tree, the facts and
// the thread ids): idle 8.2, busy 32.1, hidden 0.2. The branch-PR safety poll
// (once the server answered it from memory) added 2 a minute: idle 3 → 5,
// busy 14 → 16, hidden 0.

const app = await loadPluginApp(() => import("../app"));
const MINUTES = 10;
const node = (threadId: string, worker: string | null, role: string) => ({
  threadId,
  label: threadId,
  role,
  worker,
  parentWorker: null,
  state: "active",
  bbProjectId: "project-1",
});
const tree = {
  version: 1,
  projects: [
    {
      id: "p1",
      name: "Busy",
      objective: "",
      paused: false,
      coordinatorThreadId: "c",
      memberProjectIds: ["project-1"],
      inFlight: 0,
      remaining: 0,
      opinions: 0,
      revisit: 0,
      retired: 0,
      nodes: [node("c", null, "coordinator"), node("w1", "W1", "work"), node("w2", "W2", "work")],
    },
  ],
};
const facts = [
  { ref: "W1", profile: null, group: "working" },
  { ref: "W2", profile: null, group: "idle" },
];
const rpc = {
  projectMode: async () => ({ available: true, tree, order: null, orderError: null }),
  adventureWorkers: async () => ({ workers: facts }),
  initiativeThreads: async () => ({ available: true, threadIds: ["c", "w1", "w2"], status: "ready" }),
  getSnoozes: async () => ({ revision: 1, entries: [] }),
  getSnoozePresets: async () => ({ revision: 1, presets: [] }),
  listArchived: async () => [],
  branchPullRequestEligibility: async () => ({ eligible: {} }),
};
const threads = [
  thread({ id: "c", title: "Coordinator" }),
  thread({ id: "w1", title: "W1 Build" }),
  thread({ id: "w2", title: "W2 Review" }),
  thread({ id: "plain", title: "Plain" }),
];
let visibility: DocumentVisibilityState = "visible";
const slots: ReturnType<typeof renderSlot>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  updateState(() => ({ ...parseState(null), selected: "p1" }));
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(async () => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
  updateState(() => parseState(null));
});

async function measure(during: (slot: ReturnType<typeof renderSlot>, minute: number) => Promise<void>) {
  const slot = renderSlot(
    app.threadLists[0],
    {
      activeThreadId: "plain",
      activeProjectId: "project-1",
      isCompactViewport: false,
      searchQuery: "",
      onNavigate: () => {},
      Original: () => null,
    },
    { rpc, sidebarThreads: { threads, projects: [{ id: "project-1", name: "One", isPersonal: false }] } },
  );
  slots.push(slot);
  // The mount's own reads settle first; the rate counts the steady state.
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  const start = slot.inspection.rpcCalls.length;
  for (let minute = 0; minute < MINUTES; minute++) await during(slot, minute);
  const perMethod: Record<string, number> = {};
  for (const call of slot.inspection.rpcCalls.slice(start))
    perMethod[call.method] = (perMethod[call.method] ?? 0) + 1;
  const total = slot.inspection.rpcCalls.length - start;
  return {
    perMinute: total / MINUTES,
    byMethod: Object.fromEntries(Object.entries(perMethod).map(([m, n]) => [m, n / MINUTES])),
  };
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("request rate of an open sidebar", () => {
  it("idle, visible", async () => {
    const rate = await measure(() => advance(60_000));
    console.log("idle", JSON.stringify(rate));
    // The safety poll: one tree, one thread-id and one facts read a minute,
    // and one branch-PR read for each shown id set (the thread list and the
    // picked Adventure's workers), which the server answers from memory.
    expect(rate.byMethod).toEqual({
      projectMode: 1,
      initiativeThreads: 1,
      adventureWorkers: 1,
      branchPullRequestEligibility: 2,
    });
  });

  it("a busy Adventure announcing a change every 5 s", async () => {
    const rate = await measure(async (slot) => {
      for (let s = 0; s < 60; s += 5) {
        await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
        await advance(5_000);
      }
    });
    console.log("busy", JSON.stringify(rate));
    // One conditional tree read per signal; the thread ids, facts and branch
    // PRs have their own signals and keep to the safety poll.
    expect(rate.byMethod).toEqual({
      projectMode: 12,
      initiativeThreads: 1,
      adventureWorkers: 1,
      branchPullRequestEligibility: 2,
    });
  });

  it("hidden tab", async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    const rate = await measure(() => advance(60_000));
    console.log("hidden", JSON.stringify(rate));
    expect(rate.perMinute).toBe(0);
  });

  it("two mounted lists share one read of each query", async () => {
    const calls: Record<string, number> = {};
    const counted = Object.fromEntries(
      Object.entries(rpc).map(([method, handler]) => [
        method,
        (input: unknown) => {
          calls[method] = (calls[method] ?? 0) + 1;
          return (handler as (input: unknown) => unknown)(input);
        },
      ]),
    );
    const props = {
      activeThreadId: "plain",
      activeProjectId: "project-1",
      isCompactViewport: false,
      searchQuery: "",
      onNavigate: () => {},
      Original: () => null,
    };
    const options = {
      rpc: counted,
      sidebarThreads: { threads, projects: [{ id: "project-1", name: "One", isPersonal: false }] },
    };
    slots.push(renderSlot(app.threadLists[0], props, options));
    slots.push(renderSlot(app.threadLists[0], { ...props, isCompactViewport: true }, options));
    await advance(2_000);
    expect(calls).toMatchObject({ projectMode: 1, initiativeThreads: 1, adventureWorkers: 1, getSnoozes: 1 });
    await slots[0]!.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await slots[1]!.behavior.emitRealtime("initiatives-changed", { projectId: "p1" });
    await advance(1_000);
    expect(calls.projectMode).toBe(2);
  });
});
