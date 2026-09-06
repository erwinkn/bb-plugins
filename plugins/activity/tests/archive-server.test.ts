import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

describe("archive API", () => {
  it("pages visible archives and restores through BB", async () => {
    const host = createFakePluginHost({
      sdk: {
        threads: {
          list: async () => [
            {
              ...makeThreadResponse({ id: "old", archivedAt: 123 }),
              environmentName: null,
              environmentBranchName: null,
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
