// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState } from "../lib/client-state";
import { DEFAULT_SNOOZE_PRESETS } from "../lib/snooze-presets";
import type { SnoozeDoc, SnoozeEntry } from "../lib/snooze-schema";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const HOUR = 3_600_000;
const projects = [{ id: "project-1", name: "One", isPersonal: false }];
const threads = [
  thread({ id: "plain", title: "Plain thread", updatedAt: 500 }),
  thread({ id: "asleep", title: "Sleeping thread", updatedAt: 400 }),
  thread({
    id: "asleep-child",
    title: "Child of the sleeper",
    parentThreadId: "asleep",
    updatedAt: 300,
  }),
  thread({ id: "woke", title: "Woke thread", isUnread: true, updatedAt: 200 }),
  thread({ id: "pinned", title: "Pinned thread", isPinned: true, updatedAt: 100 }),
];
const now = Date.now();
const entry = (overrides: Partial<SnoozeEntry> & { threadId: string }): SnoozeEntry => ({
  until: now + HOUR,
  createdAt: now - HOUR,
  wokeAt: null,
  wasPinned: false,
  ...overrides,
});
const initial: SnoozeDoc = {
  revision: 1,
  entries: [
    entry({ threadId: "asleep", until: now + 2 * HOUR }),
    entry({ threadId: "woke", until: now - HOUR, wokeAt: now - 60_000 }),
  ],
};
// A fake server: mutations keep a document the test can broadcast.
function server(start: SnoozeDoc = initial) {
  let doc = start;
  const bump = (entries: SnoozeEntry[]) => (doc = { revision: doc.revision + 1, entries });
  const rpc = {
    getSpaces: async () => ({ revision: 0, spaces: [] }),
    listArchived: async () => [],
    getLibrary: async () => ({ revision: 0, ids: [] }),
    getSnoozes: async () => doc,
    getSnoozePresets: async () => ({ revision: 0, presets: DEFAULT_SNOOZE_PRESETS }),
    snooze: vi.fn(async (input: unknown) => {
      const { threadId, until } = input as { threadId: string; until: number };
      return bump([
        ...doc.entries.filter((item) => item.threadId !== threadId),
        entry({ threadId, until, createdAt: Date.now() }),
      ]);
    }),
    unsnooze: vi.fn(async (input: unknown) => {
      const { threadId } = input as { threadId: string };
      return bump(doc.entries.filter((item) => item.threadId !== threadId));
    }),
    acknowledge: vi.fn(async (input: unknown) => {
      const { threadId } = input as { threadId: string };
      return bump(
        doc.entries.filter((item) => !(item.threadId === threadId && item.wokeAt !== null)),
      );
    }),
  };
  return { rpc, doc: () => doc };
}
const props = {
  activeThreadId: "plain",
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
const mounted: ReturnType<typeof renderSlot>[] = [];
const mount = (
  fake: ReturnType<typeof server> = server(),
  overrides: Partial<typeof props> = {},
) => {
  const slot = renderSlot(
    app.threadLists[0],
    { ...props, ...overrides },
    { sidebarThreads: { threads, projects }, rpc: fake.rpc },
  );
  mounted.push(slot);
  return slot;
};
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const rowsIn = (element: HTMLElement) =>
  Array.from(element.querySelectorAll("[data-sidebar-thread-id]")).map((node) =>
    node.getAttribute("data-sidebar-thread-id"),
  );
const row = (slot: { container: HTMLElement }, id: string) =>
  slot.container.querySelector(`[data-sidebar-thread-id="${id}"]`) as HTMLElement;
const wrapper = (slot: { container: HTMLElement }, id: string) =>
  row(slot, id).closest("[data-thread-status]") as HTMLElement;
const section = (slot: ReturnType<typeof renderSlot>, name: string) =>
  slot.getByRole("region", { name });
// jsdom has no matchMedia; the sidebar treats that as a touch viewport.
let finePointer = false;
const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
  finePointer = false;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("pointer") && finePointer,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  window.matchMedia = originalMatchMedia;
  await tick();
});
async function openMenu(slot: ReturnType<typeof renderSlot>, id: string) {
  fireEvent.contextMenu(row(slot, id));
  await tick();
  return slot.getByRole("menu", { name: /^Actions for / });
}

