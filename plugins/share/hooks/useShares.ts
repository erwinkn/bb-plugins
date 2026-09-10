import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcCallArgs, PluginRpcValidationIssue } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { REALTIME_CHANNEL, type rpcContract, type Share, type Status } from "../lib/model";

type CreateInput = Omit<PluginRpcCallArgs<typeof rpcContract.share_create>[0], "threadId">;
export type SharePatch = Omit<PluginRpcCallArgs<typeof rpcContract.share_update>[0], "threadId" | "shareId">;
const FIELD_LABELS: Record<string, string> = {
  allowedEmails: "Allowed people", includeTools: "Include tool output",
  expiresAt: "Expiry", expiresInDays: "New link expiry", visibility: "Link visibility",
  threadId: "Thread", shareId: "Link",
};
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues)) {
    const details = error.issues.filter((issue): issue is PluginRpcValidationIssue =>
      typeof issue === "object" && issue !== null && typeof issue.message === "string",
    ).map(({ message, path }) => {
      if (!Array.isArray(path) || path.length === 0) return message;
      const [field, ...rest] = path;
      const label = FIELD_LABELS[String(field)] ?? String(field);
      const suffix = field === "allowedEmails" && typeof rest[0] === "number"
        ? ` (entry ${rest[0] + 1})` : rest.length ? `.${rest.join(".")}` : "";
      return `${label}${suffix}: ${message}`;
    });
    if (details.length) return details.join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

type ListRefresh = { promise: Promise<void>; trailing: Promise<void>; queued: boolean };

/** One mounted header owns this state. Old requests cannot update a new pane. */
export function useShares(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [shares, setShares] = useState<Share[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const listSequence = useRef(0);
  const statusSequence = useRef(0);
  const listRefresh = useRef<ListRefresh | null>(null);
  const realtimeTimer = useRef<number | null>(null);

  const refreshList = useCallback(function refreshList(): Promise<void> {
    if (!mounted.current) return Promise.resolve();
    if (realtimeTimer.current !== null) {
      window.clearTimeout(realtimeTimer.current);
      realtimeTimer.current = null;
    }
    const running = listRefresh.current;
    if (running) {
      running.queued = true;
      // Wait for the requested trailing read, not an unbounded stream of views.
      return running.promise.then(() => running.trailing);
    }
    const request: ListRefresh = { promise: Promise.resolve(), trailing: Promise.resolve(), queued: false };
    listRefresh.current = request;
    const sequence = ++listSequence.current;
    request.promise = (async () => {
      try {
        const result = await rpc.call("share_list", { threadId });
        if (!mounted.current || sequence !== listSequence.current) return;
        setShares(result.shares);
        setListError(null);
      } catch (error) {
        if (!mounted.current || sequence !== listSequence.current) return;
        setListError(messageOf(error));
        toast.error(messageOf(error));
      }
    })().finally(() => {
      if (listRefresh.current !== request) return;
      listRefresh.current = null;
      if (request.queued && mounted.current) request.trailing = refreshList();
    });
    return request.promise;
  }, [rpc, threadId]);

  const refreshStatus = useCallback(async () => {
    const sequence = ++statusSequence.current;
    try {
      const result = await rpc.call("share_status", {});
      if (!mounted.current || sequence !== statusSequence.current) return;
      setStatus(result);
      setStatusError(null);
    } catch (error) {
      if (!mounted.current || sequence !== statusSequence.current) return;
      setStatusError(messageOf(error));
      toast.error(messageOf(error));
    }
  }, [rpc]);

  const refresh = useCallback(() => Promise.all([refreshList(), refreshStatus()]), [refreshList, refreshStatus]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      listRefresh.current = null;
      if (realtimeTimer.current !== null) window.clearTimeout(realtimeTimer.current);
      realtimeTimer.current = null;
      ++listSequence.current;
      ++statusSequence.current;
    };
  }, [refresh]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (typeof payload === "object" && payload !== null && "threadId" in payload && payload.threadId === threadId) {
      if (listRefresh.current) {
        listRefresh.current.queued = true;
      } else if (realtimeTimer.current === null) {
        // The fixed contract has no count-only read for the closed header.
        // Batch views for 250 ms without postponing updates indefinitely.
        realtimeTimer.current = window.setTimeout(() => void refreshList(), 250);
      }
    }
  });
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const hasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected") {
      if (previousConnection.current !== "connected" && hasConnected.current) void refresh();
      hasConnected.current = true;
    }
    // A header mounted during an outage must also reconcile on recovery.
    if (connection === "reconnecting") hasConnected.current = true;
    previousConnection.current = connection;
  }, [connection, refresh]);

  // Expiry itself has no realtime signal. Reconcile at the nearest deadline.
  useEffect(() => {
    const deadlines = (shares ?? []).filter((share) => share.state === "active" && share.expiresAt !== null).map((share) => share.expiresAt!);
    if (deadlines.length === 0) return;
    const delay = Math.min(2_147_483_647, Math.max(1000, Math.min(...deadlines) - Date.now()));
    const timer = window.setTimeout(() => void refreshList(), delay);
    return () => window.clearTimeout(timer);
  }, [shares, refreshList]);

  const mutate = async (call: () => Promise<{ share: Share }>): Promise<boolean> => {
    if (mutating.current || !mounted.current) return false;
    mutating.current = true;
    setBusy(true);
    ++listSequence.current;
    let succeeded = false;
    try {
      const { share } = await call();
      succeeded = true;
      if (mounted.current) {
        ++listSequence.current;
        setShares((current) => [share, ...(current ?? []).filter((item) => item.id !== share.id)]);
      }
    } catch (error) {
      if (mounted.current) toast.error(messageOf(error));
    } finally {
      if (mounted.current) await refreshList();
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
    return succeeded;
  };

  return {
    shares, status, listError, statusError, busy, refresh,
    create: (input: CreateInput) => mutate(() => rpc.call("share_create", { ...input, threadId })),
    update: (shareId: string, patch: SharePatch) => mutate(() => rpc.call("share_update", { ...patch, threadId, shareId })),
    revoke: (shareId: string) => mutate(() => rpc.call("share_revoke", { threadId, shareId })),
  };
}

export type SharesController = ReturnType<typeof useShares>;
