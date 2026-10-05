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
