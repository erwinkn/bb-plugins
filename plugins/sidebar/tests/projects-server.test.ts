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
      },
    },
  });
  plugin(fake.bb);
  return fake;
}

describe("projects API", () => {
  it("renames and deletes through BB's project API", async () => {
    const fake = boot();
    const { behavior, inspection } = fake.harness;
    try {
      await expect(
        behavior.callRpc("renameProject", { projectId: "p1", name: "Alpha!" }),
      ).resolves.toMatchObject({ name: "Alpha!" });
      await expect(
        behavior.callRpc("renameProject", { projectId: "p1", name: "   " }),
      ).rejects.toThrow();

      await expect(
        behavior.callRpc("deleteProject", { projectId: "p2" }),
      ).resolves.toEqual({ ok: true });
      expect(inspection.sdk.callsTo("projects.delete")).toEqual([
        [{ projectId: "p2" }],
      ]);
    } finally {
      await fake.harness.lifecycle.dispose();
    }
  });
});
