import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  acquireFileSession,
  configureFileSessions,
  dirtyPaths,
  peekFileSession,
  sessionKeyFor,
  sessionsOverview,
  subscribeDirtyPaths,
  subscribeSessions,
  type FileSession,
  type FileSessionIo,
  type FileSessionSnapshot,
  type FileSessionSource,
  type ReloadOutcome,
  type SessionOverviewEntry,
  type SessionSeed,
} from "./file-session";
import { AUTO_SAVE_DELAY_MS, type EditorPrefs } from "./editor-options";

/** The plugin's `read` and `write` RPC as the session layer's transport. */
export function useFileSessionIo(): FileSessionIo {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo<FileSessionIo>(
    () => ({
      read: (input) => rpc.call("read", input),
      write: (input) => rpc.call("write", input),
    }),
    [rpc],
  );
}

export interface UseFileSessionOptions {
  source: FileSessionSource;
  /** Null shows no file; the hook then holds no session. */
  path: string | null;
  /** Content the caller already read, for example from the diff RPC. */
  seed?: SessionSeed | null;
}

export interface UseFileSession {
  session: FileSession | null;
  state: FileSessionSnapshot | null;
  /** This view's id. Pass it to the editor surface and to `setContent`. */
  viewId: string;
  /** This view may edit; another view is a read-only mirror. */
  isEditor: boolean;
  claimEditor: () => void;
  setContent: (text: string) => void;
  save: () => Promise<boolean>;
  overwrite: () => Promise<boolean>;
  reload: () => Promise<ReloadOutcome>;
  refresh: () => Promise<boolean>;
  restoreDraft: () => void;
  discardDraft: () => void;
}

const NO_OP = () => {};
const NEVER_CHANGES = () => NO_OP;

/**
 * The session for one file in one view. The session itself outlives the view,
 * so a draft survives an unmount of the panel body, and two views of one file
 * share the text, the dirty state and the save queue.
 */
export function useFileSession(options: UseFileSessionOptions): UseFileSession {
  const { source, path, seed = null } = options;
  const io = useFileSessionIo();
  const viewId = useId();
  const key = path === null ? null : sessionKeyFor(source, path);

  // Acquiring is idempotent: the registry returns the session for the key.
  const held = useRef<{ key: string; session: FileSession } | null>(null);
  if (key !== null && path !== null && (held.current?.key !== key || held.current.session.disposed)) {
    // Supply the first seed before attach starts a read. Supplying it only in
    // the later effect would arrive while that read is already in flight.
    held.current = {
      key,
      session: peekFileSession(source, path) ?? acquireFileSession({ source, path, io, seed }),
    };
  }
  const session = key === null ? null : (held.current?.session ?? null);

  useEffect(() => {
    if (session === null) return;
    session.setIo(io);
  }, [session, io]);

  useEffect(() => {
    if (session === null) return;
    return session.attach(viewId);
  }, [session, viewId]);

  const seedContent = seed?.content ?? null;
  const seedSha = seed?.sha256 ?? null;
  useEffect(() => {
    if (session === null || seed === null || seedContent === null || seedSha === null) return;
    session.seed(seed);
    // The seed's identity changes with each render of the caller; its content
    // and hash are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, seedContent, seedSha]);

  const subscribe = useCallback(
    (listener: () => void) => (session === null ? NO_OP : session.subscribe(listener)),
    [session],
  );
  const read = useCallback(() => session?.getSnapshot() ?? null, [session]);
  const state = useSyncExternalStore(session === null ? NEVER_CHANGES : subscribe, read, read);

  const isEditor = state !== null && (state.editorId === null || state.editorId === viewId);
  return {
    session,
    state,
    viewId,
    isEditor,
    claimEditor: useCallback(() => session?.claimEditor(viewId), [session, viewId]),
    setContent: useCallback((text: string) => session?.setContent(text, viewId), [session, viewId]),
    save: useCallback(() => session?.save() ?? Promise.resolve(false), [session]),
    overwrite: useCallback(() => session?.overwrite() ?? Promise.resolve(false), [session]),
    reload: useCallback(
      () => session?.reload() ?? Promise.resolve<ReloadOutcome>({ ok: false, reason: "error", message: "No file" }),
      [session],
    ),
    refresh: useCallback(() => session?.refresh() ?? Promise.resolve(false), [session]),
    restoreDraft: useCallback(() => session?.restoreDraft(), [session]),
    discardDraft: useCallback(() => session?.discardDraft(), [session]),
  };
}

/** The paths with unsaved work in one workspace, for a file list marker. */
export function useDirtyPaths(source: FileSessionSource): ReadonlySet<string> {
  const prefix = sessionKeyFor(source, "");
  const [paths, setPaths] = useState<ReadonlySet<string>>(() => dirtyPaths(source));
  useEffect(
    () => subscribeDirtyPaths(source, setPaths),
    // The prefix is the workspace identity; the source object is rebuilt often.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefix],
  );
  return paths;
}

/**
 * Applies the auto-save preference to the session layer. The save timer lives
 * in the sessions, not in any view, so a pending write outlives the pane that
 * scheduled it. Call once per mounted workbench; re-applying is idempotent.
 */
export function useSessionConfig(prefs: EditorPrefs): void {
  useEffect(() => {
    configureFileSessions({
      // "onBlur" needs no session timer: leaving the editor flushes anyway.
      autoSave: prefs.autoSave === "afterDelay" ? "afterDelay" : "off",
      autoSaveDelayMs: AUTO_SAVE_DELAY_MS,
      retryFailedSaves: true,
    });
  }, [prefs.autoSave]);
}

/**
 * Every file with unsaved work or a failed save, whichever tab holds it. The
 * registry is shared, so the indicator a workbench draws covers sessions
 * whose panes are not mounted.
 */
export function useSessionsOverview(): SessionOverviewEntry[] {
  const [entries, setEntries] = useState<SessionOverviewEntry[]>(() => sessionsOverview());
  useEffect(() => subscribeSessions(() => setEntries(sessionsOverview())), []);
  return entries;
}
