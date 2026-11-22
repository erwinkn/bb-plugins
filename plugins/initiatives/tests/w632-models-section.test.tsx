// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { answersLikeServer } from "./helpers";
import { projectFixture } from "./fake-native";

installTestPluginRuntime();
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const sonnet = { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "low" } as const;
const sol = { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" } as const;

async function open(profiles: Record<string, unknown>, profileDefaults?: Record<string, unknown>, inventory: unknown[] = []) {
  const { f, project } = await projectFixture();
  f.service.editProject(project.id, { policy: { profiles } });
  const o = await f.overview(project.id);
  if (profileDefaults) o.project.profileDefaults = profileDefaults as never;
  const command = vi.fn().mockResolvedValue({});
  const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: () => o, inventory: () => inventory, command: answersLikeServer(command) } });
  mounted.push(slot);
  fireEvent.click(await slot.findByRole("tab", { name: "Context" }));
  return { slot, command };
}
const row = (slot: ReturnType<typeof renderSlot>, role: string) => slot.getByText(role, { selector: "strong" }).closest(".cr-repository") as HTMLElement;

describe("W632 Models section", () => {
  it("lists every role with its effective model, Default or Custom", async () => {
    const { slot } = await open({ implementation: sonnet }, { reviewer: sol });
    for (const role of ["Coordinator", "Worker", "Fast worker", "Very fast worker", "Reviewer", "Fallback reviewer"])
      expect(row(slot, role)).toBeTruthy();
    expect(Array.from(slot.getByRole("region", { name: "Models" }).querySelectorAll(".cr-repository strong")).map((el) => el.textContent)).toEqual(["Coordinator", "Worker", "Fast worker", "Very fast worker", "Reviewer", "Fallback reviewer"]);
    expect(slot.queryByText("Reviewer (of Claude work)")).toBeNull();
    expect(slot.queryByText("Reviewer (of GPT work)")).toBeNull();
    // An override of this Initiative.
    expect(within(row(slot, "Worker")).getByText("Custom")).toBeTruthy();
    expect(within(row(slot, "Worker")).getByText("Sonnet 5.5 · low")).toBeTruthy();
    // A global default from Settings, then the built-in one.
    expect(within(row(slot, "Reviewer")).getByText("Default")).toBeTruthy();
    expect(within(row(slot, "Reviewer")).getByText("Sol 6.1 · xhigh")).toBeTruthy();
    expect(within(row(slot, "Coordinator")).getByText("Default")).toBeTruthy();
    expect(within(row(slot, "Coordinator")).getByText("Opus 5.5 · high")).toBeTruthy();
    expect(slot.getByText(/running threads keep their model/)).toBeTruthy();
  });

  it("saves a role override through the edit command, keeping the others", async () => {
    const { slot, command } = await open({ implementation: sonnet });
    fireEvent.click(slot.getByRole("button", { name: "Customize Reviewer" }));
    const picker = slot.getByTestId("bb-provider-model-picker");
    fireEvent.change(within(picker).getByLabelText("Provider ID"), { target: { value: "codex" } });
    fireEvent.change(within(picker).getByLabelText("Model"), { target: { value: "gpt-6.1-sol" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(slot.getByRole("button", { name: "Save Reviewer" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command).toEqual({
      action: "edit",
      profiles: { reviewer: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" } },
    });
  });

  it("clears one override, or all, back to the default by leaving the key out", async () => {
    const { slot, command } = await open({ implementation: sonnet, reviewer: sol });
    expect(slot.queryByRole("button", { name: "Use the default for Coordinator" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Use the default for Worker" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command).toEqual({ action: "edit", profiles: { implementation: null } });
    fireEvent.click(slot.getByRole("button", { name: "Reset all to defaults" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][0].command).toEqual({ action: "edit", profiles: { reviewer: null } });
  });

  it("a second save before the refresh names only its own role and keeps the first one cleared", async () => {
    const { slot, command } = await open({ implementation: sonnet, reviewer: sol });
    fireEvent.click(slot.getByRole("button", { name: "Use the default for Worker" }));
    await waitFor(() => expect(within(row(slot, "Worker")).getByText("Default")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Use the default for Reviewer" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][0].command).toEqual({ action: "edit", profiles: { reviewer: null } });
    await waitFor(() => expect(within(row(slot, "Reviewer")).getByText("Default")).toBeTruthy());
    expect(within(row(slot, "Worker")).getByText("Default")).toBeTruthy();
  });

  it("offers no reset when nothing is overridden", async () => {
    const { slot } = await open({});
    expect(slot.queryByRole("button", { name: "Reset all to defaults" })).toBeNull();
  });

  it("lists models where the coordinator runs: its checkout, else its host, else the primary machine", async () => {
    const customize = (slot: ReturnType<typeof renderSlot>) => {
      fireEvent.click(slot.getByRole("button", { name: "Customize Worker" }));
      return slot.getByTestId("bb-provider-model-picker");
    };
    const withHome = await open({}, undefined, [{ id: "proj_a", name: "Repository", defaultSourceHostId: "Remote", environments: [{ id: "linux", hostId: "Remote", isDefaultHome: true, path: "/r" }] }]);
    const home = customize(withHome.slot);
    await waitFor(() => expect(home.getAttribute("data-routing-kind")).toBe("environment"));
    expect(home.getAttribute("data-routing-id")).toBe("linux");
    withHome.slot.unmount();
    const hostOnly = await open({}, undefined, [{ id: "proj_a", name: "Repository", defaultSourceHostId: "Remote", environments: [] }]);
    const host = customize(hostOnly.slot);
    await waitFor(() => expect(host.getAttribute("data-routing-kind")).toBe("host"));
    expect(host.getAttribute("data-routing-id")).toBe("Remote");
    hostOnly.slot.unmount();
    const none = await open({});
    expect(customize(none.slot).getAttribute("data-routing-kind")).toBe("primary");
  });
});
