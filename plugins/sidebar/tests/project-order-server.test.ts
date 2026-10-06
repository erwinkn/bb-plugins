import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerProjectMode } from "../lib/project-mode-server";
import { PROJECT_ORDER_CHANNEL } from "../lib/project-order-schema";

const project = (id: string) => ({
  id,
  name: `Project ${id}`,
  objective: "",
  paused: false,
  coordinatorThreadId: null,
  memberProjectIds: [],
  inFlight: 0,
  remaining: 0,
  opinions: 0,
  revisit: 0,
  retired: 0,
  nodes: [],
});

const host = (projectIds: () => string[]) =>
  createFakePluginHost({
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [{ id: "initiatives", enabled: true, status: "running" }],
        }),
        callRpc: async () => ({
          version: 1,
          projects: projectIds().map(project),
        }),
      },
    },
  });

interface OrderResult {
  available: boolean;
  tree: unknown;
  order: { revision: number; order: string[] } | null;
  orderError: string | null;
}
const readMode = (h: ReturnType<typeof host>) =>
  h.harness.callRpc("projectMode", null) as Promise<OrderResult>;
const saveOrder = (
  h: ReturnType<typeof host>,
  expectedRevision: number,
  order: string[],
) =>
  h.harness.callRpc("saveProjectOrder", { expectedRevision, order }) as Promise<{
    revision: number;
    order: string[];
  }>;

