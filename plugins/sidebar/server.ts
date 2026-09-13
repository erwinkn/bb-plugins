import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { archiveContract } from "./lib/archive-contract";
import { archiveTree } from "./lib/archive-tree";
import { threadTitle } from "./lib/status";
import { registerLibrary } from "./lib/library-store";
import { registerProjects } from "./lib/projects-rpc";
import { registerSpaces } from "./lib/spaces-store";
import { registerUiPreferences } from "./lib/ui-preferences-store";

export default function plugin(bb: BbPluginApi) {
  registerSpaces(bb);
  registerLibrary(bb);
  registerProjects(bb);
  registerUiPreferences(bb);
  bb.rpc.register(archiveContract, {
    parentTitle: async ({ threadId }) =>
      threadTitle(await bb.sdk.threads.get({ threadId })),
    archiveTree: ({ threadId }) => archiveTree(bb, threadId),
    listArchived: ({ offset }) =>
      bb.sdk.threads.list({
        archived: true,
        includeHidden: false,
        limit: 200,
        offset,
      }),
    restoreThread: async ({ threadId }) => {
      const result = await bb.sdk.threads.unarchive({ threadId });
      bb.realtime.publish("archives-changed", {});
      return result;
    },
  });
  bb.events.on("thread.archived", () =>
    bb.realtime.publish("archives-changed", {}),
  );
  bb.events.on("thread.deleted", () =>
    bb.realtime.publish("archives-changed", {}),
  );
}
