// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerItem } from "../lib/overview";

// W462: worker rows open their thread, carry a menu (right click, long press, keyboard), and the
// quiet ones split from Needs you into Idle, which retires in bulk.
installTestPluginRuntime();
// jsdom has no PointerEvent; the long press reads its pointerType and isPrimary.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
    this.isPrimary = init.isPrimary ?? false;
  }
}
(window as unknown as { PointerEvent: unknown }).PointerEvent ??= TestPointerEvent;
const app = await loadPluginApp(() => import("../app"));
const { modelLabel, ControlRoom } = await import("../control-room");
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const NOW = Date.now();
function base(): Overview {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Equisafe", objective: "Ship the market platform", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const o = buildOverview(store, "p1", new Map(), NOW);
  db.close();
  return o;
}
const worker = (ref: string, over: Partial<WorkerItem> = {}): WorkerItem => ({
  ref, label: `${ref} label`, role: "work", kind: null, area: `${ref} purpose`, bbProjectId: "repo", threadId: `thr_${ref}`,
  generation: 1, generations: 1, state: "active", profile: "claude-code / claude-opus-5-5 / high / tier unspecified", forkedFrom: null,
  nativeParent: true, lastHandoff: null, runtime: "idle", context: { used: null, window: null, estimated: null },
  lead: null, open: null, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 3 * 86_400_000, ...over,
});
const report = (outcome: "done" | "blocked", summary: string, question: string | null = null) => ({
  ref: "A9", outcome, summary, question, reportedAt: NOW - 3_600_000, preSwitch: null,
});
function fleet() {
  const o = base();
  o.workers.current = [
    worker("W1", { label: "PDF perf", latestReport: report("blocked", "CPU capped.", "Pages or a queue?") }),
    worker("W2", { label: "Stalled fix", open: { ref: "A2", state: "running", tasks: [] } }),
    worker("W3", { label: "#3058 fresh review", role: "review", profile: "codex / gpt-6.1-sol / xhigh / fast", prs: [{ url: "https://github.com/e/m/pull/3058", stage: "in-review" }] }),
    worker("W4", { label: "Old fixer", stopReason: "Superseded by W9" }),
    worker("W5", { label: "Live work", runtime: "active", open: { ref: "A5", state: "running", tasks: [] } }),
    worker("W6", { label: "Enum cleanup", latestReport: report("done", "Removed 23 unused enum types.") }),
  ];
  o.workers.retired = [worker("W0", { label: "Clerk follow-up", state: "retired" })];
  o.workerWaiting = Object.fromEntries(o.workers.current.map((w) => [w.ref, { on: null, checked: true, children: 0 }]));
  // W1's blocker is open in the Inbox: it needs the user.
  o.blockers = [blocker("W1", "Pages or a queue?")];
  return o;
}
function blocker(ref: string, question: string, answer: Overview["blockers"][number]["answer"] = null): Overview["blockers"][number] {
  return { assignment: "A9", role: "work", tasks: [], owner: { worker: ref, label: `${ref} label`, threadId: `thr_${ref}` }, question, context: "", options: [], recommendation: null, reportedAt: NOW - 3_600_000, answer };
}
function mount(o: Overview, command = vi.fn().mockResolvedValue({}), overview = () => o) {
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview, command,
    childPage: () => ({ status: "ready", value: { rows: [], next: null } }) } });
  mounted.push(slot);
  return { slot, command };
}
async function workersTab(o = fleet(), command?: ReturnType<typeof vi.fn>, overview?: () => Overview) {
  const mountedSlot = mount(o, command, overview);
  fireEvent.click(await mountedSlot.slot.findByRole("tab", { name: /Workers/ }));
  mountedSlot.slot.navigateCalls.length = 0;
  return mountedSlot;
}
const sent = (command: ReturnType<typeof vi.fn>, n = 0) => command.mock.calls[n]![0].command;
const items = (slot: ReturnType<typeof renderSlot>) => slot.getAllByRole("menuitem").map((b) => b.textContent);

