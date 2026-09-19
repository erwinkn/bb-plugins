/**
 * The host module: it runs on the machine that holds the files and keeps
 * one native watch per workspace root the server asked for. Each batch of
 * changes goes back to the server as a signal; the server tells the open
 * editors, which re-read the files they show.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { MAX_CHANGED_PATHS, watchContract, watchSignals } from "./lib/watch-contract.js";

/** Trees whose churn never reaches an open file and would only cost batches. */
const IGNORED = [".git", "node_modules", ".bb"];

const watches = new Map<string, ExperimentalHostWatchSubscription>();

type GitRunner = (args: string[], options: { cwd: string; signal: AbortSignal }) => Promise<string>;

/** Run one bounded, non-shell Git probe in the requested checkout. */
const runGit: GitRunner = (args, { cwd, signal }) => new Promise((resolve, reject) => {
  execFile("git", args, {
    cwd,
    signal,
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    encoding: "utf8",
    windowsHide: true,
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Keep both `main` for identity and `origin/main` for the comparison ref. */
export function branchFromOriginHead(output: string): { name: string; ref: string } | null {
  const ref = output.trim();
  return ref.startsWith("origin/") && ref.length > "origin/".length
    ? { name: ref.slice("origin/".length), ref }
    : null;
}

/** Resolve origin/HEAD without fetching or mutating the checkout. */
export async function gitDefaultBranch(
  rootPath: string,
  signal: AbortSignal,
  git: GitRunner = runGit,
): Promise<{ name: string; ref: string } | null> {
  try {
    return branchFromOriginHead(await git(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: rootPath, signal },
    ));
  } catch {
    return null;
  }
}

function realPath(rootPath: string): string {
  try {
    return realpathSync.native(rootPath);
  } catch {
    return rootPath;
  }
}

export default experimental_defineHostEntry({
  contract: watchContract,
  experimental_signals: watchSignals,
  handlers: {
    async gitDefaultBranch({ rootPath }, context) {
      return { defaultBranch: await gitDefaultBranch(rootPath, context.signal) };
    },
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
          // The watcher reports real paths, so a root reached through a
          // symbolic link (macOS's /tmp, for one) is resolved first and every
          // change is made relative to it.
          const realRoot = realPath(rootPath);
          // `let`, not `const`: an event can arrive while the call is still
          // resolving, and reading a `const` there throws before the
          // subscription can be checked at all.
          let subscription: ExperimentalHostWatchSubscription | undefined;
          subscription = await context.experimental_watch({ rootPath: realRoot, ignoredPaths: IGNORED }, async (event) => {
            // The watch may already be gone, or still starting; a batch from
            // outside the registered subscription says nothing.
            if (subscription === undefined || watches.get(rootPath) !== subscription) return;
            if (event.kind === "changed") {
              const paths = event.changes.flatMap((change) => {
                const relative = path.relative(realRoot, path.resolve(realRoot, change.path));
                return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? [] : [{ path: relative, type: change.type }];
              });
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
