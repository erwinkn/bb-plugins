// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as renderSdkSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState } from "../lib/client-state";
import type { SyncedPreferences } from "../lib/ui-preferences-schema";
import { thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSdkSlot>[] = [];
const props = {
  activeThreadId: null,
  activeProjectId: "project-1",
  isCompactViewport: false,
  searchQuery: "",
  onNavigate: vi.fn(),
  Original: () => <p>BB fallback</p>,
};
const projects = [
  { id: "project-1", name: "One", isPersonal: false },
  { id: "project-2", name: "Two", isPersonal: false },
];
const threads = [
  thread({ id: "a", title: "A", projectId: "project-1", updatedAt: 300 }),
  thread({ id: "b", title: "B", projectId: "project-2", updatedAt: 200 }),
  thread({ id: "pin", title: "Pinned", isPinned: true, updatedAt: 100 }),
];
const entry = <T,>(value: T, revision = 1) => ({ revision, value });
const hostDefaults = (): SyncedPreferences => ({
  "sidebar.organizationMode": entry("chronological"),
  "sidebar.chronologicalSort": entry("updated"),
  "sidebar.sortDirection": entry("default"),
  "sidebar.collapsedSections": entry([]),
  "sidebar.collapsedProjects": entry([]),
});
type Host = SyncedPreferences;

function mount(
  host: Host,
  options: { failWrites?: number; readError?: { current: Error | null } } = {},
) {
  let failures = options.failWrites ?? 0;
  const readError = options.readError ?? { current: null };
  const slot = renderSdkSlot(app.threadLists[0], props, {
    sidebarThreads: { threads, projects },
    rpc: {
      listArchived: async () => [],
      getLibrary: async () => ({ revision: 0, ids: [] }),
      "uiPreferences.read": async () => {
        if (readError.current) throw readError.current;
        return host;
      },
      "uiPreferences.write": async (raw: unknown) => {
        const input = raw as {
          key: keyof Host;
          value: unknown;
          expectedRevision: number;
        };
        if (failures > 0) {
          failures -= 1;
          throw new Error("Revision conflict");
        }
        if (input.expectedRevision !== host[input.key].revision)
          throw new Error("Revision conflict");
        const next = {
          revision: input.expectedRevision + 1,
          value: input.value,
        };
        host[input.key] = next as never;
        return { key: input.key, ...next };
      },
    },
  });
  mounted.push(slot);
  return slot;
}
const writes = (slot: ReturnType<typeof mount>) =>
  slot.inspection.rpcCalls
    .filter((call) => call.method === "uiPreferences.write")
    .map((call) => call.input);
const reads = (slot: ReturnType<typeof mount>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "uiPreferences.read")
    .length;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const chooseDisplayOption = async (
  slot: ReturnType<typeof mount>,
  name: string,
) => {
  fireEvent.keyDown(slot.getByRole("button", { name: "Threads display options" }), {
    key: "Enter",
  });
  await settle();
  fireEvent.click(slot.getByRole("menuitemradio", { name, hidden: true }));
  await settle();
};
const current = () =>
  parseState(window.localStorage.getItem("bb-plugin-sidebar:v1"));

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await settle();
});

