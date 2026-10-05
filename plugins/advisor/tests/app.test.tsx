// @vitest-environment jsdom
// The frontend slots driven against the real backend on the SDK fake host:
// RPC calls from the components go through the host's RPC validation into the
// actual runtime and store. No BB server, no network.

import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../src/rpc.js";
import { unavailableInitiatives } from "../src/runtime/initiatives.js";
import { oneLineDiff, rig, type Rig } from "./helpers/world.js";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

const T = "thr_ui";
const EXACT = "it('computes totals', () => expect(total(l)).toBe(42));";
const LOOSE = "it('computes totals', () => expect(total(l)).toBeGreaterThan(0));";

function rpcFor(r: Rig) {
  return Object.fromEntries(Object.keys(rpcContract).map((m) => [m, (input: unknown) => r.harness.behavior.callRpc(m, input ?? null)]));
}

async function backendWithFinding(settings: Record<string, unknown> = { reviewEnabled: true, severityThreshold: "note" }) {
  const r = await rig(settings);
  r.world.addThread(T, { title: "Fix totals" });
  await r.advisor.watch(T, "test");
  await r.tick();
  r.world.turnStart(T);
  r.world.fileChange(T, "/repo/tests/totals.test.ts", oneLineDiff(1, EXACT, LOOSE));
  r.world.turnEnd(T);
  r.clock.advance(5 * 60_000);
  await r.tick();
  return r;
}

