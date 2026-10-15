import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createProjectOrderStore } from "./project-order-store";
import {
  INITIATIVES_CHANGED,
  INITIATIVE_THREADS_CHANGED,
} from "./project-mode-names";
import { initiativeThreadIds, withDescendants } from "./initiative-threads";
import { withReadTimeout } from "./read-timeout";
import { createWorkerFacts } from "./adventure-workers-server";
import { treeSchema } from "./project-tree-schema";
import {
  MAX_ANCESTRY,
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
  if (!(await initiativesRunning(bb))) throw new Error("The Adventures plugin is not running.");
};

// BB refuses a call to a missing or stopped plugin, so only a failed read pays
// for the full plugin list, to tell those apart from a running Initiatives
// that failed. Null means Initiatives is not running.
const readTree = async (bb: BbPluginApi) => {
  try {
    return await bb.sdk.plugins.callRpc({
      pluginId: INITIATIVES_PLUGIN_ID,
      method: "tree",
      input: null,
      outputSchema: treeSchema,
    });
  } catch (cause: unknown) {
    if (!(await initiativesRunning(bb))) return null;
    throw cause;
  }
};

// Reading the descendants is many small host calls, so it gets longer than
// the tree read.
const DESCENDANTS_TIMEOUT_MS = 60_000;

type ThreadIdsSnapshot = { available: boolean; threadIds: string[] };
const snapshotKey = (s: ThreadIdsSnapshot) =>
  JSON.stringify([s.available, [...s.threadIds].sort()]);

// Walking the forest is hundreds of host calls, so walks start at least this
// far apart however often the snapshot is read.
export const MIN_WALK_INTERVAL_MS = 30_000;

export function registerProjectMode(bb: BbPluginApi) {
  const order = createProjectOrderStore(bb);
  // The hidden thread ids (Initiative threads and all their descendants) as of
  // the last finished walk, shared by every client. `initiativeThreads`
  // answers from it, so no caller waits on Initiatives. A walk that fails or
  // stalls leaves the snapshot as it was; without one yet the answer is
  // "failed", never an empty confirmed snapshot.
  let snapshot: ThreadIdsSnapshot | null = null;
  let firstReadFailed = false;
  // At most one walk runs; a ledger change announced meanwhile (or within the
  // interval) marks the snapshot dirty and earns one more walk, once allowed.
  let walking: AbortController | null = null;
  let walkStartedAt = -Infinity;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readSnapshot = async (
    controller: AbortController,
  ): Promise<ThreadIdsSnapshot> => {
    const tree = await withReadTimeout(readTree(bb));
    if (!tree) return { available: false, threadIds: [] };
    const walk = withDescendants(
      bb,
      initiativeThreadIds(tree),
      controller.signal,
    );
    try {
      const threadIds = await withReadTimeout(
        walk,
        DESCENDANTS_TIMEOUT_MS,
        "Reading the Initiative thread descendants took too long.",
      );
      return { available: true, threadIds };
    } finally {
      // A timed-out walk stops its readers before the next one may start.
      controller.abort();
      await walk.catch(() => {});
    }
  };
  const refreshSnapshot = (ledgerChanged = false) => {
    if (ledgerChanged) dirty = true;
    if (walking || timer) return;
    const wait = walkStartedAt + MIN_WALK_INTERVAL_MS - Date.now();
    if (wait > 0) {
      if (dirty)
        timer = setTimeout(() => {
          timer = undefined;
          refreshSnapshot();
        }, wait);
      return;
    }
    dirty = false;
    walkStartedAt = Date.now();
    const controller = (walking = new AbortController());
    readSnapshot(controller)
      .then(
        (next) => {
          const changed = !snapshot || snapshotKey(snapshot) !== snapshotKey(next);
          snapshot = next;
          firstReadFailed = false;
          if (changed) bb.realtime.publish(INITIATIVE_THREADS_CHANGED, {});
        },
        (cause: unknown) => {
          bb.log.warn(
            `Reading the Initiative thread ids failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          // Clients waiting on the first read hear that it failed.
          if (!snapshot && !firstReadFailed) {
            firstReadFailed = true;
            bb.realtime.publish(INITIATIVE_THREADS_CHANGED, {});
          }
        },
      )
      // A walk that outlives a plugin reload finds its API handle stale.
      .catch(() => {})
      .finally(() => {
        walking = null;
        if (dirty) refreshSnapshot();
      });
  };
  const workerFacts = createWorkerFacts(
    bb,
    (projectId) =>
      bb.sdk.plugins.callRpc({
        pluginId: INITIATIVES_PLUGIN_ID,
        method: "overview",
        input: { projectId, detail: "summary" },
        outputSchema: z.unknown(),
      }),
    // Clients read the tree again, with the facts beside it.
    () => bb.realtime.publish(INITIATIVES_CHANGED, {}),
  );
  bb.onDispose(() => {
    workerFacts.dispose();
    dirty = false;
    clearTimeout(timer);
    walking?.abort();
  });
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
      const fresh = await readTree(bb);
      if (!fresh)
        return { available: false, tree: null, order: null, orderError: null };
      const listed = new Set(fresh.projects.map((project) => project.id));
      workerFacts.retain(listed);
      // An Adventure the tree no longer lists is never read.
      const workers = input?.workersOf
        ? workerFacts.read(input.workersOf.filter((id) => listed.has(id)))
        : undefined;
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
        ...(workers ? { workers } : {}),
      };
    },
    initiativeThreads: () => {
      refreshSnapshot();
      return snapshot
        ? { ...snapshot, status: "ready" as const }
        : {
            available: false,
            threadIds: [],
            status: firstReadFailed ? ("failed" as const) : ("loading" as const),
          };
    },
    threadAncestry: async ({ threadId }) => {
      const links: { id: string; parentThreadId: string | null }[] = [];
      const seen = new Set<string>();
      for (let id: string | null = threadId; id && !seen.has(id) && links.length < MAX_ANCESTRY; ) {
        seen.add(id);
        let thread;
        try {
          thread = await bb.sdk.threads.get({ threadId: id });
        } catch (cause) {
          // A deleted ancestor ends the chain; the links below it still help.
          if (!links.length) throw cause;
          break;
        }
        links.push({ id, parentThreadId: thread.parentThreadId });
        id = thread.parentThreadId;
      }
      return { links };
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
      refreshSnapshot(true);
      workerFacts.changed(payload.projectId);
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
