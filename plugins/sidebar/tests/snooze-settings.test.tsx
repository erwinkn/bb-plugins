// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  DEFAULT_SNOOZE_PRESETS,
  normalizePresets,
  type SnoozePresetsDoc,
} from "../lib/snooze-presets";

const app = await loadPluginApp(() => import("../app"));
const section = app.settingsSections.find((item) => item.id === "snooze")!;

function server(start: SnoozePresetsDoc = { revision: 0, presets: [...DEFAULT_SNOOZE_PRESETS] }) {
  let doc = start;
  const rpc = {
    getSnoozePresets: async () => doc,
    saveSnoozePresets: vi.fn(async (input: unknown) => {
      const { presets } = input as { presets: unknown };
      doc = { revision: doc.revision + 1, presets: normalizePresets(presets) };
      return doc;
    }),
  };
  return { rpc, doc: () => doc };
}
const mounted: ReturnType<typeof renderSlot>[] = [];
const mount = (fake = server()) => {
  const slot = renderSlot(section, {}, { rpc: fake.rpc });
  mounted.push(slot);
  return slot;
};
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("snooze presets settings", () => {
  it("is registered as a settings section and lists the defaults", async () => {
    expect(section.title).toBe("Snooze presets");
    const slot = mount();
    await tick();
    const form = slot.getByRole("form", { name: "Snooze presets" });
    const labels = within(form).getAllByLabelText(/^Preset \d+ label$/) as HTMLInputElement[];
    expect(labels.map((input) => input.value)).toEqual(["1 hour", "3 hours", "Tomorrow", "Next week"]);
    const names = within(form).getAllByLabelText(/^Preset \d+ name$/) as HTMLInputElement[];
    expect(names.map((input) => input.value)).toEqual(["1h", "3h", "tomorrow", "next-week"]);
    expect((within(form).getByLabelText("Preset 3 days ahead") as HTMLInputElement).value).toBe("1");
    expect((within(form).getByLabelText("Preset 3 time") as HTMLInputElement).value).toBe("09:00");
    expect((within(form).getByLabelText("Preset 4 days ahead") as HTMLInputElement).value).toBe("7");
    expect(within(form).getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("adds, edits, and saves a preset; the name follows the label until edited", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    const form = slot.getByRole("form", { name: "Snooze presets" });
    fireEvent.click(within(form).getByRole("button", { name: "Add preset" }));
    const label = within(form).getByLabelText("Preset 5 label");
    fireEvent.change(label, { target: { value: "Tonight" } });
    expect((within(form).getByLabelText("Preset 5 name") as HTMLInputElement).value).toBe("tonight");
    fireEvent.change(within(form).getByLabelText("Preset 5 kind"), { target: { value: "time" } });
    fireEvent.change(within(form).getByLabelText("Preset 5 days ahead"), { target: { value: "0" } });
    fireEvent.change(within(form).getByLabelText("Preset 5 time"), { target: { value: "18:30" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save presets" }));
    await waitFor(() => expect(fake.rpc.saveSnoozePresets).toHaveBeenCalledTimes(1));
    expect(fake.doc().presets.at(-1)).toEqual({
      id: "tonight",
      label: "Tonight",
      rule: { type: "time", days: 0, hour: 18, minute: 30 },
    });
    await waitFor(() => expect(within(form).getByRole("status").textContent).toBe("Saved."));
  });

  it("blocks saving while the list is invalid and shows why", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    const form = slot.getByRole("form", { name: "Snooze presets" });
    fireEvent.change(within(form).getByLabelText("Preset 2 name"), { target: { value: "1h" } });
    expect(within(form).getByRole("alert").textContent).toMatch(/"1h" is used twice/);
    expect(within(form).getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(form).getByLabelText("Preset 2 name"), { target: { value: "3h" } });
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("removes, reorders, and resets to the defaults", async () => {
    const fake = server({
      revision: 3,
      presets: [{ id: "later", label: "Later", rule: { type: "duration", minutes: 15 } }],
    });
    const slot = mount(fake);
    await tick();
    const form = slot.getByRole("form", { name: "Snooze presets" });
    expect(within(form).getAllByLabelText(/^Preset \d+ label$/)).toHaveLength(1);
    fireEvent.click(within(form).getByRole("button", { name: "Reset to defaults" }));
    expect(within(form).getAllByLabelText(/^Preset \d+ label$/)).toHaveLength(4);
    fireEvent.click(within(form).getByRole("button", { name: "Move preset 2 up" }));
    fireEvent.click(within(form).getByRole("button", { name: "Remove preset 4" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save presets" }));
    await waitFor(() => expect(fake.rpc.saveSnoozePresets).toHaveBeenCalledTimes(1));
    expect(fake.doc().presets.map((preset) => preset.id)).toEqual(["3h", "1h", "tomorrow"]);
  });
});