describe("Advisor page", () => {
  it("shows activation honestly, lists watched threads and opens a finding with its exact citation", async () => {
    const r = await backendWithFinding();
    const w = r.store.getWatchByThread(T)!;
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: w.id }, { rpc: rpcFor(r) as any });
    await slot.findByText("reviews on");
    expect(slot.getByText("provider requests off")).toBeTruthy();
    expect(slot.getAllByText("Fix totals").length).toBeGreaterThan(0);
    await slot.findByText("subject verified");
    expect(slot.getByText("fake reviewer: not a judgment")).toBeTruthy();
    expect(slot.getByText(/\+ it\('computes totals', \(\) => expect\(total\(l\)\)\.toBeGreaterThan\(0\)\);/u)).toBeTruthy();
    expect(slot.getByText(/- it\('computes totals', \(\) => expect\(total\(l\)\)\.toBe\(42\)\);/u)).toBeTruthy();
    fireEvent.click(slot.getByText("Mark seen"));
    await waitFor(() => expect(r.store.listOccurrences(w.id)[0]!.acknowledgedAt).not.toBeNull());
    expect(r.store.issueState(w.id, "test-integrity", r.store.listOccurrences(w.id)[0]!.locator)).toBe("open");
    await slot.findByText(/^seen /u);
    fireEvent.click(slot.getByText("Coverage"));
    await slot.findByText(/Requirement coverage/u);
    expect(slot.getByText(/Observed from #1; read through #/u)).toBeTruthy();
  });

  it("findings below the display threshold are stored but collapsed", async () => {
    const r = await backendWithFinding({ reviewEnabled: true });
    const w = r.store.getWatchByThread(T)!;
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: w.id }, { rpc: rpcFor(r) as any });
    await slot.findByText(/No findings to show/u);
    fireEvent.click(slot.getByLabelText(/Show below “concern” \(1\)/u));
    await slot.findByText("subject verified");
  });

  it("an empty page says watching is off until a thread is picked", async () => {
    const r = await rig({});
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpcFor(r) as any });
    await slot.findByText("No thread is watched. Watching is off until you pick a thread.");
    expect(slot.getByText(/Initiative finding intake: Unavailable/u)).toBeTruthy();
  });

  it("picks a thread to watch from the dialog", async () => {
    const r = await rig({});
    r.world.addThread("thr_pick", { title: "Pick me" });
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpcFor(r) as any });
    fireEvent.click(await slot.findByLabelText("Watch a thread"));
    const row = await within(document.body).findByText("Pick me");
    fireEvent.click(within(row.closest("li")!).getByText("Watch"));
    await waitFor(() => expect(r.store.getWatchByThread("thr_pick")).not.toBeNull());
  });

  it("watches a whole Initiative from the picker and shows its members and roles", async () => {
    const initiatives = {
      ...unavailableInitiatives,
      available: true,
      async initiatives() {
        return { status: "ok" as const, value: [{ id: "prj_1", name: "bb-plugins", paused: false, coordinatorThreadId: "thr_c" }] };
      },
      async members(id: string) {
        return {
          status: "ok" as const,
          value: { id, name: "bb-plugins", archived: false, next: null, members: [{ threadId: "thr_c", kind: "coordinator", role: "coordinator", worker: null, generation: 1, state: "active" as const }, { threadId: "thr_w", kind: "worker", role: "review", worker: "W4", generation: 1, state: "active" as const }] },
        };
      },
    };
    const r = await rig({}, { initiatives });
    r.world.addThread("thr_c", { title: "Coordinator" });
    r.world.addThread("thr_w", { title: "Review totals" });
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpcFor(r) as any });
    fireEvent.click(await slot.findByLabelText("Watch an Initiative"));
    const row = await within(document.body).findByText("bb-plugins");
    fireEvent.click(within(row.closest("li")!).getByText("Watch"));
    await waitFor(() => expect(r.store.listWatches().map((w) => w.origin)).toEqual(["initiative", "initiative"]));
    await slot.findByText("2 observed of 2 live members");
    expect(slot.getByText("W4 review")).toBeTruthy();
    fireEvent.click(slot.getByText("On"));
    await waitFor(() => expect(r.store.listWatches().every((w) => !w.enabled)).toBe(true));
  });

  it("T105: opens on one feed across watches, filters it, marks all seen, and Discuss goes to its own route", async () => {
    const r = await backendWithFinding();
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpcFor(r) as any });
    await slot.findByText("1 new");
    expect(slot.getAllByText("Fix totals").length).toBeGreaterThan(0);
    expect((slot.getByLabelText("Thread") as HTMLSelectElement).options.length).toBe(2);
    const occ = r.store.listOccurrences(r.store.getWatchByThread(T)!.id)[0]!;
    fireEvent.click(slot.getByText("Discuss"));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toPluginPanel", options: expect.objectContaining({ subPath: `discuss/${occ.id}` }) }));
    fireEvent.click(slot.getByText("Mark all seen"));
    await waitFor(() => expect(r.store.getOccurrence(occ.id)!.acknowledgedAt).not.toBeNull());
    await slot.findByText("0 new");
  });

  it("T105: Discuss seeds BB's composer with the finding and creates the separate thread only on submit", async () => {
    const r = await backendWithFinding();
    const occ = r.store.listOccurrences(r.store.getWatchByThread(T)!.id)[0]!;
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: `discuss/${occ.id}` }, { rpc: rpcFor(r) as any });
    const input = (await slot.findByTestId("bb-new-thread-composer-input")) as HTMLTextAreaElement;
    expect(input.value).toContain(occ.summary);
    expect(slot.getByTestId("bb-new-thread-composer").getAttribute("data-draft-key")).toBe(`advisor:discuss:${occ.id}`);
    expect(r.world.spawns).toEqual([]);
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(r.world.spawns).toHaveLength(1));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "thr_spawned_1" })));
  });

  it("T105: the sidebar badge counts unseen findings live and hides at zero", async () => {
    const r = await backendWithFinding();
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const badge = renderSlot({ component: page.experimental_sidebarAccessory! }, {}, { rpc: rpcFor(r) as any });
    await badge.findByLabelText("1 new Advisor findings");
    r.store.acknowledgeAll(null, r.clock.now());
    await badge.behavior.emitRealtime("advisor.changed", {});
    await waitFor(() => expect(badge.queryByLabelText(/new Advisor findings/u)).toBeNull());
  });

  it("A252 #3: Mark all seen stays available while an unseen finding is only on an older page", async () => {
    const r = await backendWithFinding();
    const w = r.store.getWatchByThread(T)!;
    const o = r.store.listOccurrences(w.id)[0]!;
    for (let i = 1; i <= 50; i++) {
      r.store.addOccurrence({ ...o, id: `seen_${i}`, locator: `seen_${i}`, createdAt: o.createdAt + i }, true);
      r.store.acknowledge(`seen_${i}`, r.clock.now());
    }
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpcFor(r) as any });
    await slot.findByText("1 new");
    expect(slot.getByText("Older findings")).toBeTruthy();
    const button = slot.getByRole("button", { name: "Mark all seen" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(r.store.getOccurrence(o.id)!.acknowledgedAt).not.toBeNull());
  });

  it("A252 #1: a late response for an earlier filter is dropped, and Mark all seen acts on the filter shown", async () => {
    const r = await backendWithFinding();
    r.world.addThread("thr_b", { title: "Thread B" });
    const b = await r.advisor.watch("thr_b", "test");
    const a = r.store.getWatchByThread(T)!;
    const o = r.store.listOccurrences(a.id)[0]!;
    r.store.addOccurrence({ ...o, id: "b_finding", watchId: b.id, locator: "b_finding", summary: "Finding B", createdAt: o.createdAt + 1 }, true);
    const rpc = rpcFor(r) as Record<string, (input: any) => Promise<any>>;
    let release: () => void = () => {};
    let waiting = false;
    const realFeed = rpc.feed!;
    rpc.feed = async (input) => {
      const result = await realFeed(input);
      if (input?.watchId === a.id) {
        waiting = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return result;
    };
    let marked: any = null;
    const realMark = rpc.feedMarkSeen!;
    rpc.feedMarkSeen = (input) => ((marked = input), realMark(input));
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpc as any });
    await slot.findByText("Finding B");
    fireEvent.change(slot.getByLabelText("Thread"), { target: { value: a.id } });
    await waitFor(() => expect(waiting).toBe(true));
    fireEvent.change(slot.getByLabelText("Thread"), { target: { value: b.id } });
    await waitFor(() => expect(slot.queryByText(o.summary)).toBeNull());
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByText(o.summary)).toBeNull();
    expect(slot.getByText("Finding B")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Mark all seen" }));
    await waitFor(() => expect(marked).toEqual({ watchId: b.id }));
    expect(r.store.getOccurrence(o.id)!.acknowledgedAt).toBeNull();
  });

  it("the Initiative picker says plainly when Projects cannot be read", async () => {
    const r = await rig({});
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: "" }, { rpc: rpcFor(r) as any });
    fireEvent.click(await slot.findByLabelText("Watch an Initiative"));
    await within(document.body).findByText(/Initiatives cannot be listed: the Projects context routes are unavailable/u);
  });

  it("preview runs the fake reviewer without spending", async () => {
    const r = await rig({ route: "luna:openai-api", severityThreshold: "note" });
    r.world.addThread(T, { title: "Fix totals" });
    await r.advisor.watch(T, "test");
    await r.tick();
    r.world.turnStart(T);
    r.world.fileChange(T, "/repo/tests/totals.test.ts", oneLineDiff(1, EXACT, LOOSE));
    r.world.turnEnd(T);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const page = app.navPanels.find((p) => p.id === "advisor")!;
    const slot = renderSlot(page, { subPath: w.id }, { rpc: rpcFor(r) as any });
    fireEvent.click(await slot.findByText("Preview (fake)"));
    await waitFor(() => expect(r.store.listReviews(w.id)[0]?.preview).toBe(true));
    expect(r.store.listLedger()).toEqual([]);
    await slot.findByText("preview (fake reviewer): not a judgment");
  });
});

describe("thread panel and settings", () => {
  it("the thread panel offers to watch an unwatched thread", async () => {
    const r = await rig({});
    r.world.addThread(T);
    const action = app.threadPanelActions.find((a) => a.id === "advisor-thread")!;
    const slot = renderSlot(action, { threadId: T, params: null }, { rpc: rpcFor(r) as any });
    fireEvent.click(await slot.findByText("Watch this thread"));
    await waitFor(() => expect(r.store.getWatchByThread(T)).not.toBeNull());
    await slot.findByText("Findings");
  });

  it("the settings section shows cross-field errors, secret presence and unverified route facts", async () => {
    const r = await rig({ route: "sonnet:pool", reviewEnabled: true });
    const section = app.settingsSections.find((s) => s.id === "advisor-state")!;
    const slot = renderSlot(section, {}, { rpc: rpcFor(r) as any });
    await slot.findByText(/Reviews: Route sonnet:pool uses subscription quota/u);
    expect(slot.getByText(/anthropicApiKey not set/u)).toBeTruthy();
    expect(slot.getByText(/U1: whether Anthropic accepts/u)).toBeTruthy();
    expect(slot.getByText(/never falls back to another model/u)).toBeTruthy();
  });
});
