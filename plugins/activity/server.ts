import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { archiveContract } from "./lib/archive-contract";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(archiveContract, {
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
