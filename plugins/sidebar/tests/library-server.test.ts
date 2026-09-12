import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const child = (id: string) => makeThreadResponse({ id });

describe("library API", () => {
  it("starts empty, saves one id per call, and publishes the document", async () => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      const { behavior, inspection } = host.harness;
      await expect(behavior.callRpc("getLibrary", null)).resolves.toEqual({
        revision: 0,
        ids: [],
      });
      const saved = await behavior.callRpc("save", { threadId: "root" });
      expect(saved).toEqual({ revision: 1, ids: ["root"] });
      expect(inspection.realtimeSignals).toEqual([
        { channel: "library-changed", payload: saved },
      ]);
      // Saving the same thread again changes nothing and stays silent.
      const again = await behavior.callRpc("save", { threadId: "root" });
      expect(again).toEqual(saved);
      expect(inspection.realtimeSignals).toHaveLength(1);
      // The sidebar owns family display; the server stores no tree walk.
      expect(inspection.sdk.callsTo("threads.list")).toEqual([]);
      await expect(
        behavior.callRpc("save", { threadId: "" }),
      ).rejects.toThrow();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("removes only the requested id so independent saves survive", async () => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      const { behavior, inspection } = host.harness;
      await behavior.callRpc("save", { threadId: "root" });
      await behavior.callRpc("save", { threadId: "child" });
      const next = await behavior.callRpc("remove", { threadId: "root" });
      expect(next).toMatchObject({ ids: ["child"] });
      // Removing a non-member changes nothing and publishes nothing.
      inspection.realtimeSignals.length = 0;
      await behavior.callRpc("remove", { threadId: "root" });
      expect(inspection.realtimeSignals).toEqual([]);
      await expect(behavior.callRpc("getLibrary", null)).resolves.toMatchObject(
        { ids: ["child"] },
      );
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("drops archived and deleted threads without touching other members", async () => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      const { behavior, inspection } = host.harness;
      await behavior.callRpc("save", { threadId: "root" });
      await behavior.callRpc("save", { threadId: "child" });
      inspection.realtimeSignals.length = 0;
      await host.harness.emitThreadEvent("thread.archived", {
        thread: child("child"),
      });
      await host.harness.emitThreadEvent("thread.deleted", {
        thread: child("unrelated"),
      });
      await expect(behavior.callRpc("getLibrary", null)).resolves.toMatchObject(
        { ids: ["root"] },
      );
      // Only the real removal publishes; the unknown id stays silent.
      expect(
        inspection.realtimeSignals.filter(
          (signal) => signal.channel === "library-changed",
        ),
      ).toHaveLength(1);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
