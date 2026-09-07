import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { CoordinatorConfig } from "./coordinator/manager.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, within, waitFor } = await import("@testing-library/react");
installTestPluginRuntime();
const { CoordinatorSettings } = await import("./coordinator-panel.tsx");
after(() => dom.window.close());

test("mandatory coordinator settings save only supported execution options and keep failed edits out of the UI", async () => {
  let coordinator: CoordinatorConfig = { providerId: "codex", model: null, reasoningLevel: null, serviceTier: "default" };
  let failSave = false;
  const patches: unknown[] = [];
  const slot = renderSlot({ component: CoordinatorSettings }, {}, { rpc: {
    getConfig: () => ({ coordinator }),
    listCoordinatorProviders: () => ({
      providers: [
        { id: "codex", displayName: "Codex", available: true, serviceTiers: [{ id: "default", label: "Standard" }, { id: "fast", label: "Fast" }] },
        { id: "other", displayName: "Other provider", available: true, serviceTiers: [] },
      ],
      models: [
        { providerId: "codex", id: "gpt", model: "gpt", displayName: "GPT", isDefault: true, reasoningLevels: [{ id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }], defaultReasoningLevel: "high" },
        { providerId: "other", id: "other", model: "other", displayName: "Other model", isDefault: true, reasoningLevels: [], defaultReasoningLevel: null },
      ],
    }),
    setConfig: (input: unknown) => {
      patches.push(input);
      if (failSave) throw new Error("Provider unavailable");
      coordinator = { ...coordinator, ...(input as { coordinator: Partial<CoordinatorConfig> }).coordinator };
      return { coordinator };
    },
  } });
  const ui = within(slot.container);
  try {
    await ui.findByRole("option", { name: "Codex" });
    assert.equal(ui.queryByRole("checkbox", { name: /enable/i }), null);
    assert.equal(ui.queryByRole("combobox", { name: /machine/i }), null);
    fireEvent.change(ui.getByRole("combobox", { name: "Coordinator reasoning effort" }), { target: { value: "xhigh" } });
    await waitFor(() => assert.equal(coordinator.reasoningLevel, "xhigh"));
    await waitFor(() => assert.equal(ui.getByRole("checkbox", { name: "Fast" }).hasAttribute("disabled"), false));
    fireEvent.click(ui.getByRole("checkbox", { name: "Fast" }));
    await waitFor(() => assert.equal(coordinator.serviceTier, "fast"));
    await waitFor(() => assert.equal(ui.getByRole("combobox", { name: "Coordinator provider" }).hasAttribute("disabled"), false));
    failSave = true;
    fireEvent.change(ui.getByRole("combobox", { name: "Coordinator provider" }), { target: { value: "other" } });
    await ui.findByRole("alert");
    assert.equal((ui.getByRole("combobox", { name: "Coordinator provider" }) as HTMLSelectElement).value, "codex");
    assert.equal(coordinator.serviceTier, "fast");
    failSave = false;
    fireEvent.change(ui.getByRole("combobox", { name: "Coordinator provider" }), { target: { value: "other" } });
    await waitFor(() => assert.equal(ui.queryByRole("checkbox", { name: "Fast" }) === null, true));
    assert.equal(ui.queryByRole("combobox", { name: "Coordinator reasoning effort" }), null);
    assert.deepEqual(coordinator, { providerId: "other", model: null, reasoningLevel: null, serviceTier: "default" });
    assert.deepEqual(patches.at(-1), { coordinator: { providerId: "other", model: null, reasoningLevel: null, serviceTier: "default" } });
  } finally { slot.lifecycle.unmount(); }
});
