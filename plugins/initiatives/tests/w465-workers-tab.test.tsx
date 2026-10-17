// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore, settledChildPage } from "./helpers";
import { projectFixture } from "./fake-native";
import { buildOverview, type Overview, type WorkerChild, type WorkerItem } from "../lib/overview";
import { needsYouCount } from "../lib/blockers";

// W465: Needs you holds only what waits on the user, ended work goes to Stopped; a retired row
// leaves at once and hands focus to its neighbour without scrolling; child-thread toggles say
// how many there are and show only where some are known.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  generation: 1, generations: 1, state: "active", profile: null, forkedFrom: null,
  nativeParent: true, lastHandoff: null, runtime: "idle", context: { used: null, window: null, estimated: null },
  lead: null, open: null, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 3 * 86_400_000, ...over,
});
const report = (outcome: "done" | "blocked" | "failed", summary: string, question: string | null = null) => ({
  ref: "A9", outcome, summary, question, reportedAt: NOW - 3_600_000, preSwitch: null,
});
type Blocker = Overview["blockers"][number];
const blocker = (ref: string, question: string, answer: Blocker["answer"] = null): Blocker => ({
  assignment: `A${ref.slice(1)}`, role: "work", tasks: [], owner: { worker: ref, label: `${ref} label`, threadId: `thr_${ref}` },
  question, context: "", options: [], recommendation: null, reportedAt: NOW - 3_600_000, answer,
});
const answered = { ref: "D1", note: "Pages.", at: NOW, to: "coordinator" as const, delivery: null, notification: null } as unknown as Blocker["answer"];
const child = (n: number, children: number | null): WorkerChild => ({
  threadId: `c${n}`, title: `Helper ${n}`, status: "idle", archived: false, running: null, providerId: null, updatedAt: NOW - 60_000, children,
});

function mount(o: Overview | (() => Overview), command = vi.fn().mockResolvedValue({}), childPage: (input: unknown) => unknown = () => ({ status: "ready", value: { rows: [], next: null } })) {
  const overview = typeof o === "function" ? o : () => o;
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview, command, childPage } });
  mounted.push(slot);
  return slot;
}
async function workersTab(o: Overview | (() => Overview), command?: ReturnType<typeof vi.fn>, childPage?: (input: unknown) => unknown) {
  const slot = mount(o, command, childPage);
  fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
  return slot;
}
const rows = (slot: ReturnType<typeof renderSlot>, group: string) =>
  within(slot.getByRole("region", { name: group })).getAllByRole("button", { name: /^W\d+ / }).map((b) => b.getAttribute("aria-label"));

