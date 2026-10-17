// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerItem } from "../lib/overview";
import { workerGroup, workerKind, type WorkerFacts } from "../lib/worker-group";
import { adventureRows } from "../../sidebar/lib/adventure-rows";
import { readFileSync } from "node:fs";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { fixture } from "./fake-native";

// W498: W45 (A63) asked its coordinator two questions by plain message, then went idle with no
// report. It read as running, nothing reached the Inbox, and nobody noticed for ~20 h. Open work
// on an idle thread with no report now shows "Idle, no report" under Waiting, in the Workers tab
// and the sidebar alike; Needs you stays the user's open Inbox questions.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const NOW = Date.now();
const facts = (over: Partial<WorkerFacts> = {}): WorkerFacts => ({ asksUser: false, runtime: "idle", waiting: false, open: false, stopReason: false, outcome: null, ...over });

describe("the idle, no-report status", () => {
  it("idle with open work and no report waits; it is neither working nor needs you", () => {
    expect(workerKind(facts({ open: true }))).toBe("idleNoReport");
    expect(workerGroup(facts({ open: true }))).toBe("waiting");
  });
  it("a thread with an active turn is working", () => {
    for (const runtime of ["active", "starting", "stopping"]) expect(workerGroup(facts({ runtime, open: true }))).toBe("working");
  });
  it("an idle thread with a report goes where its report says", () => {
    expect(workerKind(facts({ outcome: "done" }))).toBe("done");
    expect(workerKind(facts({ outcome: "blocked" }))).toBe("onCoordinator");
    expect(workerGroup(facts({ outcome: "blocked" }))).toBe("waiting");
    expect(workerKind(facts({ outcome: "failed" }))).toBe("reported");
    expect(workerGroup(facts({ outcome: "failed" }))).toBe("stopped");
    // A blocker still open in the Inbox needs the user, whatever the thread does.
    expect(workerGroup(facts({ outcome: "blocked", asksUser: true }))).toBe("needs");
  });
  it("open work that cannot wake keeps Stopped: a failed, archived or deleted thread, or stopped work", () => {
    for (const over of [{ runtime: "error" }, { runtime: "archived" }, { runtime: "deleted" }, { stopReason: true }])
      expect(workerGroup(facts({ open: true, ...over }))).toBe("stopped");
  });
});

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
  open: null, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 60_000, ...over,
});
const host = (id: string, over: Partial<PluginSidebarThread> = {}): PluginSidebarThread => ({
  id, projectId: "repo", title: id, titleFallback: null, parentThreadId: null, sectionId: null, originKind: null, originPluginId: null,
  providerId: "claude-code", hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, isArchived: false, environment: null, host: null,
  createdAt: 1, updatedAt: 1, lastReadAt: 1, latestAttentionAt: 1, ...over,
});

describe("W45's case in the Workers tab and the sidebar", () => {
  // The server's cache may still read the thread as active; BB's live list says it went quiet.
  const overview = (runtime: string) => {
    const o = base();
    o.workers.current = [worker("W45", { label: "Settlement export", runtime, open: { ref: "A63", state: "running", tasks: [] } })];
    o.workerWaiting = { W45: { on: null, checked: true, children: 0 } };
    return o;
  };
  const mount = (o: Overview, threads: PluginSidebarThread[]) => {
    const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, {
      rpc: { inventory: () => [], list: () => [], overview: () => o, command: () => ({}), childPage: () => ({ status: "ready", value: { rows: [], next: null } }) },
      sidebarThreads: { status: "ready", threads },
    });
    mounted.push(slot);
    return slot;
  };
  const rows = (slot: ReturnType<typeof mount>, group: string) => {
    const region = slot.queryByRole("region", { name: group });
    return region ? within(region).getAllByRole("button", { name: /^W\d+ / }).map((b) => b.getAttribute("aria-label")) : [];
  };

  for (const server of ["idle", "active"])
    it(`shows Idle, no report under Waiting once BB lists the thread quiet (server reads it ${server})`, async () => {
      const slot = mount(overview(server), [host("thr_W45")]);
      fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
      expect(rows(slot, "Waiting")).toEqual(["W45 Settlement export"]);
      expect(rows(slot, "Working")).toEqual([]);
      expect(rows(slot, "Needs you")).toEqual([]);
      expect(rows(slot, "Stopped")).toEqual([]);
      expect(within(slot.getByRole("region", { name: "Waiting" })).getByText("Idle, no report")).toBeTruthy();
      expect(slot.getByText("1 waiting")).toBeTruthy();

      // The sidebar reads the server's two variants and lands on the same group.
      const f = facts({ runtime: server, open: true });
      const project = { id: "p1", name: "P", objective: "", paused: false, coordinatorThreadId: "c", memberProjectIds: ["repo"], inFlight: 0, remaining: 0, opinions: 0, needsYou: 0, revisit: 0, nodes: [{ threadId: "thr_W45", role: "work", worker: "W45" }] };
      const known = { ref: "W45", profile: null, group: workerGroup(f), quiet: workerGroup({ ...f, runtime: "idle" }), errored: workerGroup({ ...f, runtime: "error" }) };
      expect(adventureRows(project as never, [host("thr_W45")], [], [known], "worker").workers[0]!.group).toBe("waiting");
    });

  it("shows it Working while BB runs a turn on it", async () => {
    const slot = mount(overview("idle"), [host("thr_W45", { indicator: "runtime" })]);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(rows(slot, "Working")).toEqual(["W45 Settlement export"]);
    expect(rows(slot, "Waiting")).toEqual([]);
  });
});

describe("worker guidance: questions go in a blocked report; reviews follow rule R5", () => {
  const skill = (name: string) => readFileSync(`skills/${name}/SKILL.md`, "utf8");
  it("asks questions in a blocked report, never a plain message before stopping, and ends a turn without one only to wait", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Ask questions in a blocked report, never in a plain message before you stop.");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("One for your lead goes in the summary; one only the user can answer also fills question, options and recommendation");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("End one without a report only to wait like that.");
    expect(skill("initiative-worker")).toContain("never ask it in a plain message\n  and then stop");
    expect(skill("initiative-worker")).toContain("is the only reason to end a turn without a report");
  });
  it("leaves no 4- or 6-round review limit in the defaults or the skills", () => {
    for (const text of [DEFAULT_WORKER_INSTRUCTIONS, DEFAULT_COORDINATOR_INSTRUCTIONS, skill("initiative-worker"), skill("initiative-coordinator")])
      expect(text.replace(/\s+/g, " ")).not.toMatch(/\b[46] (more |extra )?(review )?rounds|after round \d|at most \d+ (converging |review )?rounds/i);
    expect(skill("initiative-worker").replace(/\s+/g, " ")).toContain("whack-a-mole (P1s, or P2s that keep reappearing in the same area round after round) or on scope creep");
  });
  it.each(["coordinator", "worker"] as const)("a saved copy of the %s default from before R5 upgrades to the current one", async (field) => {
    const previous = PREVIOUS_DEFAULTS[field][0]!;
    expect(previous).toContain("6 review rounds");
    const key = field === "coordinator" ? "coordinatorInstructions" : "workerInstructions";
    const f = fixture({ [key]: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration()[key]).toBe(field === "coordinator" ? DEFAULT_COORDINATOR_INSTRUCTIONS : DEFAULT_WORKER_INSTRUCTIONS);
  });
});
