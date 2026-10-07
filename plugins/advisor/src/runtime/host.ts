// The narrow slice of the public plugin SDK the runtime uses. Production binds
// it to bb.sdk; tests bind it to the SDK's fake host. Nothing here writes to a
// watched thread, its files or any Initiative record.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EventQuery, EventRow } from "../rules/events.js";

type Sdk = BbPluginApi["sdk"];
export type ThreadDto = Awaited<ReturnType<Sdk["threads"]["get"]>>;
export type ThreadListItem = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];
type StatusResult = Awaited<ReturnType<Sdk["environments"]["status"]>>;
type DiffFilesResult = Awaited<ReturnType<Sdk["environments"]["diffFiles"]>>;
type DiffPatchResult = Awaited<ReturnType<Sdk["environments"]["diffPatch"]>>;

export interface AdvisorHost {
  getThread(threadId: string, signal?: AbortSignal): Promise<ThreadDto>;
  listEvents(threadId: string, q: EventQuery, signal?: AbortSignal): Promise<EventRow[]>;
  listProjectThreads(projectId: string, signal?: AbortSignal): Promise<ThreadListItem[]>;
  listRecentThreads(limit: number): Promise<ThreadListItem[]>;
  envPath(environmentId: string, signal?: AbortSignal): Promise<string | null>;
  envStatus(environmentId: string, signal?: AbortSignal): Promise<StatusResult>;
  envDiffFiles(environmentId: string, signal?: AbortSignal): Promise<DiffFilesResult>;
  envDiffPatch(environmentId: string, paths: string[], signal?: AbortSignal): Promise<DiffPatchResult>;
  poolerToken(signal?: AbortSignal): Promise<string>;
}

export function sdkHost(bb: Pick<BbPluginApi, "sdk">, poolerPluginId: string): AdvisorHost {
  return {
    getThread: (threadId, signal) => bb.sdk.threads.get({ threadId, ...(signal ? { signal } : {}) }),
    listEvents: async (threadId, q, signal) =>
      (await bb.sdk.threads.events.list({
        threadId,
        ...(q.order ? { order: q.order } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.afterSeq ? { afterSeq: q.afterSeq } : {}),
        ...(q.beforeSeq ? { beforeSeq: q.beforeSeq } : {}),
        ...(q.types ? { types: q.types as any } : {}),
        ...(signal ? { signal } : {}),
      })) as unknown as EventRow[],
    listProjectThreads: (projectId, signal) =>
      bb.sdk.threads.list({ projectId, archived: false, includeHidden: true, limit: 200, ...(signal ? { signal } : {}) }),
    listRecentThreads: (limit) => bb.sdk.threads.list({ archived: false, limit }),
    envPath: async (environmentId, signal) => (await bb.sdk.environments.get({ environmentId, ...(signal ? { signal } : {}) })).path,
    envStatus: (environmentId, signal) => bb.sdk.environments.status({ environmentId, ...(signal ? { signal } : {}) }),
    envDiffFiles: (environmentId, signal) => bb.sdk.environments.diffFiles({ environmentId, target: "uncommitted", ...(signal ? { signal } : {}) }),
    envDiffPatch: (environmentId, paths, signal) =>
      bb.sdk.environments.diffPatch({ environmentId, paths, target: { type: "uncommitted" }, ...(signal ? { signal } : {}) }),
    poolerToken: async () => (await bb.sdk.plugins.token({ pluginId: poolerPluginId })).token,
  };
}

export const READ_DEADLINE_MS = 10_000;

/**
 * A 10-second deadline for one native read, also cut by the caller's signal. The parent must not
 * be long-lived: Node 22's AbortSignal.any records each composite on its sources and walks them all
 * whenever one is collected, so composites of the service signal stall the event loop (a tick
 * passes its own signal down instead).
 */
export function readSignal(parent?: AbortSignal, ms = READ_DEADLINE_MS): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, t]) : t;
}
