import { useCallback, useRef, useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectModeContract } from "./project-mode-contract";
import type { ProjectOrderDoc } from "./project-order-schema";

interface PendingOrder {
  /**
   * The visible-id order the user last asked for. Kept as a bare user intent:
   * ids the doc does not know stay in the sequence (a save resubmits them)
   * and ids the doc gains appear through the merged display order.
   */
  order: string[];
  /** The doc revision that order was built against. */
  baseRevision: number;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The subset of `doc` holding only ids `intent` names, in doc order. */
const realizedOrder = (doc: ProjectOrderDoc, intent: readonly string[]) => {
  const wanted = new Set(intent);
  return doc.order.filter((id) => wanted.has(id));
};

/**
 * The shown order while an intent is pending: the user's sequence verbatim —
 * an id the doc has not synced yet (a fresh project whose save failed) keeps
 * its requested slot — followed by ids the doc gained since (a foreign sync's
 * new projects land at the end, matching the store's own append rule). Ids
 * the tree no longer lists are filtered out when rows render.
 */
const displayOrder = (
  intent: readonly string[],
  doc: ProjectOrderDoc | null,
): string[] => {
  if (!doc) return [...intent];
  const inIntent = new Set(intent);
  return [
    ...intent,
    ...doc.order.filter((id) => !inIntent.has(id)),
  ];
};

export interface ProjectOrderState {
  /**
   * Effective id order for the flat list: the pending order merged over the
   * latest doc while an unsaved or previewed move exists, else the latest
   * acknowledged document. Null until the first projectMode read answers.
   */
  order: string[] | null;
  /** The last failed save or unreadable store's message; kept until a save lands or is dismissed. */
  error: string | null;
  /**
   * Feed the `order`/`orderError` fields of a projectMode snapshot or realtime
   * update. Out-of-order snapshots drop by revision; a surviving pending
   * order retries its save.
   */
  applySnapshot: (
    doc: ProjectOrderDoc | null,
    readError?: string | null,
  ) => void;
  /** Commit a new displayed order; saves run serialized and coalesce. */
  commit: (order: string[]) => void;
  dismissError: () => void;
}

/**
 * Sidebar-side view of the persisted Initiatives order. The doc arrives with
 * every projectMode read and on the order realtime channel; out-of-order
 * snapshots are dropped by revision. A committed order applies optimistically
 * and survives a failed save, the acknowledgement of an earlier save, foreign
 * writes, and reads that append new projects — each newer doc rebases the
 * intent so the queued save chains onto it. Only a doc that already realizes
 * the intent, or a successful save whose reply shows the store could not keep
 * it, settles the pending order.
 */
export function useProjectOrder(
  api: PluginRpcClient<typeof projectModeContract>,
): ProjectOrderState {
  const [doc, setDoc] = useState<ProjectOrderDoc | null>(null);
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<ProjectOrderDoc | null>(null);
  const pendingRef = useRef<PendingOrder | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  const setPendingOrder = useCallback((next: PendingOrder | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const applyDoc = useCallback(
    (next: ProjectOrderDoc) => {
      const current = docRef.current;
      if (current && next.revision <= current.revision) return;
      docRef.current = next;
      setDoc(next);
      const intent = pendingRef.current;
      if (!intent) return;
      // Realized when the doc's sequence over the intent's ids already reads
      // as the intent — remembered absent ids interleaved by the store's
      // merge do not block this.
      if (sameIds(realizedOrder(next, intent.order), intent.order)) {
        setError(null);
        setPendingOrder(null);
        return;
      }
      // Not realized: an earlier save's acknowledgement, a foreign write, or
      // a sync that appended new ids. The pending order survives — rebased so
      // its queued save chains onto this revision.
      if (next.revision !== intent.baseRevision)
        setPendingOrder({ order: intent.order, baseRevision: next.revision });
    },
    [setPendingOrder],
  );

  const flush = useCallback(() => {
    // One save at a time so expectedRevision chains correctly; each run saves
    // the latest intent, so rapid moves coalesce.
    saveQueue.current = saveQueue.current.then(async () => {
      const intent = pendingRef.current;
      if (!intent) return;
      const base = docRef.current;
      try {
        const saved = await api.call("saveProjectOrder", {
          expectedRevision: base?.revision ?? 0,
          order: intent.order,
        });
        // A reply older than an already-observed doc changes nothing — the
        // newer doc stands and any pending intent keeps its rebased save.
        const fresh =
          !docRef.current || saved.revision > docRef.current.revision;
        if (!fresh) return;
        applyDoc(saved);
        const remaining = pendingRef.current;
        if (!remaining) return;
        if (remaining.order === intent.order || sameIds(remaining.order, intent.order)) {
          // This reply answers that intent: the store kept a different
          // sequence (a merged or capped write), which is authoritative.
          setPendingOrder(null);
          setError(null);
          return;
        }
        // A newer intent superseded this write mid-flight; save it next.
        flush();
      } catch (cause) {
        // Re-read so a foreign order can rebase the pending one, then surface
        // the failure; a still-pending order retries on the next read.
        try {
          const fresh = await api.call("projectMode", null);
          if (fresh.order) applyDoc(fresh.order);
        } catch {
          /* Still unreachable; the next refresh retries. */
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, [api, applyDoc, setPendingOrder]);

  const applySnapshot = useCallback(
    (snapshot: ProjectOrderDoc | null, readError?: string | null) => {
      if (readError) setError(readError);
      if (!snapshot) return;
      applyDoc(snapshot);
      // A pending order outlives a failed save; retry it on each fresh read.
      if (pendingRef.current) flush();
    },
    [applyDoc, flush],
  );

  const commit = useCallback(
    (order: string[]) => {
      setPendingOrder({
        order,
        baseRevision: docRef.current?.revision ?? 0,
      });
      flush();
    },
    [setPendingOrder, flush],
  );

  return {
    order: pending ? displayOrder(pending.order, doc) : (doc?.order ?? null),
    error,
    applySnapshot,
    commit,
    dismissError: useCallback(() => setError(null), []),
  };
}