describe("W462 grouping and rows", () => {
  it("keeps open blockers in Needs you, ended work in Stopped, and quiet workers with nothing open in Idle", async () => {
    const { slot } = await workersTab();
    expect(slot.getByText("1 working · 1 needs you · 1 done · 2 stopped · 1 idle")).toBeTruthy();
    const rows = (group: string) => within(slot.getByRole("region", { name: group })).getAllByRole("button", { name: /^W\d+ / }).map((b) => b.getAttribute("aria-label"));
    expect(rows("Needs you")).toEqual(["W1 PDF perf"]);
    expect(rows("Stopped")).toEqual(["W2 Stalled fix", "W4 Old fixer"]);
    expect(rows("Idle · nothing open")).toEqual(["W3 #3058 fresh review"]);
    const needs = within(slot.getByRole("region", { name: "Needs you" }));
    expect(needs.getByText("Blocked: Pages or a queue?")).toBeTruthy();
    expect(needs.queryByRole("button", { name: "Retire all" })).toBeNull();
    const stopped = within(slot.getByRole("region", { name: "Stopped" }));
    expect(stopped.getByText("Idle without a report")).toBeTruthy();
    expect(stopped.getByText("Stopped: Superseded by W9")).toBeTruthy();
    expect(stopped.getByRole("button", { name: "Retire all" })).toBeTruthy();
    const idle = within(slot.getByRole("region", { name: "Idle · nothing open" }));
    expect(idle.getByText("No report")).toBeTruthy();
    expect(idle.getByRole("button", { name: "Retire all" })).toBeTruthy();
  });

  it("a row reads label, then ID · PR · status, model and age; the status is its description", async () => {
    const { slot } = await workersTab();
    const row = slot.getByRole("button", { name: "W3 #3058 fresh review" });
    expect(row.querySelector(".cr-w-label")!.textContent).toBe("#3058 fresh review");
    expect(row.querySelector(".cr-w-meta")!.textContent).toBe("W3#3058No reportSol 6.1 · xhigh3d");
    expect(row.querySelector(".cr-w-meta-main > .cr-ref:first-child")!.textContent).toBe("W3");
    expect(document.getElementById(row.getAttribute("aria-describedby")!)!.textContent).toBe("No report");
    expect(modelLabel("claude-code / claude-opus-5-5 / high / tier unspecified")).toBe("Opus 5.5 · high");
    expect(modelLabel(null)).toBeNull();
  });
});

