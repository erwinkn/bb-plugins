import type { BbPluginApi } from "@get-bb/plugin-sdk";

export async function archiveTree(bb: BbPluginApi, threadId: string) {
  // Collect first: archiving a parent detaches any children that remain active.
  const ids = [threadId];
  const activeIds = [threadId];
  const seen = new Set(ids);
  for (let index = 0; index < ids.length; index++) {
    // Restoring a descendant alone can leave an archived ancestor in its path.
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 200) {
        const children = await bb.sdk.threads.list({
          parentThreadId: ids[index],
          archived,
          includeHidden: true,
          limit: 200,
          offset,
        });
        for (const child of children) {
          if (seen.has(child.id)) {
            throw new Error("Thread tree changed or contains a cycle. Retry Archive.");
          }
          seen.add(child.id);
          ids.push(child.id);
          if (!archived) activeIds.push(child.id);
        }
        if (children.length < 200) break;
      }
    }
  }
  let completed = 0;
  try {
    // Reverse breadth-first order puts every descendant before its parent.
    for (const id of activeIds.reverse()) {
      await bb.sdk.threads.archive({ threadId: id });
      completed++;
    }
  } catch (error) {
    throw new Error(
      `Archive stopped after ${completed} of ${activeIds.length} threads. Some threads may already be archived. ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    bb.realtime.publish("archives-changed", {});
  }
  return { ok: true as const };
}