describe("W465 Needs you means the user has to act", () => {
  it("failed threads and cancelled work go to Stopped; only an open, unanswered blocker needs you; an answered or dismissed one, and idle open work with no report, wait", async () => {
    const o = base();
    o.workers.current = [
      worker("W1", { label: "Asking", latestReport: report("blocked", "CPU capped.", "Pages or a queue?") }),
      worker("W2", { label: "Crashed", runtime: "error", stopReason: "claude-code exited with code 0" }),
      worker("W3", { label: "Cancelled", stopReason: "Stopped: Replaced by W12" }),
      worker("W4", { label: "Went quiet", open: { ref: "A4", state: "idle_no_report", tasks: [] } }),
      worker("W5", { label: "Answered", latestReport: report("blocked", "Unsure.", "Which table?") }),
      worker("W6", { label: "Dismissed", latestReport: report("blocked", "Unsure.", "Which column?") }),
      worker("W7", { label: "Gave up", latestReport: report("failed", "Tests never pass.") }),
      worker("W8", { label: "Crashed while asking", runtime: "failed", latestReport: report("blocked", "Stuck.", "Retry?") }),
      worker("W9", { label: "Done then cancelled", stopReason: "Stopped: Superseded", latestReport: report("done", "Shipped.") }),
    ];
    // W5's blocker is answered and W6's dismissed (the Inbox no longer lists it); W8's is open.
    o.blockers = [blocker("W1", "Pages or a queue?"), blocker("W5", "Which table?", answered), blocker("W8", "Retry?")];
    const slot = await workersTab(o);
    expect(rows(slot, "Needs you")).toEqual(["W1 Asking", "W8 Crashed while asking"]);
    expect(rows(slot, "Needs you").length).toBe(needsYouCount(o));
    // W498: W4 went idle on open work without a report; it waits, it has not stopped.
    expect(rows(slot, "Waiting")).toEqual(["W4 Went quiet", "W5 Answered", "W6 Dismissed"]);
    expect(rows(slot, "Stopped")).toEqual(["W2 Crashed", "W3 Cancelled", "W7 Gave up", "W9 Done then cancelled"]);
    expect(slot.getByText("3 waiting · 2 need you · 4 stopped")).toBeTruthy();
    const waiting = within(slot.getByRole("region", { name: "Waiting" }));
    expect(waiting.getByText("Waiting on the coordinator: Which table? · you answered")).toBeTruthy();
    expect(waiting.getByText("Waiting on the coordinator: Which column?")).toBeTruthy();
    expect(waiting.getByText("Idle, no report")).toBeTruthy();
    // Nothing runs on a worker waiting on its coordinator: no working glyph.
    expect(slot.getByRole("button", { name: "W5 Answered" }).closest("li")!.querySelector(".cr-w-status")).toBeNull();
    const stopped = within(slot.getByRole("region", { name: "Stopped" }));
    for (const text of ["Thread failed: claude-code exited with code 0", "Stopped: Replaced by W12",
      "Failed: Tests never pass.", "Stopped: Superseded"])
      expect(stopped.getByText(text)).toBeTruthy();
    expect(within(slot.getByRole("region", { name: "Needs you" })).getByText("Blocked: Retry?")).toBeTruthy();
    expect(stopped.getByRole("button", { name: "Retire all" })).toBeTruthy();
    expect(slot.queryByRole("region", { name: "Idle · nothing open" })).toBeNull();
  });
});

