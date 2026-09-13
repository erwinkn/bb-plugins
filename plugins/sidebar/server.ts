import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { archiveContract } from "./lib/archive-contract";
import { archiveTree } from "./lib/archive-tree";
import { threadTitle } from "./lib/status";
import { registerLibrary } from "./lib/library-store";
import { registerProjects } from "./lib/projects-rpc";
import { registerSnoozes } from "./lib/snooze-store";
import { registerSidebarCli } from "./lib/sidebar-cli";
import { registerSpaces } from "./lib/spaces-store";
import { registerUiPreferences } from "./lib/ui-preferences-store";
import { registerPullRequests } from "./lib/pull-requests-store";
import { nestingContract } from "./lib/nesting-contract";

export default function plugin(bb: BbPluginApi) {
  const spaces = registerSpaces(bb);
  registerLibrary(bb);
  const snoozes = registerSnoozes(bb);
  // One `bb sidebar` namespace per plugin: spaces and snooze share it.
  registerSidebarCli(bb, { spaces, snoozes });
  registerProjects(bb);
  registerUiPreferences(bb);
  registerPullRequests(bb);
  bb.rpc.register(nestingContract, {
    setParent: async ({ threadId, parentThreadId }) => {
      if (parentThreadId !== null) {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.pinnedAt !== null)
          await bb.sdk.threads.unpin({ threadId });
      }
      await bb.sdk.threads.update({ threadId, parentThreadId });
      return { ok: true as const };
    },
  });
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
  // Every change to the archive set invalidates the frontend's list, including
  // restores made outside the plugin (BB's own UI, the CLI, other clients).
  for (const event of [
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const) {
    bb.events.on(event, () => bb.realtime.publish("archives-changed", {}));
  }
}
