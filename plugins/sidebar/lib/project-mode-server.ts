import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createProjectOrderStore } from "./project-order-store";
import { treeSchema } from "./project-tree-schema";
import {
  projectModeContract,
  threadCreateResultSchema,
} from "./project-mode-contract";

const projectsRunning = async (bb: BbPluginApi) => {
  const installed = (await bb.sdk.plugins.list()).plugins.find(
    (p) => p.id === "projects",
  );
  return Boolean(installed?.enabled && installed.status === "running");
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
      if (!(await projectsRunning(bb)))
        return { available: false, tree: null, order: null, orderError: null };
      const fresh = await bb.sdk.plugins.callRpc({
        pluginId: "projects",
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
        tree,
        ...(input ? { revision, unchanged } : {}),
        order: doc,
        orderError,
      };
    },
    saveProjectOrder: ({ expectedRevision, order: ids }) =>
      order.save(expectedRevision, ids),
    renameTreeProject: async ({ projectId, name }) => {
      if (!(await projectsRunning(bb)))
        throw new Error("The Projects plugin is not running.");
      return bb.sdk.plugins.callRpc({
        pluginId: "projects",
        method: "command",
        input: { projectId, command: { action: "edit", name } },
        outputSchema: z.unknown(),
      });
    },
    setTreeProjectAppearance: async ({ projectId, icon, color }) => {
      if (!(await projectsRunning(bb)))
        throw new Error("The Projects plugin is not running.");
      return bb.sdk.plugins.callRpc({
        pluginId: "projects",
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
      if (!(await projectsRunning(bb)))
        throw new Error("The Projects plugin is not running.");
      return bb.sdk.plugins.callRpc({
        pluginId: "projects",
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
    projectsChanged: (payload) => {
      bb.realtime.publish("projects-changed", payload);
      return { ok: true as const };
    },
  });
}
