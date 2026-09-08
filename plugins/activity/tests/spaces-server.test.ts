import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const space = (id: string, name: string, projectIds: string[] = []) => ({
  id,
  name,
  projectIds,
});

describe("spaces API", () => {
  it("starts empty, saves with a revision check, and publishes the document", async () => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      const { behavior, inspection } = host.harness;
      await expect(behavior.callRpc("getSpaces", null)).resolves.toEqual({ revision: 0, spaces: [] });
      const saved = await behavior.callRpc("saveSpaces", {
        expectedRevision: 0,
        spaces: [space("a", "  Client work ", ["p1", "p1", "p2"])],
      });
      expect(saved).toEqual({ revision: 1, spaces: [space("a", "Client work", ["p1", "p2"])] });
      expect(inspection.realtimeSignals).toEqual([{ channel: "spaces-changed", payload: saved }]);
      await expect(behavior.callRpc("getSpaces", null)).resolves.toEqual(saved);
      await expect(
        behavior.callRpc("saveSpaces", { expectedRevision: 0, spaces: [] }),
      ).rejects.toThrow(/changed on another client/);
      await expect(behavior.callRpc("getSpaces", null)).resolves.toEqual(saved);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it.each([
    { spaces: [space("a", "   ")], message: /cannot be empty/ },
    { spaces: [space("a", "Work"), space("b", "work")], message: /already exists/ },
    { spaces: [space("a", "One"), space("a", "Two")], message: /ids must be unique/ },
  ])("rejects invalid catalogs: $message", async ({ spaces, message }) => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      await expect(
        host.harness.behavior.callRpc("saveSpaces", { expectedRevision: 0, spaces }),
      ).rejects.toThrow(message);
      expect(host.harness.inspection.realtimeSignals).toEqual([]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("serializes concurrent saves so only one wins per revision", async () => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      const results = await Promise.allSettled([
        host.harness.behavior.callRpc("saveSpaces", { expectedRevision: 0, spaces: [space("a", "A")] }),
        host.harness.behavior.callRpc("saveSpaces", { expectedRevision: 0, spaces: [space("b", "B")] }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      await expect(host.harness.behavior.callRpc("getSpaces", null)).resolves.toEqual({
        revision: 1,
        spaces: [space("a", "A")],
      });
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("exports and imports the catalog through the CLI", async () => {
    const host = createFakePluginHost();
    plugin(host.bb);
    try {
      const { behavior } = host.harness;
      await behavior.callRpc("saveSpaces", { expectedRevision: 0, spaces: [space("a", "A", ["p1"])] });
      const exported = await behavior.runCli(["spaces-export"]);
      expect(exported.exitCode).toBe(0);
      expect(JSON.parse(exported.stdout)).toEqual({ revision: 1, spaces: [space("a", "A", ["p1"])] });

      const imported = await behavior.runCli([
        "spaces-import",
        JSON.stringify({ spaces: [space("b", "B", ["p2"])] }),
      ]);
      expect(imported).toMatchObject({ exitCode: 0, stdout: "Imported 1 space(s) at revision 2.\n" });
      await expect(behavior.callRpc("getSpaces", null)).resolves.toEqual({
        revision: 2,
        spaces: [space("b", "B", ["p2"])],
      });

      expect(await behavior.runCli(["spaces-import", "{not json"])).toMatchObject({ exitCode: 2 });
      expect(await behavior.runCli(["spaces-import", '{"spaces":[{"id":"x","name":"","projectIds":[]}]}'])).toMatchObject({ exitCode: 2 });
      expect(await behavior.runCli(["spaces-import", JSON.stringify({ spaces: [space("a", "A"), space("b", "a")] })])).toMatchObject({
        exitCode: 1,
        stderr: 'A space named "a" already exists.\n',
      });
      expect(await behavior.runCli(["nope"])).toMatchObject({ exitCode: 2 });
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
