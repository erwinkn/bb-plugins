// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as renderSdkSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { parseState, updateState, type ClientState } from "../lib/client-state";
import type {
  SyncedPreferenceEntry,
  SyncedPreferences,
} from "../lib/ui-preferences-schema";
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
// Rpc handlers the Initiatives section calls on every mount.
const initiativeRpc = {
  projectMode: async () => ({
    available: true,
    tree: [],
    order: null,
    orderError: null,
  }),
  initiativeThreads: async () => ({
    available: true,
    threadIds: [],
    status: "ready",
  }),
  branchPullRequestEligibility: async () => ({ eligible: {} }),
  listArchived: async () => [],
};
const entry = <T,>(value: T, revision = 1) => ({ revision, value });
const hostDefaults = (): SyncedPreferences => ({
  "sidebar.collapsedSections": entry([]),
  "sidebar.collapsedProjects": entry([]),
});
type Host = SyncedPreferences;

function mount(
  host: Host,
  options: {
    failWrites?: number;
    readError?: { current: Error | null };
    holdWrite?: {
      current:
        | ((entry: SyncedPreferenceEntry) => Promise<SyncedPreferenceEntry>)
        | null;
    };
  } = {},
) {
  let failures = options.failWrites ?? 0;
  const readError = options.readError ?? { current: null };
  const slot = renderSdkSlot(app.threadLists[0], props, {
    sidebarThreads: { threads, projects },
    rpc: {
      ...initiativeRpc,
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
        const entry = { key: input.key, ...next } as SyncedPreferenceEntry;
        return options.holdWrite?.current
          ? options.holdWrite.current(entry)
          : entry;
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
  slot.inspection.rpcCalls.filter(
    (call) => call.method === "uiPreferences.read",
  ).length;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const toggleGroup = async (slot: ReturnType<typeof mount>, name: string) => {
  fireEvent.click(await slot.findByRole("button", { name }));
  await settle();
};
const setListing = (patch: Partial<ClientState["listing"]>) =>
  updateState((state) => ({
    ...state,
    listing: { ...state.listing, ...patch },
  }));
const current = () =>
  parseState(window.localStorage.getItem("bb-plugin-sidebar:v1"));

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  // Project groups are the collapsible entries the host mirrors.
  setListing({ groupBy: "project" });
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await settle();
});

describe("synced sidebar preferences", () => {
  it("adopts BB's collapsed groups on mount", async () => {
    const host = hostDefaults();
    host["sidebar.collapsedSections"] = entry(["threads", "pinned"]);
    host["sidebar.collapsedProjects"] = entry(["project-2", "project-9"]);
    updateState((state) => ({
      ...state,
      collapsed: ["status:done", "project:project-1"],
    }));
    const slot = mount(host);
    await waitFor(() =>
      expect(current().collapsed).toEqual([
        "status:done",
        "pinned",
        "project:project-2",
        "project:project-9",
      ]),
    );
    expect(
      slot
        .getByRole("button", { name: "Pinned" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    // Adopting the host is not a change; nothing is written back.
    await settle();
    expect(writes(slot)).toEqual([]);
  });

  it("leaves this client's grouping and order alone", async () => {
    setListing({
      groupBy: "project",
      sortBy: "created",
      sortDirection: "ascending",
    });
    const host = hostDefaults();
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    await settle();
    expect(current().listing).toEqual({
      groupBy: "project",
      sortBy: "created",
      sortDirection: "ascending",
    });
    // Changing them is local too: nothing reaches BB.
    act(() => setListing({ groupBy: "status", sortDirection: "descending" }));
    await settle();
    expect(writes(slot)).toEqual([]);
  });

  it("writes each collapse through with the key's revision", async () => {
    const host = hostDefaults();
    host["sidebar.collapsedProjects"] = entry(["project-9"], 4);
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    // Collapsing a project group adds it to BB's list without dropping the
    // projects this client does not show.
    await toggleGroup(slot, "Two");
    await waitFor(() => expect(writes(slot)).toHaveLength(1));
    expect(writes(slot)[0]).toEqual({
      key: "sidebar.collapsedProjects",
      value: ["project-9", "project-2"],
      expectedRevision: 4,
    });
    await toggleGroup(slot, "Pinned");
    await waitFor(() => expect(writes(slot)).toHaveLength(2));
    expect(writes(slot)[1]).toEqual({
      key: "sidebar.collapsedSections",
      value: ["pinned"],
      expectedRevision: 1,
    });
    // The second write of a key uses the revision the first one returned.
    await toggleGroup(slot, "Two");
    await waitFor(() => expect(writes(slot)).toHaveLength(3));
    expect(writes(slot)[2]).toEqual({
      key: "sidebar.collapsedProjects",
      value: ["project-9"],
      expectedRevision: 5,
    });
    expect(host["sidebar.collapsedSections"]).toEqual(entry(["pinned"], 2));
  });

  it("retries a conflicting write once against the fresh revision", async () => {
    const host = hostDefaults();
    const slot = mount(host, { failWrites: 1 });
    await waitFor(() => expect(reads(slot)).toBe(1));
    await toggleGroup(slot, "Two");
    await waitFor(() => expect(writes(slot)).toHaveLength(2));
    expect(reads(slot)).toBe(2);
    expect(host["sidebar.collapsedProjects"]).toEqual(entry(["project-2"], 2));
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("reports a write that still fails after the retry", async () => {
    const host = hostDefaults();
    const slot = mount(host, { failWrites: 2 });
    await waitFor(() => expect(reads(slot)).toBe(1));
    await toggleGroup(slot, "Two");
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain(
        "Revision conflict",
      ),
    );
    expect(writes(slot)).toHaveLength(2);
  });

  it("re-reads on focus and reconnect and follows plugin realtime entries", async () => {
    const host = hostDefaults();
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    host["sidebar.collapsedProjects"] = entry(["project-2"], 2);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(current().collapsed).toContain("project:project-2"),
    );
    expect(reads(slot)).toBe(2);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(reads(slot)).toBeGreaterThanOrEqual(3));
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.collapsedSections",
      revision: 3,
      value: ["pinned"],
    });
    await waitFor(() => expect(current().collapsed).toContain("pinned"));
    // A stale entry never rolls the client back.
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.collapsedSections",
      revision: 1,
      value: [],
    });
    await settle();
    expect(current().collapsed).toContain("pinned");
    expect(writes(slot)).toEqual([]);
  });

  it("keeps local preferences when the preference RPC is unavailable", async () => {
    setListing({ groupBy: "project" });
    const slot = renderSdkSlot(app.threadLists[0], props, {
      sidebarThreads: { threads, projects },
      rpc: {
        ...initiativeRpc,
        "uiPreferences.read": async () => {
          throw new Error("Not available");
        },
      },
    });
    mounted.push(slot);
    await settle();
    expect(current().listing.groupBy).toBe("project");
    expect(slot.getByRole("region", { name: "One" })).toBeTruthy();
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("ignores a read snapshot older than a revision it already applied", async () => {
    const host = hostDefaults();
    const slot = mount(host);
    await waitFor(() => expect(reads(slot)).toBe(1));
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.collapsedSections",
      revision: 3,
      value: ["pinned"],
    });
    await waitFor(() => expect(current().collapsed).toContain("pinned"));
    // The next read still answers with the older snapshot; the newer
    // revision already applied must not be rolled back.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(reads(slot)).toBe(2));
    await settle();
    expect(current().collapsed).toContain("pinned");
    expect(host["sidebar.collapsedSections"]).toEqual(entry([]));
    expect(writes(slot)).toEqual([]);
  });

  it("keeps an unacknowledged change pending and retries it on the next read", async () => {
    const host = hostDefaults();
    const readError = { current: null as Error | null };
    const slot = mount(host, { failWrites: 1, readError });
    await waitFor(() => expect(reads(slot)).toBe(1));
    readError.current = new Error("offline");
    await toggleGroup(slot, "Two");
    // The write and its recovery read both fail; the local change stays.
    await waitFor(() => expect(writes(slot)).toHaveLength(1));
    await settle();
    expect(current().collapsed).toContain("project:project-2");
    // A later host snapshot must not drop the pending local value, and the
    // retry writes it against the fresh revision.
    readError.current = null;
    host["sidebar.collapsedProjects"] = entry([], 5);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(writes(slot)).toHaveLength(2));
    expect(writes(slot)[1]).toEqual({
      key: "sidebar.collapsedProjects",
      value: ["project-2"],
      expectedRevision: 5,
    });
    // Mount read, the failed recovery read, and the focus read.
    await waitFor(() => expect(reads(slot)).toBe(3));
    expect(host["sidebar.collapsedProjects"]).toEqual(entry(["project-2"], 6));
    expect(current().collapsed).toContain("project:project-2");
  });

  it("keeps the newer host revision when a stale write acknowledgement lands", async () => {
    const host = hostDefaults();
    let release!: () => void;
    const holdWrite: {
      current:
        | ((entry: SyncedPreferenceEntry) => Promise<SyncedPreferenceEntry>)
        | null;
    } = {
      current: (entry: SyncedPreferenceEntry) =>
        new Promise<SyncedPreferenceEntry>((resolve) => {
          holdWrite.current = null;
          release = () => resolve(entry);
        }),
    };
    const slot = mount(host, { holdWrite });
    await waitFor(() => expect(reads(slot)).toBe(1));
    await toggleGroup(slot, "Two");
    await waitFor(() => expect(writes(slot)).toHaveLength(1));
    // Another client's revision lands before our write's response; the
    // unacknowledged local value stays on screen until the write settles.
    await slot.behavior.emitRealtime("ui-preferences-changed", {
      key: "sidebar.collapsedProjects",
      revision: 3,
      value: [],
    });
    await settle();
    expect(current().collapsed).toContain("project:project-2");
    // The stale acknowledgement clears the pending value but must not roll
    // host or UI back over the newer revision.
    await act(async () => release());
    await settle();
    expect(current().collapsed).not.toContain("project:project-2");
    expect(writes(slot)).toHaveLength(1);
  });

  it("writes a newer value queued behind a held request for the same key", async () => {
    const host = hostDefaults();
    let release!: () => void;
    const holdWrite: {
      current:
        | ((entry: SyncedPreferenceEntry) => Promise<SyncedPreferenceEntry>)
        | null;
    } = {
      current: (entry: SyncedPreferenceEntry) =>
        new Promise<SyncedPreferenceEntry>((resolve) => {
          holdWrite.current = null;
          release = () => resolve(entry);
        }),
    };
    const slot = mount(host, { holdWrite });
    await waitFor(() => expect(reads(slot)).toBe(1));
    await toggleGroup(slot, "Two");
    await waitFor(() => expect(writes(slot)).toHaveLength(1));
    // The user changes the same key while the first write is in flight.
    await toggleGroup(slot, "Two");
    await act(async () => release());
    // The held ack must not delete the newer pending value: its queued
    // write still runs and chains on the acknowledged revision.
    await waitFor(() => expect(writes(slot)).toHaveLength(2));
    expect(writes(slot)[1]).toEqual({
      key: "sidebar.collapsedProjects",
      value: [],
      expectedRevision: 2,
    });
    expect(host["sidebar.collapsedProjects"]).toEqual(entry([], 3));
    expect(current().collapsed).not.toContain("project:project-2");
  });
});
