// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { answersLikeServer } from "./helpers";

installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
});

const inventory = () => [
  { id: "repo", name: "Repository", environments: [{ id: "linux", path: "/code/repo", hostId: "Linux", isDefaultHome: true }] },
];
function open(rpc: Record<string, unknown> = {}) {
  const command = vi.fn().mockResolvedValue({ project: { id: "created" }, note: null });
  const slot = renderSlot(app.threadPanelActions[0], { threadId: "loose", params: {} }, { rpc: {
    panel: () => ({ membership: null, summary: null, tabs: null }),
    inventory,
    command: answersLikeServer(command),
    ...rpc,
  } });
  mounted.push(slot);
  return { slot, command };
}
async function fill(slot: ReturnType<typeof renderSlot>) {
  await waitFor(() => expect(slot.getByRole("checkbox", { name: "Repository" })).toBeTruthy());
  fireEvent.change(slot.getByLabelText("Initiative name"), { target: { value: "Search" } });
  fireEvent.change(slot.getByLabelText("What should this initiative achieve?"), { target: { value: "Find" } });
  fireEvent.click(slot.getByRole("checkbox", { name: "Repository" }));
}

describe("W632 Create initiative: coordinator model", () => {
  it("shows the picker only while a new coordinator is chosen, and the old hardcoded line is gone", async () => {
    const { slot } = open({ coordinatorDefault: () => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }) });
    await fill(slot);
    expect(slot.queryByText("The coordinator will use Opus 5.5 High.")).toBeNull();
    // The thread is adopted by default, which keeps its own model: no picker.
    expect(slot.queryByTestId("bb-provider-model-picker")).toBeNull();
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    // Even with a new coordinator the picker stays out of the way until the user opts in.
    expect(slot.queryByTestId("bb-provider-model-picker")).toBeNull();
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    const shown = slot.getByTestId("bb-provider-model-picker");
    expect((within(shown).getByLabelText("Model") as HTMLInputElement).value).toBe("claude-opus-5-5");
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    expect(slot.queryByTestId("bb-provider-model-picker")).toBeNull();
  });

  it("leaves the model out when untouched, even if the default never loaded", async () => {
    const { slot, command } = open({ coordinatorDefault: () => new Promise(() => {}) });
    await fill(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("button", { name: "Create initiative" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command.coordinator).toEqual({ kind: "new", bbProjectId: "repo", environment: { type: "project-default" } });
  });
});

describe("W632 Create initiative: picked model", () => {
  it("sends the chosen model on the new coordinator", async () => {
    const { slot, command } = open({ coordinatorDefault: () => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }) });
    await fill(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    const picker = slot.getByTestId("bb-provider-model-picker");
    fireEvent.change(within(picker).getByLabelText("Provider ID"), { target: { value: "acp-antigravity" } });
    fireEvent.change(within(picker).getByLabelText("Model"), { target: { value: "gemini-pro-orchestrator-neon" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(slot.getByRole("button", { name: "Create initiative" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command.coordinator).toEqual({
      kind: "new",
      bbProjectId: "repo",
      environment: { type: "project-default" },
      profile: { providerId: "acp-antigravity", model: "gemini-pro-orchestrator-neon", reasoningLevel: "high" },
    });
  });

  it("starts the picker on the configured default", async () => {
    const { slot } = open({ coordinatorDefault: () => ({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" }) });
    await fill(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    await waitFor(() => expect((within(slot.getByTestId("bb-provider-model-picker")).getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-6.1-sol"));
  });
});

describe("W632 Create initiative: picker routing and normalization", () => {
  it("routes the picker to the chosen checkout, else the first repository's default one", async () => {
    const { slot } = open({ coordinatorDefault: () => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }) });
    await fill(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    const picker = () => slot.getByTestId("bb-provider-model-picker");
    await waitFor(() => expect(picker().getAttribute("data-routing-kind")).toBe("environment"));
    expect(picker().getAttribute("data-routing-id")).toBe("linux");
  });

  it("falls back to the default source's host when no checkout of it is ready", async () => {
    const { slot } = open({
      inventory: () => [{ id: "repo", name: "Repository", defaultSourceHostId: "Remote", environments: [] }],
    });
    await fill(slot);
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    const picker = slot.getByTestId("bb-provider-model-picker");
    expect(picker.getAttribute("data-routing-kind")).toBe("host");
    expect(picker.getAttribute("data-routing-id")).toBe("Remote");
  });

  it("does not route before a repository is chosen", async () => {
    const { slot } = open();
    await waitFor(() => expect(slot.getByRole("checkbox", { name: "Repository" })).toBeTruthy());
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-routing-kind")).toBe("primary");
  });
});
