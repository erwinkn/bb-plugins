import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerProjectMode } from "../lib/project-mode-server";
// BB refuses an RPC to a plugin that is missing or not running.
const refused = async () => { throw new Error('unknown plugin "initiatives"'); };

it("keeps the sidebar usable when Initiatives is missing or disabled", async () => {
  const h = createFakePluginHost({
    sdk: { plugins: { list: async () => ({ plugins: [] }), callRpc: refused } },
  });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("projectMode", null)).toEqual({
      available: false,
      tree: null,
      order: null,
      orderError: null,
    });
  } finally {
    await h.harness.dispose();
  }
});

it("W196 reads the tree without listing every plugin, and lists them only when the read fails", async () => {
  let failing = false;
  const h = createFakePluginHost({
    sdk: {
      plugins: {
        list: async () => ({ plugins: [{ id: "initiatives", enabled: true, status: "running" }] }),
        callRpc: async () => {
          if (failing) throw new Error("tree exploded");
          return { version: 1, projects: [] };
        },
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("projectMode", null)).toMatchObject({ available: true });
    expect(h.harness.sdk.callsTo("plugins.list")).toEqual([]);
    // A running Initiatives that fails is an error, not "unavailable".
    failing = true;
    await expect(h.harness.callRpc("projectMode", null)).rejects.toThrow(/tree exploded/);
    expect(h.harness.sdk.callsTo("plugins.list")).toHaveLength(1);
  } finally {
    await h.harness.dispose();
  }
});

it("W196 logs one warn line per reported client timeout", async () => {
  const h = createFakePluginHost({ sdk: {} });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("reportReadTimeout", {
      elapsedMs: 41250, hidden: true, online: true, sinceVisibleMs: 38000, hiddenDuringRead: true,
    })).toEqual({ ok: true });
    expect(h.harness.inspection.logEntries).toEqual([{
      level: "warn",
      message: "An Initiatives tree read timed out in a client: elapsedMs=41250 hidden=true online=true sinceVisibleMs=38000 hiddenDuringRead=true",
    }]);
  } finally {
    await h.harness.dispose();
  }
});

it("republishes the Initiatives bump on its own realtime channel", async () => {
  const h = createFakePluginHost({
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("initiativesChanged", { projectId: "p1" })).toEqual({ ok: true });
    expect(h.harness.inspection.realtimeSignals).toEqual([
      { channel: "initiatives-changed", payload: { projectId: "p1" } },
    ]);
  } finally {
    await h.harness.dispose();
  }
});

it("T112 answers an unchanged tree with its revision instead of resending it", async () => {
  let names = ["One"];
  const h = createFakePluginHost({
    sdk: {
      plugins: {
        list: async () => ({ plugins: [{ id: "initiatives", enabled: true, status: "running" }] }),
        callRpc: async () => ({
          version: 1,
          projects: names.map((name, index) => ({
            id: `p${index}`, name, objective: "", paused: false, coordinatorThreadId: null,
            memberProjectIds: [], inFlight: 0, remaining: 0, opinions: 0, revisit: 0, retired: 0, nodes: [],
          })),
        }),
      },
    },
  });
  registerProjectMode(h.bb);
  type Mode = { tree: { projects: { name: string }[] } | null; revision?: string | null; unchanged?: boolean };
  const read = (known: string | null) => h.harness.callRpc("projectMode", { known }) as Promise<Mode>;
  try {
    const first = await read(null);
    expect(first.tree?.projects.map((p) => p.name)).toEqual(["One"]);
    expect(first.unchanged).toBe(false);
    const same = await read(first.revision!);
    expect(same).toMatchObject({ tree: null, unchanged: true, revision: first.revision });
    names = ["One", "Two"];
    const changed = await read(first.revision!);
    expect(changed.unchanged).toBe(false);
    expect(changed.tree?.projects.map((p) => p.name)).toEqual(["One", "Two"]);
    expect(changed.revision).not.toBe(first.revision);
    // The unconditional read keeps its original shape.
    expect(Object.keys(await h.harness.callRpc("projectMode", null) as object).sort()).toEqual(["available", "order", "orderError", "tree"]);
  } finally {
    await h.harness.dispose();
  }
});

it("T120 serves the tree from the initiatives plugin only, and is unavailable while it does not run", async () => {
  let plugins: { id: string; enabled: boolean; status: string }[] = [];
  const h = createFakePluginHost({
    sdk: {
      plugins: {
        list: async () => ({ plugins }),
        callRpc: async ({ pluginId }: { pluginId: string }) => {
          if (!plugins.some((p) => p.id === pluginId && p.status === "running")) return refused();
          return { version: 1, projects: [] };
        },
      },
    },
  });
  registerProjectMode(h.bb);
  const mode = () => h.harness.callRpc("projectMode", null) as Promise<{ available: boolean }>;
  const asked = () => h.harness.inspection.sdk.callsTo("plugins.callRpc").map((call) => (call as [{ pluginId: string }])[0].pluginId);
  try {
    // The former `projects` ID is never asked, even when something runs under it.
    plugins = [{ id: "projects", enabled: true, status: "running" }];
    expect(await mode()).toMatchObject({ available: false });
    plugins = [{ id: "initiatives", enabled: true, status: "running" }];
    expect(await mode()).toMatchObject({ available: true });
    expect(new Set(asked())).toEqual(new Set(["initiatives"]));
    plugins = [{ id: "initiatives", enabled: true, status: "starting" }];
    expect(await mode()).toMatchObject({ available: false });
    await expect(h.harness.callRpc("renameTreeProject", { projectId: "p1", name: "New" })).rejects.toThrow(/not running/);
  } finally {
    await h.harness.dispose();
  }
});

