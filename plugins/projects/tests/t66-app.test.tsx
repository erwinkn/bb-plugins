// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); });
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const beat = () => act(async () => { await new Promise(r => setTimeout(r, 190)); });

it("Context manual Refresh reloads loaded inventory without forcing detailed telemetry", async () => {
  const { f, project } = await projectFixture(); const o = await f.overview(project.id);
  const overview = vi.fn(async (_input: unknown) => o), inventory = vi.fn(async () => []);
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, inventory } }); slots.push(s);
  fireEvent.click(await s.findByRole("tab", { name: "Context" }));
  await waitFor(() => expect(inventory).toHaveBeenCalledTimes(1)); expect(overview).toHaveBeenCalledTimes(1);
  fireEvent.click(s.getByRole("button", { name: "Initiative menu" })); fireEvent.click(s.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(inventory).toHaveBeenCalledTimes(2)); expect(overview.mock.calls.every(c => (c[0] as { detail?: string }).detail === "summary")).toBe(true);
});
it("manual Refresh after Usage keeps global inventory lazy when it was never loaded", async () => {
  const { f, project } = await projectFixture(); const o = await f.overview(project.id);
  const overview = vi.fn(async (_input: unknown) => o), inventory = vi.fn(async () => []);
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, inventory } }); slots.push(s);
  fireEvent.click(await s.findByRole("tab", { name: "Usage" })); await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  fireEvent.click(s.getByRole("button", { name: "Initiative menu" })); fireEvent.click(s.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(overview).toHaveBeenCalledTimes(4)); expect(inventory).not.toHaveBeenCalled();
});
it("zero eligibility protects user choices/questions and disables the bulk control with no RPC", async () => {
  const { f, project } = await projectFixture();
  f.service.recordDecision(project.id, { decision: { description: "User choice", madeBy: "user" } }, recorder);
  f.service.recordQuestion(project.id, { title: "Scope", question: "Scope?", context: "Need scope", humanAttention: "needs-opinion" }, recorder);
  const o = await f.overview(project.id), command = vi.fn();
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: () => o, command } }); slots.push(s);
  fireEvent.click(await s.findByRole("tab", { name: "Decisions" })); const clear = s.getByRole("button", { name: "Accept all unchecked agent decisions" }) as HTMLButtonElement;
  expect(clear.disabled).toBe(true); fireEvent.click(clear); expect(command).not.toHaveBeenCalled();
});
it("already accepted choices stay readable and cannot be bulk accepted again; empty Inbox hides its section", async () => {
  const { f, project } = await projectFixture(); const d = f.service.recordDecision(project.id, { decision: { description: "Agent choice", madeBy: "agent" } }, recorder);
  await f.service.reviewDecision(project.id, d.ref, "okay", ""); const o = await f.overview(project.id), command = vi.fn();
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: () => o, command } }); slots.push(s);
  await s.findByText("You’re up to date."); expect(s.queryByRole("region", { name: "Agent decisions to check" })).toBeNull();
  fireEvent.click(s.getByRole("tab", { name: "Decisions" }));
  const button = s.getByRole("button", { name: "Accept all unchecked agent decisions" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); fireEvent.click(button); expect(command).not.toHaveBeenCalled(); expect(s.getByText("Agent choice")).toBeTruthy();
});
it("Okay updates durably without generic persistent save noise or a native notification", async () => {
  const { f, project } = await projectFixture(); const d = f.service.recordDecision(project.id, { decision: { description: "Agent choice", madeBy: "agent" } }, recorder);
  const o = await f.overview(project.id), command = vi.fn(input => f.harness.callRpc("command", input));
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: () => o, command } }); slots.push(s);
  fireEvent.click(await s.findByRole("button", { name: "Okay" })); await waitFor(() => expect(f.store.decisionItem(project.id, d.num)?.review).toBe("okay"));
  expect(s.queryByText(/review saved/)).toBeNull(); expect(s.queryByText(/^saved\.$/)).toBeNull(); expect(f.send).not.toHaveBeenCalled();
});
it("Inbox and Decisions share one bulk request, busy state and explicit failure without retry", async () => {
  const { f, project } = await projectFixture();
  f.service.recordDecision(project.id, { decision: { description: "Agent choice", madeBy: "agent" } }, recorder);
  const o = await f.overview(project.id);
  let reject!: (e: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  const command = vi.fn(() => pending);
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: () => o, command } }); slots.push(s);
  const inbox = await s.findByRole("region", { name: "Agent decisions to check" });
  expect(inbox.contains(s.getByRole("button", { name: "Accept all unchecked agent decisions" }))).toBe(true);
  fireEvent.click(s.getByRole("button", { name: "Accept all unchecked agent decisions" }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0]).toEqual([{ projectId: project.id, command: { action: "decision-accept-all" } }]);
  expect((s.getByRole("button", { name: "Accepting…" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(s.getByRole("tab", { name: "Decisions" }));
  const other = s.getByRole("button", { name: "Accepting…" }) as HTMLButtonElement;
  expect(other.disabled).toBe(true); fireEvent.click(other); expect(command).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error("Save refused")); });
  expect(s.getAllByRole("alert").some(el => el.textContent?.includes("Save refused"))).toBe(true);
  fireEvent.click(s.getByRole("tab", { name: /^Inbox/ }));
  expect(s.getAllByRole("alert").some(el => el.textContent?.includes("Save refused"))).toBe(true);
  expect((s.getByRole("button", { name: "Accept all unchecked agent decisions" }) as HTMLButtonElement).disabled).toBe(false);
  await beat(); expect(command).toHaveBeenCalledTimes(1);
});
it("both bulk locations disable immediately after the committed result while refresh is held", async () => {
  const { f, project } = await projectFixture();
  f.service.recordDecision(project.id, { decision: { description: "Agent choice", madeBy: "agent" } }, recorder);
  f.service.recordDecision(project.id, { decision: { description: "User choice", madeBy: "user" } }, recorder);
  const o = await f.overview(project.id), held = new Promise<never>(() => {});
  const overview = vi.fn().mockResolvedValueOnce(o).mockImplementation(() => held);
  const command = vi.fn(input => f.harness.callRpc("command", input));
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, command } }); slots.push(s);
  await s.findByRole("button", { name: "Accept all unchecked agent decisions" });
  if (process.env.INITIATIVE_UI_EVIDENCE) {
    const dir = process.env.INITIATIVE_UI_EVIDENCE; mkdirSync(dir, { recursive: true });
    const css = readFileSync("app.css", "utf8") + readFileSync("control-room.css", "utf8");
    const exportView = (tab: string) => writeFileSync(join(dir, `${tab}.html`), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0} ${css}</style>${s.container.innerHTML}`);
    exportView("inbox"); fireEvent.click(s.getByRole("tab", { name: "Decisions" })); exportView("decisions");
    fireEvent.click(s.getByRole("tab", { name: /^Inbox/ }));
  }
  fireEvent.click(s.getByRole("button", { name: "Accept all unchecked agent decisions" }));
  await s.findByText("1 agent decision accepted.");
  expect(s.queryByRole("region", { name: "Agent decisions to check" })).toBeNull();
  fireEvent.click(s.getByRole("tab", { name: "Decisions" }));
  expect((s.getByRole("button", { name: "Accept all unchecked agent decisions" }) as HTMLButtonElement).disabled).toBe(true);
  expect(s.getByText("User choice")).toBeTruthy(); expect(f.send).not.toHaveBeenCalled();
  expect(f.store.decisionItem(project.id, 1)).toMatchObject({ status: "active", review: "okay" });
  await beat(); expect(command).toHaveBeenCalledTimes(1);
});
