// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type Overview, type WorkerChild, type WorkerItem } from "../lib/overview";

// v9 §10: the Workers, Tasks and Rules tabs of the dashboard.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const { modelName, tokenCount, toTab } = await import("../control-room");
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
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
  open: null, latestReport: null, stopReason: null, tokens: null, prs: [], since: NOW - 60_000, ...over,
});
const child = (threadId: string, title: string, status: string, ago = 6): WorkerChild => ({
  threadId, title, status, archived: false, running: status === "active" ? "active" : null, providerId: "codex", updatedAt: NOW - ago * 60_000, children: 0,
});
// The live child pages childPage answers, by parent thread.
const CHILDREN: Record<string, WorkerChild[]> = {
  thr_W1420: [child("thr_r3", "Review r3 #2631", "active", 6), child("thr_r2", "Review r2 #2631", "idle", 19)],
  thr_W1373: [child("thr_r1", "Review r1 #2544", "idle", 40), child("thr_r0", "Review r0 #2544", "idle", 90)],
};
const report = (outcome: "done" | "blocked" | "failed", summary: string, question: string | null = null) => ({
  ref: "A9", outcome, summary, question, reportedAt: NOW - 3_600_000, preSwitch: null,
});
function mount(o: Overview, command = vi.fn().mockResolvedValue({})) {
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o, command,
    childPage: (input: unknown) => ({ status: "ready", value: { rows: CHILDREN[(input as { threadId: string }).threadId] ?? [], next: null } }) } });
  mounted.push(slot);
  return { slot, command };
}
const sent = (command: ReturnType<typeof vi.fn>, n = 0) => command.mock.calls[n]![0].command;

describe("v9 tabs", () => {
  it("maps the views a remembered tab or old route may name", () => {
    expect(["threads", "decisions", "context", "log", "workers", "nonsense", "toString"].map(toTab))
      .toEqual(["workers", "archive", "rules", "activity", "workers", null, null]);
  });

  it("shows model names and token totals compactly", () => {
    expect(modelName("claude-code / claude-opus-5-5 / high / tier unspecified")).toBe("Opus 5.5");
    expect(modelName("codex / gpt-6.1-sol / high / fast")).toBe("Sol 6.1");
    expect(modelName("codex / gpt-5-codex / high / fast")).toBe("gpt-5-codex");
    expect(modelName(null)).toBeNull();
    expect([3_100_000, 18_420_000, 950_000, 420].map(tokenCount)).toEqual(["3.1M", "18.4M", "950k", "420"]);
  });
});

