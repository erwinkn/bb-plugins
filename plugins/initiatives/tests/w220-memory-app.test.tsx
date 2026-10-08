// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.unmount(); cleanup(); });

// W220 (D431): the Context tab's memory panel shows the mode, log, tree and cost, and switches modes.
it("shows the coordinator's memory and switches its mode", async () => {
  const { f, project } = await projectFixture();
  await f.perform(project.id, { action: "memory", mode: "optchat" }, "user", null);
  const o = await f.overview(project.id);
  o.memory = { ...o.memory!, log: { messages: 1370, bytes: 1_581_293, threads: 2 }, tree: { ...o.memory!.tree, nodes: 1200, total: 2734, state: "unavailable", detail: "403 advisor route for codex is off" }, cost: { calls: 900, tries: 1900, inputTokens: 20_000_000, cachedTokens: 17_000_000, outputTokens: 1_500_000, usd: 1.34, callSeconds: 9000 } };
  const setMemory = vi.fn(async () => ({}));
  const s = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => o, inventory: async () => [], setMemory } }); slots.push(s);
  fireEvent.click(await s.findByRole("tab", { name: "Context" }));
  const panel = within(await s.findByRole("region", { name: "Memory" }));
  expect(panel.getByRole("radio", { name: "OptChat" }).getAttribute("aria-checked")).toBe("true");
  panel.getByText(/A fresh session per message over the summary view/);
  panel.getByText(/1,370 messages · 1\.6MB · 2 coordinator threads/);
  panel.getByText(/1,200 of 2,734 lines \(43%\) · Summarizer unavailable: 403 advisor route for codex is off/);
  panel.getByText(/\$1\.34 at list price · 900 calls · 20\.0M in \(85% cached\)/);
  panel.getByText(/past 150k tokens · hybrid default/);
  fireEvent.click(panel.getByRole("radio", { name: "Hybrid" }));
  await waitFor(() => expect(setMemory).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" })));
  fireEvent.change(panel.getByRole("textbox", { name: /Compaction limit/ }), { target: { value: "120k" } });
  fireEvent.click(panel.getByRole("button", { name: "Save limit" }));
  await waitFor(() => expect(setMemory).toHaveBeenCalledWith(expect.objectContaining({ compactTokens: 120_000 })));
});
