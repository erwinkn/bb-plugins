// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard, ProjectPanel } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });
const beat = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });

// W636: archiving from a thread's Initiative panel ends on an archived state: the menu closes,
// nothing reads the archived Initiative again, and no "Unknown Initiative" error shows.
describe("W636 archiving from the Initiative panel", () => {
  it("confirms, archives through the real service, and stays on the archived state", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const a = f.store.assignments(project.id)[0]!;
    f.store.updateAssignment(project.id, a.num, { state: "running" });
    const summary = await f.overview(project.id);
    const membership = () => {
      const p = f.store.project(project.id)!;
      return p.archivedAt === null ? { projectId: p.id, name: p.name, role: "coordinator" as const, former: false } : null;
    };
    const panel = vi.fn(async () => ({ membership: membership(), summary: membership() ? summary : null }));
    const overview = vi.fn(async () => {
      if (f.store.project(project.id)!.archivedAt !== null) throw new Error(`Unknown Initiative ${project.id}.`);
      return summary;
    });
    const command = vi.fn(async (input: unknown) => {
      expect((input as { command: { action: string } }).command.action).toBe("archive");
      return f.service.archiveProject(project.id);
    });
    const mergeQueue = vi.fn(async () => { throw new Error("gh unavailable"); });
    const slot = renderSlot({ component: ProjectPanel }, { threadId: "coordinator", params: { threadId: "coordinator" } }, { rpc: { panel, overview, command, mergeQueue, inventory: () => [] } });
    slots.push(slot);

    const menu = await slot.findByRole("button", { name: new RegExp(`${summary.project.name}: Initiative menu`) });
    fireEvent.click(menu);
    // The name's menu opens from its own left edge, inside a narrow panel.
    expect(slot.getByRole("group", { name: /Initiative menu/ }).className).toContain("cr-menu--start");
    fireEvent.click(slot.getByRole("button", { name: "Archive initiative" }));
    expect(slot.getByText(/Its running work is stopped first/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Confirm archive initiative" }));

    await waitFor(() => expect(slot.getByRole("status").textContent).toMatch(/is archived/));
    expect(command).toHaveBeenCalledTimes(1);
    expect(f.store.project(project.id)!.archivedAt).not.toBeNull();
    expect(f.store.assignment(project.id, a.num)!.state).toBe("cancelled");
    expect(slot.getByText(`Work ended: ${a.ref} stopped.`)).toBeTruthy();
    expect(slot.queryByRole("group", { name: /Initiative menu/ })).toBeNull();

    // The archive's change signal re-reads the panel, which no longer finds a membership.
    const overviewReads = overview.mock.calls.length;
    const queueReads = mergeQueue.mock.calls.length;
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await slot.behavior.emitRealtime("merge-queue-changed", {});
    await beat();
    await waitFor(() => expect(panel.mock.calls.length).toBeGreaterThan(1));
    await beat();
    expect(slot.getByRole("status").textContent).toMatch(/is archived/);
    expect(slot.queryByText(/Unknown Initiative/)).toBeNull();
    expect(slot.queryByRole("alert")).toBeNull();
    expect(overview.mock.calls.length).toBe(overviewReads);
    expect(mergeQueue.mock.calls.length).toBe(queueReads);
  });

  it("still shows an archive answered after the 30 s write deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { f, project } = await projectFixture();
      await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
      const a = f.store.assignments(project.id)[0]!;
      f.store.updateAssignment(project.id, a.num, { state: "running" });
      const summary = await f.overview(project.id);
      const membership = () => {
        const p = f.store.project(project.id)!;
        return p.archivedAt === null ? { projectId: p.id, name: p.name, role: "coordinator" as const, former: false } : null;
      };
      const panel = vi.fn(async () => ({ membership: membership(), summary: membership() ? summary : null }));
      const overview = vi.fn(async () => {
        if (f.store.project(project.id)!.archivedAt !== null) throw new Error(`Unknown Initiative ${project.id}.`);
        return summary;
      });
      // The archive is saved at once; its answer is held past the dashboard's write deadline.
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => { answer = resolve; });
      const command = vi.fn(async () => {
        const result = await f.service.archiveProject(project.id);
        await answered;
        return result;
      });
      const mergeQueue = vi.fn(async () => { throw new Error("gh unavailable"); });
      const slot = renderSlot({ component: ProjectPanel }, { threadId: "coordinator", params: { threadId: "coordinator" } }, { rpc: { panel, overview, command, mergeQueue, inventory: () => [] } });
      slots.push(slot);

      fireEvent.click(await slot.findByRole("button", { name: new RegExp(`${summary.project.name}: Initiative menu`) }));
      fireEvent.click(slot.getByRole("button", { name: "Archive initiative" }));
      fireEvent.click(slot.getByRole("button", { name: "Confirm archive initiative" }));
      await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
      // The write deadline passes; the archive's signal re-reads the panel, which loses its membership.
      await act(async () => { vi.advanceTimersByTime(30_000); });
      await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
      await beat();
      await waitFor(() => expect(slot.queryByRole("button", { name: /Initiative menu/ })).toBeNull());

      await act(async () => { answer(); await answered; });
      await waitFor(() => expect(slot.getByRole("status").textContent).toMatch(/is archived/));
      expect(slot.getByText(`Work ended: ${a.ref} stopped.`)).toBeTruthy();
      const settled = overview.mock.calls.length;
      await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
      await beat();
      expect(overview.mock.calls.length).toBe(settled);
      expect(slot.queryByText(/Unknown Initiative/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues no read once the archive answers, even one a signal queued while it saved", async () => {
    // The page dashboard reads its overview itself (the panel's is seeded by the panel read).
    const { f, project } = await projectFixture();
    const summary = await f.overview(project.id);
    const overview = vi.fn(async () => {
      if (f.store.project(project.id)!.archivedAt !== null) throw new Error(`Unknown Initiative ${project.id}.`);
      return summary;
    });
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const command = vi.fn(async () => { await answered; return f.service.archiveProject(project.id); });
    const mergeQueue = vi.fn(async () => { throw new Error("gh unavailable"); });
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview, command, mergeQueue, inventory: () => [] } });
    slots.push(slot);

    fireEvent.click(await slot.findByRole("button", { name: new RegExp(`${summary.project.name}: Initiative menu`) }));
    fireEvent.click(slot.getByRole("button", { name: "Archive initiative" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm archive initiative" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const reads = overview.mock.calls.length;
    // A signal during the save: its debounce ends while the save holds the read, which waits behind it.
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await beat();
    await act(async () => { answer(); await answered; });
    await waitFor(() => expect(slot.getByRole("status").textContent).toMatch(/is archived/));
    await beat();
    expect(overview.mock.calls.length).toBe(reads);
    expect(slot.queryByText(/Unknown Initiative/)).toBeNull();
  });
});
