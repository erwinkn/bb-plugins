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
import type { LibraryDoc } from "../lib/library-schema";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const localStorage = window.localStorage;
const projects = [
  { id: "project-1", name: "One", isPersonal: false },
  { id: "project-2", name: "Two", isPersonal: false },
];
const threads = [
  thread({ id: "keep", title: "Plain thread" }),
  thread({
    id: "saved",
    title: "Saved parent",
    projectId: "project-2",
  }),
  // One member saved on its own and one child that only rides along with
  // the family through the ancestor rule.
  thread({
    id: "saved-child",
    title: "Saved child",
    parentThreadId: "saved",
    projectId: "project-2",
  }),
  thread({
    id: "saved-new",
    title: "Reply saved with the family",
    parentThreadId: "saved",
    projectId: "project-2",
  }),
];
const initial: LibraryDoc = {
  revision: 1,
  entries: [
    { id: "saved", savedAt: 1 },
    { id: "saved-child", savedAt: 1 },
  ],
};
// A fake server: the mutations keep a document the test can broadcast as the
// realtime signal.
function server(start: LibraryDoc = initial) {
  let doc = start;
  const rpc = {
    getSpaces: async () => ({ revision: 0, spaces: [] }),
    listArchived: async () => [],
    getLibrary: async () => doc,
    save: vi.fn(async (input: unknown) => {
      const { threadId } = input as { threadId: string };
      if (doc.entries.some((entry) => entry.id === threadId)) return doc;
      doc = {
        revision: doc.revision + 1,
        entries: [...doc.entries, { id: threadId, savedAt: 1 }],
      };
      return doc;
    }),
    remove: vi.fn(async (input: unknown) => {
      const { threadId } = input as { threadId: string };
      doc = {
        revision: doc.revision + 1,
        entries: doc.entries.filter((entry) => entry.id !== threadId),
      };
      return doc;
    }),
  };
  return { rpc, doc: () => doc };
}
const props = {
  activeThreadId: "keep",
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
const scopeButton = (slot: ReturnType<typeof renderSlot>) =>
  slot.getByRole("button", { name: /^Threads: /, hidden: true });
async function openScope(slot: ReturnType<typeof renderSlot>) {
  fireEvent.keyDown(scopeButton(slot), { key: "Enter" });
  await tick();
}
const rows = (slot: ReturnType<typeof renderSlot>) =>
  Array.from(slot.container.querySelectorAll("[data-sidebar-thread-id]")).map(
    (node) => node.getAttribute("data-sidebar-thread-id"),
  );

beforeEach(() => {
  localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("library scope", () => {
  it("lists Library under the spaces and shows only saved families there", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    // Active view: the saved parent and both children stay hidden.
    expect(rows(slot)).toEqual(["keep"]);

    await openScope(slot);
    const entries = slot
      .getAllByRole("menuitemradio", { hidden: true })
      .map((node) => node.textContent?.replace("✓", ""));
    expect(entries).toEqual(["All projects", "Library"]);
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: /Library/, hidden: true }),
    );
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: Library",
    );
    // The whole family appears, including the child saved by inheritance.
    expect(rows(slot)).toEqual(["saved", "saved-child", "saved-new"]);
    expect(
      parseState(localStorage.getItem("bb-plugin-erwin-activity:v1")),
    ).toMatchObject({ spaceId: "library" });
  });

  it("saves a thread from a row action and hides it once the signal lands", async () => {
    const fake = server({ revision: 0, entries: [] });
    const slot = mount(fake);
    await tick();
    expect(rows(slot)).toHaveLength(4);

    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="keep"]')!,
    );
    fireEvent.click(
      within(await slot.findByRole("menu")).getByRole("menuitem", {
        name: "Save to Library",
      }),
    );
    await waitFor(() =>
      expect(fake.rpc.save).toHaveBeenCalledWith({ threadId: "keep" }),
    );
    // The row stays until the document arrives over realtime.
    expect(rows(slot)).toHaveLength(4);
    await slot.emitRealtime("library-changed", fake.doc());
    expect(rows(slot)).toEqual(["saved", "saved-child", "saved-new"]);
  });

  it("suppresses Remove on members under a saved ancestor and on inherited rows", async () => {
    const fake = server();
    const slot = mount(fake);
    await tick();
    updateState((state) => ({ ...state, spaceId: "library" }));
    await tick();
    expect(rows(slot)).toEqual(["saved", "saved-child", "saved-new"]);

    // The child that rides along is not a member; the member under a saved
    // ancestor keeps its entry but removing it would change nothing on screen.
    for (const id of ["saved-new", "saved-child"]) {
      fireEvent.contextMenu(
        slot.container.querySelector(`[data-sidebar-thread-id="${id}"]`)!,
      );
      within(await slot.findByRole("menu")).getByRole("menuitem", {
        name: "Archive",
      });
      expect(
        within(slot.getByRole("menu")).queryByRole("menuitem", {
          name: /Library/,
        }),
      ).toBeNull();
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await tick();
    }

    fireEvent.contextMenu(
      slot.container.querySelector('[data-sidebar-thread-id="saved"]')!,
    );
    fireEvent.click(
      within(await slot.findByRole("menu")).getByRole("menuitem", {
        name: "Remove from Library",
      }),
    );
    await waitFor(() =>
      expect(fake.rpc.remove).toHaveBeenCalledWith({ threadId: "saved" }),
    );
    await slot.emitRealtime("library-changed", fake.doc());
    // The independently saved child becomes a root; the sibling that only
    // rode along with the removed parent leaves the library with it.
    expect(rows(slot)).toEqual(["saved-child"]);
  });

  it("marks the scope entry and menu item when a saved thread needs a look", async () => {
    const fake = server();
    const slot = renderSlot(app.threadLists[0], props, {
      sidebarThreads: {
        threads: [
          ...threads,
          thread({
            id: "saved-question",
            title: "Saved question",
            parentThreadId: "saved",
            projectId: "project-2",
            hasPendingInteraction: true,
          }),
        ],
        projects,
      },
      rpc: fake.rpc,
    });
    mounted.push(slot);
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toContain(
      "a saved thread needs attention",
    );
    await openScope(slot);
    expect(
      slot.getByRole("img", {
        name: "Library: a saved thread needs attention",
        hidden: true,
      }),
    ).toBeTruthy();
  });

  it("shows the empty state and does not confuse Library with a missing space", async () => {
    const fake = server({ revision: 0, entries: [] });
    updateState((state) => ({ ...state, spaceId: "library" }));
    const slot = mount(fake, { activeThreadId: "" });
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: Library",
    );
    expect(slot.getByText(/No saved threads/)).toBeTruthy();
    expect(slot.queryByText(/no longer exists/)).toBeNull();
  });

  it("flags a viewed thread that is not in the library", async () => {
    const fake = server();
    updateState((state) => ({ ...state, spaceId: "library" }));
    const slot = mount(fake, { activeThreadId: "keep" });
    await tick();
    expect(slot.getByRole("status").textContent).toContain(
      "outside this scope",
    );
    fireEvent.click(slot.getByRole("button", { name: "Show all projects" }));
    await tick();
    expect(scopeButton(slot).getAttribute("aria-label")).toBe(
      "Threads: All projects",
    );
  });
});
