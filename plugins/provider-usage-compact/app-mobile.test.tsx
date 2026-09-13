// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("lets the compact machine drawer handle its backdrop before dismissing usage", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(max-width: 767px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
  }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    ok: true, result: { machines: [{ id: "host", displayName: "Test machine", status: "connected", machineProvider: null, providers: [], error: null }] },
  }))));
  const app = await loadPluginApp(() => import("./app"));
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const dismiss = vi.fn();
  const slot = renderSlot(item, { dismiss });
  const trigger = await slot.findByRole("button", { name: "Usage machine: Test machine" });
  fireEvent.click(trigger);
  const drawer = await slot.findByRole("dialog", { name: "Usage machine" });
  const handle = drawer.querySelector("[data-persistent-drawer-handle]");
  if (!handle) throw new Error("missing drawer handle");
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0 });
  expect(dismiss).not.toHaveBeenCalled();
  const backdrop = document.querySelector("[data-persistent-drawer-backdrop]");
  if (!backdrop) throw new Error("missing drawer backdrop");
  fireEvent.pointerDown(backdrop);
  fireEvent.click(backdrop);
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Usage machine" })).toBeNull());
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(dismiss).toHaveBeenCalledOnce();
});
