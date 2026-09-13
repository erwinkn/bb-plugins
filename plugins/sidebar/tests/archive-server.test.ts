import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

describe("archive API", () => {
  it.each([
    { title: " Archived parent ", titleFallback: "Fallback", expected: "Archived parent" },
    { title: null, titleFallback: " Fallback ", expected: "Fallback" },
  ])("fetches only the requested parent title: $expected", async ({ title, titleFallback, expected }) => {
    const host = createFakePluginHost({ sdk: { threads: {
      get: async () => makeThreadResponse({ id: "parent", title, titleFallback, archivedAt: 123 }),
    } } });
    plugin(host.bb);
    try {
      await expect(host.harness.behavior.callRpc("parentTitle", { threadId: "parent" })).resolves.toBe(expected);
      expect(host.harness.inspection.sdk.callsTo("threads.get")).toEqual([[{ threadId: "parent" }]]);
      expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([]);
      await expect(host.harness.behavior.callRpc("parentTitle", { threadId: "" })).rejects.toThrow();
    } finally { await host.harness.lifecycle.dispose(); }
  });

  const child = (id: string) => ({
    ...makeThreadResponse({ id }),
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other" as const,
  });

  it("collects all pages, includes hidden children, and archives deepest first", async () => {
    const archived: string[] = [];
    const siblings = Array.from({ length: 200 }, (_, i) => child(`child-${i}`));
    const host = createFakePluginHost({ sdk: { threads: {
      list: async (args) => {
        expect(args).toMatchObject({ includeHidden: true, limit: 200 });
        expect(archived).toEqual([]);
        if (args?.archived) return [];
        if (args?.parentThreadId === "root") return args.offset === 0 ? siblings : [child("last")];
        if (args?.parentThreadId === "child-0") return [child("grandchild")];
        if (args?.parentThreadId === "grandchild") return [child("great-grandchild")];
        return [];
      },
      archive: async ({ threadId }) => { archived.push(threadId); return { ok: true }; },
    } } });
    plugin(host.bb);
    try {
      await host.harness.behavior.callRpc("archiveTree", { threadId: "root" });
      expect(archived).toEqual(["great-grandchild", "grandchild", "last", ...siblings.map(c => c.id).reverse(), "root"]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("finds active descendants below archived ancestors without archiving those ancestors again", async () => {
    const host = createFakePluginHost({ sdk: { threads: {
      list: async ({ parentThreadId, archived } = {}) =>
        parentThreadId === "root" && archived ? [child("archived-child")]
          : parentThreadId === "archived-child" && !archived ? [child("restored-grandchild")] : [],
      archive: async () => ({ ok: true }),
    } } });
    plugin(host.bb);
    try {
      await host.harness.behavior.callRpc("archiveTree", { threadId: "root" });
      expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
        [{ threadId: "restored-grandchild" }], [{ threadId: "root" }],
      ]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it.each(["cycle", "read failure"])("does not archive anything on discovery %s", async (failure) => {
    const host = createFakePluginHost({ sdk: { threads: {
      list: async ({ parentThreadId, archived } = {}) => {
        if (archived) return [];
        if (parentThreadId === "root") return [child("child")];
        if (failure === "cycle") return [child("root")];
        throw new Error("Read failed");
      },
    } } });
    plugin(host.bb);
    try {
      await expect(host.harness.behavior.callRpc("archiveTree", { threadId: "root" })).rejects.toThrow();
      expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("reports partial failure and leaves ancestors unarchived", async () => {
    const archived: string[] = [];
    const host = createFakePluginHost({ sdk: { threads: {
      list: async ({ parentThreadId, archived } = {}) => archived ? [] : parentThreadId === "root" ? [child("child")] : parentThreadId === "child" ? [child("grandchild")] : [],
      archive: async ({ threadId }) => {
        if (threadId === "child") throw new Error("Offline");
        archived.push(threadId);
        return { ok: true };
      },
    } } });
    plugin(host.bb);
    try {
      await expect(host.harness.behavior.callRpc("archiveTree", { threadId: "root" })).rejects.toThrow("Archive stopped after 1 of 3 threads");
      expect(archived).toEqual(["grandchild"]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("pages visible archives and restores through BB", async () => {
    const host = createFakePluginHost({
      sdk: {
        threads: {
          list: async () => [
            {
              ...makeThreadResponse({ id: "old", archivedAt: 123 }),
              environmentName: null,
              environmentBranchName: null,
              environmentProviderId: null,
              environmentWorkspaceDisplayKind: "other",
            },
          ],
          unarchive: async () => ({ ok: true }),
        },
      },
    });
    plugin(host.bb);
    try {
      const result = await host.harness.behavior.callRpc("listArchived", {
        offset: 200,
      });
      expect(result).toMatchObject([{ id: "old" }]);
      expect(host.harness.inspection.sdk.callsTo("threads.list")[0]).toEqual([
        { archived: true, includeHidden: false, limit: 200, offset: 200 },
      ]);
      await host.harness.behavior.callRpc("restoreThread", { threadId: "old" });
      expect(
        host.harness.inspection.sdk.callsTo("threads.unarchive")[0],
      ).toEqual([{ threadId: "old" }]);
      await expect(
        host.harness.behavior.callRpc("listArchived", { offset: -1 }),
      ).rejects.toThrow();
      await expect(
        host.harness.behavior.callRpc("restoreThread", { threadId: "" }),
      ).rejects.toThrow();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});

describe("archive change signals", () => {
  it.each(["thread.archived", "thread.unarchived", "thread.deleted"] as const)(
    "invalidates the archive list on %s",
    async (event) => {
      const host = createFakePluginHost({
        sdk: { threads: { updatePluginMetadata: async () => ({}) } },
      });
      plugin(host.bb);
      try {
        host.harness.inspection.realtimeSignals.length = 0;
        await host.harness.emitThreadEvent(event, {
          thread: makeThreadResponse({ id: "moved" }),
        });
        expect(
          host.harness.inspection.realtimeSignals.filter(
            (signal) => signal.channel === "archives-changed",
          ),
        ).toEqual([{ channel: "archives-changed", payload: {} }]);
      } finally {
        await host.harness.lifecycle.dispose();
      }
    },
  );

  it("does not put a restored thread back into the library", async () => {
    const host = createFakePluginHost({
      sdk: { threads: { updatePluginMetadata: async () => ({}) } },
    });
    plugin(host.bb);
    try {
      await host.harness.behavior.callRpc("save", { threadId: "kept" });
      await host.harness.emitThreadEvent("thread.archived", {
        thread: makeThreadResponse({ id: "kept" }),
      });
      await host.harness.emitThreadEvent("thread.unarchived", {
        thread: makeThreadResponse({ id: "kept" }),
      });
      await expect(
        host.harness.behavior.callRpc("getLibrary", null),
      ).resolves.toMatchObject({ ids: [] });
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
