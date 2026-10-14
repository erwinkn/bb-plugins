// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); });
const recorder = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
const beat = () => act(async () => { await new Promise(r => setTimeout(r, 190)); });

it("Rules manual Refresh reloads loaded inventory without forcing detailed telemetry", async () => {
  const { f, project } = await projectFixture(); const o = await f.overview(project.id);
  const overview = vi.fn(async (_input: unknown) => o), inventory = vi.fn(async () => []);
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, inventory } }); slots.push(s);
  fireEvent.click(await s.findByRole("tab", { name: "Rules" }));
  await waitFor(() => expect(inventory).toHaveBeenCalledTimes(1)); expect(overview).toHaveBeenCalledTimes(1);
  fireEvent.click(s.getByRole("button", { name: /Initiative menu/ })); fireEvent.click(s.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(inventory).toHaveBeenCalledTimes(2)); expect(overview.mock.calls.every(c => (c[0] as { detail?: string }).detail === "summary")).toBe(true);
});
it("manual Refresh after Usage keeps global inventory lazy when it was never loaded", async () => {
  const { f, project } = await projectFixture(); const o = await f.overview(project.id);
  const overview = vi.fn(async (_input: unknown) => o), inventory = vi.fn(async () => []);
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, inventory } }); slots.push(s);
  fireEvent.click(await s.findByRole("button", { name: "More views" })); fireEvent.click(s.getByRole("button", { name: "Usage" }));
  await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  fireEvent.click(s.getByRole("button", { name: /Initiative menu/ })); fireEvent.click(s.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(overview).toHaveBeenCalledTimes(4)); expect(inventory).not.toHaveBeenCalled();
});
it("v9: an agent decision never reaches the Inbox, and the Archive shows it with no review controls", async () => {
  const { f, project } = await projectFixture();
  f.service.recordDecision(project.id, { decision: { description: "Agent choice", madeBy: "agent" } }, recorder);
  f.service.recordDecision(project.id, { decision: { description: "User choice", madeBy: "user" } }, recorder);
  const o = await f.overview(project.id), command = vi.fn();
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: () => o, command } }); slots.push(s);
  await s.findByText("You’re up to date.");
  fireEvent.click(s.getByRole("button", { name: "More views" })); fireEvent.click(s.getByRole("button", { name: "Archive" }));
  await s.findByText("Agent choice"); expect(s.getByText("User choice")).toBeTruthy();
  expect(s.queryByRole("button", { name: /^Okay$|^Not okay$|Accept all/ })).toBeNull();
  await beat(); expect(command).not.toHaveBeenCalled();
});
