import { describe, expect, it, vi } from "vitest";
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

describe("saved flag mirror", () => {
  type MetadataCall = {
    threadId: string;
    set?: Record<string, unknown>;
    remove?: string[];
  };
  const metadataCalls = (host: ReturnType<typeof createFakePluginHost>) =>
    host.harness.inspection.sdk
      .callsTo("threads.updatePluginMetadata")
      .map(([args]) => args as MetadataCall);
  const withMetadata = () =>
    createFakePluginHost({
      sdk: { threads: { updatePluginMetadata: async () => ({}) } },
    });

  it("writes the flag on save and removes it on unsave and archive, not delete", async () => {
    const host = withMetadata();
    plugin(host.bb);
    try {
      const { behavior } = host.harness;
      await behavior.callRpc("save", { threadId: "root" });
      expect(metadataCalls(host)).toEqual([
        expect.objectContaining({
          threadId: "root",
          set: { saved: true, savedAt: expect.any(Number) },
        }),
      ]);
      // Saving an existing member is a no-op for the index and the flag.
      await behavior.callRpc("save", { threadId: "root" });
      expect(metadataCalls(host)).toHaveLength(1);
      await behavior.callRpc("remove", { threadId: "root" });
      expect(metadataCalls(host)[1]).toEqual(
        expect.objectContaining({
          threadId: "root",
          remove: ["saved", "savedAt"],
        }),
      );
      await behavior.callRpc("save", { threadId: "archived-later" });
      await behavior.callRpc("save", { threadId: "deleted-later" });
      await host.harness.emitThreadEvent("thread.archived", {
        thread: child("archived-later"),
      });
      await host.harness.emitThreadEvent("thread.deleted", {
        thread: child("deleted-later"),
      });
      // The archive clears the flag; the deleted thread's metadata is gone
      // with the thread, so no call is made for it.
      expect(metadataCalls(host).slice(4)).toEqual([
        expect.objectContaining({
          threadId: "archived-later",
          remove: ["saved", "savedAt"],
        }),
      ]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("keeps the index authoritative when the metadata write fails", async () => {
    const host = createFakePluginHost({
      sdk: {
        threads: {
          updatePluginMetadata: async () => {
            throw new Error("Thread not found");
          },
        },
      },
    });
    plugin(host.bb);
    try {
      await expect(
        host.harness.behavior.callRpc("save", { threadId: "root" }),
      ).resolves.toMatchObject({ ids: ["root"] });
      expect(
        host.harness.logEntries.some(
          (entry) =>
            entry.level === "warn" && /Thread not found/.test(entry.message),
        ),
      ).toBe(true);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("backfills flags for existing entries once", async () => {
    const host = withMetadata();
    await host.bb.storage.kv.set("library", { revision: 3, ids: ["a", "b"] });
    plugin(host.bb);
    try {
      await vi.waitFor(() => expect(metadataCalls(host)).toHaveLength(2));
      expect(metadataCalls(host).map((args) => args.threadId)).toEqual([
        "a",
        "b",
      ]);
      await expect(
        host.bb.storage.kv.get("saved-flag-backfill"),
      ).resolves.toMatchObject({ count: 2 });
      // A reload keeps the KV marker, so the pass does not repeat.
      const reloaded = await host.harness.lifecycle.reload((bb) => plugin(bb));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(metadataCalls(reloaded)).toHaveLength(0);
      await reloaded.harness.lifecycle.dispose();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
