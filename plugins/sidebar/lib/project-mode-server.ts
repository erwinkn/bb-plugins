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
  bb.rpc.register(projectModeContract, {
    projectMode: async () => {
      if (!(await projectsRunning(bb)))
        return { available: false, tree: null, order: null, orderError: null };
      const tree = await bb.sdk.plugins.callRpc({
        pluginId: "projects",
        method: "tree",
        input: null,
        outputSchema: treeSchema,
      });
      // A doc read failure must not take the tree down with it; the error is
      // reported so an unreadable store is visible instead of silently reset.
      let doc = null;
      let orderError = null;
      try {
        doc = await order.sync(
          tree.projects.map((project) => project.id),
        );
      } catch (cause: unknown) {
        const message =
          cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`Could not sync the project order: ${message}`);
        orderError = message;
      }
      return { available: true, tree, order: doc, orderError };
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
