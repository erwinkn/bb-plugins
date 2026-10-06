/**
 * The workspace a panel tab inspects.
 *
 * `targetThreadId` rides in the tab's persisted params; the picker's choice
 * applies at once in session state and is persisted by rewriting the tab's
 * `paramsJson` through the `setPanelTarget` RPC. A persisted target that
 * stops resolving stays selected and reported — it never silently falls
 * back to the panel's own thread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { paramsWithTarget, sameJson, targetThreadParam } from "./panel-target";
import { flushDirtySessions, NO_SOURCE, parkDirtySessions, type FileSessionSource } from "./file-session";
import { useDirtyPaths } from "./use-file-session";
import type { WorkspaceEntry } from "./workspace-entries";

export type { WorkspaceEntry };

export interface WorkspacesState {
  kind: "loading" | "error" | "ready";
  message: string | null;
  coordinatorThreadId: string | null;
  /** Whether Initiatives named the entries; false rows are native fallbacks. */
  named: boolean;
  /** Set when Initiatives ran but its tree could not be read. */
  degraded: string | null;
  entries: readonly WorkspaceEntry[];
}

const LOADING: WorkspacesState = { kind: "loading", message: null, coordinatorThreadId: null, named: false, degraded: null, entries: [] };

/** The coordinator's own threads plus the panel's, resolved for the picker. */
export function useWorkspaces(threadId: string): WorkspacesState & { refresh: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<WorkspacesState>(LOADING);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("workspaces", { threadId })
      .then((result) => {
        if (cancelled) return;
        setState((current) => {
          // A degraded answer only knows the native fallback list — the
          // exact tree rows it cannot prove (cross-repository or adopted
          // members) stay listed until a healthy tree replaces membership.
          const retained =
            result.degraded !== null
              ? current.entries.filter((entry) => !result.entries.some((fresh) => fresh.threadId === entry.threadId))
              : [];
          return {
            kind: "ready",
            message: null,
            coordinatorThreadId: result.coordinatorThreadId,
            named: result.named,
            degraded: result.degraded,
            entries: [...result.entries, ...retained],
          };
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A failed refresh keeps the last good list — the entries were true
        // moments ago and the selected row must not vanish under an error
        // banner. The message marks the state as stale evidence.
        setState((current) => ({
          kind: "error",
          message: error instanceof Error ? error.message : "The workspace list could not be loaded",
          coordinatorThreadId: current.coordinatorThreadId,
          named: current.named,
          degraded: current.degraded,
          entries: current.entries,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, nonce]);
  return { ...state, refresh };
}

export interface PanelTarget {
  /** The thread whose workspace this tab inspects. */
  targetThreadId: string;
  /** True when the inspected workspace belongs to another thread. */
  foreign: boolean;
  /**
   * Point this tab at another thread's workspace. Applies immediately;
   * persistence is attempted in the background and reported, never assumed.
   */
  switchTarget: (nextThreadId: string) => void;
}

/**
 * The issued/receipt ledger. Params props arrive unordered — BB may deliver
 * an older tab state after a newer one — so the hook cannot trust a changed
 * prop on its own. Each pick records the params it persisted; the latest
 * positively confirmed state (our write, or external params we accepted)
 * carries the newest confirmed sequence.
 *
 * A prop naming a target a confirmed pick superseded is judged by content,
 * not by target alone: byte-identical to the superseded receipt means it is
 * that old state echoing back — suppressed, then revalidated through the
 * tabs record via an identity `setPanelTarget` write (persisted means the
 * tab really holds it; a decline answers the tab's actual params). Params
 * the ledger has never persisted are new evidence — a genuine navigation
 * back carries them and is adopted at once. A tab that cannot be read
 * safely keeps the prop suppressed.
 */
interface PickLedger {
  seq: number;
  /** This mount's picks, oldest first; pending until their rpc settles. */
  issued: { seq: number; target: string; pending: boolean; params?: unknown }[];
  /** Target of the newest positive receipt. */
  confirmedTarget: string;
  /** Ledger position the confirmed target holds. */
  confirmedSeq: number;
}

export function usePanelTarget(ownThreadId: string, params: unknown, actionId: "files" | "changes"): PanelTarget {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState<string>(() => targetThreadParam(params) ?? ownThreadId);
  // The params prop changes when the persisted rewrite lands (a remount) or
  // when another source rewrites this tab; a foreign param wins, like a link.
  const lastSeenParams = useRef(params);
  /** The params matching the newest positive receipt — the chain's expected. */
  const openedParams = useRef(params);
  const ledger = useRef<PickLedger>({
    seq: 0,
    issued: [],
    confirmedTarget: targetThreadParam(params) ?? ownThreadId,
    confirmedSeq: 0,
  });
  /** The newest ambiguous prop awaiting tab-record revalidation. */
  const revalidation = useRef<{ params: unknown; seqAtProp: number } | null>(null);
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    // Params objects are rebuilt as props; only a real change counts, or an
    // equal-but-new object would retarget the panel out from under a pick.
    if (sameJson(lastSeenParams.current, params)) return;
    lastSeenParams.current = params;
    const book = ledger.current;
    const propTarget = targetThreadParam(params) ?? ownThreadId;
    // The newest pick to name this target — an older duplicate is not it.
    const prior = [...book.issued].reverse().find((entry) => entry.target === propTarget);
    const pending = book.issued.some((entry) => entry.pending);
    if (pending && propTarget !== book.issued.at(-1)?.target) {
      // An older echo while a newer pick is still in flight: it cannot say
      // what the tab holds now, so neither state nor receipt moves.
      return;
    }
    if (
      !pending &&
      prior !== undefined &&
      prior.seq < book.confirmedSeq &&
      prior.params !== undefined &&
      sameJson(prior.params, params)
    ) {
      // Byte-identical to a superseded receipt: either that old state is
      // echoing late, or something navigated back to it exactly. Revalidate
      // against the tabs record — an identity write persists only when the
      // tab really holds these params — but the visible state stays put
      // until the record answers.
      const request = { params, seqAtProp: book.seq };
      revalidation.current = request;
      persistQueue.current = persistQueue.current.then(async () => {
        if (revalidation.current !== request) return; // a newer prop superseded it
        try {
          const result = await rpc.call("setPanelTarget", {
            threadId: ownThreadId,
            actionId,
            expectedParams: params,
            params,
          });
          if (revalidation.current !== request) return; // superseded in flight
          revalidation.current = null;
          const adoptedParams = result.persisted ? params : result.currentParams;
          // Unreadable, missing or ambiguous tabs give no evidence — the
          // prop stays suppressed and nothing changes.
          if (adoptedParams === undefined) return;
          const book2 = ledger.current;
          // Another pick after the prop still reconciles bookkeeping — the
          // queued pick needs the true expected — but must not steal the
          // visible target back from it.
          const safeToShow = book2.seq === request.seqAtProp;
          openedParams.current = adoptedParams;
          book2.confirmedTarget = targetThreadParam(adoptedParams) ?? ownThreadId;
          book2.confirmedSeq = ++book2.seq;
          if (safeToShow) setTarget(book2.confirmedTarget);
        } catch {
          // An unreachable tab answers nothing; the prop stays suppressed.
          if (revalidation.current === request) revalidation.current = null;
        }
      });
      return;
    }
    // The confirmed write's own echo, or genuine external navigation: the
    // params are what the tab holds, so the receipt and target follow them.
    openedParams.current = params;
    book.confirmedTarget = propTarget;
    book.confirmedSeq = prior !== undefined ? prior.seq : (book.seq += 1);
    if (prior !== undefined) prior.pending = false;
    setTarget((current) => (current === propTarget ? current : propTarget));
  }, [params, ownThreadId, rpc, actionId]);

  const switchTarget = useCallback(
    (nextThreadId: string) => {
      setTarget(nextThreadId);
      const book = ledger.current;
      const entry: PickLedger["issued"][number] = { seq: ++book.seq, target: nextThreadId, pending: true };
      book.issued.push(entry);
      persistQueue.current = persistQueue.current.then(async () => {
        // The expected state is read inside the step, from the last positive
        // receipt — not captured when the user clicked. Rapid picks then
        // chain target→target, so an earlier pick's expected can never be
        // written over a newer persisted target, and the last pick wins.
        try {
          const expected = openedParams.current;
          const nextParams = paramsWithTarget(expected, ownThreadId, nextThreadId);
          if (sameJson(nextParams, expected)) {
            // The tab already holds it — that is the pick's receipt.
            entry.params = nextParams;
            return;
          }
          const result = await rpc.call("setPanelTarget", {
            threadId: ownThreadId,
            actionId,
            expectedParams: expected,
            params: nextParams,
          });
          if (result.persisted) {
            // The params this pick left the tab holding — a later props
            // delivery identical to them is that receipt echoing back.
            entry.params = nextParams;
            openedParams.current = nextParams;
            book.confirmedTarget = nextThreadId;
            book.confirmedSeq = entry.seq;
          } else {
            // A decline can carry the tab's real params: adopt them so the
            // next pick chains from the server's truth instead of declining
            // again on a receipt a stale echo moved.
            if (result.currentParams !== undefined) openedParams.current = result.currentParams;
            if (result.reason !== null) toast.info(result.reason);
          }
        } catch (error: unknown) {
          toast.info(`The workspace target applies to this session only: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          entry.pending = false;
        }
      });
    },
    [rpc, ownThreadId, actionId],
  );

  return useMemo(
    () => ({ targetThreadId: target, foreign: target !== ownThreadId, switchTarget }),
    [target, ownThreadId, switchTarget],
  );
}

/** A switch waits at most this long for in-flight writes before moving on. */
const SWITCH_FLUSH_MS = 1500;

export interface GuardedSwitch {
  /** Ask to inspect `entry`. A dirty manual-mode buffer pauses behind `confirm`. */
  requestSwitch: (entry: { threadId: string; label: string }) => void;
  /** Set when the user must decide what happens to unsaved work first. */
  confirm: {
    label: string;
    saveAndSwitch: () => void;
    keepAndSwitch: () => void;
    cancel: () => void;
  } | null;
}

/**
 * Dirty-state guard for a workspace switch. Auto-saving modes flush the
 * current workspace's dirty files first; manual mode asks — save, or park
 * the buffers unsaved (sessions and drafts survive a remount untouched).
 * Either way a switch never mixes content or writes another worktree's file.
 */
export function useGuardedSwitch(
  source: FileSessionSource | null,
  autoSave: "off" | "onBlur" | "afterDelay",
  switchTarget: (threadId: string) => void,
): GuardedSwitch {
  const dirty = useDirtyPaths(source ?? NO_SOURCE);
  const [pending, setPending] = useState<{ threadId: string; label: string } | null>(null);
  const apply = useCallback(
    (threadId: string) => {
      setPending(null);
      switchTarget(threadId);
    },
    [switchTarget],
  );
  const requestSwitch = useCallback(
    (entry: { threadId: string; label: string }) => {
      if (source !== null && dirty.size > 0 && autoSave === "off") {
        setPending({ threadId: entry.threadId, label: entry.label });
        return;
      }
      if (source !== null) void flushDirtySessions({ source, timeoutMs: SWITCH_FLUSH_MS }).then(() => apply(entry.threadId));
      else apply(entry.threadId);
    },
    [source, dirty, autoSave, apply],
  );
  const confirm = useMemo(
    () =>
      pending === null
        ? null
        : {
            label: pending.label,
            saveAndSwitch: () => {
              const flush =
                source === null ? Promise.resolve() : flushDirtySessions({ source, timeoutMs: SWITCH_FLUSH_MS });
              void flush.then(() => apply(pending.threadId));
            },
            keepAndSwitch: () => {
              if (source !== null) parkDirtySessions(source);
              apply(pending.threadId);
            },
            cancel: () => setPending(null),
          },
    [pending, source, apply],
  );
  return { requestSwitch, confirm };
}
