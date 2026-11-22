// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { answersLikeServer } from "./helpers";

// The real picker calls onChange on its own when its catalog replaces a stale model.
vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  experimental_ProviderModelPicker: ({ value, onChange }: { value: Record<string, unknown>; onChange(v: unknown): void }) => {
    useEffect(() => { onChange({ ...value, model: "normalized-by-catalog" }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="auto-picker">{String(value.model)}</div>;
  },
}));

installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

describe("W632 automatic picker normalization", () => {
  it("is not sent while the picker is closed", async () => {
    const command = vi.fn().mockResolvedValue({ project: { id: "created" }, note: null });
    const slot = renderSlot(app.threadPanelActions[0], { threadId: "loose", params: {} }, { rpc: {
      panel: () => ({ membership: null, summary: null, tabs: null }),
      inventory: () => [{ id: "repo", name: "Repository", environments: [] }],
      coordinatorDefault: () => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }),
      command: answersLikeServer(command),
    } });
    await waitFor(() => expect(slot.getByRole("checkbox", { name: "Repository" })).toBeTruthy());
    fireEvent.change(slot.getByLabelText("Initiative name"), { target: { value: "Search" } });
    fireEvent.change(slot.getByLabelText("What should this initiative achieve?"), { target: { value: "Find" } });
    fireEvent.click(slot.getByRole("checkbox", { name: "Repository" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    // Closed picker: nothing mounted, so nothing can be sent behind the user's back.
    expect(slot.queryByTestId("auto-picker")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Create initiative" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command.coordinator).not.toHaveProperty("profile");
    slot.unmount();
  });

  it("opting back out drops whatever the picker had set", async () => {
    const command = vi.fn().mockResolvedValue({ project: { id: "created" }, note: null });
    const slot = renderSlot(app.threadPanelActions[0], { threadId: "loose", params: {} }, { rpc: {
      panel: () => ({ membership: null, summary: null, tabs: null }),
      inventory: () => [{ id: "repo", name: "Repository", environments: [] }],
      coordinatorDefault: () => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }),
      command: answersLikeServer(command),
    } });
    await waitFor(() => expect(slot.getByRole("checkbox", { name: "Repository" })).toBeTruthy());
    fireEvent.change(slot.getByLabelText("Initiative name"), { target: { value: "Search" } });
    fireEvent.change(slot.getByLabelText("What should this initiative achieve?"), { target: { value: "Find" } });
    fireEvent.click(slot.getByRole("checkbox", { name: "Repository" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Use this thread as the coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    expect(slot.getByTestId("auto-picker")).toBeTruthy();
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different coordinator model" }));
    fireEvent.click(slot.getByRole("button", { name: "Create initiative" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command.coordinator).not.toHaveProperty("profile");
    slot.unmount();
  });
});
