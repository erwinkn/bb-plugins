// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview } from "../lib/overview";

// T98: a question the coordinator withdrew leaves the Inbox and stays visible in
// Decisions history as a withdrawal, distinct from the user's quiet close.
installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of mounted.splice(0)) slot.unmount(); cleanup(); });

const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
function overview() {
  const { db, store } = memoryStore();
  store.createProject({ id: "p1", name: "Search", objective: "Focused work", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
  const ask = (question: string) => store.addDecision({
    projectId: "p1", title: question, topic: question, scope: "project", status: "active",
    body: { title: question, humanAttention: "needs-opinion", blocksTaskIds: [], question, context: "c", options: [] } as never,
    madeBy: null, humanAttention: "needs-opinion", blocks: [], deadline: null, provenance: coordinator, supersedes: null,
  });
  const withdrawn = ask("Which component kit?");
  store.updateDecision("p1", withdrawn.num, { status: "withdrawn", body: { ...withdrawn.body, resolution: { note: "Settled by D15.", at: Date.now(), withdrawnBy: coordinator } } });
  const closed = ask("Include archives?");
  store.updateDecision("p1", closed.num, { status: "closed", body: { ...closed.body, resolution: { note: "", at: Date.now() } } });
  ask("Ship Friday?");
  const o = buildOverview(store, "p1", new Map(), Date.now());
  db.close();
  return o;
}

it("shows a withdrawal honestly in Decisions history and keeps only open questions in the Inbox", async () => {
  const o = overview();
  expect(o.opinionNeeded.map(q => q.question)).toEqual(["Ship Friday?"]);
  const command = vi.fn();
  const slot = renderSlot(app.navPanels[0], { subPath: "p1" }, { rpc: { inventory: () => [], list: () => [], overview: () => o, command } });
  mounted.push(slot);
  await slot.findAllByText("Ship Friday?");
  expect(slot.queryByText("Which component kit?")).toBeNull();
  fireEvent.click(slot.getByRole("tab", { name: /Decisions/ }));
  fireEvent.click(await slot.findByText("Closed questions · 2"));
  const row = slot.getByText("D1 · Withdrawn by the coordinator · No answer recorded").closest("article")!;
  expect(within(row).getByText("Which component kit?")).toBeTruthy();
  expect(within(row).getByText("Settled by D15.")).toBeTruthy();
  expect(within(row).queryByText("Yours")).toBeNull();
  expect(slot.getByText("D2 · Closed quietly · No answer recorded")).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});
