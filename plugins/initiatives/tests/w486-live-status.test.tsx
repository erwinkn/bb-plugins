// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerItem } from "../lib/overview";
import { withLiveRuntime, workerGroup, workerKind, workerRuntime, type HostThread, type WorkerFacts } from "../lib/worker-group";
import { adventureRows } from "../../sidebar/lib/adventure-rows";

// W486: after a usage-limit interruption BB's server copy of a worker's thread status can still
// read "active" (no turn completion was announced). The Workers tab takes busy-ness from BB's
// live thread list, the source the sidebar reads, and both views take the group from one function.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const NOW = Date.now();
function base(): Overview {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Equisafe", objective: "Ship", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const o = buildOverview(store, "p1", new Map(), NOW);
  db.close();
  return o;
}
const worker = (ref: string, over: Partial<WorkerItem> = {}): WorkerItem => ({
  ref, label: `${ref} label`, role: "work", kind: null, area: `${ref} purpose`, bbProjectId: "repo", threadId: `thr_${ref}`,
  generation: 1, generations: 1, state: "active", profile: null, forkedFrom: null,
  nativeParent: true, lastHandoff: null, runtime: "idle", context: { used: null, window: null, estimated: null },
  lead: null, open: null, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 60_000, ...over,
});
const host = (id: string, over: Partial<PluginSidebarThread> = {}): PluginSidebarThread => ({
  id, projectId: "repo", title: id, titleFallback: null, parentThreadId: null, sectionId: null, originKind: null, originPluginId: null,
  providerId: "claude-code", hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, isArchived: false, environment: null, host: null,
  createdAt: 1, updatedAt: 1, lastReadAt: 1, latestAttentionAt: 1, ...over,
});
const quiet = { isArchived: false, hasPendingInteraction: false, indicator: "none", activity: {} } satisfies HostThread;
const facts = (over: Partial<WorkerFacts> = {}): WorkerFacts => ({ asksUser: false, runtime: "idle", waiting: false, open: false, stopReason: false, outcome: null, ...over });

describe("worker group derivation", () => {
  it("orders asks the user, running, waiting, failed, idle with no report, open, stopped, done, on the coordinator, reported, none", () => {
    const kinds = [
      { asksUser: true, runtime: "active" }, { runtime: "active", open: true }, { waiting: true, open: true, outcome: "done" },
      { runtime: "error", outcome: "done" }, { open: true }, { runtime: "archived", open: true }, { stopReason: true, outcome: "done" }, { outcome: "done" }, { outcome: "blocked" }, { outcome: "failed" }, {},
    ].map((over) => workerKind(facts(over)));
    expect(kinds).toEqual(["asksUser", "running", "waiting", "failed", "idleNoReport", "open", "stopReason", "done", "onCoordinator", "reported", "none"]);
    expect(workerGroup(facts({ runtime: "failed" }))).toBe("stopped");
  });
});

describe("worker runtime from BB's live thread list", () => {
  const planMode = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 1, goals: 0 };
  it("lets a thread BB shows stopped leave the server's stale active", () => {
    expect(workerRuntime("active", { ...quiet, indicator: "unread-error" })).toBe("error");
    expect(workerRuntime("active", quiet)).toBe("idle");
    expect(workerRuntime("starting", quiet)).toBe("idle");
  });
  it("puts an unread error before the work the host still counts, as the sidebar does", () => {
    expect(workerRuntime("active", { ...quiet, indicator: "unread-error", activity: planMode })).toBe("error");
    expect(workerRuntime("active", { ...quiet, indicator: "unread-error", hasPendingInteraction: true })).toBe("error");
  });
  it("shows a thread BB runs as active, even before the server heard", () => {
    expect(workerRuntime("idle", { ...quiet, indicator: "runtime" })).toBe("active");
    expect(workerRuntime("active", { ...quiet, indicator: "runtime" })).toBe("active");
    expect(workerRuntime("idle", { ...quiet, activity: planMode })).toBe("active");
  });
  it("reads a pending question or approval as waiting for input, which needs you", () => {
    expect(workerRuntime("active", { ...quiet, hasPendingInteraction: true })).toBe("waiting-for-input");
    expect(workerRuntime("idle", { ...quiet, indicator: "waiting-for-input" })).toBe("waiting-for-input");
    expect(workerKind(facts({ runtime: "waiting-for-input" }))).toBe("input");
    expect(workerGroup(facts({ runtime: "waiting-for-input" }))).toBe("needs");
  });
  it("keeps what the server recorded when BB has nothing to add", () => {
    expect(workerRuntime("error", quiet)).toBe("error");
    expect(workerRuntime("active", undefined)).toBe("active");
    expect(workerRuntime("idle", { ...quiet, isArchived: true })).toBe("archived");
  });
});

