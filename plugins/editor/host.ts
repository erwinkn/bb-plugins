/**
 * The host module: it runs on the machine that holds the files and keeps
 * one native watch per workspace root the server asked for. Each batch of
 * changes goes back to the server as a signal; the server tells the open
 * editors, which re-read the files they show.
 */
import { experimental_defineHostEntry, type ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { MAX_CHANGED_PATHS, watchContract, watchSignals } from "./lib/watch-contract.js";

/** Trees whose churn never reaches an open file and would only cost batches. */
const IGNORED = [".git", "node_modules", ".bb"];

const watches = new Map<string, ExperimentalHostWatchSubscription>();

export default experimental_defineHostEntry({
  contract: watchContract,
  experimental_signals: watchSignals,
  handlers: {
    async syncWatches({ roots }, context) {
      const wanted = new Set(roots);
      const stopped: Promise<void>[] = [];
      for (const [rootPath, subscription] of watches) {
        if (wanted.has(rootPath)) continue;
        watches.delete(rootPath);
        stopped.push(subscription.dispose().catch(() => undefined));
      }
      await Promise.all(stopped);
      const failed: { rootPath: string; message: string }[] = [];
      for (const rootPath of wanted) {
        if (watches.has(rootPath)) continue;
        try {
          const subscription = await context.experimental_watch({ rootPath, ignoredPaths: IGNORED }, async (event) => {
            // The watch may already be gone; a late batch from it says nothing.
            if (watches.get(rootPath) !== subscription) return;
            if (event.kind === "changed") {
              const paths = event.changes.map((change) => ({ path: change.path, type: change.type }));
              const kind = paths.length > MAX_CHANGED_PATHS ? "rescan" : "changed";
              await context.experimental_emitSignal("changed", { rootPath, kind, paths: kind === "changed" ? paths : [] });
              return;
            }
            // A lost-events notice or a watcher failure: the editors reload
            // what they show. A failed watch is dropped, so the next sync
            // starts it again instead of trusting a dead subscription.
            if (event.kind === "watch-error") {
              watches.delete(rootPath);
              void subscription.dispose().catch(() => undefined);
            }
            await context.experimental_emitSignal("changed", { rootPath, kind: "rescan", paths: [] });
          });
          watches.set(rootPath, subscription);
        } catch (error) {
          failed.push({ rootPath, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { watching: [...watches.keys()], failed };
    },
  },
  async dispose() {
    const all = [...watches.values()];
    watches.clear();
    await Promise.all(all.map((subscription) => subscription.dispose().catch(() => undefined)));
  },
});
