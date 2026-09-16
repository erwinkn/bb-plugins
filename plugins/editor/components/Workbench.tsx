import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { toast } from "sonner";
import { experimental_useCodeTheme, useBbNavigate, useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { mergeListing, pathWithinRoot, sameEntries, splitPath, type FlatEntry } from "@/lib/file-tree";
import { useElementWidth } from "@/lib/use-element-width";
import type { EditorPrefs } from "@/lib/editor-options";
import {
  clampTreeWidth,
  readLastFile,
  readTreeOpen,
  readTreeWidth,
  storeLastFile,
  storeTreeOpen,
  storeTreeWidth,
} from "@/lib/layout-storage";
import { cn } from "@/lib/utils";
import { EditorPane, NoticeAction, NoticeRow, type EditorPaneHandle, type SetPref } from "./EditorPane";
import { SaveStatusBar } from "./SaveStatusBar";
import { FileTree, type CreateKind } from "./FileTree";
import { QuickOpen } from "./QuickOpen";
import { ResizeHandle } from "./ResizeHandle";
import { ThemePicker } from "./ThemePicker";
import { themeNameFor } from "@/lib/themes";
import { FolderIcon, SidebarLeftGlyph, SidebarRightGlyph } from "./icons";
import { useFileWatch, type FileChange } from "@/lib/file-watch";
import { previewKind } from "@/lib/file-preview";
import { flushDirtySessions } from "@/lib/file-session";
import { useSessionConfig, useSessionsOverview } from "@/lib/use-file-session";
import { useEditorTelemetry } from "@/lib/client-log";

export type Surface = "opener" | "panel";

export interface WorkbenchProps {
  surface: Surface;
  source: PluginFileOpenerSource;
  /** Workspace-relative path to show first; null shows the empty state. */
  initialPath: string | null;
  /** Stable key for per-workspace memory (last file). */
  workspaceKey: string;
  label: string;
  prefs: EditorPrefs;
  /** Optimistic preference write; the settings store confirms it. */
  onSetPref: SetPref;
  Original?: ComponentType;
}

interface TreeState {
  entries: readonly FlatEntry[];
  root: string;
  isLoading: boolean;
  error: string | null;
}

const EMPTY_TREE: TreeState = { entries: [], root: "", isLoading: false, error: null };

/** A file to show, and how it reaches history: recorded as new, or reached by Back/Forward at `historyIndex`. */
interface PendingNavigation {
  path: string;
  record: boolean;
  historyIndex: number | null;
}
const COMPACT_BREAKPOINT_PX = 420;
const HISTORY_LIMIT = 50;
/** Navigation waits at most this long for in-flight writes before switching files. */
const NAVIGATE_FLUSH_MS = 1500;
/** How long a change notice may still be the echo of our own mutation. */
const MUTATION_ECHO_WINDOW_MS = 2000;

export function Workbench({ surface, source, initialPath, workspaceKey, label, prefs, onSetPref, Original }: WorkbenchProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const paneId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<EditorPaneHandle | null>(null);

  const firstPath = initialPath ?? (surface === "panel" ? readLastFile(workspaceKey) : null);
  const [activePath, setActivePath] = useState<string | null>(firstPath);
  const [history, setHistory] = useState<{ paths: string[]; index: number }>(() => ({
    paths: firstPath === null ? [] : [firstPath],
    index: firstPath === null ? -1 : 0,
  }));
  const [pendingOpen, setPendingOpen] = useState<PendingNavigation | null>(null);
  const pendingRef = useRef(pendingOpen);
  pendingRef.current = pendingOpen;
  const [treeOpen, setTreeOpen] = useState(() => readTreeOpen(surface));
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
  const width = useElementWidth(rootRef);
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const entriesRef = useRef<readonly FlatEntry[]>(EMPTY_TREE.entries);
  entriesRef.current = tree.entries;
  const [quickOpen, setQuickOpen] = useState(false);
  const [themePicker, setThemePicker] = useState<{ current: string | null } | null>(null);
  const [themePreview, setThemePreview] = useState<string | null>(null);
  const bbTheme = experimental_useCodeTheme();
  const openThemePicker = useCallback(() => {
    setThemePicker({ current: null });
    rpc
      .call("theme", null)
      .then((theme) => setThemePicker((state) => (state === null ? null : { current: theme.pair })))
      .catch((error: unknown) => console.warn("[editor] could not read BB's theme", error));
  }, [rpc]);
  const [focusNonce, setFocusNonce] = useState(0);
  const treeRequested = useRef(false);

  // The save scheduler and the retry timers live in the shared sessions;
  // this workbench only applies the preference and wires the plugin log.
  useSessionConfig(prefs);
  useEditorTelemetry(() => ({
    phase: surface === "opener" ? "file-opener" : "files-panel",
    path: activePath ?? undefined,
    sourceKind: source.kind,
    host: source.experimental_hostId ?? undefined,
  }));
  // The panel closing or a thread switch must not take pending writes down.
  useEffect(() => () => void flushDirtySessions({ reason: "workbench-unmount" }), []);
  const sessionOverview = useSessionsOverview();

  const show = useCallback((path: string, options: { record: boolean }) => {
    setActivePath(path);
    setFocusNonce((nonce) => nonce + 1);
    if (!options.record) return;
    setHistory((current) => {
      const paths = [...current.paths.slice(0, current.index + 1), path].slice(-HISTORY_LIMIT);
      return { paths, index: paths.length - 1 };
    });
  }, []);

  // The first path is already open (initial state); later ones are files BB
  // opened into this tab, which go through the unsaved-changes guard.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (initialPath !== null) setFocusNonce((nonce) => nonce + 1);
      return;
    }
    if (initialPath !== null) guardedShow(initialPath, { record: true });
    // Only external path changes re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  useEffect(() => {
    if (surface === "panel") storeLastFile(workspaceKey, activePath);
  }, [activePath, surface, workspaceKey]);

  const compact = width > 0 && width < COMPACT_BREAKPOINT_PX;
  const effectiveTreeWidth = compact ? width : clampTreeWidth(treeWidth, width || Number.POSITIVE_INFINITY);
  // Quick open's empty-query list: where the user was, latest first.
  const recentPaths = useMemo(() => [...new Set([...history.paths].reverse())], [history]);

  // Directory listings load on expand; one request per path until it lands.
  const listingRequests = useRef(new Set<string>());
  // A refresh starts a new generation; in-flight results from before it are dropped.
  const treeGeneration = useRef(0);
  /**
   * Resolves true when a listing was applied. A quiet reload happens in the
   * background — no spinner, and a failure toasts rather than replacing the
   * tree with an error. Either way the response merges into the entries the
   * tree has, so levels a reload does not cover stay on screen.
   */
  const loadTree = useCallback(
    (options?: { quiet?: boolean }) => {
      treeGeneration.current += 1;
      const generation = treeGeneration.current;
      listingRequests.current.clear();
      const quiet = options?.quiet === true;
      if (!quiet) setTree((current) => ({ ...current, isLoading: true, error: null }));
      return rpc
        .call("tree", { source })
        .then((result) => {
          if (generation !== treeGeneration.current) return false;
          setTree((current) => {
            const entries = mergeListing(current.entries, "", result.entries);
            // An identical merge leaves the tree untouched — no re-render.
            if (current.root === result.root && current.error === null && sameEntries(current.entries, entries)) {
              return current.isLoading ? { ...current, isLoading: false } : current;
            }
            return { entries, root: result.root, isLoading: false, error: null };
          });
          return true;
        })
        .catch((error: unknown) => {
          if (generation !== treeGeneration.current) return false;
          const message = error instanceof Error ? error.message : "Could not list files";
          if (quiet) {
            setTree((current) =>
              current.entries.length === 0 ? { ...current, isLoading: false, error: message } : { ...current, isLoading: false },
            );
            toast.error(message);
            return false;
          }
          treeRequested.current = false;
          setTree({ ...EMPTY_TREE, error: message });
          return false;
        });
    },
    [rpc, source],
  );

  const loadDirectory = useCallback(
    (subpath: string) => {
      if (listingRequests.current.has(subpath)) return;
      listingRequests.current.add(subpath);
      const generation = treeGeneration.current;
      rpc
        .call("tree", { source, subpath })
        .then((result) => {
          if (generation !== treeGeneration.current) return;
          setTree((current) => ({ ...current, entries: mergeListing(current.entries, subpath, result.entries) }));
        })
        .catch((error: unknown) => {
          if (generation !== treeGeneration.current) return;
          listingRequests.current.delete(subpath);
          toast.error(error instanceof Error ? error.message : `Could not list ${subpath}`);
        });
    },
    [rpc, source],
  );

  // A file that appeared or went away changes the tree; an edit does not.
  // The open files themselves are re-read by the watch hook.
  const treeReload = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The batched change notices waiting for the debounce. */
  const pendingNotice = useRef<{ rescan: boolean; changes: FileChange[] }>({ rescan: false, changes: [] });
  /** Paths a mutation of ours just rewrote; the watcher's echo of them must not reload the tree again. */
  const ownMutations = useRef(new Map<string, number>());
  const noteOwnMutation = useCallback((paths: readonly string[]) => {
    const now = Date.now();
    for (const path of paths) ownMutations.current.set(path, now);
  }, []);
  const isOwnMutationEcho = useCallback((changedPath: string): boolean => {
    const normalized = changedPath.replace(/\\/g, "/");
    const now = Date.now();
    for (const [mutated, at] of ownMutations.current) {
      if (now - at > MUTATION_ECHO_WINDOW_MS) {
        ownMutations.current.delete(mutated);
        continue;
      }
      // Only the path the mutation itself rewrote echoes back; a change
      // below it in the window is something else and must still reload.
      if (normalized === mutated) return true;
    }
    return false;
  }, []);
  useFileWatch(source, (event) => {
    if (!treeRequested.current) return;
    if (event.kind === "changed" && event.changes.every((change) => change.type === "update")) return;
    if (event.kind === "rescan") pendingNotice.current.rescan = true;
    else pendingNotice.current.changes.push(...event.changes);
    if (treeReload.current !== null) clearTimeout(treeReload.current);
    treeReload.current = setTimeout(() => {
      treeReload.current = null;
      const notice = pendingNotice.current;
      pendingNotice.current = { rescan: false, changes: [] };
      // A notice that only echoes our own just-applied mutations is already
      // reflected in the tree; a rescan always reloads.
      if (!notice.rescan && notice.changes.length > 0 && notice.changes.every((change) => isOwnMutationEcho(change.path))) return;
      void loadTree({ quiet: true });
      // The root listing covers only the top level, so a directory the tree
      // holds that a change landed in is relisted too — a rescan, which lost
      // the detail, relists them all. One a delete in this batch covers is
      // gone; skip it.
      const listed = new Set<string>();
      for (const entry of entriesRef.current) if (entry.kind === "directory" && entry.deferred !== true) listed.add(entry.path);
      const deleted = notice.changes.filter((change) => change.type === "delete").map((change) => change.path.replace(/\\/g, "/"));
      const affected = notice.rescan
        ? listed
        : new Set(notice.changes.map((change) => splitPath(change.path.replace(/\\/g, "/")).directory));
      for (const dir of affected) {
        if (dir === "" || !listed.has(dir) || deleted.some((gone) => dir === gone || dir.startsWith(`${gone}/`))) continue;
        loadDirectory(dir);
      }
    }, 300);
  });

  useEffect(() => {
    if (!treeOpen || treeRequested.current) return;
    treeRequested.current = true;
    void loadTree();
  }, [treeOpen, loadTree]);

  // The open file's place in the tree: a path under the root as a
  // workspace-relative path; null for a file outside it, which the tree
  // does not reveal or select.
  const treePath = useMemo(
    () => (activePath === null ? null : pathWithinRoot(tree.root, activePath)),
    [activePath, tree.root],
  );

  const openInTab = useCallback(
    (path: string) => {
      if (source.kind !== "workspace" || source.environmentId === null) return false;
      // The preview target is workspace-relative: an absolute path inside
      // the root maps to it, and one outside it stays in this pane.
      const relative = pathWithinRoot(tree.root, path);
      if (relative === null || relative === "") return false;
      return navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId: source.environmentId, path: relative },
        location: null,
      });
    },
    [navigate, source, tree.root],
  );

  /** Apply a navigation: move in history when it came from Back/Forward, then show the file. */
  const navigateTo = useCallback(
    (pending: PendingNavigation) => {
      if (pending.historyIndex !== null) setHistory((current) => ({ ...current, index: pending.historyIndex ?? current.index }));
      show(pending.path, { record: pending.record });
      if (compact) setTreeOpen(false);
    },
    [compact, show],
  );

  /**
   * Navigate unless the open file has unsaved edits, in which case the
   * navigation waits behind the banner (history stays where it is until the
   * user decides). In the compact layout the tree gives way so the banner is
   * visible.
   */
  const guardedNavigate = useCallback(
    (pending: PendingNavigation) => {
      if (pending.path === activePath) {
        if (compact) setTreeOpen(false);
        paneRef.current?.focus();
        return;
      }
      if (paneRef.current?.isDirty()) {
        if (prefs.autoSave !== "off") {
          // The write goes before the switch: wait for the dirty buffers to
          // land, bounded, so a slow host cannot trap the user on the file.
          void flushDirtySessions({ reason: "navigate", timeoutMs: NAVIGATE_FLUSH_MS }).then(() => {
            navigateTo(pending);
          });
          return;
        }
        // Manual mode: navigating away is where unsaved work would die.
        setPendingOpen(pending);
        if (compact) setTreeOpen(false);
        return;
      }
      navigateTo(pending);
    },
    [activePath, compact, navigateTo, prefs.autoSave],
  );

  const guardedShow = useCallback(
    (path: string, options: { record: boolean }) => guardedNavigate({ path, record: options.record, historyIndex: null }),
    [guardedNavigate],
  );

  const openFile = useCallback(
    (path: string, options: { newTab: boolean }) => {
      // BB's Original belongs to the file that opened this host tab. Give a
      // different HTML file its own tab so it receives the correct preview.
      if ((options.newTab || previewKind(path) === "html") && openInTab(path)) return;
      guardedShow(path, { record: true });
    },
    [guardedShow, openInTab],
  );

  const goBack = () => {
    if (history.index <= 0) return;
    const path = history.paths[history.index - 1];
    if (path === undefined) return;
    guardedNavigate({ path, record: false, historyIndex: history.index - 1 });
  };
  const goForward = () => {
    if (history.index >= history.paths.length - 1) return;
    const path = history.paths[history.index + 1];
    if (path === undefined) return;
    guardedNavigate({ path, record: false, historyIndex: history.index + 1 });
  };

  const createEntry = useCallback(
    async (path: string, kind: CreateKind) => {
      await rpc.call("create", { path, source, kind });
      if (await loadTree({ quiet: true })) noteOwnMutation([path]);
      if (kind === "file") guardedShow(path, { record: true });
      else toast.success(`Created ${path}/`);
    },
    [guardedShow, loadTree, noteOwnMutation, rpc, source],
  );

  const renameEntry = useCallback(
    async (path: string, newPath: string, kind: CreateKind) => {
      const prefix = `${path}/`;
      // The open file counts when its tree path is the renamed one; a file
      // outside the root is never under a tree entry.
      const movesOpenFile =
        treePath !== null && (treePath === path || (kind === "directory" && treePath.startsWith(prefix)));
      // The editor reloads the renamed file from disk, so unsaved edits go to
      // disk first; a failed save (conflict, error) leaves the name alone.
      if (movesOpenFile && paneRef.current?.isDirty()) {
        const saved = await paneRef.current.save();
        // Typing during the save leaves the buffer dirty again; a save now
        // would still target the old name, so the rename waits for a clean file.
        if (!saved || paneRef.current.isDirty()) throw new Error("Save the open file before renaming it");
      }
      await rpc.call("rename", { path, source, newPath });
      // History follows the rename (the old paths no longer exist), and the
      // open file's new name replaces its entry rather than adding one. The
      // editor moves to the new name before the tree reloads, so no save can
      // recreate the old path in between.
      const renamed = (entry: string) =>
        entry === path ? newPath : kind === "directory" && entry.startsWith(prefix) ? `${newPath}/${entry.slice(prefix.length)}` : entry;
      setHistory((current) => ({ ...current, paths: current.paths.map(renamed) }));
      if (movesOpenFile && treePath !== null) show(renamed(treePath), { record: false });
      if (await loadTree({ quiet: true })) noteOwnMutation([path, newPath]);
    },
    [treePath, loadTree, noteOwnMutation, rpc, show, source],
  );

  const deleteEntry = useCallback(
    async (path: string, kind: CreateKind) => {
      const removed = (entry: string) => entry === path || (kind === "directory" && entry.startsWith(`${path}/`));
      const gone = treePath !== null && removed(treePath);
      // Deleting the open file would take its unsaved edits with it.
      if (gone && paneRef.current?.isDirty()) throw new Error("The open file has unsaved changes; save or discard them first");
      // The editor lets go of the file before the request, so nothing typed
      // while it runs can be lost with it; a failed request brings it back.
      if (gone) setActivePath(null);
      try {
        await rpc.call("remove", { path, source, kind });
      } catch (error) {
        if (gone) setActivePath(activePath);
        throw error;
      }
      if (await loadTree({ quiet: true })) noteOwnMutation([path]);
      // Deleted paths leave history; the index stays on the same entry.
      setHistory((current) => {
        const paths = current.paths.filter((entry) => !removed(entry));
        if (gone) return { paths, index: paths.length - 1 };
        const removedBefore = current.paths.slice(0, current.index).filter(removed).length;
        return { paths, index: current.index - removedBefore };
      });
      toast.success(`Deleted ${path}`);
    },
    [activePath, treePath, loadTree, rpc, source],
  );

  const toggleTree = useCallback(() => {
    setTreeOpen((open) => {
      storeTreeOpen(surface, !open);
      return !open;
    });
  }, [surface]);

  const treeOnRight = prefs.fileTreeSide === "right";

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "p" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      setQuickOpen(true);
    } else if (key === "b" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      toggleTree();
    }
  };

  const showEditor = !compact || !treeOpen;
  const canOpenInTab = source.kind === "workspace" && source.environmentId !== null;

  const treeColumn = treeOpen ? (
    <div
      style={{ width: effectiveTreeWidth }}
      className={cn("relative flex h-full shrink-0 flex-col", !compact && (treeOnRight ? "border-l border-border/60" : "border-r border-border/60"))}
    >
      <FileTree
        entries={tree.entries}
        root={tree.root}
        label={label || (tree.root === "" ? "Files" : tree.root.split(/[\\/]/).at(-1) || "Files")}
        isLoading={tree.isLoading}
        error={tree.error}
        activePath={treePath}
        onOpenFile={openFile}
        onRefresh={() => void loadTree()}
        onLoadDirectory={loadDirectory}
        onCreate={createEntry}
        onRename={renameEntry}
        onDelete={deleteEntry}
      />
      {compact ? null : (
        <ResizeHandle
          side={treeOnRight ? "left" : "right"}
          label="Resize the file tree"
          width={treeWidth}
          available={width}
          onResize={setTreeWidth}
          onResizeEnd={storeTreeWidth}
        />
      )}
    </div>
  ) : null;

  const editorColumn = showEditor ? (
    activePath === null ? (
      <EmptyState treeOpen={treeOpen} treeOnRight={treeOnRight} onShowTree={toggleTree} onQuickOpen={() => setQuickOpen(true)} />
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {pendingOpen !== null ? (
          <NoticeRow tone="warning">
            Open {splitPath(pendingOpen.path).name} and discard your unsaved changes?
            <NoticeAction
              onClick={() => {
                const next = pendingOpen;
                setPendingOpen(null);
                void paneRef.current?.save().then((saved) => {
                  // A file chosen during the save has its own banner; it wins.
                  if (pendingRef.current !== null) return;
                  // Typing during the save dirties the buffer again; the banner returns.
                  if (saved && !paneRef.current?.isDirty()) navigateTo(next);
                  else setPendingOpen(next);
                });
              }}
            >
              Save and open
            </NoticeAction>
            <NoticeAction
              onClick={() => {
                const next = pendingOpen;
                setPendingOpen(null);
                navigateTo(next);
              }}
            >
              Discard and open
            </NoticeAction>
            <NoticeAction onClick={() => setPendingOpen(null)}>Cancel</NoticeAction>
          </NoticeRow>
        ) : null}
        <EditorPane
          ref={paneRef}
          paneId={paneId}
          source={source}
          path={activePath}
          prefs={prefs}
          treeOpen={treeOpen}
          treeSide={prefs.fileTreeSide}
          onToggleTree={toggleTree}
          onQuickOpen={() => setQuickOpen(true)}
          onOpenInTab={canOpenInTab ? () => void openInTab(activePath) : null}
          onOpenPath={(path) => openFile(path, { newTab: false })}
          history={{ canBack: history.index > 0, canForward: history.index < history.paths.length - 1, back: goBack, forward: goForward }}
          onSetPref={onSetPref}
          themePreview={themePreview}
          onPickTheme={openThemePicker}
          Original={activePath === initialPath ? Original : undefined}
          focusNonce={focusNonce}
        />
      </div>
    )
  ) : null;

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground"
      onKeyDown={onKeyDown}
      data-surface={surface}
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        {treeOnRight ? (
          <>
            {editorColumn}
            {treeColumn}
          </>
        ) : (
          <>
            {treeColumn}
            {editorColumn}
          </>
        )}
      </div>
      <SaveStatusBar entries={sessionOverview} />
      {quickOpen ? (
        <QuickOpen source={source} recentPaths={recentPaths} onOpen={openFile} onClose={() => setQuickOpen(false)} />
      ) : null}
      {themePicker !== null ? (
        <ThemePicker
          mode={bbTheme.mode}
          current={themePicker.current}
          onPreview={(pair) => setThemePreview(pair === null ? null : themeNameFor(pair, bbTheme.mode))}
          onChoose={(pair) => {
            // Keep the preview up until the shared setting arrives, so the switch does not flash.
            rpc
              .call("applyTheme", { pair })
              .then(() => setThemePreview(null))
              .catch((error: unknown) => {
                setThemePreview(null);
                toast.error(`Could not set the theme: ${error instanceof Error ? error.message : String(error)}`);
              });
          }}
          onClose={() => {
            setThemePicker(null);
            paneRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function EmptyState({
  treeOpen,
  treeOnRight,
  onShowTree,
  onQuickOpen,
}: {
  treeOpen: boolean;
  treeOnRight: boolean;
  onShowTree: () => void;
  onQuickOpen: () => void;
}) {
  const TreeGlyph = treeOnRight ? SidebarRightGlyph : SidebarLeftGlyph;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {treeOpen ? null : (
        <div className={cn("flex h-9 shrink-0 items-center border-b border-border/60 bg-background px-1.5", treeOnRight && "justify-end")}>
          <button
            type="button"
            onClick={onShowTree}
            title="Show file tree (⌘B)"
            aria-label="Show file tree"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <TreeGlyph />
          </button>
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
        <FolderIcon className="size-5 text-subtle-foreground" />
        <p className="text-sm">Select a file to edit</p>
        <button
          type="button"
          onClick={onQuickOpen}
          className={cn(
            "cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-foreground",
            "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          Go to file <kbd className="ml-1 text-muted-foreground">⌘P</kbd>
        </button>
      </div>
    </div>
  );
}