describe("withLiveRuntime", () => {
  it("reads the coordinator and each current worker from BB's live list, and returns the same overview when nothing differs", () => {
    const o = base();
    o.project.coordinatorThreadId = "thr_c";
    o.project.coordinatorStatus = "active";
    o.workers.current = [worker("W1", { runtime: "active" }), worker("W2", { runtime: "idle" })];
    const live = withLiveRuntime(o, [host("thr_c", { indicator: "unread-error" }), host("thr_W1", { indicator: "runtime" })]);
    expect(live.project.coordinatorStatus).toBe("error");
    expect(live.workers.current.map((w) => w.runtime)).toEqual(["active", "idle"]);
    expect(withLiveRuntime(o, [host("thr_c", { indicator: "runtime" })])).toBe(o);
  });
});

describe("Workers tab after an active → error transition with no completion", () => {
  let waiting: Overview["workerWaiting"];
  // The server's cached copy of W1: still "active" with open work, unless a test says it is quiet.
  let quietServer = false;
  beforeEach(() => { waiting = undefined; quietServer = false; });
  const overview = () => {
    const o = base();
    if (waiting) o.workerWaiting = waiting;
    // The server's cache still says W1's thread is active (a 429 killed its turn).
    o.workers.current = [worker("W1", { runtime: quietServer ? "idle" : "active", open: quietServer ? null : { ref: "A1", state: "running", tasks: [] } })];
    return o;
  };
  const mount = (threads: PluginSidebarThread[]) => {
    const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, {
      rpc: { inventory: () => [], list: () => [], overview: () => overview(), command: () => ({}), childPage: () => ({ status: "ready", value: { rows: [], next: null } }) },
      sidebarThreads: { status: "ready", threads },
    });
    mounted.push(slot);
    return slot;
  };
  const rows = (slot: ReturnType<typeof mount>, group: string) => {
    const region = slot.queryByRole("region", { name: group });
    return region ? within(region).getAllByRole("button", { name: /^W\d+ / }).map((b) => b.getAttribute("aria-label")) : [];
  };

  it("shows Stopped when BB's live list has the thread errored, Working while BB runs it", async () => {
    const errored = mount([host("thr_W1", { indicator: "unread-error" })]);
    fireEvent.click(await errored.findByRole("tab", { name: /Workers/ }));
    expect(rows(errored, "Working")).toEqual([]);
    expect(rows(errored, "Stopped")).toEqual(["W1 W1 label"]);
    errored.unmount();
    const running = mount([host("thr_W1", { indicator: "runtime" })]);
    fireEvent.click(await running.findByRole("tab", { name: /Workers/ }));
    expect(rows(running, "Working")).toEqual(["W1 W1 label"]);
  });

  it("shows Needs you when BB's list has the thread asking for approval", async () => {
    const slot = mount([host("thr_W1", { hasPendingInteraction: true })]);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(rows(slot, "Needs you")).toEqual(["W1 W1 label"]);
    expect(rows(slot, "Working")).toEqual([]);
  });

  it("offers Stop while BB counts work on a thread whose error masks it", async () => {
    const work = { workflows: 0, backgroundAgents: 0, backgroundCommands: 1, planMode: 0, goals: 0 };
    quietServer = true;
    const slot = mount([host("thr_W1", { indicator: "unread-error", activity: work })]);
    // Nothing open: only the live work keeps Stop offered.
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(rows(slot, "Stopped")).toEqual(["W1 W1 label"]);
    fireEvent.contextMenu(slot.getByRole("button", { name: "W1 W1 label" }), { clientX: 40, clientY: 10 });
    expect(slot.getAllByRole("menuitem").map((b) => b.textContent)).toContain("Stop…");
  });

  it("offers Stop for a pending approval or a descendant's background command that an error masks", async () => {
    quietServer = true;
    const work = { workflows: 0, backgroundAgents: 0, backgroundCommands: 1, planMode: 0, goals: 0 };
    const menu = async (threads: PluginSidebarThread[]) => {
      const slot = mount(threads);
      fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
      fireEvent.contextMenu(slot.getByRole("button", { name: "W1 W1 label" }), { clientX: 40, clientY: 10 });
      const list = slot.getAllByRole("menuitem").map((b) => b.textContent);
      slot.unmount();
      return list;
    };
    expect(await menu([host("thr_W1", { indicator: "unread-error", hasPendingInteraction: true })])).toContain("Stop…");
    expect(await menu([host("thr_W1"), host("kid", { parentThreadId: "thr_W1", indicator: "unread-error", activity: work })])).toContain("Stop…");
    expect(await menu([host("thr_W1", { indicator: "unread-error" })])).not.toContain("Stop…");
  });

  it("does not show a stale zero child count beside a child BB lists as running", async () => {
    quietServer = true;
    waiting = { W1: { on: null, checked: true, children: 0 } };
    const slot = mount([host("thr_W1"), host("kid", { parentThreadId: "thr_W1", indicator: "runtime", title: "Review r1" })]);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(rows(slot, "Waiting")).toEqual(["W1 W1 label"]);
    fireEvent.click(slot.getByRole("button", { name: "W1 W1 label" }));
    expect(slot.queryByText(/0 child threads/)).toBeNull();
    expect(slot.getAllByText(/Child threads/).length).toBeGreaterThan(0);
  });

  it("keeps the server's status for a thread BB's list does not carry", async () => {
    const slot = mount([]);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(rows(slot, "Working")).toEqual(["W1 W1 label"]);
  });
});

