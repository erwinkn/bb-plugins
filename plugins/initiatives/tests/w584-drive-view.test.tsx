// @vitest-environment jsdom
// W584: the Context tab's Files section, read with TanStack Query and refreshed by the drive watcher.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DriveFile, DriveList } from "../lib/drive-types";
import { SIGNAL_DEBOUNCE_MS, adventuresQueryClient } from "../lib/query";
await loadPluginApp(() => import("../app"));
const { DriveFiles } = await import("../drive-view");

const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  adventuresQueryClient().clear();
});

const list: DriveList = {
  root: "/data/drives/eq",
  truncated: false,
  entries: [
    { path: "notes", kind: "dir", size: 0, mtimeMs: 1, title: null },
    { path: "notes/plan.md", kind: "file", size: 12, mtimeMs: 2, title: "Plan" },
  ],
};

function drive(initial: string) {
  const file = { text: initial, version: "v1" };
  const read = (): DriveFile => ({ path: "notes/plan.md", size: file.text.length, mtimeMs: 2, version: file.version, text: file.text });
  return {
    file,
    rpc: {
      driveList: async () => list,
      driveRead: async () => read(),
      driveSave: async (input: unknown) => {
        const { text, base } = input as { text: string; base: string | null };
        if (base !== file.version) return { conflict: read() };
        Object.assign(file, { text, version: `${file.version}+` });
        return { saved: read() };
      },
    },
  };
}

describe("W584 Files view", () => {
  it("reads the list once on open, once more for a burst of its drive's signals, and ignores other drives", async () => {
    const d = drive("# Plan\n");
    const slot = renderSlot({ component: DriveFiles }, { projectId: "eq" }, { rpc: d.rpc });
    slots.push(slot);
    await slot.findByText("plan.md");
    const reads = () => slot.rpcCalls.filter((c) => c.method === "driveList").length;
    expect(reads()).toBe(1);
    for (let i = 0; i < 20; i++) await slot.emitRealtime("drive-changed", { projectId: "eq" });
    for (let i = 0; i < 5; i++) await slot.emitRealtime("drive-changed", { projectId: "other" });
    await act(() => new Promise((resolve) => setTimeout(resolve, SIGNAL_DEBOUNCE_MS * 2)));
    await waitFor(() => expect(reads()).toBe(2));
    // Hovering a file prefetches it after a short dwell; a passing pointer reads nothing.
    const entry = slot.getByText("plan.md");
    fireEvent.mouseEnter(entry);
    fireEvent.mouseLeave(entry);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(slot.rpcCalls.filter((c) => c.method === "driveRead")).toHaveLength(0);
    fireEvent.mouseEnter(entry);
    await waitFor(() => expect(slot.rpcCalls.filter((c) => c.method === "driveRead")).toHaveLength(1));
    expect(reads()).toBe(2);
  });

  it("shows a conflict instead of overwriting a file an agent changed during the edit", async () => {
    const d = drive("# Plan\n");
    const slot = renderSlot({ component: DriveFiles }, { projectId: "eq" }, { rpc: d.rpc });
    slots.push(slot);
    fireEvent.click(await slot.findByText("plan.md"));
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Edit notes/plan.md"), { target: { value: "# Mine\n" } });
    Object.assign(d.file, { text: "# Agent's\n", version: "v2" });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText(/changed since you opened it/);
    expect(d.file.text).toBe("# Agent's\n");
    expect((slot.getByLabelText("Edit notes/plan.md") as HTMLTextAreaElement).value).toBe("# Mine\n");
    fireEvent.click(slot.getByRole("button", { name: /Load the latest/ }));
    expect((slot.getByLabelText("Edit notes/plan.md") as HTMLTextAreaElement).value).toBe("# Agent's\n");
    fireEvent.change(slot.getByLabelText("Edit notes/plan.md"), { target: { value: "# Agent's, then mine\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByRole("button", { name: "Edit" });
    expect(d.file.text).toBe("# Agent's, then mine\n");
  });

  it("keeps the editor and its draft when an agent deletes the file, and saving then overwrites nothing", async () => {
    const d = drive("# Plan\n");
    let gone = false;
    const rpc = {
      ...d.rpc,
      driveList: async () => (gone ? { ...list, entries: [] } : list),
      driveRead: async () => (gone ? Promise.reject(new Error("notes/plan.md is not in the drive.")) : d.rpc.driveRead()),
      driveSave: async () => ({ conflict: null }),
    };
    const slot = renderSlot({ component: DriveFiles }, { projectId: "eq" }, { rpc });
    slots.push(slot);
    fireEvent.click(await slot.findByText("plan.md"));
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Edit notes/plan.md"), { target: { value: "# Mine\n" } });
    gone = true;
    await slot.emitRealtime("drive-changed", { projectId: "eq" });
    await slot.findByText(/No files yet/);
    await slot.findByText(/Couldn't read it again: .*not in the drive/, {}, { timeout: 3000 });
    expect((slot.getByLabelText("Edit notes/plan.md") as HTMLTextAreaElement).value).toBe("# Mine\n");
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText(/deleted or moved since you opened it/);
    expect((slot.getByLabelText("Edit notes/plan.md") as HTMLTextAreaElement).value).toBe("# Mine\n");
  });

  it("holds the text still while a save is in flight, so no keystroke is lost", async () => {
    const d = drive("# Plan\n");
    let finish: () => void = () => {};
    const rpc = { ...d.rpc, driveSave: (input: unknown) => new Promise((resolve) => (finish = () => resolve(d.rpc.driveSave(input)))) };
    const slot = renderSlot({ component: DriveFiles }, { projectId: "eq" }, { rpc });
    slots.push(slot);
    fireEvent.click(await slot.findByText("plan.md"));
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    const editor = () => slot.getByLabelText("Edit notes/plan.md") as HTMLTextAreaElement;
    fireEvent.change(editor(), { target: { value: "# Mine\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editor().readOnly).toBe(true));
    finish();
    await slot.findByRole("button", { name: "Edit" });
    expect(d.file.text).toBe("# Mine\n");
  });

  it("asks before the user's own click drops an unsaved edit", async () => {
    const d = drive("# Plan\n");
    const slot = renderSlot({ component: DriveFiles }, { projectId: "eq" }, { rpc: d.rpc });
    slots.push(slot);
    fireEvent.click(await slot.findByText("plan.md"));
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Edit notes/plan.md"), { target: { value: "# Mine\n" } });
    const asked: string[] = [];
    window.confirm = (message) => (asked.push(String(message)), false);
    fireEvent.click(slot.getByTitle("Delete notes/plan.md"));
    expect(asked).toEqual(["Drop your unsaved edit of notes/plan.md?"]);
    expect(slot.rpcCalls.filter((c) => c.method === "driveChange")).toHaveLength(0);
    // So does New file, which would open the new file in its place.
    fireEvent.click(slot.getByRole("button", { name: "New file" }));
    fireEvent.click(slot.getByRole("button", { name: "Create" }));
    expect(asked).toHaveLength(2);
    expect(slot.rpcCalls.filter((c) => c.method === "driveSave")).toHaveLength(0);
    expect((slot.getByLabelText("Edit notes/plan.md") as HTMLTextAreaElement).value).toBe("# Mine\n");
  });
});