describe("W465 Stop follows what runs, not the group", () => {
  it("a worker that needs you keeps Stop while its thread or a child runs", async () => {
    const o = base();
    o.workers.current = [
      worker("W1", { label: "Busy asker", runtime: "active", latestReport: report("blocked", "Stuck.", "Which?") }),
      worker("W2", { label: "Child asker", latestReport: report("blocked", "Stuck.", "Where?") }),
      worker("W3", { label: "Quiet asker", latestReport: report("blocked", "Stuck.", "When?") }),
    ];
    o.blockers = [blocker("W1", "Which?"), blocker("W2", "Where?"), blocker("W3", "When?")];
    o.workerWaiting = { W2: { on: { threadId: "thr_r1", title: "Review r1", running: "active", since: NOW - 60_000 }, checked: true, children: 1 } };
    const slot = await workersTab(o);
    expect(rows(slot, "Needs you")).toEqual(["W1 Busy asker", "W2 Child asker", "W3 Quiet asker"]);
    const menuFor = (name: string) => {
      fireEvent.contextMenu(slot.getByRole("button", { name }));
      const list = slot.getAllByRole("menuitem").map((b) => b.textContent);
      fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
      return list;
    };
    expect(menuFor("W1 Busy asker")).toContain("Stop…");
    expect(menuFor("W2 Child asker")).toContain("Stop…");
    expect(menuFor("W3 Quiet asker")).not.toContain("Stop…");
    // The running child shows open, as under Waiting.
    expect(slot.getByRole("button", { name: "W2 Child asker" }).closest("li")!.querySelector(":scope > .cr-w-fold")!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("W465 a retired row leaves at once and keeps focus in place", () => {
  /** Stopped W2, W4; Idle W3; one retired worker under a closed Earlier. */
  function fleet() {
    const o = base();
    o.workers.current = [
      worker("W2", { label: "Stalled fix", runtime: "error", open: { ref: "A2", state: "running", tasks: [] } }),
      worker("W3", { label: "Quiet review", role: "review" }),
      worker("W4", { label: "Old fixer", stopReason: "Superseded by W9" }),
    ];
    o.workers.retired = [worker("W0", { label: "Clerk follow-up", state: "retired" })];
    return o;
  }
  const retireFromMenu = (slot: ReturnType<typeof renderSlot>, name: string, ref: string) => {
    fireEvent.contextMenu(slot.getByRole("button", { name }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Retire…" }));
    fireEvent.click(slot.getByRole("menuitem", { name: `Retire ${ref}` }));
  };

  it("hides the row before the refresh, focuses the next row without scrolling, and stays there when the worker reaches Earlier", async () => {
    let o = fleet();
    const command = vi.fn(async () => ({ ref: "W4", state: "retired" }));
    const slot = await workersTab(() => o, command);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    retireFromMenu(slot, "W4 Old fixer", "W4");
    await waitFor(() => expect(slot.queryByRole("button", { name: "W4 Old fixer" })).toBeNull());
    // The dashboard still lists W4 as current: only the successful write hid it.
    expect(o.workers.current.some((w) => w.ref === "W4")).toBe(true);
    const next = slot.getByRole("button", { name: "W3 Quiet review" });
    expect(document.activeElement).toBe(next);
    expect(focus.mock.contexts.at(-1)).toBe(next);
    expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
    expect(slot.queryByRole("menu")).toBeNull();

    // The refresh confirms the retirement: W4 folds under the closed Earlier, and focus does not follow.
    const w4 = o.workers.current.find((w) => w.ref === "W4")!;
    o = { ...o, workers: { current: o.workers.current.filter((w) => w !== w4), retired: [...o.workers.retired, { ...w4, state: "retired" }] } };
    focus.mockClear();
    await act(async () => { await slot.behavior.emitRealtime("initiatives-changed", { projectId: "p1" }); });
    const earlier = slot.getByText("Earlier").closest("details")!;
    await waitFor(() => expect(earlier.querySelector('[data-worker="W4"]')).toBeTruthy());
    expect(earlier.open).toBe(false);
    expect(document.activeElement).toBe(next);
    expect(focus).not.toHaveBeenCalled();
  });

  it("the last row hands focus to the one before, not to Earlier's header; the only row hands it to that header", async () => {
    const o = fleet();
    const slot = await workersTab(o);
    retireFromMenu(slot, "W3 Quiet review", "W3");
    await waitFor(() => expect(slot.queryByRole("button", { name: "W3 Quiet review" })).toBeNull());
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "W4 Old fixer" }));
    expect(slot.queryByRole("region", { name: "Idle · nothing open" })).toBeNull();
    for (const s of mounted.splice(0)) s.unmount();
    cleanup();

    const lone = fleet();
    lone.workers.current = lone.workers.current.filter((w) => w.ref === "W4");
    const only = await workersTab(lone);
    retireFromMenu(only, "W4 Old fixer", "W4");
    await waitFor(() => expect(only.queryByRole("button", { name: "W4 Old fixer" })).toBeNull());
    expect(document.activeElement).toBe(only.getByText("Earlier").closest("summary"));
  });

  it("with no row left and no Earlier yet, the list itself keeps the focus", async () => {
    const o = fleet();
    o.workers.current = o.workers.current.filter((w) => w.ref === "W4");
    o.workers.retired = [];
    const slot = await workersTab(o);
    retireFromMenu(slot, "W4 Old fixer", "W4");
    await waitFor(() => expect(slot.queryByRole("button", { name: "W4 Old fixer" })).toBeNull());
    expect(document.activeElement).toBe(slot.container.querySelector(".cr-w-list"));
  });

  it("Retire all keeps focus on a row it could not retire, else on the list when nothing is left", async () => {
    for (const refuse of [true, false]) {
      const o = fleet();
      o.workers.current = o.workers.current.filter((w) => w.ref !== "W3");
      o.workers.retired = [];
      const command = vi.fn(async (input: { command: { worker: string } }) => {
        if (refuse && input.command.worker === "W2") throw new Error("W2 still has A2 open (running).");
        return {};
      });
      const slot = await workersTab(o, command);
      const stopped = () => within(slot.getByRole("region", { name: "Stopped" }));
      fireEvent.click(stopped().getByRole("button", { name: "Retire all" }));
      fireEvent.click(stopped().getByRole("button", { name: "Retire 2" }));
      if (refuse) {
        await stopped().findByRole("alert");
        expect(slot.queryByRole("button", { name: "W4 Old fixer" })).toBeNull();
        expect(document.activeElement).toBe(slot.getByRole("button", { name: "W2 Stalled fix" }));
      } else {
        await waitFor(() => expect(slot.queryByRole("region", { name: "Stopped" })).toBeNull());
        expect(document.activeElement).toBe(slot.container.querySelector(".cr-w-list"));
      }
      for (const s of mounted.splice(0)) s.unmount();
      cleanup();
    }
  });

  it("two retires that land together never hand focus to the other's row", async () => {
    const answers: Record<string, (value: unknown) => void> = {};
    const command = vi.fn((input: { command: { worker: string } }) => new Promise((resolve) => { answers[input.command.worker] = resolve; }));
    const slot = await workersTab(fleet(), command);
    // W4's retire is out and its menu closed; W2 (just before W4) is retired next, its menu still open.
    retireFromMenu(slot, "W4 Old fixer", "W4");
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
    retireFromMenu(slot, "W2 Stalled fix", "W2");
    await act(async () => { answers.W4!({}); answers.W2!({}); });
    expect(slot.queryByRole("button", { name: "W4 Old fixer" })).toBeNull();
    expect(slot.queryByRole("button", { name: "W2 Stalled fix" })).toBeNull();
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "W3 Quiet review" }));
  });

  it("a retire that lands after the reader moved on hides the row and leaves focus where it is", async () => {
    let done!: (value: unknown) => void;
    const command = vi.fn(() => new Promise((resolve) => { done = resolve; }));
    const slot = await workersTab(fleet(), command);
    retireFromMenu(slot, "W4 Old fixer", "W4");
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
    const elsewhere = slot.getByRole("button", { name: "W2 Stalled fix" });
    elsewhere.focus();
    await act(async () => done({ ref: "W4", state: "retired" }));
    expect(slot.queryByRole("button", { name: "W4 Old fixer" })).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("a refused retire keeps the row and shows why in its menu", async () => {
    const command = vi.fn().mockRejectedValue(new Error("W2 still has A2 open (running)."));
    const slot = await workersTab(fleet(), command);
    retireFromMenu(slot, "W2 Stalled fix", "W2");
    expect((await within(slot.getByRole("menu")).findByRole("alert")).textContent).toMatch(/still has A2 open/);
    expect(slot.getByRole("button", { name: "W2 Stalled fix" })).toBeTruthy();
  });

  it("Retire all hides each retired row and gives the lost focus to the nearest row outside the group", async () => {
    const o = fleet();
    o.workers.retired = [];
    const slot = await workersTab(o);
    const stopped = () => within(slot.getByRole("region", { name: "Stopped" }));
    fireEvent.click(stopped().getByRole("button", { name: "Retire all" }));
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    fireEvent.click(stopped().getByRole("button", { name: "Retire 2" }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "Stopped" })).toBeNull());
    const next = slot.getByRole("button", { name: "W3 Quiet review" });
    expect(document.activeElement).toBe(next);
    expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
  });
});

describe("W465 child-thread toggles say how many and show only where some are known", () => {
  it("a worker row's toggle counts its children; none known, no toggle", async () => {
    const o = base();
    o.workers.current = [worker("W1", { label: "One" }), worker("W2", { label: "Three" }), worker("W3", { label: "None" })];
    o.workerWaiting = { W1: { on: null, checked: true, children: 1 }, W2: { on: null, checked: true, children: 3 }, W3: { on: null, checked: true, children: 0 } };
    const slot = await workersTab(o);
    const fold = (name: string) => slot.getByRole("button", { name }).closest("li")!.querySelector<HTMLButtonElement>(":scope > .cr-w-fold")?.textContent ?? null;
    expect(fold("W1 One")).toBe("1 child thread");
    expect(fold("W2 Three")).toBe("3 child threads");
    expect(fold("W3 None")).toBeNull();
  });

  it("a child offers its own children only when the cache counts some, with that count", async () => {
    const o = base();
    o.workers.current = [worker("W1", { label: "Lead" })];
    o.workerWaiting = { W1: { on: null, checked: true, children: 3 } };
    const childPage = (input: unknown) => {
      const { threadId } = input as { threadId: string };
      return { status: "ready", value: { rows: threadId === "thr_W1" ? [child(1, 0), child(2, 2), child(3, null)] : [child(4, 0), child(5, 0)], next: null } };
    };
    const slot = await workersTab(o, undefined, childPage);
    const row = slot.getByRole("button", { name: "W1 Lead" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "3 child threads" }));
    await within(row).findByRole("button", { name: "Open Helper 3" });
    const nested = within(row).getAllByRole("button", { name: /child thread/ }).map((b) => [b.getAttribute("aria-label") ?? b.textContent, b.textContent]);
    expect(nested).toEqual([["3 child threads", "3 child threads"], ["Helper 2: 2 child threads", "2 child threads"]]);
    fireEvent.click(within(row).getByRole("button", { name: "Helper 2: 2 child threads" }));
    await within(row).findByRole("button", { name: "Open Helper 5" });
    expect(within(row).queryByText("No child threads.")).toBeNull();
  });
});