describe("v9 Workers tab", () => {
  function fleet() {
    const o = base();
    o.workers.current = [
      worker("W1406", { label: "PDF Worker perf", latestReport: report("blocked", "Paid caps CPU at 30 s.", "Split rendering into pages or move to a queue consumer?"), tokens: 4_800_000 }),
      worker("W1247", { label: "Catalog binding fixes", runtime: "error", stopReason: "provider 529", prs: [{ url: "https://github.com/e/m/pull/2500", stage: "in-review" }] }),
      worker("W1425", { label: "Slot safety fixes", runtime: "active", open: { ref: "A1650", state: "running", tasks: ["T163"] } }),
      worker("W1420", { label: "Human-steps SQL fix", open: { ref: "A1641", state: "idle_no_report", tasks: ["T163"] }, prs: [{ url: "https://github.com/e/m/pull/2631", stage: "working" }], tokens: 3_100_000 }),
      worker("W1373", { label: "Enum cleanup", latestReport: report("done", "Removed 23 unused enum types.\nAll tests pass.") }),
    ];
    o.workerWaiting = {
      W1420: { on: { threadId: "thr_r3", title: "Review r3 #2631", running: "active", since: NOW - 6 * 60_000 }, checked: true },
      W1373: { on: null, checked: true, children: 2 },
    };
    o.blockers = [{ assignment: "A9", role: "work", tasks: [], owner: { worker: "W1406", label: "PDF Worker perf", threadId: "thr_W1406" },
      question: "Split rendering into pages or move to a queue consumer?", context: "", options: [], recommendation: null, reportedAt: NOW - 3_600_000, answer: null }];
    o.tasks = [{ ref: "T163", title: "Human-steps query double-counts", status: "in_progress", statusReason: "W1420 on A1641", setByHand: false, summary: "", workers: ["W1420", "W1425"], updatedAt: NOW }];
    return o;
  }

  it("lists every worker under its group, says why from recorded text, and sums the fleet", async () => {
    const { slot } = mount(fleet());
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    expect(slot.getByRole("tab", { name: /Workers/ }).textContent).toBe("Workers5");
    expect(slot.getByText("1 working · 1 waiting · 1 needs you · 1 done · 1 stopped · 7.9M tokens")).toBeTruthy();
    const rows = (group: string) => within(slot.getByRole("region", { name: group })).getAllByRole("button", { name: /^W\d+ / }).map((b) => b.getAttribute("aria-label"));
    expect(rows("Needs you")).toEqual(["W1406 PDF Worker perf"]);
    expect(rows("Stopped")).toEqual(["W1247 Catalog binding fixes"]);
    expect(rows("Working")).toEqual(["W1425 Slot safety fixes"]);
    expect(rows("Waiting")).toEqual(["W1420 Human-steps SQL fix"]);
    expect(rows("Done · PR waiting")).toEqual(["W1373 Enum cleanup"]);
    const needs = slot.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Blocked: Split rendering into pages or move to a queue consumer?")).toBeTruthy();
    const stopped = slot.getByRole("region", { name: "Stopped" });
    expect(within(stopped).getByText("Thread failed: provider 529")).toBeTruthy();
    expect(within(stopped).getByText("#2500")).toBeTruthy();
    const working = slot.getByRole("region", { name: "Working" });
    expect(within(working).getByText("Running")).toBeTruthy();
    // No worker row names who gave it work: the coordinator always did.
    expect(within(working).queryByText(/^from /)).toBeNull();
    const waiting = slot.getByRole("region", { name: "Waiting" });
    expect(within(waiting).getByText("Waiting on “Review r3 #2631” (running 6m)")).toBeTruthy();
    expect(within(waiting).getByText("Opus 5.5 · high")).toBeTruthy();
  });

  it("opens each worker's thread and each child's thread from its row; only a waiting worker shows its children open", async () => {
    const { slot, command } = mount(fleet());
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    slot.navigateCalls.length = 0;
    fireEvent.click(slot.getByRole("button", { name: "W1420 Human-steps SQL fix" }));
    fireEvent.click(await slot.findByRole("button", { name: "Open Review r3 #2631" }));
    fireEvent.click(slot.getByRole("button", { name: "Open Review r2 #2631" }));
    expect(slot.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_W1420" },
      { method: "toThread", threadId: "thr_r3" },
      { method: "toThread", threadId: "thr_r2" },
    ]);
    // W1373 reported done: its children are read when asked for.
    const done = slot.getByRole("region", { name: "Done · PR waiting" });
    expect(within(done).queryByRole("button", { name: "Open Review r1 #2544" })).toBeNull();
    fireEvent.click(within(done).getByRole("button", { name: "2 child threads" }));
    fireEvent.click(await within(done).findByRole("button", { name: "Open Review r1 #2544" }));
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_r1" });
    expect(command).not.toHaveBeenCalled();
  });

  it("the detail shows status, report, PRs, tasks and children, and stops or retires the worker", async () => {
    const { slot, command } = mount(fleet());
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    fireEvent.contextMenu(slot.getByRole("button", { name: "W1420 Human-steps SQL fix" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Details" }));
    const detail = slot.getByRole("region", { name: "W1420 details" });
    expect(within(detail).getByRole("heading", { name: "Human-steps SQL fix" })).toBeTruthy();
    expect(within(detail).getByText("Waiting on “Review r3 #2631” (running 6m)")).toBeTruthy();
    expect(within(detail).getByRole("link", { name: "#2631" }).getAttribute("href")).toBe("https://github.com/e/m/pull/2631");
    expect(within(detail).getByText("Human-steps query double-counts")).toBeTruthy();
    slot.navigateCalls.length = 0;
    fireEvent.click(within(detail).getByRole("button", { name: "Open thread" }));
    fireEvent.click(await within(detail).findByRole("button", { name: "Open Review r3 #2631" }));
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_W1420" }, { method: "toThread", threadId: "thr_r3" }]);
    fireEvent.click(within(detail).getByRole("button", { name: "Stop" }));
    fireEvent.change(within(detail).getByLabelText("Reason for stop"), { target: { value: "Superseded by W1433" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(sent(command)).toEqual({ action: "worker-stop", worker: "W1420", reason: "Superseded by W1433" });
    fireEvent.click(within(detail).getByRole("button", { name: "Retire" }));
    fireEvent.change(within(detail).getByLabelText("Reason for retire"), { target: { value: "Done" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Confirm retire" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(sent(command, 1)).toEqual({ action: "worker-retire", worker: "W1420", reason: "Done" });
    // Back to the list (the narrow layout's back row).
    fireEvent.click(within(detail).getByRole("button", { name: "‹ Workers" }));
    expect(slot.queryByRole("region", { name: "W1420 details" })).toBeNull();
  });

  it("a blocked report shows its question and the pre-switch line; retired workers fold under Earlier", async () => {
    const o = fleet();
    o.workers.current[0]!.latestReport = { ...report("blocked", "Paid caps CPU at 30 s.", "Pages or a queue?"), preSwitch: "Given out before the switch to v9." };
    o.workers.retired = [worker("W1302", { label: "Clerk follow-up", state: "retired" })];
    const { slot } = mount(o);
    fireEvent.click(await slot.findByRole("tab", { name: /Workers/ }));
    const earlier = slot.getByRole("button", { name: "W1302 Clerk follow-up" }).closest("details")!;
    expect(earlier.open).toBe(false);
    fireEvent.click(slot.getByText("Earlier"));
    expect(earlier.open).toBe(true);
    expect(within(slot.getByRole("region", { name: "Earlier" })).getByRole("button", { name: "W1302 Clerk follow-up" })).toBeTruthy();
    fireEvent.contextMenu(slot.getByRole("button", { name: "W1406 PDF Worker perf" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Details" }));
    const detail = slot.getByRole("region", { name: "W1406 details" });
    expect(within(detail).getByText("Pages or a queue?")).toBeTruthy();
    expect(within(detail).getByText("Given out before the switch to v9.")).toBeTruthy();
  });

  it("a task's linked worker opens that worker in the Workers tab", async () => {
    const { slot } = mount(fleet());
    fireEvent.click(await slot.findByRole("tab", { name: /Tasks/ }));
    fireEvent.click(slot.getByText("Human-steps query double-counts"));
    fireEvent.click(slot.getByRole("button", { name: "W1425" }));
    expect(slot.getByRole("tab", { name: /Workers/ }).getAttribute("aria-selected")).toBe("true");
    expect(slot.getByRole("region", { name: "W1425 details" })).toBeTruthy();
  });
});

describe("v9 Tasks tab", () => {
  function tasks() {
    const o = base();
    o.tasks = [
      { ref: "T163", title: "Human-steps query", status: "in_progress", statusReason: "W1420 on A1641", setByHand: false, summary: "", workers: ["W1420"], updatedAt: NOW },
      { ref: "T142", title: "Catalog reconciler", status: "blocked", statusReason: "W1247's thread failed: provider 529", setByHand: false, summary: "", workers: ["W1247"], updatedAt: NOW },
      { ref: "T151", title: "Template picker", status: "planned", statusReason: "#2588 closed unmerged", setByHand: false, summary: "", workers: [], updatedAt: NOW },
      { ref: "T40", title: "Import DNS", status: "cancelled", statusReason: "", setByHand: true, summary: "", workers: [], updatedAt: NOW },
      { ref: "T7", title: "Old work", status: "done", statusReason: "#2400 merged", setByHand: false, summary: "", workers: [], updatedAt: NOW },
    ];
    return o;
  }

  it("groups tasks In progress, Blocked, Planned, with Done and Cancelled folded; a hand-set status says so", async () => {
    const { slot } = mount(tasks());
    fireEvent.click(await slot.findByRole("tab", { name: /Tasks/ }));
    const titles = (name: string) => within(slot.getByRole("region", { name })).getAllByText(/^(Human|Catalog|Template|Import|Old)/).map((e) => e.textContent);
    expect(titles("In progress")).toEqual(["Human-steps query"]);
    expect(titles("Blocked")).toEqual(["Catalog reconciler"]);
    expect(titles("Planned")).toEqual(["Template picker"]);
    expect(within(slot.getByRole("region", { name: "Planned" })).getByText("#2588 closed unmerged")).toBeTruthy();
    const folded = Array.from(slot.container.querySelectorAll("details.cr-earlier")).map((d) => [d.querySelector("summary")!.textContent, (d as HTMLDetailsElement).open]);
    expect(folded).toEqual([["Done 1", false], ["Cancelled 1", false]]);
    expect(within(slot.getByRole("region", { name: "Cancelled" })).getByText("set by hand")).toBeTruthy();
  });

  it("Cancel task, Mark done, Mark planned and Follow the work send task-status", async () => {
    const { slot, command } = mount(tasks());
    fireEvent.click(await slot.findByRole("tab", { name: /Tasks/ }));
    fireEvent.click(slot.getByText("Template picker"));
    const row = within(slot.getByText("Template picker").closest("details")!);
    expect(row.queryByRole("button", { name: "Mark planned" })).toBeNull();
    expect(row.queryByRole("button", { name: "Follow the work" })).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(sent(command)).toEqual({ action: "task-status", task: "T151", status: "cancelled", reason: "Set from the Tasks tab." });
    fireEvent.click(row.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(sent(command, 1)).toMatchObject({ action: "task-status", task: "T151", status: "done" });
    fireEvent.click(slot.getByText("Cancelled"));
    fireEvent.click(slot.getByText("Import DNS"));
    const cancelled = within(slot.getByText("Import DNS").closest("details")!);
    expect(cancelled.queryByRole("button", { name: "Cancel task" })).toBeNull();
    fireEvent.click(cancelled.getByRole("button", { name: "Mark planned" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(sent(command, 2)).toMatchObject({ action: "task-status", task: "T40", status: "planned" });
    fireEvent.click(cancelled.getByRole("button", { name: "Follow the work" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4));
    expect(sent(command, 3)).toEqual({ action: "task-status", task: "T40", status: "auto", reason: "Set from the Tasks tab." });
  });
});

describe("v9 Rules tab", () => {
  function rules() {
    const o = base();
    o.rules = [
      { ref: "R1", text: "Every PR targets dev.", sources: ["D86", "D214"] },
      { ref: "R2", text: "Never run seed:prod.", sources: [] },
      { ref: "R3", text: "Money uses Decimal.", sources: [] },
    ];
    return o;
  }
  async function open(o = rules()) {
    const mountedSlot = mount(o);
    fireEvent.click(await mountedSlot.slot.findByRole("tab", { name: "Rules" }));
    return mountedSlot;
  }

  it("shows purpose, the numbered rules with their sources, who gets them, and links the Archive", async () => {
    const { slot } = await open();
    expect(slot.getByText("Ship the market platform")).toBeTruthy();
    const list = slot.getByRole("region", { name: "Standing rules" });
    expect(within(list).getByText("3 / 60")).toBeTruthy();
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.querySelector(".cr-ref")!.textContent)).toEqual(["R1", "R2", "R3"]);
    expect(within(list).getByText("from D86, D214")).toBeTruthy();
    expect(within(list).getByText(/The coordinator and every worker get these/)).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: /^Archive/ }));
    expect(slot.getByRole("tab", { name: "Archive" }).getAttribute("aria-selected")).toBe("true");
  });

  it("adds, edits, deletes and reorders rules with the rule commands", async () => {
    const { slot, command } = await open();
    fireEvent.click(slot.getByRole("button", { name: "+ Add rule" }));
    fireEvent.change(slot.getByLabelText("New rule"), { target: { value: "  Ask before   adding a dependency.  " } });
    fireEvent.click(slot.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(sent(command)).toEqual({ action: "rule-add", text: "Ask before adding a dependency." });
    await waitFor(() => expect(slot.queryByLabelText("New rule")).toBeNull());

    fireEvent.click(slot.getByRole("button", { name: "Edit R2" }));
    fireEvent.change(slot.getByLabelText("Edit R2"), { target: { value: "Never run seed:prod; propose it to Erwin." } });
    fireEvent.submit(slot.getByLabelText("Edit R2").closest("form")!);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(sent(command, 1)).toEqual({ action: "rule-edit", rule: "R2", text: "Never run seed:prod; propose it to Erwin." });

    fireEvent.click(slot.getByRole("button", { name: "Delete R3" }));
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(sent(command, 2)).toEqual({ action: "rule-remove", rule: "R3" });

    expect((slot.getByRole("button", { name: "Move R1 up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((slot.getByRole("button", { name: "Move R3 down" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Move R2 up" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4));
    expect(sent(command, 3)).toEqual({ action: "rule-move", rule: "R2", to: 1 });
    fireEvent.click(slot.getByRole("button", { name: "Move R2 down" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(5));
    expect(sent(command, 4)).toEqual({ action: "rule-move", rule: "R2", to: 3 });
  });

  it("keeps a refused rule in its box with the error on one line", async () => {
    const o = rules();
    const command = vi.fn().mockRejectedValue(new Error("A rule is one line: one or two sentences."));
    const { slot } = mount(o, command);
    fireEvent.click(await slot.findByRole("tab", { name: "Rules" }));
    fireEvent.click(slot.getByRole("button", { name: "+ Add rule" }));
    fireEvent.change(slot.getByLabelText("New rule"), { target: { value: "Something" } });
    fireEvent.click(slot.getByRole("button", { name: "Save rule" }));
    expect((await slot.findByRole("alert")).textContent).toBe("A rule is one line: one or two sentences.");
    expect((slot.getByLabelText("New rule") as HTMLInputElement).value).toBe("Something");
  });
});
