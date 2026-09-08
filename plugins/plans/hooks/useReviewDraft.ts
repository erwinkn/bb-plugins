import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearDraft,
  EMPTY_DRAFT,
  isDraftEmpty,
  readDraft,
  writeDraft,
  type ReviewDraft,
} from "../lib/draft-store";

const SAVE_DELAY_MS = 250;

export interface ReviewDraftState {
  draft: ReviewDraft;
  /** True after a write actually failed; the UI says so only then. */
  persistFailed: boolean;
  update: (patch: Partial<ReviewDraft> | ((current: ReviewDraft) => ReviewDraft)) => void;
  reset: () => void;
}

/** localStorage-backed draft for one plan version, written on a short debounce. */
export function useReviewDraft(planId: string, versionId: string): ReviewDraftState {
  const [draft, setDraft] = useState<ReviewDraft>(() => readDraft(planId, versionId));
  const [persistFailed, setPersistFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ planId: string; versionId: string; draft: ReviewDraft } | null>(null);
  const keyRef = useRef({ planId, versionId });

  // Write whatever is still debounced, now. Called on key change, unmount,
  // and when the page hides, so a quick navigation never drops text.
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    const ok = writeDraft(pending.planId, pending.versionId, pending.draft);
    // An empty draft that fails to clear is harmless; only report lost text.
    setPersistFailed(!ok && !isDraftEmpty(pending.draft));
  }, []);

  useEffect(() => {
    flush();
    keyRef.current = { planId, versionId };
    setDraft(readDraft(planId, versionId));
    setPersistFailed(false);
  }, [flush, planId, versionId]);

  const update = useCallback<ReviewDraftState["update"]>(
    (patch) => {
      setDraft((current) => {
        const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
        pendingRef.current = { ...keyRef.current, draft: next };
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, SAVE_DELAY_MS);
        return next;
      });
    },
    [flush],
  );

  const reset = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    clearDraft(keyRef.current.planId, keyRef.current.versionId);
    setDraft(EMPTY_DRAFT);
    setPersistFailed(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  return { draft, persistFailed, update, reset };
}
