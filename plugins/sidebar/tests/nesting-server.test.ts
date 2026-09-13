import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

describe("setParent API", () => {
  it("reparents a non-pinned thread with a single update", async () => {
    const updates: unknown[] = [];
    const host = createFakePluginHost({
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ id: "child" }),
          update: async (args) => {
            updates.push(args);
            return { ok: true };
          },
        },
      },
    });
    plugin(host.bb);
    try {
      await expect(
        host.harness.behavior.callRpc("setParent", {
          threadId: "child",
          parentThreadId: "parent",
        }),
      ).resolves.toEqual({ ok: true });
      expect(updates).toEqual([
        { threadId: "child", parentThreadId: "parent" },
      ]);
      expect(
        host.harness.inspection.sdk.callsTo("threads.unpin"),
      ).toEqual([]);
      expect(
        host.harness.inspection.sdk.callsTo("threads.get"),
      ).toEqual([[{ threadId: "child" }]]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("unpins a pinned source before reparenting it", async () => {
    const order: string[] = [];
    const host = createFakePluginHost({
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({ id: "child", pinnedAt: 123 }),
          unpin: async () => {
            order.push("unpin");
            return { ok: true };
          },
          update: async () => {
            order.push("update");
            return { ok: true };
          },
        },
      },
    });
    plugin(host.bb);
    try {
      await host.harness.behavior.callRpc("setParent", {
        threadId: "child",
        parentThreadId: "parent",
      });
      expect(order).toEqual(["unpin", "update"]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("detaches to the top level without a pin check", async () => {
    const host = createFakePluginHost({
      sdk: {
        threads: {
          update: async () => ({ ok: true }),
        },
      },
    });
    plugin(host.bb);
    try {
      await host.harness.behavior.callRpc("setParent", {
        threadId: "child",
        parentThreadId: null,
      });
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toEqual([]);
      expect(
        host.harness.inspection.sdk.callsTo("threads.update"),
      ).toEqual([[{ threadId: "child", parentThreadId: null }]]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("rejects empty ids and propagates update failures", async () => {
    const host = createFakePluginHost({
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ id: "child" }),
          update: async () => {
            throw new Error("thread would exceed nesting depth");
          },
        },
      },
    });
    plugin(host.bb);
    try {
      await expect(
        host.harness.behavior.callRpc("setParent", {
          threadId: "",
          parentThreadId: null,
        }),
      ).rejects.toThrow();
      await expect(
        host.harness.behavior.callRpc("setParent", {
          threadId: "child",
          parentThreadId: "parent",
        }),
      ).rejects.toThrow("nesting depth");
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