describe("W473 an open tree re-reads on its own signal", () => {
  it("a child-page signal for its thread refreshes it; one for another thread, nothing", async () => {
    const o = base();
    o.workers.current = [worker("W1", { label: "Lead" })];
    o.workerWaiting = { W1: { on: null, checked: true, children: 1 } };
    let rows = [child(1, 0)];
    const childPage = vi.fn(() => ({ status: "ready", value: { rows, next: null } }));
    const slot = await workersTab(o, undefined, childPage);
    const row = slot.getByRole("button", { name: "W1 Lead" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "1 child thread" }));
    await within(row).findByRole("button", { name: "Open Helper 1" });
    const reads = childPage.mock.calls.length;
    rows = [child(2, 0), child(1, 0)];
    await slot.emitRealtime("initiatives-children", { threadId: "thr_W2" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(childPage.mock.calls.length).toBe(reads);
    await slot.emitRealtime("initiatives-children", { threadId: "thr_W1" });
    await within(row).findByRole("button", { name: "Open Helper 2" });
  });
});

describe("W465 childPage counts each child's children from the cache", () => {
  type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
  const childOf = (f: Fx, id: string, parentThreadId: string) =>
    f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: "idle" as never, title: `Thread ${id}`, createdAt: Date.now() }) as never);

  it("null until the child's own tree is listed, which the page starts in the background; then its count, with no extra read", async () => {
    const { f, project } = await projectFixture();
    const [w] = JSON.parse((await f.harness.callAgentTool("initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." }, { threadId: "coordinator" })) as string);
    childOf(f, "reviewer", w.threadId);
    childOf(f, "helper", w.threadId);
    childOf(f, "grandchild", "reviewer");
    const input = { projectId: project.id, threadId: w.threadId };
    const counts = (page: Awaited<ReturnType<typeof settledChildPage>>) =>
      page.status === "ready" ? Object.fromEntries(page.value.rows.map((r) => [r.threadId, r.children])) : page.error;
    expect(counts(await settledChildPage(f.harness, input))).toEqual({ reviewer: null, helper: null });
    // W473: nobody opens the children; the page's own background listings count them.
    await vi.waitFor(async () => expect(counts(await settledChildPage(f.harness, input))).toEqual({ reviewer: 1, helper: 0 }));
    let lists = 0;
    f.intercept((path, _args, call) => { if (path === "threads.list") lists++; return call(); });
    // The worker's page is still fresh in its cache: the counts come from the cache alone.
    expect(counts(await settledChildPage(f.harness, input))).toEqual({ reviewer: 1, helper: 0 });
    expect(lists).toBe(0);
  });
});