describe("snoozed group", () => {
  it("moves sleeping families into a closed Snoozed group with the wake time, and woke threads into Needs Attention", async () => {
    const slot = mount();
    await tick();
    const snoozed = section(slot, "Snoozed");
    expect(within(snoozed).getByRole("button", { name: /Snoozed/ }).getAttribute("aria-expanded")).toBe("false");
    expect(rowsIn(snoozed)).toEqual([]);
    // Sleeping threads and their children stay out of the status groups.
    expect(rowsIn(section(slot, "Done"))).toEqual(["plain"]);
    expect(rowsIn(section(slot, "Needs Attention"))).toEqual(["woke"]);
    expect(slot.container.querySelector('[data-sidebar-thread-id="asleep-child"]')).toBeNull();
    fireEvent.click(within(snoozed).getByRole("button", { name: /Snoozed/ }));
    await tick();
    expect(rowsIn(snoozed)).toEqual(["asleep", "asleep-child"]);
    const stamp = within(wrapper(slot, "asleep")).getByText(/^\d{1,2}:\d{2}|Tomorrow|^[A-Z][a-z]{2} /);
    expect(stamp.closest("time")?.getAttribute("data-thread-wake")).toBe("");
    expect(wrapper(slot, "asleep").getAttribute("data-thread-snoozed")).toBe("");
    // The child keeps its age; only the snoozed thread shows a wake time.
    expect(wrapper(slot, "asleep-child").querySelector("[data-thread-wake]")).toBeNull();
  });

  it("orders snoozed roots by wake time and drops a thread from the group when the server wakes it", async () => {
    const fake = server({
      revision: 1,
      entries: [
        entry({ threadId: "plain", until: now + 3 * HOUR }),
        entry({ threadId: "asleep", until: now + HOUR }),
      ],
    });
    const slot = mount(fake, { activeThreadId: undefined });
    await tick();
    fireEvent.click(within(section(slot, "Snoozed")).getByRole("button", { name: /Snoozed/ }));
    await tick();
    expect(rowsIn(section(slot, "Snoozed"))).toEqual(["asleep", "asleep-child", "plain"]);
    await slot.behavior.emitRealtime("snoozes-changed", {
      revision: 2,
      entries: [
        entry({ threadId: "plain", until: now + 3 * HOUR }),
        entry({ threadId: "asleep", until: now - 1, wokeAt: now }),
      ],
    });
    expect(rowsIn(section(slot, "Snoozed"))).toEqual(["plain"]);
    // The woke thread returns with its family nested under it.
    expect(rowsIn(section(slot, "Needs Attention"))).toEqual(["asleep", "asleep-child"]);
  });

  it("acknowledges a woke thread once it is the active thread", async () => {
    const fake = server();
    mount(fake, { activeThreadId: "woke" });
    await tick();
    await waitFor(() => expect(fake.rpc.acknowledge).toHaveBeenCalledWith({ threadId: "woke" }));
    expect(fake.rpc.acknowledge).toHaveBeenCalledTimes(1);
  });
});