describe("the Threads sidebar and the Workers tab agree", () => {
  const project = { id: "p1", name: "P", objective: "", paused: false, coordinatorThreadId: "c", memberProjectIds: ["repo"], inFlight: 0, remaining: 0, opinions: 0, needsYou: 0, revisit: 0, nodes: [{ threadId: "thr_W1", role: "work", worker: "W1" }] };
  const planMode = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 1, goals: 0 };
  const hosts: [string, Partial<PluginSidebarThread>][] = [
    ["quiet", {}], ["running", { indicator: "runtime" }], ["errored", { indicator: "unread-error" }],
    ["errored in plan mode", { indicator: "unread-error", activity: planMode }], ["asking for approval", { hasPendingInteraction: true }],
    ["waiting for input", { indicator: "waiting-for-input" }], ["in plan mode", { activity: planMode }],
  ];
  const servers: [string, Partial<WorkerFacts>][] = [
    ["stale active, open work", { runtime: "active", open: true }], ["idle, open work", { open: true }], ["stale active, queued child", { runtime: "active", waiting: true }],
    ["idle, done report", { outcome: "done" }], ["idle, nothing", {}], ["errored", { runtime: "error" }], ["asking the user", { asksUser: true, runtime: "active" }],
    ["blocked, on the coordinator", { outcome: "blocked" }],
  ];
  const kids: [string, PluginSidebarThread[]][] = [
    ["no child", []],
    ["a running child", [host("kid", { parentThreadId: "thr_W1", indicator: "runtime" })]],
    ["a child asking for approval", [host("kid", { parentThreadId: "thr_W1", hasPendingInteraction: true })]],
    ["an errored child", [host("kid", { parentThreadId: "thr_W1", indicator: "unread-error" })]],
    ["a quiet child", [host("kid", { parentThreadId: "thr_W1" })]],
    ["a running grandchild under an archived child", [host("kid", { parentThreadId: "thr_W1", isArchived: true }), host("grand", { parentThreadId: "kid", indicator: "runtime" })]],
  ];
  // The same server facts and the same BB threads: both views land in one group, with nothing
  // Working once BB says it errored.
  for (const [serverName, over] of servers)
    for (const [hostName, patch] of hosts)
      for (const [kidName, below] of kids)
        it(`${serverName}, BB shows it ${hostName}, with ${kidName}`, () => {
          const f = facts(over);
          const threads = [host("thr_W1", patch), ...below];
          const variants = { group: workerGroup(f), quiet: workerGroup({ ...f, runtime: "idle" }), errored: workerGroup({ ...f, runtime: "error" }) };
          const o = base();
          o.workers.current = [worker("W1", { runtime: f.runtime })];
          o.workerWaiting = { W1: { on: f.waiting ? { threadId: "queued", title: "Queued review", running: "pending", since: NOW } : null, checked: true } };
          const live = withLiveRuntime(o, threads);
          const tab = workerGroup({ ...f, runtime: live.workers.current[0]!.runtime, waiting: !!live.workerWaiting?.W1?.on });
          const sidebar = adventureRows(project as never, threads, [], [{ ref: "W1", profile: null, ...variants }], "worker").workers[0]!.group;
          expect(sidebar).toBe(tab);
          if (patch.indicator === "unread-error" && !f.asksUser && !below.length) expect(tab).not.toBe("working");
        });
});
