import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerProjectMode } from "../lib/project-mode-server";
it("keeps the sidebar usable when Initiatives is missing or disabled", async () => {
  const h = createFakePluginHost({
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("projectMode", null)).toEqual({
      available: false,
      tree: null,
      order: null,
      orderError: null,
    });
    expect(h.harness.sdk.callsTo("plugins.callRpc")).toEqual([]);
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
        callRpc: async () => ({ version: 1, projects: [] }),
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
    expect(asked()).toEqual(["initiatives"]);
    plugins = [{ id: "initiatives", enabled: true, status: "starting" }];
    expect(await mode()).toMatchObject({ available: false });
    await expect(h.harness.callRpc("renameTreeProject", { projectId: "p1", name: "New" })).rejects.toThrow(/not running/);
  } finally {
    await h.harness.dispose();
  }
});

it("reads the saved view mode", async () => {
  const { parseState } = await import("../lib/client-state");
  expect(parseState(JSON.stringify({ mode: "initiatives" })).mode).toBe("initiatives");
  expect(parseState(JSON.stringify({ mode: "other" })).mode).toBe("threads");
});
