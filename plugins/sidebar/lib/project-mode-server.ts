import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createProjectOrderStore } from "./project-order-store";
import { INITIATIVES_CHANGED } from "./project-mode-names";
import { treeSchema } from "./project-tree-schema";
import {
  projectModeContract,
  threadCreateResultSchema,
} from "./project-mode-contract";

/**
 * The Initiatives plugin is installed as `initiatives`; until its one-time
 * move it was `projects`. Whichever of them is running serves the tree, so
 * the order of the switch does not matter. Remove the fallback once
 * `projects` is retired.
 */
export const INITIATIVE_PLUGIN_IDS = ["initiatives", "projects"] as const;
export const initiativesProvider = async (bb: BbPluginApi) => {
  const plugins = (await bb.sdk.plugins.list()).plugins;
  return (
    INITIATIVE_PLUGIN_IDS.find((id) =>
      plugins.some((p) => p.id === id && p.enabled && p.status === "running"),
    ) ?? null
  );
};
const requireProvider = async (bb: BbPluginApi) => {
  const provider = await initiativesProvider(bb);
  if (!provider) throw new Error("The Initiatives plugin is not running.");
  return provider;
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
      const provider = await initiativesProvider(bb);
      if (!provider)
        return { available: false, tree: null, order: null, orderError: null };
      const fresh = await bb.sdk.plugins.callRpc({
        pluginId: provider,
        method: "tree",
        input: null,
        outputSchema: treeSchema,
      });
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
        pluginId: provider,
        tree,
        ...(input ? { revision, unchanged } : {}),
        order: doc,
        orderError,
      };
    },
    saveProjectOrder: ({ expectedRevision, order: ids }) =>
      order.save(expectedRevision, ids),
    renameTreeProject: async ({ projectId, name }) => {
      return bb.sdk.plugins.callRpc({
        pluginId: await requireProvider(bb),
        method: "command",
        input: { projectId, command: { action: "edit", name } },
        outputSchema: z.unknown(),
      });
    },
    setTreeProjectAppearance: async ({ projectId, icon, color }) => {
      return bb.sdk.plugins.callRpc({
        pluginId: await requireProvider(bb),
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
      return bb.sdk.plugins.callRpc({
        pluginId: await requireProvider(bb),
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
    // The name the plugin called before its move to `initiatives`.
    projectsChanged: (payload) => {
      bb.realtime.publish(INITIATIVES_CHANGED, payload);
      return { ok: true as const };
    },
  });
}