describe("row context menu", () => {
  it("offers the presets in a Snooze submenu and sends the resolved wake time", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    const menu = await openMenu(slot, "plain");
    const trigger = within(menu).getByRole("menuitem", { name: /^Snooze…/ });
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    await tick();
    const sub = slot.getByRole("menu", { name: "Snooze…" });
    const items = within(sub).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("data-snooze-preset"))).toEqual([
      "1h",
      "3h",
      "tomorrow",
      "next-week",
      "custom",
    ]);
    fireEvent.click(items[2]!);
    await tick();
    expect(fake.rpc.snooze).toHaveBeenCalledTimes(1);
    const { threadId, until } = fake.rpc.snooze.mock.calls[0]![0] as { threadId: string; until: number };
    expect(threadId).toBe("plain");
    expect(new Date(until).getHours()).toBe(9);
    expect(until).toBeGreaterThan(Date.now());
  });

  it("offers Unsnooze on a sleeping thread and no Snooze submenu", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    fireEvent.click(within(section(slot, "Snoozed")).getByRole("button", { name: /Snoozed/ }));
    await tick();
    const menu = await openMenu(slot, "asleep");
    expect(within(menu).queryByRole("menuitem", { name: /^Snooze…/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unsnooze" }));
    await tick();
    expect(fake.rpc.unsnooze).toHaveBeenCalledWith({ threadId: "asleep" });
  });

  it("opens the custom date picker from the submenu and submits a future time", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    const menu = await openMenu(slot, "plain");
    const trigger = within(menu).getByRole("menuitem", { name: /^Snooze…/ });
    fireEvent.pointerMove(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    await tick();
    fireEvent.click(slot.getByRole("menuitem", { name: /Custom date and time/ }));
    await tick();
    const dialog = slot.getByRole("dialog", { name: "Snooze Plain thread" });
    const input = within(dialog).getByLabelText("Wake time") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2000-01-01T09:00" } });
    fireEvent.submit(within(dialog).getByRole("form", { name: /date and time/ }));
    await tick();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/future/);
    expect(fake.rpc.snooze).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "2999-01-01T09:00" } });
    fireEvent.submit(within(dialog).getByRole("form", { name: /date and time/ }));
    await tick();
    expect(fake.rpc.snooze).toHaveBeenCalledWith({
      threadId: "plain",
      until: new Date(2999, 0, 1, 9, 0).getTime(),
    });
    expect(slot.queryByRole("dialog", { name: "Snooze Plain thread" })).toBeNull();
  });
});

describe("hover control", () => {
  it("shows a snooze control left of the archive control on a fine pointer only", async () => {
    finePointer = true;
    const fake = server();
    const slot = mount(fake);
    await tick();
    const plain = wrapper(slot, "plain");
    expect(within(plain).queryByRole("button", { name: "Snooze thread" })).toBeNull();
    fireEvent.pointerOver(plain);
    const snooze = within(plain).getByRole("button", { name: "Snooze thread" });
    const archive = within(plain).getByRole("button", { name: "Archive thread" });
    expect(snooze.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(snooze);
    await tick();
    const dialog = slot.getByRole("dialog", { name: "Snooze Plain thread" });
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("data-snooze-preset"))).toEqual([
      "1h",
      "3h",
      "tomorrow",
      "next-week",
      "custom",
    ]);
    // The row is still hovered-looking while the popover is open, even
    // after the pointer leaves for the popover.
    fireEvent.pointerOut(plain);
    expect(within(plain).getByRole("button", { name: "Snooze thread" })).toBeTruthy();
    fireEvent.click(buttons[0]!);
    await tick();
    expect(fake.rpc.snooze).toHaveBeenCalledTimes(1);
    const { until } = fake.rpc.snooze.mock.calls[0]![0] as { until: number };
    expect(until - Date.now()).toBeGreaterThan(HOUR - 5_000);
    expect(until - Date.now()).toBeLessThanOrEqual(HOUR);
    expect(slot.queryByRole("dialog", { name: "Snooze Plain thread" })).toBeNull();
    // A sleeping row's control unsnoozes directly.
    fireEvent.click(within(section(slot, "Snoozed")).getByRole("button", { name: /Snoozed/ }));
    await tick();
    const asleep = wrapper(slot, "asleep");
    fireEvent.pointerOver(asleep);
    fireEvent.click(within(asleep).getByRole("button", { name: "Unsnooze thread" }));
    await tick();
    expect(fake.rpc.unsnooze).toHaveBeenCalledWith({ threadId: "asleep" });
  });

  it("keeps the status marker and offers no hover control on a touch viewport", async () => {
    const slot = mount();
    await tick();
    const plain = wrapper(slot, "plain");
    fireEvent.pointerOver(plain);
    expect(within(plain).queryByRole("button", { name: "Snooze thread" })).toBeNull();
    expect(within(plain).queryByRole("button", { name: "Archive thread" })).toBeNull();
    // Long press (the touch path) still reaches the Snooze submenu.
    const menu = await openMenu(slot, "plain");
    expect(within(menu).getByRole("menuitem", { name: /^Snooze…/ })).toBeTruthy();
  });
});