describe("project order", () => {
  it("seeds the stored order from the tree and keeps it stable", async () => {
    let ids = ["a", "b"];
    const h = host(() => ids);
    registerProjectMode(h.bb);
    try {
      const first = await readMode(h);
      expect(first).toEqual({
        available: true,
        tree: expect.anything(),
        order: { revision: 1, order: ["a", "b"] },
        orderError: null,
      });
      expect(h.harness.inspection.realtimeSignals).toEqual([
        {
          channel: PROJECT_ORDER_CHANNEL,
          payload: { revision: 1, order: ["a", "b"] },
        },
      ]);
      // A reordered tree must not move already-known projects.
      ids = ["b", "a"];
      const next = await readMode(h);
      expect(next.order).toEqual(first.order);
      expect(h.harness.inspection.realtimeSignals).toHaveLength(1);
    } finally {
      await h.harness.dispose();
    }
  });

  it("appends new projects and keeps slots for missing ones", async () => {
    let ids = ["a", "b"];
    const h = host(() => ids);
    registerProjectMode(h.bb);
    try {
      await readMode(h);
      ids = ["c", "b"]; // a archived, c new
      const next = await readMode(h);
      expect(next.order).toEqual({ revision: 2, order: ["a", "b", "c"] });
    } finally {
      await h.harness.dispose();
    }
  });

  it("saves a reorder with a revision check and publishes the document", async () => {
    const h = host(() => ["a", "b", "c"]);
    registerProjectMode(h.bb);
    try {
      const { order: doc } = await readMode(h);
      const saved = await saveOrder(h, doc!.revision, ["c", "a", "b"]);
      expect(saved).toEqual({ revision: 2, order: ["c", "a", "b"] });
      expect(h.harness.inspection.realtimeSignals.at(-1)).toEqual({
        channel: PROJECT_ORDER_CHANNEL,
        payload: saved,
      });
      await expect(
        saveOrder(h, doc!.revision, ["b", "a", "c"]),
      ).rejects.toThrow(/changed on another client/);
    } finally {
      await h.harness.dispose();
    }
  });

  it("keeps stored ids absent from the submitted order in their slot", async () => {
    const h = host(() => ["a", "b", "c"]);
    registerProjectMode(h.bb);
    try {
      const { order: doc } = await readMode(h);
      const saved = await saveOrder(h, doc!.revision, ["c", "a"]);
      // b was missing from this client's tree; it holds its slot between
      // the moved a and c instead of losing its place or the reorder.
      expect(saved).toEqual({ revision: 2, order: ["c", "b", "a"] });
    } finally {
      await h.harness.dispose();
    }
  });

  it("serializes concurrent saves so only one wins per revision", async () => {
    const h = host(() => ["a", "b"]);
    registerProjectMode(h.bb);
    try {
      const { order: doc } = await readMode(h);
      const results = await Promise.allSettled([
        saveOrder(h, doc!.revision, ["b", "a"]),
        saveOrder(h, doc!.revision, ["a", "b"]),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    } finally {
      await h.harness.dispose();
    }
  });

  it("rejects malformed order input before touching the store", async () => {
    const h = host(() => ["a"]);
    registerProjectMode(h.bb);
    try {
      await readMode(h);
      await expect(
        h.harness.callRpc("saveProjectOrder", {
          expectedRevision: 1,
          order: ["a", ""],
        }),
      ).rejects.toThrow();
      // The rejection wrote nothing: the same base revision still wins.
      const saved = await saveOrder(h, 1, ["a"]);
      expect(saved).toEqual({ revision: 2, order: ["a"] });
    } finally {
      await h.harness.dispose();
    }
  });

  it("keeps new projects orderable when remembered ids fill the cap", async () => {
    // 256 remembered ids the tree no longer lists (archived or unreachable)
    // must not crowd a visible project out of the stored order.
    const archived = Array.from({ length: 256 }, (_, i) => `old-${i}`);
    let ids = ["new-a", "new-b"];
    const h = host(() => ids);
    registerProjectMode(h.bb);
    try {
      await h.bb.storage.kv.set("project-order", {
        revision: 4,
        order: archived,
      });
      const first = await readMode(h);
      expect(first.order).not.toBeNull();
      const synced = first.order!;
      expect(synced.revision).toBe(5);
      // Both new ids are stored; remembered placeholders yield from the tail.
      expect(synced.order).toContain("new-a");
      expect(synced.order).toContain("new-b");
      expect(synced.order).toHaveLength(256);
      // A follow-up read stays put — no rewrite churn.
      const again = await readMode(h);
      expect(again.order).toEqual(synced);
      // And a reorder of the new ids lands and persists.
      const saved = await saveOrder(h, synced.revision, ["new-b", "new-a"]);
      expect(saved.order.indexOf("new-b")).toBeLessThan(
        saved.order.indexOf("new-a"),
      );
      expect(saved.order).toHaveLength(256);
      // Newer archived ids lose to the visible pair in the merge.
      expect(saved.order.filter((id) => id.startsWith("new-"))).toEqual([
        "new-b",
        "new-a",
      ]);
    } finally {
      await h.harness.dispose();
    }
  });

  it("stays stable past the cap when a snapshot shuffles the same set", async () => {
    // With more visible projects than the 256-id bound, presence must be
    // computed over all of them — otherwise every reordered snapshot would
    // evict a different tail id and churn the revision.
    const ids = Array.from({ length: 257 }, (_, i) => `v${i}`);
    let current = ids;
    const h = host(() => current);
    registerProjectMode(h.bb);
    try {
      const first = await readMode(h);
      const seed = first.order!;
      expect(seed.order).toEqual(ids.slice(0, 256));
      // Re-reading the same set writes nothing.
      expect((await readMode(h)).order!.revision).toBe(seed.revision);
      // A same-set shuffle is not an eviction excuse.
      current = [ids[256], ...ids.slice(0, 256)];
      const shuffled = await readMode(h);
      expect(shuffled.order!.revision).toBe(seed.revision);
      expect(shuffled.order!.order).toEqual(seed.order);
      // Shuffling back is equally inert.
      current = ids;
      const restored = await readMode(h);
      expect(restored.order!.revision).toBe(seed.revision);
      expect(restored.order!.order).toEqual(seed.order);
      // And the overflow tail id is simply not persisted: an over-cap save
      // still fails at the RPC boundary instead of writing a mutant doc.
      await expect(saveOrder(h, seed.revision, ids)).rejects.toThrow();
    } finally {
      await h.harness.dispose();
    }
  });

  it("surfaces an unreadable stored order instead of overwriting it", async () => {
    const broken = { revision: "invalid", order: ["b", "a"] };
    const h = host(() => ["a", "b"]);
    registerProjectMode(h.bb);
    try {
      await h.bb.storage.kv.set("project-order", broken);
      const result = await readMode(h);
      // The tree still renders; only the persisted order reports a problem.
      expect(result.available).toBe(true);
      expect(result.order).toBeNull();
      expect(result.orderError).toContain("unreadable");
      expect(await h.bb.storage.kv.get("project-order")).toEqual(broken);
      await expect(saveOrder(h, 1, ["b", "a"])).rejects.toThrow(/unreadable/);
      // Still nothing has overwritten the stored bytes.
      expect(await h.bb.storage.kv.get("project-order")).toEqual(broken);
    } finally {
      await h.harness.dispose();
    }
  });

  it("forwards renames to the Initiatives plugin's command RPC", async () => {
    const calls: { pluginId?: string; method: string; input: unknown }[] = [];
    const h = createFakePluginHost({
      sdk: {
        plugins: {
          list: async () => ({
            plugins: [{ id: "initiatives", enabled: true, status: "running" }],
          }),
          callRpc: async (args: { pluginId: string; method: string; input?: unknown }) => {
            calls.push({ pluginId: args.pluginId, method: args.method, input: args.input });
            return args.method === "tree"
              ? { version: 1, projects: [project("p1")] }
              : { renamed: true };
          },
        },
      },
    });
    registerProjectMode(h.bb);
    try {
      const out = await h.harness.callRpc("renameTreeProject", {
        projectId: "p1",
        name: "Better search",
      });
      expect(out).toEqual({ renamed: true });
      expect(calls).toEqual([
        {
          pluginId: "initiatives",
          method: "command",
          input: {
            projectId: "p1",
            command: { action: "edit", name: "Better search" },
          },
        },
      ]);
    } finally {
      await h.harness.dispose();
    }
  });

  it("forwards icon and color to the Projects command RPC, and validates the palette first", async () => {
    const calls: { method: string; input: unknown }[] = [];
    const h = createFakePluginHost({
      sdk: {
        plugins: {
          list: async () => ({
            plugins: [{ id: "initiatives", enabled: true, status: "running" }],
          }),
          callRpc: async (args: { method: string; input?: unknown }) => {
            calls.push({ method: args.method, input: args.input });
            return { appearance: { icon: "Bug", color: null } };
          },
        },
      },
    });
    registerProjectMode(h.bb);
    try {
      await h.harness.callRpc("setTreeProjectAppearance", { projectId: "p1", icon: "Bug", color: null });
      await h.harness.callRpc("setTreeProjectAppearance", { projectId: "p1", color: "teal" });
      expect(calls).toEqual([
        { method: "command", input: { projectId: "p1", command: { action: "appearance", icon: "Bug", color: null } } },
        { method: "command", input: { projectId: "p1", command: { action: "appearance", color: "teal" } } },
      ]);
      await expect(h.harness.callRpc("setTreeProjectAppearance", { projectId: "p1", color: "#f00" })).rejects.toThrow();
      expect(calls).toHaveLength(2);
    } finally {
      await h.harness.dispose();
    }
  });

  it("rejects a rename when the Projects plugin is not running", async () => {
    const h = createFakePluginHost({
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    });
    registerProjectMode(h.bb);
    try {
      await expect(
        h.harness.callRpc("renameTreeProject", {
          projectId: "p1",
          name: "x",
        }),
      ).rejects.toThrow(/not running/);
    } finally {
      await h.harness.dispose();
    }
  });

  it("forwards thread creation to the Projects plugin's command RPC", async () => {
    const calls: { method: string; input: unknown }[] = [];
    const h = createFakePluginHost({
      sdk: {
        plugins: {
          list: async () => ({
            plugins: [{ id: "initiatives", enabled: true, status: "running" }],
          }),
          callRpc: async (args: { method: string; input?: unknown }) => {
            calls.push({ method: args.method, input: args.input });
            return { threadId: "t-1", state: "active", note: null };
          },
        },
      },
    });
    registerProjectMode(h.bb);
    try {
      const out = await h.harness.callRpc("createProjectThread", {
        projectId: "p1",
        bbProjectId: "repo-2",
        prompt: "Investigate the queue",
      });
      expect(out).toEqual({
        threadId: "t-1",
        state: "active",
        note: null,
      });
      expect(calls).toEqual([
        {
          method: "command",
          input: {
            projectId: "p1",
            command: {
              action: "thread-create",
              bbProjectId: "repo-2",
              prompt: "Investigate the queue",
            },
          },
        },
      ]);
      // A single-member caller may omit bbProjectId entirely.
      await h.harness.callRpc("createProjectThread", {
        projectId: "p1",
        prompt: "hi",
      });
      expect(calls[1]).toEqual({
        method: "command",
        input: {
          projectId: "p1",
          command: { action: "thread-create", prompt: "hi" },
        },
      });
      // An empty first message never reaches Projects.
      await expect(
        h.harness.callRpc("createProjectThread", {
          projectId: "p1",
          prompt: "  ",
        }),
      ).rejects.toThrow();
    } finally {
      await h.harness.dispose();
    }
  });

  it("rejects thread creation when the Projects plugin is not running", async () => {
    const h = createFakePluginHost({
      sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    });
    registerProjectMode(h.bb);
    try {
      await expect(
        h.harness.callRpc("createProjectThread", {
          projectId: "p1",
          prompt: "hi",
        }),
      ).rejects.toThrow(/not running/);
    } finally {
      await h.harness.dispose();
    }
  });
});
