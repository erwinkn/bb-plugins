import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const source = (id: string, path: string, isDefault = true) => ({
  id,
  projectId: "p1",
  type: "local_path" as const,
  hostId: "host-1",
  path,
  isDefault,
  createdAt: 0,
  updatedAt: 0,
});
const project = (
  id: string,
  name: string,
  kind: "standard" | "personal" = "standard",
  sources = [source(`src-${id}`, `/code/${name}`)],
) => ({
  id,
  name,
  kind,
  gitRemoteUrl: null,
  createdAt: 0,
  updatedAt: 0,
  sources,
});
const host = (id: string, name: string, status = "connected") => ({
  id,
  name,
  status,
});

function boot() {
  let list = [
    project("p1", "alpha"),
    project("p2", "beta"),
    project("personal", "Personal", "personal", []),
  ];
  const fake = createFakePluginHost({
    sdk: {
      projects: {
        list: async () => list,
        get: async ({ projectId }) => list.find((p) => p.id === projectId)!,
        create: async ({ name, source: src }) => {
          const created = project(`p${list.length + 1}`, name, "standard", [
            { ...source(`src-new`, src.path), hostId: src.hostId },
          ]);
          list = [...list, created];
          return created;
        },
        update: async ({ projectId, name }) => {
          list = list.map((p) =>
            p.id === projectId ? { ...p, name: name ?? p.name } : p,
          );
          return list.find((p) => p.id === projectId)!;
        },
        delete: async ({ projectId }) => {
          list = list.filter((p) => p.id !== projectId);
          return { ok: true as const };
        },
        reorder: async ({ projectId, previousProjectId }) => {
          const moving = list.find((p) => p.id === projectId)!;
          const rest = list.filter((p) => p.id !== projectId);
          const at = previousProjectId
            ? rest.findIndex((p) => p.id === previousProjectId) + 1
            : 0;
          list = [...rest.slice(0, at), moving, ...rest.slice(at)];
          return list;
        },
        sources: {
          update: async ({ projectId, sourceId, path }) => {
            list = list.map((p) =>
              p.id === projectId
                ? {
                    ...p,
                    sources: p.sources.map((s) =>
                      s.id === sourceId ? { ...s, path: path ?? s.path } : s,
                    ),
                  }
                : p,
            );
            return list.find((p) => p.id === projectId)!.sources[0];
          },
        },
      },
      hosts: {
        list: async () => [
          host("host-1", "MacBook"),
          host("host-2", "Server", "disconnected"),
        ],
        directory: async ({ path }) => ({
          directory: path ?? "/Users/me",
          parent: "/Users",
          entries: [
            { kind: "directory", name: "Code", path: "/Users/me/Code" },
            { kind: "file", name: ".zshrc", path: "/Users/me/.zshrc" },
          ],
        }),
        pickFolder: async () => ({ path: "/Users/me/picked" }),
      },
    },
  });
  plugin(fake.bb);
  return fake;
}

describe("projects API", () => {
  it("lists projects with their default folder and hosts", async () => {
    const fake = boot();
    try {
      const result = await fake.harness.behavior.callRpc("listProjects", null);
      expect(result).toEqual({
        projects: [
          {
            id: "p1",
            name: "alpha",
            isPersonal: false,
            source: { id: "src-p1", hostId: "host-1", path: "/code/alpha" },
          },
          {
            id: "p2",
            name: "beta",
            isPersonal: false,
            source: { id: "src-p2", hostId: "host-1", path: "/code/beta" },
          },
          { id: "personal", name: "Personal", isPersonal: true, source: null },
        ],
        hosts: [
          { id: "host-1", name: "MacBook", connected: true },
          { id: "host-2", name: "Server", connected: false },
        ],
      });
      expect(fake.harness.inspection.sdk.callsTo("projects.list")).toEqual([
        [{ includePersonal: true }],
      ]);
    } finally {
      await fake.harness.lifecycle.dispose();
    }
  });

  it("creates, renames, moves, re-folders, and deletes through BB's project API", async () => {
    const fake = boot();
    const { behavior, inspection } = fake.harness;
    try {
      const created = await behavior.callRpc("createProject", {
        name: "  gamma ",
        hostId: "host-1",
        path: "/code/gamma",
      });
      expect(created).toMatchObject({
        name: "gamma",
        source: { hostId: "host-1", path: "/code/gamma" },
      });
      expect(inspection.sdk.callsTo("projects.create")).toEqual([
        [
          {
            name: "gamma",
            source: {
              type: "local_path",
              hostId: "host-1",
              path: "/code/gamma",
            },
          },
        ],
      ]);

      await expect(
        behavior.callRpc("renameProject", { projectId: "p1", name: "Alpha!" }),
      ).resolves.toMatchObject({ name: "Alpha!" });
      await expect(
        behavior.callRpc("renameProject", { projectId: "p1", name: "   " }),
      ).rejects.toThrow();

      const reordered = await behavior.callRpc("reorderProject", {
        projectId: "p2",
        previousProjectId: null,
        nextProjectId: "p1",
      });
      expect(
        (reordered as { projects: { id: string }[] }).projects.map((p) => p.id),
      ).toEqual(["p2", "p1", "personal", "p4"]);

      await expect(
        behavior.callRpc("changeProjectFolder", {
          projectId: "p1",
          path: "/elsewhere/alpha",
        }),
      ).resolves.toMatchObject({
        source: { path: "/elsewhere/alpha" },
      });
      expect(inspection.sdk.callsTo("projects.sources.update")).toEqual([
        [
          {
            projectId: "p1",
            sourceId: "src-p1",
            type: "local_path",
            path: "/elsewhere/alpha",
          },
        ],
      ]);
      await expect(
        behavior.callRpc("changeProjectFolder", {
          projectId: "personal",
          path: "/x",
        }),
      ).rejects.toThrow(/no folder/);

      await expect(
        behavior.callRpc("deleteProject", { projectId: "p4" }),
      ).resolves.toEqual({ ok: true });
      expect(inspection.sdk.callsTo("projects.delete")).toEqual([
        [{ projectId: "p4" }],
      ]);
    } finally {
      await fake.harness.lifecycle.dispose();
    }
  });

  it("lists only directories and opens the folder picker on the target host", async () => {
    const fake = boot();
    const { behavior, inspection } = fake.harness;
    try {
      await expect(
        behavior.callRpc("listDirectory", {
          hostId: "host-1",
          path: "/Users/me",
        }),
      ).resolves.toEqual({
        directory: "/Users/me",
        parent: "/Users",
        entries: [{ name: "Code", path: "/Users/me/Code" }],
      });
      await expect(
        behavior.callRpc("pickFolder", { hostId: "host-1" }),
      ).resolves.toEqual({ path: "/Users/me/picked" });
      expect(inspection.sdk.callsTo("hosts.pickFolder")).toEqual([
        [{ hostId: "host-1", clientHostId: "host-1" }],
      ]);
    } finally {
      await fake.harness.lifecycle.dispose();
    }
  });
});
