import { useEffect, useRef, type ComponentType } from "react";
import {
  QueryClientProvider,
  keepPreviousData,
  queryOptions,
  replaceEqualDeep,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  useRealtime,
  useRealtimeConnectionState,
  type PluginRpcClient,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { projectModeContract } from "./project-mode-contract";
import type { snoozeContract } from "./snooze-contract";
import type { archiveContract, ArchivedThread } from "./archive-contract";
import type { branchPullRequestContract } from "./branch-pull-request-contract";
import { treeSchema } from "./project-tree-schema";
import { projectOrderDocSchema } from "./project-order-schema";
import { adventureWorkerSchema, type AdventureWorker } from "./adventure-workers";
import { SNOOZE_CHANNEL, snoozeDocSchema, type SnoozeDoc } from "./snooze-schema";
import {
  SNOOZE_PRESETS_CHANNEL,
  snoozePresetsDocSchema,
  type SnoozePresetsDoc,
} from "./snooze-presets";
import {
  ADVENTURE_WORKERS_CHANGED,
  INITIATIVES_CHANGED,
  INITIATIVE_THREADS_CHANGED,
} from "./project-mode-names";
import {
  READ_TIMEOUT_MS,
  ReadTimeoutError,
  claimReport,
  withReadTimeout,
} from "./read-timeout";
import { isLive, refresh, sidebarQueryClient } from "./query";

/**
 * Every query the sidebar makes: its key, how it reads, and how a change
 * reaches it. Realtime signals refresh the keys they name (QuerySync below);
 * a slow safety poll covers a signal lost while the tab was away. Every read
 * has a deadline: `refresh` waits for a read in flight, so one that never
 * settles would hold every refresh after it.
 */
export const SAFETY_POLL_MS = 60_000;

/** The deadline of a read that is not about the Adventures. */
const deadline = <T,>(read: Promise<T>) =>
  withReadTimeout(read, READ_TIMEOUT_MS, "The sidebar server did not answer in time.");

export const queryKeys = {
  tree: ["adventure-tree"] as const,
  workers: (projectId: string) => ["adventure-workers", projectId] as const,
  threadIds: ["initiative-threads"] as const,
  ancestries: ["thread-ancestry"] as const,
  ancestry: (threadId: string) => ["thread-ancestry", threadId] as const,
  snoozes: ["snoozes"] as const,
  snoozePresets: ["snooze-presets"] as const,
  archives: ["archives"] as const,
  branchPullRequests: (idsKey: string) => ["branch-pull-requests", idsKey] as const,
};

const treeDataSchema = z.object({
  available: z.boolean(),
  tree: treeSchema.nullable(),
  revision: z.string().nullable(),
  order: projectOrderDocSchema.nullable(),
  orderError: z.string().nullable(),
});
export type TreeData = z.infer<typeof treeDataSchema>;

/** The queries saved for a cold open, by root key, with what their data must pass. */
const PERSISTED = {
  [queryKeys.tree[0]]: treeDataSchema,
  "adventure-workers": z.array(adventureWorkerSchema),
  [queryKeys.threadIds[0]]: z.array(z.string()),
  [queryKeys.snoozes[0]]: snoozeDocSchema,
  [queryKeys.snoozePresets[0]]: snoozePresetsDocSchema,
};

export const queryClient = () => sidebarQueryClient(PERSISTED);

type ModeApi = PluginRpcClient<typeof projectModeContract>;

/**
 * The Adventures tree and the saved order. The read is conditional: an
 * unchanged tree comes back as a few bytes and keeps the tree in hand.
 */
export const treeQuery = (api: ModeApi) =>
  queryOptions({
    queryKey: queryKeys.tree,
    queryFn: async ({ client }): Promise<TreeData> => {
      const known = client.getQueryData<TreeData>(queryKeys.tree);
      try {
        const result = await withReadTimeout(
          api.call("projectMode", { known: known?.revision ?? null }),
        );
        return {
          available: result.available,
          tree: result.unchanged ? (known?.tree ?? null) : result.tree,
          revision: result.revision ?? null,
          order: result.order,
          orderError: result.orderError,
        };
      } catch (error) {
        if (error instanceof ReadTimeoutError && claimReport())
          void api.call("reportReadTimeout", error.report).catch(() => {});
        throw error;
      }
    },
    refetchInterval: SAFETY_POLL_MS,
  });

/**
 * The model and group of an Adventure's workers. The server answers from
 * memory and rereads an Adventure only while someone asked within its
 * WANTED_MS (2 min), so the poll keeps a shown Adventure's facts current.
 */
export const workersQuery = (api: ModeApi, projectId: string) =>
  queryOptions({
    queryKey: queryKeys.workers(projectId),
    queryFn: async ({ client }): Promise<AdventureWorker[] | null> => {
      const { workers } = await withReadTimeout(
        api.call("adventureWorkers", { projectId }),
      );
      // Not read yet on the server (a restart): what this client knew stays.
      return workers ?? client.getQueryData<AdventureWorker[] | null>(queryKeys.workers(projectId)) ?? null;
    },
    refetchInterval: SAFETY_POLL_MS,
  });

/**
 * The ids of the threads Adventures own. Null is unknown: the server is still
 * on its first read (its signal follows). Only a confirmed answer replaces a
 * known set; a non-answer keeps it, and without one, a failed first read is
 * an error, which ends the wait without caching anything.
 */
export const threadIdsQuery = (api: ModeApi) =>
  queryOptions({
    queryKey: queryKeys.threadIds,
    queryFn: async ({ client }): Promise<string[] | null> => {
      const result = await withReadTimeout(api.call("initiativeThreads", null));
      if (result.status === "ready") return result.available ? result.threadIds : [];
      const known = client.getQueryData<string[] | null>(queryKeys.threadIds) ?? null;
      if (result.status === "failed" && !known)
        throw new Error("The server's first read of the Adventure threads failed.");
      return known;
    },
    refetchInterval: SAFETY_POLL_MS,
  });

/**
 * A thread's parent links up the chain, for threads BB's list omits (an
 * archived reviewer between a worker and its helper). They seldom change, so
 * they stay for the session; a failed read is asked again on the next use.
 */
export const ancestryQuery = (api: ModeApi, threadId: string) =>
  queryOptions({
    queryKey: queryKeys.ancestry(threadId),
    queryFn: () => withReadTimeout(api.call("threadAncestry", { threadId })),
    staleTime: Infinity,
    retry: false,
  });

type Revisioned = { revision: number };

/**
 * Keeps the newer of two revisioned documents: an answer that was in flight
 * while a signal or a write landed a newer one must not roll it back. A
 * document restored from storage never outranks the server's.
 */
function newerDoc<Doc extends Revisioned>(
  client: QueryClient,
  queryKey: QueryKey,
  next: Doc,
): Doc {
  const state = client.getQueryState<Doc>(queryKey);
  return state?.data && isLive(state.dataUpdatedAt) && state.data.revision > next.revision
    ? state.data
    : next;
}
/** Writes a document (a signal's, a write's answer) unless the cache holds a newer one. */
export function applyDoc<Doc extends Revisioned>(
  client: QueryClient,
  queryKey: QueryKey,
  doc: Doc,
) {
  client.setQueryData(queryKey, newerDoc(client, queryKey, doc));
}
/**
 * The same rule where a read's answer enters the cache: a write that landed
 * after the read returned, but before its answer was stored, stays.
 */
const keepNewer = (queryKey: QueryKey) => (old: unknown, next: unknown) =>
  replaceEqualDeep(old, newerDoc(queryClient(), queryKey, next as Revisioned));

type SnoozeApi = PluginRpcClient<typeof snoozeContract>;
export const snoozesQuery = (api: SnoozeApi) =>
  queryOptions({
    queryKey: queryKeys.snoozes,
    queryFn: async (): Promise<SnoozeDoc> =>
      snoozeDocSchema.parse(await deadline(api.call("getSnoozes", null))),
    structuralSharing: keepNewer(queryKeys.snoozes),
  });
export const snoozePresetsQuery = (api: SnoozeApi) =>
  queryOptions({
    queryKey: queryKeys.snoozePresets,
    queryFn: async (): Promise<SnoozePresetsDoc> =>
      snoozePresetsDocSchema.parse(await deadline(api.call("getSnoozePresets", null))),
    structuralSharing: keepNewer(queryKeys.snoozePresets),
  });

function sidebarThread(thread: ArchivedThread): PluginSidebarThread {
  return {
    ...thread,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: true,
    host: null,
    lastReadAt: null,
    latestAttentionAt: thread.updatedAt,
    environment: thread.environmentId
      ? {
          id: thread.environmentId,
          name: thread.environmentName,
          branchName: thread.environmentBranchName,
          providerId: thread.environmentProviderId,
          workspaceDisplayKind: thread.environmentWorkspaceDisplayKind,
        }
      : null,
  };
}

/** Every archived thread, read page by page; only while the Archived list shows. */
export const archivesQuery = (api: PluginRpcClient<typeof archiveContract>) =>
  queryOptions({
    queryKey: queryKeys.archives,
    queryFn: async ({ signal }): Promise<PluginSidebarThread[]> => {
      const result: PluginSidebarThread[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await deadline(api.call("listArchived", { offset }));
        // The list closed meanwhile (useArchives cancels the read): no more pages.
        signal.throwIfAborted();
        result.push(...page.map(sidebarThread));
        if (page.length < 200) break;
      }
      return [...new Map(result.map((thread) => [thread.id, thread])).values()];
    },
  });

/**
 * Whether each listed thread's environment branch PR is its own, in one bulk
 * call per id set. Each new set is read, even one seen before (a thread's
 * checkout may have changed since), as is every set on reconnection; the last
 * answer shows until the new one lands.
 */
export const branchPullRequestsQuery = (
  api: PluginRpcClient<typeof branchPullRequestContract>,
  idsKey: string,
) =>
  queryOptions({
    queryKey: queryKeys.branchPullRequests(idsKey),
    // Reading `signal` lets TanStack cancel the read once the list moves to
    // another set: a late answer for a set nobody shows is never cached, so it
    // cannot pass for newer than the answer that followed it.
    queryFn: async ({ signal }) => {
      const { eligible } = await deadline(
        api.call("branchPullRequestEligibility", {
          threadIds: idsKey === "" ? [] : idsKey.split("\0"),
        }),
      );
      signal.throwIfAborted();
      return eligible;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    gcTime: 60_000,
    placeholderData: keepPreviousData,
  });

/**
 * Routes the plugin's realtime signals to the queries they concern. A signal
 * carrying the new document applies it; the rest refresh their keys. Signals
 * are not replayed, so a reconnection refreshes everything.
 */
function QuerySync() {
  const client = useQueryClient();
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") refresh(client, []);
    previous.current = connection;
  }, [client, connection]);
  useRealtime(INITIATIVES_CHANGED, () => refresh(client, queryKeys.tree));
  useRealtime(ADVENTURE_WORKERS_CHANGED, (payload) => {
    const projectId = (payload as { projectId?: unknown } | null)?.projectId;
    refresh(client, typeof projectId === "string" ? queryKeys.workers(projectId) : ["adventure-workers"]);
  });
  useRealtime(INITIATIVE_THREADS_CHANGED, () => refresh(client, queryKeys.threadIds));
  useRealtime("archives-changed", () => refresh(client, queryKeys.archives));
  useRealtime(SNOOZE_CHANNEL, (payload) => {
    const parsed = snoozeDocSchema.safeParse(payload);
    if (parsed.success) applyDoc(client, queryKeys.snoozes, parsed.data);
  });
  useRealtime(SNOOZE_PRESETS_CHANNEL, (payload) => {
    const parsed = snoozePresetsDocSchema.safeParse(payload);
    if (parsed.success) applyDoc(client, queryKeys.snoozePresets, parsed.data);
  });
  return null;
}

/** A slot component with the sidebar's QueryClient and realtime routing around it. */
export function withQueries<Props extends object>(
  Component: ComponentType<Props>,
): ComponentType<Props> {
  function WithQueries(props: Props) {
    return (
      <QueryClientProvider client={queryClient()}>
        <QuerySync />
        <Component {...props} />
      </QueryClientProvider>
    );
  }
  return WithQueries;
}
