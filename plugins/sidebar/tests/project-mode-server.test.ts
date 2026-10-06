import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerProjectMode } from "../lib/project-mode-server";
it("keeps the sidebar usable when Projects is missing or disabled", async () => {
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

it("republishes the Projects plugin's bump on its own realtime channel", async () => {
  const h = createFakePluginHost({
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  registerProjectMode(h.bb);
  try {
    expect(await h.harness.callRpc("projectsChanged", {})).toEqual({
      ok: true,
    });
    expect(h.harness.inspection.realtimeSignals).toEqual([
      { channel: "projects-changed", payload: {} },
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
        list: async () => ({ plugins: [{ id: "projects", enabled: true, status: "running" }] }),
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
