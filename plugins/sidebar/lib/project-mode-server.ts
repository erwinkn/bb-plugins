import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createProjectOrderStore } from "./project-order-store";
import { INITIATIVES_CHANGED } from "./project-mode-names";
import { treeSchema } from "./project-tree-schema";
import {
  projectModeContract,
  threadCreateResultSchema,
} from "./project-mode-contract";

/** The Initiatives plugin, which serves the tree. */
export const INITIATIVES_PLUGIN_ID = "initiatives";
const initiativesRunning = async (bb: BbPluginApi) =>
  (await bb.sdk.plugins.list()).plugins.some(
    (p) => p.id === INITIATIVES_PLUGIN_ID && p.enabled && p.status === "running",
  );
const requireRunning = async (bb: BbPluginApi) => {
  if (!(await initiativesRunning(bb))) throw new Error("The Initiatives plugin is not running.");
};

export function registerProjectMode(bb: BbPluginApi) {
  const order = createProjectOrderStore(bb);
  // The last tree served and its revision. The random epoch keeps a revision
  // from an earlier server instance from ever matching a new tree.
  const epoch = Math.random().toString(36).slice(2, 10);
  let served = { json: "", revision: "" };
  let count = 0;
  const revisionOf = (json: string) => {
    if (json !== served.json) served = { json, revision: `${epoch}:${++count}` };
    return served.revision;
  };
  bb.rpc.register(projectModeContract, {
    projectMode: async (input) => {
      let fresh;
      try {
        fresh = await bb.sdk.plugins.callRpc({
          pluginId: INITIATIVES_PLUGIN_ID,
          method: "tree",
          input: null,
          outputSchema: treeSchema,
        });
      } catch (cause: unknown) {
        // BB refuses a call to a missing or stopped plugin, so only a failed
        // read pays for the full plugin list, to tell those apart from a
        // running Initiatives that failed.
        if (!(await initiativesRunning(bb)))
          return { available: false, tree: null, order: null, orderError: null };
        throw cause;
      }
      const revision = input ? revisionOf(JSON.stringify(fresh)) : null;
      const unchanged = !!input?.known && input.known === revision;
      const tree = unchanged ? null : fresh;
      // A doc read failure must not take the tree down with it; the error is
      // reported so an unreadable store is visible instead of silently reset.
      let doc = null;
      let orderError = null;
      try {
        doc = await order.sync(
          fresh.projects.map((project) => project.id),
        );
      } catch (cause: unknown) {
        const message =
          cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`Could not sync the project order: ${message}`);
        orderError = message;
      }
      return {
        available: true,
        tree,
        ...(input ? { revision, unchanged } : {}),
        order: doc,
        orderError,
      };
    },
    saveProjectOrder: ({ expectedRevision, order: ids }) =>
      order.save(expectedRevision, ids),
    renameTreeProject: async ({ projectId, name }) => {
      await requireRunning(bb);
      return bb.sdk.plugins.callRpc({
        pluginId: INITIATIVES_PLUGIN_ID,
        method: "command",
        input: { projectId, command: { action: "edit", name } },
        outputSchema: z.unknown(),
      });
    },
    setTreeProjectAppearance: async ({ projectId, icon, color }) => {
      await requireRunning(bb);
      return bb.sdk.plugins.callRpc({
        pluginId: INITIATIVES_PLUGIN_ID,
        method: "command",
        input: {
          projectId,
          command: {
            action: "appearance",
            ...(icon !== undefined ? { icon } : {}),
            ...(color !== undefined ? { color } : {}),
          },
        },
        outputSchema: z.unknown(),
      });
    },
    createProjectThread: async ({ projectId, bbProjectId, prompt }) => {
      await requireRunning(bb);
      return bb.sdk.plugins.callRpc({
        pluginId: INITIATIVES_PLUGIN_ID,
        method: "command",
        input: {
          projectId,
          command: {
            action: "thread-create",
            ...(bbProjectId ? { bbProjectId } : {}),
            prompt,
          },
        },
        outputSchema: threadCreateResultSchema,
      });
    },
    initiativesChanged: (payload) => {
      bb.realtime.publish(INITIATIVES_CHANGED, payload);
      return { ok: true as const };
    },
    reportReadTimeout: (r) => {
      bb.log.warn(
        `An Initiatives tree read timed out in a client: elapsedMs=${r.elapsedMs} hidden=${r.hidden} online=${r.online} sinceVisibleMs=${r.sinceVisibleMs} hiddenDuringRead=${r.hiddenDuringRead}`,
      );
      return { ok: true as const };
    },
  });
}
