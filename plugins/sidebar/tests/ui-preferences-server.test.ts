import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const entry = <T>(value: T, revision = 1) => ({ revision, value });
const hostPreferences = {
  "sidebar.organizationMode": entry("project"),
  "sidebar.chronologicalSort": entry("alpha"),
  "sidebar.sortDirection": entry("default"),
  "sidebar.sectionOrder": entry(["pinned", "projects", "threads"]),
  "sidebar.collapsedSections": entry(["threads"]),
  "sidebar.collapsedProjects": entry(["project-2"]),
  "sidebar.collapsedThreads": entry(["thread-9"]),
  "sidebar.threadListProvider": entry("sidebar/sidebar"),
};

function host(set = async (args: { key: string; value: unknown; expectedRevision: number }) => ({
  key: args.key,
  revision: args.expectedRevision + 1,
  value: args.value,
})) {
  return createFakePluginHost({
    sdk: {
      system: {
        uiPreferences: {
          list: async () => ({ preferences: hostPreferences }),
          set,
        },
      },
    },
  } as never);
}

describe("synced UI preferences API", () => {
  it("reads only the represented keys", async () => {
    const h = host();
    plugin(h.bb);
    try {
      await expect(
        h.harness.behavior.callRpc("uiPreferences.read", null),
      ).resolves.toEqual({
        "sidebar.organizationMode": entry("project"),
        "sidebar.chronologicalSort": entry("alpha"),
        "sidebar.sortDirection": entry("default"),
        "sidebar.collapsedSections": entry(["threads"]),
        "sidebar.collapsedProjects": entry(["project-2"]),
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("writes with the caller's revision and publishes the stored entry", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const written = await h.harness.behavior.callRpc("uiPreferences.write", {
        key: "sidebar.collapsedProjects",
        value: ["project-2", "project-1"],
        expectedRevision: 1,
      });
      expect(written).toEqual({
        key: "sidebar.collapsedProjects",
        revision: 2,
        value: ["project-2", "project-1"],
      });
      expect(
        h.harness.inspection.sdk.callsTo("system.uiPreferences.set"),
      ).toEqual([
        [
          {
            key: "sidebar.collapsedProjects",
            value: ["project-2", "project-1"],
            expectedRevision: 1,
          },
        ],
      ]);
      expect(h.harness.inspection.realtimeSignals).toEqual([
        { channel: "ui-preferences-changed", payload: written },
      ]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("rejects keys and values the plugin does not represent", async () => {
    const h = host();
    plugin(h.bb);
    try {
      await expect(
        h.harness.behavior.callRpc("uiPreferences.write", {
          key: "sidebar.collapsedThreads",
          value: [],
          expectedRevision: 1,
        }),
      ).rejects.toThrow();
      await expect(
        h.harness.behavior.callRpc("uiPreferences.write", {
          key: "sidebar.organizationMode",
          value: "status",
          expectedRevision: 1,
        }),
      ).rejects.toThrow();
      expect(
        h.harness.inspection.sdk.callsTo("system.uiPreferences.set"),
      ).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("surfaces a stale revision to the caller without publishing", async () => {
    const h = host(async () => {
      throw new Error("Revision conflict");
    });
    plugin(h.bb);
    try {
      await expect(
        h.harness.behavior.callRpc("uiPreferences.write", {
          key: "sidebar.sortDirection",
          value: "ascending",
          expectedRevision: 0,
        }),
      ).rejects.toThrow("Revision conflict");
      expect(h.harness.inspection.realtimeSignals).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