describe("W462 row click and menu", () => {
  it("a click, or Enter (a click with no pointer detail), opens the worker's thread; one without a thread opens its details", async () => {
    const o = fleet();
    o.workers.current.push(worker("W7", { label: "Threadless", threadId: null }));
    const { slot, command } = await workersTab(o);
    fireEvent.click(slot.getByRole("button", { name: "W1 PDF perf" }));
    fireEvent.click(slot.getByRole("button", { name: "W6 Enum cleanup" }), { detail: 0 });
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_W1" }, { method: "toThread", threadId: "thr_W6" }]);
    fireEvent.click(slot.getByRole("button", { name: "W7 Threadless" }));
    expect(slot.getByRole("region", { name: "W7 details" })).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
  });

  it("a right click opens the menu at the pointer with what applies: Stop only while it runs or holds open work", async () => {
    const { slot } = await workersTab();
    const menuFor = (name: string) => {
      fireEvent.contextMenu(slot.getByRole("button", { name }), { clientX: 40, clientY: 10 });
      const list = items(slot);
      fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
      return list;
    };
    expect(menuFor("W5 Live work")).toEqual(["Open thread", "Details", "Stop…", "Retire…"]);
    expect(menuFor("W2 Stalled fix")).toEqual(["Open thread", "Details", "Stop…", "Retire…"]);
    expect(menuFor("W3 #3058 fresh review")).toEqual(["Open thread", "Details", "Retire…"]);
    fireEvent.click(slot.getByText("Earlier"));
    expect(menuFor("W0 Clerk follow-up")).toEqual(["Open thread", "Details"]);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("menu choices open the thread or the details; Retire and Stop ask once more, then send their command", async () => {
    const command = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ worker: "W5", notStopped: ["W5's thread (host offline)"] });
    const { slot } = await workersTab(fleet(), command);
    const row = slot.getByRole("button", { name: "W3 #3058 fresh review" });
    fireEvent.contextMenu(row);
    fireEvent.click(slot.getByRole("menuitem", { name: "Open thread" }));
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_W3" }]);
    expect(slot.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(row);
    fireEvent.click(slot.getByRole("menuitem", { name: "Details" }));
    expect(slot.getByRole("region", { name: "W3 details" })).toBeTruthy();

    fireEvent.contextMenu(row);
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire…" }));
    expect(slot.getByRole("menu", { name: "Retire W3? Its thread is archived." })).toBeTruthy();
    expect(document.activeElement).toBe(slot.getByRole("menuitem", { name: "Retire W3" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire W3" }));
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    expect(sent(command)).toEqual({ action: "worker-retire", worker: "W3", reason: "Retired from the Workers tab." });
    expect(slot.queryByRole("button", { name: "W3 #3058 fresh review" })).toBeNull();

    // A Stop BB partly refused says so and stays open.
    fireEvent.contextMenu(slot.getByRole("button", { name: "W5 Live work" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop W5" }));
    expect((await within(slot.getByRole("menu")).findByRole("alert")).textContent).toBe("Some work may still run: not stopped: W5's thread (host offline).");
    expect(sent(command, 1)).toEqual({ action: "worker-stop", worker: "W5", reason: "Stopped from the Workers tab." });
    fireEvent.click(slot.getByRole("menuitem", { name: "Cancel" }));
    expect(items(slot)).toEqual(["Open thread", "Details", "Stop…", "Retire…"]);
  });

  it("a Stop warning stays shown when the stopped worker moves to another group", async () => {
    let o = fleet();
    const command = vi.fn(async () => {
      // The turn ends but a child could not be checked: the refresh moves W5 from Working to Stopped.
      o = { ...o, workers: { ...o.workers, current: o.workers.current.map((w) => w.ref === "W5" ? { ...w, runtime: "idle", open: null, stopReason: "Stopped from the Workers tab." } : w) } };
      return { worker: "W5", stoppedChildren: 0, unverified: "its child threads could not be listed (BB unavailable)" };
    });
    const { slot } = await workersTab(o, command, () => o);
    fireEvent.contextMenu(slot.getByRole("button", { name: "W5 Live work" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop W5" }));
    const stopped = () => within(slot.getByRole("region", { name: "Stopped" }));
    await waitFor(() => expect(stopped().getByRole("button", { name: "W5 Live work" })).toBeTruthy());
    expect(stopped().getByRole("alert").textContent).toBe("Some work may still run: not checked: its child threads could not be listed (BB unavailable).");
    expect(slot.queryByRole("region", { name: "Working" })).toBeNull();
  });

  it("a pending Stop survives its menu closing: reopened, it still shows Saving…, and its answer lands there", async () => {
    let fail!: (error: Error) => void;
    const command = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const { slot } = await workersTab(fleet(), command);
    const row = slot.getByRole("button", { name: "W5 Live work" });
    fireEvent.contextMenu(row);
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
    const stop = slot.getByRole("menuitem", { name: "Stop W5" });
    stop.focus();
    fireEvent.click(stop);
    // Saving keeps focus on the pending choice, so the menu's keys still work.
    expect(document.activeElement).toBe(slot.getByRole("menuitem", { name: "Saving…" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(slot.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row);
    fireEvent.contextMenu(row);
    const saving = slot.getByRole("menuitem", { name: "Saving…" });
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(saving);
    fireEvent.click(saving);
    await act(async () => fail(new Error("host offline")));
    expect(within(slot.getByRole("menu")).getByRole("alert").textContent).toBe("host offline");
    expect(slot.getByRole("menuitem", { name: "Stop W5" }).getAttribute("aria-disabled")).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("a write that answers after another worker's menu opened leaves that menu open and focused", async () => {
    let done!: (value: unknown) => void;
    const command = vi.fn(() => new Promise((resolve) => { done = resolve; }));
    const { slot } = await workersTab(fleet(), command);
    fireEvent.contextMenu(slot.getByRole("button", { name: "W5 Live work" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop W5" }));
    fireEvent.contextMenu(slot.getByRole("button", { name: "W3 #3058 fresh review" }));
    const other = slot.getByRole("menu", { name: "W3 actions" });
    expect(other.contains(document.activeElement)).toBe(true);
    await act(async () => done({ worker: "W5", stoppedChildren: 0 }));
    expect(slot.getByRole("menu", { name: "W3 actions" })).toBe(other);
    expect(other.contains(document.activeElement)).toBe(true);
    // W5's write settled: its menu opens fresh.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.contextMenu(slot.getByRole("button", { name: "W5 Live work" }));
    expect(items(slot)).toEqual(["Open thread", "Details", "Stop…", "Retire…"]);
  });

  it("an outcome that arrives while the menu is closed waits on its step until it is seen", async () => {
    for (const outcome of ["failed", "unchecked"] as const) {
      let answer!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      const command = vi.fn(() => new Promise((resolve, reject) => { answer = resolve; fail = reject; }));
      const { slot } = await workersTab(fleet(), command);
      const row = slot.getByRole("button", { name: "W5 Live work" });
      fireEvent.contextMenu(row);
      fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
      fireEvent.click(slot.getByRole("menuitem", { name: "Stop W5" }));
      fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
      await act(async () => outcome === "failed" ? fail(new Error("host offline")) : answer({ worker: "W5", stoppedChildren: 0, unverified: "a walk failed" }));
      expect(slot.queryByRole("menu")).toBeNull();
      fireEvent.contextMenu(row);
      expect(within(slot.getByRole("menu")).getByRole("alert").textContent).toBe(outcome === "failed" ? "host offline" : "Some work may still run: not checked: a walk failed.");
      expect(slot.getByRole("menuitem", { name: "Stop W5" })).toBeTruthy();
      // Leaving the step acknowledges it.
      fireEvent.click(slot.getByRole("menuitem", { name: "Cancel" }));
      expect(within(slot.getByRole("menu")).queryByRole("alert")).toBeNull();
      fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
      fireEvent.contextMenu(row);
      expect(items(slot)).toEqual(["Open thread", "Details", "Stop…", "Retire…"]);
      for (const s of mounted.splice(0)) s.unmount();
      cleanup();
    }
  });

  it("a write that succeeds after its row moved group closes the menu and focuses the moved row", async () => {
    // The app holds reads while a write is out, so the move comes as new props, as any remount would.
    let done!: (value: unknown) => void;
    const run = vi.fn(() => new Promise((resolve) => { done = resolve; }));
    const props = (o: Overview) => ({ overview: o, inventory: [], run, openThread: () => {}, refresh: async () => {}, renderOpinion: () => null,
      renderReplacement: () => null, renderContext: () => null, newTask: null, initialTab: "workers" as const });
    let o = fleet();
    const view = render(<ControlRoom {...props(o)} />);
    fireEvent.contextMenu(view.getByRole("button", { name: "W5 Live work" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Stop…" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Stop W5" }));
    o = { ...o, workers: { ...o.workers, current: o.workers.current.map((w) => w.ref === "W5" ? { ...w, runtime: "idle", open: null } : w) } };
    view.rerender(<ControlRoom {...props(o)} />);
    const moved = within(view.getByRole("region", { name: "Idle · nothing open" })).getByRole("button", { name: "W5 Live work" });
    expect(view.getByRole("menu", { name: /^Stop W5\?/ })).toBeTruthy();
    await act(async () => done({ worker: "W5", stoppedChildren: 0 }));
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(moved);
    view.unmount();
  });

  it("a Stop whose refresh then moves the worker keeps focus on its row", async () => {
    let o = fleet();
    const command = vi.fn(async () => {
      // Answered first; the refresh after the write brings W5 back under Idle.
      o = { ...o, workers: { ...o.workers, current: o.workers.current.map((w) => w.ref === "W5" ? { ...w, runtime: "idle", open: null } : w) } };
      return { worker: "W5", stoppedChildren: 0 };
    });
    const { slot } = await workersTab(o, command, () => o);
    fireEvent.contextMenu(slot.getByRole("button", { name: "W5 Live work" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop W5" }));
    const idle = () => within(slot.getByRole("region", { name: "Idle · nothing open" }));
    await waitFor(() => expect(idle().getByRole("button", { name: "W5 Live work" })).toBeTruthy());
    expect(slot.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(idle().getByRole("button", { name: "W5 Live work" }));
  });

  it("a Retire whose refresh folds the worker under a closed Earlier leaves focus on the row before it", async () => {
    let o = fleet();
    const command = vi.fn(async () => {
      const w3 = o.workers.current.find((w) => w.ref === "W3")!;
      o = { ...o, workers: { current: o.workers.current.filter((w) => w !== w3), retired: [...o.workers.retired, { ...w3, state: "retired" }] } };
      return { ref: "W3", state: "retired" };
    });
    const { slot } = await workersTab(o, command, () => o);
    fireEvent.contextMenu(slot.getByRole("button", { name: "W3 #3058 fresh review" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire W3" }));
    const earlier = () => slot.getByText("Earlier").closest("summary")!;
    await waitFor(() => expect(earlier().closest("details")!.querySelector('[data-worker="W3"]')).toBeTruthy());
    expect((earlier().closest("details") as HTMLDetailsElement).open).toBe(false);
    // W3 was the last row: the one before it keeps the focus, not Earlier's header.
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "W4 Old fixer" }));
  });

  it("a moved row does not take focus back once the reader has moved on", async () => {
    const run = vi.fn(async () => ({ worker: "W5", stoppedChildren: 0 }));
    const props = (o: Overview) => ({ overview: o, inventory: [], run, openThread: () => {}, refresh: async () => {}, renderOpinion: () => null,
      renderReplacement: () => null, renderContext: () => null, newTask: null, initialTab: "workers" as const });
    let o = fleet();
    const view = render(<ControlRoom {...props(o)} />);
    fireEvent.contextMenu(view.getByRole("button", { name: "W5 Live work" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Stop…" }));
    await act(async () => { fireEvent.click(view.getByRole("menuitem", { name: "Stop W5" })); });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "W5 Live work" }));
    const elsewhere = view.getByRole("button", { name: "W1 PDF perf" });
    elsewhere.focus();
    o = { ...o, workers: { ...o.workers, current: o.workers.current.map((w) => w.ref === "W5" ? { ...w, runtime: "idle", open: null } : w) } };
    view.rerender(<ControlRoom {...props(o)} />);
    expect(document.activeElement).toBe(elsewhere);
    view.unmount();
  });

  it("a menu near the window's bottom opens above the pointer, and clamps when neither side fits", async () => {
    const { slot } = await workersTab();
    const row = slot.getByRole("button", { name: "W5 Live work" });
    const item = row.closest("li")!;
    item.getBoundingClientRect = () => ({ top: 700, bottom: 752, left: 0, right: 400, width: 400, height: 52, x: 0, y: 700, toJSON: () => null });
    const tall = (height: number) => vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? height : 0;
    });
    window.innerHeight = 768;
    let spy = tall(120);
    fireEvent.contextMenu(row, { clientX: 20, clientY: 740 });
    // The pointer is 40 px into the row; 120 px don't fit below 740, so the menu ends at the pointer.
    expect(slot.getByRole("menu").style.top).toBe("-80px");
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
    spy.mockRestore();
    spy = tall(760);
    fireEvent.contextMenu(row, { clientX: 20, clientY: 740 });
    // Fits neither way: its top sits 8 px below the window's top edge.
    expect(slot.getByRole("menu").style.top).toBe("-692px");
    spy.mockRestore();
  });

  it("a menu a late message makes taller is placed again", async () => {
    let fail!: (error: Error) => void;
    const command = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const { slot } = await workersTab(fleet(), command);
    const row = slot.getByRole("button", { name: "W5 Live work" });
    row.closest("li")!.getBoundingClientRect = () => ({ top: 580, bottom: 632, left: 0, right: 400, width: 400, height: 52, x: 0, y: 580, toJSON: () => null });
    // 80 px tall, 200 px once it shows an error.
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? (this.querySelector("[role=alert]") ? 200 : 80) : 0;
    });
    window.innerHeight = 768;
    fireEvent.contextMenu(row, { clientX: 20, clientY: 600 });
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop…" }));
    expect(slot.getByRole("menu").style.top).toBe("20px");
    fireEvent.click(slot.getByRole("menuitem", { name: "Stop W5" }));
    await act(async () => fail(new Error("W5's thread (host offline); 3 child threads not stopped")));
    // 600 + 200 passes the window's bottom: it now ends at the pointer.
    expect(slot.getByRole("menu").style.top).toBe("-180px");
    spy.mockRestore();
  });

  it("a refused retire shows the service's reason in the menu", async () => {
    const command = vi.fn().mockRejectedValue(new Error("W2 still has A2 open (running). Wait for its report or stop it first."));
    const { slot } = await workersTab(fleet(), command);
    fireEvent.contextMenu(slot.getByRole("button", { name: "W2 Stalled fix" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire W2" }));
    expect((await within(slot.getByRole("menu")).findByRole("alert")).textContent).toMatch(/still has A2 open/);
  });

  it("the keyboard opens the menu with the context-menu key or Shift+F10, moves with arrows, and Escape returns to the row", async () => {
    const { slot } = await workersTab();
    const row = slot.getByRole("button", { name: "W5 Live work" });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(slot.getByRole("menuitem", { name: "Open thread" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(slot.getByRole("menuitem", { name: "Details" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(slot.getByRole("menuitem", { name: "Retire…" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(slot.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(slot.getByRole("menu", { name: "W5 actions" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(slot.queryByRole("menu")).toBeNull();
    expect(slot.navigateCalls).toEqual([]);
  });

  it("a still touch held 450 ms opens the menu and its release opens nothing; a tap, a moved press or a mouse hold does not", async () => {
    const { slot } = await workersTab();
    const row = slot.getByRole("button", { name: "W6 Enum cleanup" });
    vi.useFakeTimers();
    const touch = { pointerType: "touch", isPrimary: true, clientX: 30, clientY: 12 };
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(449); });
    expect(slot.queryByRole("menu")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(slot.getByRole("menu", { name: "W6 actions" })).toBeTruthy();
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row, { detail: 1 });
    expect(slot.navigateCalls).toEqual([]);
    expect(slot.getByRole("menu")).toBeTruthy();
    // A press on the row while the menu is open only closes it.
    fireEvent.pointerDown(row, touch);
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row, { detail: 1 });
    expect(slot.queryByRole("menu")).toBeNull();
    expect(slot.navigateCalls).toEqual([]);

    fireEvent.pointerDown(row, touch);
    fireEvent.pointerMove(row, touch);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerDown(row, { pointerType: "mouse", isPrimary: true, button: 0 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(slot.queryByRole("menu")).toBeNull();
    fireEvent.pointerUp(row, { pointerType: "mouse", isPrimary: true });
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row, { detail: 1 });
    expect(slot.queryByRole("menu")).toBeNull();
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_W6" }]);
  });
});

describe("W462 child threads only where the cache knows some", () => {
  it("the row offers child threads only with a known child; the detail hides its card only when it knows there are none", async () => {
    const o = fleet();
    o.workerWaiting!.W6 = { on: null, checked: true, children: 2 };
    o.workerWaiting!.W3 = { on: null, checked: false, children: null };
    const { slot } = await workersTab(o);
    const folds = slot.getAllByRole("button", { name: "2 child threads" }).map((b) => b.closest("li")!.querySelector(".cr-w-row")!.getAttribute("aria-label"));
    expect(folds).toEqual(["W6 Enum cleanup"]);
    const details = (name: string, ref: string) => {
      fireEvent.contextMenu(slot.getByRole("button", { name }));
      fireEvent.click(slot.getByRole("menuitem", { name: "Details" }));
      return within(slot.getByRole("region", { name: `${ref} details` })).queryByRole("heading", { name: "Child threads" });
    };
    expect(details("W4 Old fixer", "W4")).toBeNull();
    expect(details("W3 #3058 fresh review", "W3")).toBeTruthy();
    expect(details("W6 Enum cleanup", "W6")).toBeTruthy();
  });
});

describe("W462 Retire all", () => {
  it("confirms the count shown, retires that snapshot one by one, hides each retired row and reports each refusal", async () => {
    let o = fleet();
    let release!: () => void;
    const command = vi.fn(async (input: { command: { worker: string } }) => {
      if (input.command.worker === "W2") {
        // A worker that stops meanwhile is not part of the batch.
        o = { ...o, workers: { ...o.workers, current: [...o.workers.current, worker("W8", { label: "Late stop", stopReason: "Stopped: replaced" })] } };
        await new Promise<void>((resolve) => { release = resolve; });
        return {};
      }
      throw new Error("W4 cannot retire while an operation is unconfirmed.");
    });
    const { slot } = await workersTab(o, command, () => o);
    const stopped = () => within(slot.getByRole("region", { name: "Stopped" }));
    fireEvent.click(stopped().getByRole("button", { name: "Retire all" }));
    expect(stopped().getByText("Retire 2 workers? Their threads are archived.")).toBeTruthy();
    fireEvent.click(stopped().getByRole("button", { name: "Cancel" }));
    fireEvent.click(stopped().getByRole("button", { name: "Retire all" }));
    expect(stopped().getByRole("group", { name: "Retire stopped workers" })).toBeTruthy();
    fireEvent.click(stopped().getByRole("button", { name: "Retire 2" }));
    expect((await stopped().findByRole("status")).textContent).toBe("Retiring 1 of 2…");
    release();
    expect((await stopped().findByRole("alert")).textContent).toBe("1 worker not retired: W4 (W4 cannot retire while an operation is unconfirmed.) Dismiss");
    expect(command.mock.calls.map((call) => call[0].command)).toEqual([
      { action: "worker-retire", worker: "W2", reason: "Stopped and not picked up; retired in bulk from the Workers tab." },
      { action: "worker-retire", worker: "W4", reason: "Stopped and not picked up; retired in bulk from the Workers tab." },
    ]);
    // W2 is still current in the dashboard, but its retire succeeded: its row is gone already.
    expect(o.workers.current.some((w) => w.ref === "W2")).toBe(true);
    expect(slot.queryByRole("button", { name: "W2 Stalled fix" })).toBeNull();
    expect(stopped().getByRole("button", { name: "W4 Old fixer" })).toBeTruthy();
    fireEvent.click(stopped().getByRole("button", { name: "Dismiss" }));
    expect(stopped().queryByRole("alert")).toBeNull();
  });

  it("the report stays when the retired workers have left the Idle group", async () => {
    let o = fleet();
    const command = vi.fn(async () => {
      // The worker opened work meanwhile: it leaves Idle, and the retire is refused.
      o = { ...o, workers: { ...o.workers, current: o.workers.current.map((w) => w.ref === "W3" ? { ...w, runtime: "active", open: { ref: "A30", state: "running", tasks: [] } } : w) } };
      throw new Error("W3 still has A30 open (running).");
    });
    const { slot } = await workersTab(o, command, () => o);
    const idle = () => within(slot.getByRole("region", { name: "Idle · nothing open" }));
    fireEvent.click(idle().getByRole("button", { name: "Retire all" }));
    fireEvent.click(idle().getByRole("button", { name: "Retire 1" }));
    await waitFor(() => expect(within(slot.getByRole("region", { name: "Working" })).getByRole("button", { name: "W3 #3058 fresh review" })).toBeTruthy());
    expect(idle().getByRole("alert").textContent).toMatch(/^1 worker not retired: W3 \(W3 still has A30 open/);
    expect(idle().queryByRole("button", { name: "Retire all" })).toBeNull();
    fireEvent.click(idle().getByRole("button", { name: "Dismiss" }));
    expect(slot.queryByRole("region", { name: "Idle · nothing open" })).toBeNull();
  });
});

describe("W462 child count in the waiting cache", () => {
  it("is unknown until a listing or an event, then counts what the cache holds", async () => {
    const { RunningChildren } = await import("../lib/context");
    const cache = new RunningChildren();
    expect(cache.childCount("w")).toBeNull();
    cache.listed("w", [], cache.begin());
    expect(cache.childCount("w")).toBe(0);
    cache.observe({ id: "r1", parentThreadId: "v", title: "Review", status: "idle" } as never);
    expect(cache.childCount("v")).toBe(1);
  });
});