it("reads the saved listing, falling back to the legacy initiativesListing and ignoring removed keys", async () => {
  const { parseState } = await import("../lib/client-state");
  const listing = { groupBy: "project", sortBy: "created", sortDirection: "ascending" };
  expect(parseState(JSON.stringify({ listing })).listing).toEqual(listing);
  expect(parseState(JSON.stringify({ initiativesListing: listing })).listing).toEqual(listing);
  expect(parseState(JSON.stringify({ listing, initiativesListing: { groupBy: "status" } })).listing).toEqual(listing);
  const defaults = { groupBy: "none", sortBy: "updated", sortDirection: "descending" };
  expect(parseState(null).listing).toEqual(defaults);
  // Leftovers of the two-view layout do not leak in.
  const stale = parseState(
    JSON.stringify({ mode: "initiatives", groupBy: "project", sortBy: "created", sortDirection: "ascending", spaceId: "s" }),
  );
  expect(stale.listing).toEqual(defaults);
  expect(stale).not.toHaveProperty("mode");
  expect(stale).not.toHaveProperty("spaceId");
});

const running = async () => ({
  plugins: [{ id: "initiatives", enabled: true, status: "running" }],
});

it("creates an Initiative through the Initiatives command RPC, keyed, with a new coordinator on the first repository", async () => {
  const calls: { method: string; input: unknown }[] = [];
  const h = createFakePluginHost({
    sdk: {
      plugins: {
        list: running,
        callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
          calls.push({ method, input });
          if (method === "command")
            return {
              write: "done",
              answer: { project: { id: "p9", coordinatorThreadId: "c9", name: "x" }, note: null },
            };
          return { version: 1, projects: [] };
        },
      },
    },
  });
  registerProjectMode(h.bb);
  try {
    expect(
      await h.harness.callRpc("createInitiative", {
        name: "Faster builds",
        objective: "Halve CI time",
        memberProjectIds: ["repo-a", "repo-b"],
        key: "sidebar-create:abc:1",
      }),
    ).toEqual({ write: "done", projectId: "p9", coordinatorThreadId: "c9", note: null });
    expect(calls.find((call) => call.method === "command")?.input).toEqual({
      command: {
        action: "create",
        name: "Faster builds",
        objective: "Halve CI time",
        memberProjectIds: ["repo-a", "repo-b"],
        coordinator: {
          kind: "new",
          bbProjectId: "repo-a",
          environment: { type: "project-default" },
        },
      },
      key: "sidebar-create:abc:1",
    });
    expect(h.harness.inspection.realtimeSignals).toContainEqual({
      channel: "initiatives-changed",
      payload: {},
    });
  } finally {
    await h.harness.dispose();
  }
});

it("answers a settled refusal or unknown outcome with its message, and accepts an unwrapped answer", async () => {
  let reply: unknown = { write: "rejected", message: "BB project repo-a does not exist." };
  const h = createFakePluginHost({
    sdk: { plugins: { list: running, callRpc: async () => reply } },
  });
  registerProjectMode(h.bb);
  const input = { name: "N", objective: "O", memberProjectIds: ["repo-a"], key: "k" };
  try {
    // An answer, not an error: only a settled key is renewed by the client.
    expect(await h.harness.callRpc("createInitiative", input)).toEqual({
      write: "rejected",
      message: "BB project repo-a does not exist.",
    });
    reply = { write: "unknown", message: "It is unclear what this saved." };
    expect(await h.harness.callRpc("createInitiative", input)).toEqual({
      write: "unknown",
      message: "It is unclear what this saved.",
    });
    reply = { project: { id: "p1", coordinatorThreadId: null }, note: "Checkout pending." };
    expect(await h.harness.callRpc("createInitiative", input)).toEqual({
      write: "done",
      projectId: "p1",
      coordinatorThreadId: null,
      note: "Checkout pending.",
    });
  } finally {
    await h.harness.dispose();
  }
});

it("refuses to create while Initiatives is not running", async () => {
  const h = createFakePluginHost({
    sdk: { plugins: { list: async () => ({ plugins: [] }), callRpc: refused } },
  });
  registerProjectMode(h.bb);
  try {
    await expect(
      h.harness.callRpc("createInitiative", {
        name: "N",
        objective: "O",
        memberProjectIds: ["repo-a"],
        key: "k",
      }),
    ).rejects.toThrow(/not running/);
  } finally {
    await h.harness.dispose();
  }
});
