// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { thread } from "./fixtures";

const prefetch = vi.hoisted(() => ({
  enabled: true,
  start: vi.fn(),
  cancels: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_useSidebarThreadActions: () => ({
      ...actual.experimental_useSidebarThreadActions(),
      ...(prefetch.enabled ? { experimental_prefetch: prefetch.start } : {}),
    }),
  };
});

const app = await loadPluginApp(() => import("../app"));
const threads = [
  thread({ id: "one", title: "First thread" }),
  thread({ id: "two", title: "Second thread" }),
];
const mounted: ReturnType<typeof renderSlot>[] = [];
const mount = () => {
  const slot = renderSlot(
    app.threadLists[0],
    {
      activeThreadId: "one",
      activeProjectId: "project-1",
      isCompactViewport: false,
      searchQuery: "",
      onNavigate: vi.fn(),
      Original: () => <p>BB fallback</p>,
    },
    {
      sidebarThreads: {
        threads,
        projects: [{ id: "project-1", name: "One", isPersonal: false }],
      },
      rpc: { listArchived: async () => [] },
    },
  );
  mounted.push(slot);
  return slot;
};
// A query settles over a few macrotasks: its retry, then the batched notify.
const tick = () =>
  act(async () => {
    for (let hop = 0; hop < 8; hop++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
const link = (slot: { container: HTMLElement }, id: string) =>
  slot.container.querySelector(`[data-sidebar-thread-id="${id}"]`) as HTMLElement;
const rowOf = (slot: { container: HTMLElement }, id: string) =>
  link(slot, id).closest("[data-thread-status]") as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  prefetch.enabled = true;
  prefetch.cancels = [];
  prefetch.start.mockReset();
  prefetch.start.mockImplementation(() => {
    const cancel = vi.fn();
    prefetch.cancels.push(cancel);
    return cancel;
  });
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("thread row prefetch", () => {
  it("prefetches on pointer enter and cancels on leave", async () => {
    const slot = mount();
    await tick();
    fireEvent.pointerEnter(rowOf(slot, "two"));
    expect(prefetch.start).toHaveBeenCalledExactlyOnceWith("two");
    expect(prefetch.cancels[0]).not.toHaveBeenCalled();
    fireEvent.pointerLeave(rowOf(slot, "two"));
    expect(prefetch.cancels[0]).toHaveBeenCalledOnce();
  });

  it("prefetches on focus and cancels on blur", async () => {
    const slot = mount();
    await tick();
    fireEvent.focus(link(slot, "two"));
    expect(prefetch.start).toHaveBeenCalledExactlyOnceWith("two");
    fireEvent.blur(link(slot, "two"));
    expect(prefetch.cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels a pending prefetch when the row unmounts", async () => {
    const slot = mount();
    await tick();
    fireEvent.pointerEnter(rowOf(slot, "one"));
    expect(prefetch.cancels).toHaveLength(1);
    slot.lifecycle.unmount();
    expect(prefetch.cancels[0]).toHaveBeenCalled();
  });

  it("does nothing on a host without experimental_prefetch", async () => {
    prefetch.enabled = false;
    const slot = mount();
    await tick();
    fireEvent.pointerEnter(rowOf(slot, "two"));
    fireEvent.focus(link(slot, "two"));
    fireEvent.blur(link(slot, "two"));
    fireEvent.pointerLeave(rowOf(slot, "two"));
    expect(prefetch.start).not.toHaveBeenCalled();
  });
});