describe("synced sidebar preferences", () => {
  it("adopts BB's grouping, sort, direction, and collapsed groups on mount", async () => {
    const host = hostDefaults();
    host["sidebar.organizationMode"] = entry("project");
    host["sidebar.chronologicalSort"] = entry("created");
    host["sidebar.sortDirection"] = entry("ascending");
    host["sidebar.collapsedSections"] = entry(["threads", "pinned"]);
    host["sidebar.collapsedProjects"] = entry(["project-2", "project-9"]);
    updateState((state) => ({ ...state, collapsed: ["status:done", "project:project-1"] }));
    const slot = mount(host);
    await waitFor(() => expect(current().groupBy).toBe("project"));
    expect(current()).toMatchObject({
      sortBy: "created",
      sortDirection: "ascending",
      collapsed: ["status:done", "pinned", "project:project-2", "project:project-9"],
    });
    expect(slot.getByRole("button", { name: "Pinned" }).getAttribute("aria-expanded")).toBe("false");
    // Adopting the host is not a change; nothing is written back.
    await settle();
    expect(writes(slot)).toEqual([]);
  });

  it("keeps the local date sort when BB uses an order the plugin does not offer", async () => {
    updateState((state) => ({ ...state, sortBy: "created" }));
    const host = hostDefaults();
    host["sidebar.chronologicalSort"] = entry("alpha");
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    await settle();
    expect(current().sortBy).toBe("created");
    expect(writes(slot)).toEqual([]);
  });

  it("writes each local change through with the key's revision", async () => {
    const host = hostDefaults();
    host["sidebar.collapsedProjects"] = entry(["project-9"], 4);
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    await chooseDisplayOption(slot, "Project");
    await chooseDisplayOption(slot, "Oldest first");
    await chooseDisplayOption(slot, "Date created");
    await waitFor(() => expect(writes(slot)).toHaveLength(3));
    expect(writes(slot)).toEqual([
      { key: "sidebar.organizationMode", value: "project", expectedRevision: 1 },
      { key: "sidebar.sortDirection", value: "ascending", expectedRevision: 1 },
      { key: "sidebar.chronologicalSort", value: "created", expectedRevision: 1 },
    ]);
    // Collapsing a project group adds it to BB's list without dropping the
    // projects this client does not show.
    fireEvent.click(slot.getByRole("button", { name: "Two" }));
    await waitFor(() => expect(writes(slot)).toHaveLength(4));
    expect(writes(slot)[3]).toEqual({
      key: "sidebar.collapsedProjects",
      value: ["project-9", "project-2"],
      expectedRevision: 4,
    });
    fireEvent.click(slot.getByRole("button", { name: "Pinned" }));
    await waitFor(() => expect(writes(slot)).toHaveLength(5));
    expect(writes(slot)[4]).toEqual({
      key: "sidebar.collapsedSections",
      value: ["pinned"],
      expectedRevision: 1,
    });
    // The second write of a key uses the revision the first one returned.
    fireEvent.click(slot.getByRole("button", { name: "Two" }));
    await waitFor(() => expect(writes(slot)).toHaveLength(6));
    expect(writes(slot)[5]).toEqual({
      key: "sidebar.collapsedProjects",
      value: ["project-9"],
      expectedRevision: 5,
    });
    // Status grouping maps to BB's chronological mode.
    await chooseDisplayOption(slot, "Status");
    await waitFor(() => expect(writes(slot)).toHaveLength(7));
    expect(writes(slot)[6]).toEqual({
      key: "sidebar.organizationMode",
      value: "chronological",
      expectedRevision: 2,
    });
  });

  it("retries a conflicting write once against the fresh revision", async () => {
    const host = hostDefaults();
    const slot = mount(host, { failWrites: 1 });
    await waitFor(() => expect(reads(slot)).toBe(1));
    await chooseDisplayOption(slot, "Oldest first");
    await waitFor(() => expect(writes(slot)).toHaveLength(2));
    expect(reads(slot)).toBe(2);
    expect(host["sidebar.sortDirection"]).toEqual(entry("ascending", 2));
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("reports a write that still fails after the retry", async () => {
    const host = hostDefaults();
    const slot = mount(host, { failWrites: 2 });
    await waitFor(() => expect(reads(slot)).toBe(1));
    await chooseDisplayOption(slot, "Oldest first");
    await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Revision conflict"));
    expect(writes(slot)).toHaveLength(2);
  });

  it("re-reads on focus and reconnect and follows plugin realtime entries", async () => {
    const host = hostDefaults();
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    host["sidebar.organizationMode"] = entry("project", 2);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(current().groupBy).toBe("project"));
    expect(reads(slot)).toBe(2);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(reads(slot)).toBeGreaterThanOrEqual(3));
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.sortDirection",
      revision: 3,
      value: "ascending",
    });
    await waitFor(() => expect(current().sortDirection).toBe("ascending"));
    // A stale entry never rolls the client back.
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.sortDirection",
      revision: 1,
      value: "descending",
    });
    await settle();
    expect(current().sortDirection).toBe("ascending");
    expect(writes(slot)).toEqual([]);
  });

  it("keeps local preferences when the preference RPC is unavailable", async () => {
    updateState((state) => ({ ...state, groupBy: "project" }));
    const slot = renderSdkSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc: {
        listArchived: async () => [],
        getLibrary: async () => ({ revision: 0, ids: [] }),
        "uiPreferences.read": async () => {
          throw new Error("Not available");
        },
      },
    });
    mounted.push(slot);
    await settle();
    expect(current().groupBy).toBe("project");
    expect(slot.getByRole("region", { name: "One" })).toBeTruthy();
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("ignores a read snapshot older than a revision it already applied", async () => {
    const host = hostDefaults();
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.sortDirection",
      revision: 3,
      value: "ascending",
    });
    await waitFor(() => expect(current().sortDirection).toBe("ascending"));
    // The next read still answers with the older snapshot; the newer
    // revision already applied must not be rolled back.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(reads(slot)).toBe(2));
    await settle();
    expect(current().sortDirection).toBe("ascending");
    expect(host["sidebar.sortDirection"]).toEqual(entry("default"));
    expect(writes(slot)).toEqual([]);
  });

  it("keeps an unacknowledged change pending and retries it on the next read", async () => {
    const host = hostDefaults();
    const readError = { current: null as Error | null };
    const slot = mount(host, { failWrites: 1, readError });
    await waitFor(() => expect(reads(slot)).toBe(1));
    readError.current = new Error("offline");
    await chooseDisplayOption(slot, "Oldest first");
    // The write and its recovery read both fail; the local change stays.
    await waitFor(() => expect(writes(slot)).toHaveLength(1));
    await settle();
    expect(current().sortDirection).toBe("ascending");
    // A later host snapshot must not drop the pending local value, and the
    // retry writes it against the fresh revision.
    readError.current = null;
    host["sidebar.sortDirection"] = entry("descending", 5);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(writes(slot)).toHaveLength(2));
    expect(writes(slot)[1]).toEqual({
      key: "sidebar.sortDirection",
      value: "ascending",
      expectedRevision: 5,
    });
    // Mount read, the failed recovery read, and the focus read.
    await waitFor(() => expect(reads(slot)).toBe(3));
    expect(host["sidebar.sortDirection"]).toEqual(entry("ascending", 6));
    expect(current().sortDirection).toBe("ascending");
  });
});
