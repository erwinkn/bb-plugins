import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { snoozeContract } from "./snooze-contract";
import { EMPTY_SNOOZE_PRESETS, type SnoozePresetsDoc } from "./snooze-presets";
import { EMPTY_SNOOZES, snoozeDocSchema, type SnoozeDoc } from "./snooze-schema";
import { applyDoc, queryKeys, snoozePresetsQuery, snoozesQuery } from "./queries";

export interface SyncedDocState<Doc> {
  doc: Doc;
  /** `loading` and `error` only apply while no document is known at all. */
  status: "loading" | "ready" | "error";
  error: string | null;
  refresh: () => void;
}

// One revisioned KV document served over RPC and pushed over realtime
// (QuerySync applies the pushed documents).
function useSyncedDoc<Doc>(
  query: ReturnType<typeof useQuery<Doc, Error, Doc>>,
  empty: Doc,
): SyncedDocState<Doc> {
  const { data, error, refetch } = query;
  return {
    doc: data ?? empty,
    status: data ? "ready" : error ? "error" : "loading",
    error: data ? null : (error?.message ?? null),
    refresh: () => void refetch(),
  };
}

export function useSnooze(): SyncedDocState<SnoozeDoc> {
  const rpc = useRpc<typeof snoozeContract>();
  return useSyncedDoc(useQuery(snoozesQuery(rpc)), EMPTY_SNOOZES);
}
export function useSnoozePresets(): SyncedDocState<SnoozePresetsDoc> {
  const rpc = useRpc<typeof snoozeContract>();
  return useSyncedDoc(useQuery(snoozePresetsQuery(rpc)), EMPTY_SNOOZE_PRESETS);
}

export type SnoozeChange =
  | { action: "snooze"; threadId: string; until: number }
  | { action: "unsnooze" | "acknowledge"; threadId: string };

/**
 * Snoozes, unsnoozes or acknowledges a thread. Each write answers the stored
 * document, which applies at once instead of after the realtime signal.
 */
export function useSnoozeChange(onError: (error: unknown) => void) {
  const rpc = useRpc<typeof snoozeContract>();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: SnoozeChange) =>
      change.action === "snooze"
        ? rpc.call("snooze", { threadId: change.threadId, until: change.until })
        : rpc.call(change.action, { threadId: change.threadId }),
    onSuccess: (doc) => {
      const parsed = snoozeDocSchema.safeParse(doc);
      if (parsed.success) applyDoc(client, queryKeys.snoozes, parsed.data);
    },
    onError,
  }).mutate;
}
