// @vitest-environment jsdom
// The frontend slots driven against the real backend on the SDK fake host:
// RPC calls from the components go through the host's RPC validation into the
// actual runtime and store. No BB server, no network.

import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../src/rpc.js";
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
    fireEvent.click(await slot.findByText("Watch"));
    const row = await within(document.body).findByText("Pick me");
    fireEvent.click(within(row.closest("li")!).getByText("Watch"));
    await waitFor(() => expect(r.store.getWatchByThread("thr_pick")).not.toBeNull());
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
