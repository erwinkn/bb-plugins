import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { toast } from "sonner";
import { experimental_useCodeTheme, useBbNavigate, useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FlatEntry } from "@/lib/file-tree";
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
import { FileTree, type CreateKind } from "./FileTree";
import { QuickOpen } from "./QuickOpen";
import { ThemePicker } from "./ThemePicker";
import { themeNameFor } from "@/lib/themes";
import { FolderIcon, SidebarLeftGlyph, SidebarRightGlyph } from "./icons";

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
  truncated: boolean;
  isLoading: boolean;
  error: string | null;
}

const EMPTY_TREE: TreeState = { entries: [], root: "", truncated: false, isLoading: false, error: null };

/** A file to show, and how it reaches history: recorded as new, or reached by Back/Forward at `historyIndex`. */
interface PendingNavigation {
  path: string;
  record: boolean;
  historyIndex: number | null;
}
const COMPACT_BREAKPOINT_PX = 420;
const KEYBOARD_RESIZE_STEP_PX = 24;
const HISTORY_LIMIT = 50;

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
  const [width, setWidth] = useState(0);
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [quickOpen, setQuickOpen] = useState(false);
  const [themePicker, setThemePicker] = useState<{ current: string | null } | null>(null);
  const [themePreview, setThemePreview] = useState<string | null>(null);
  const bbTheme = experimental_useCodeTheme();
  const openThemePicker = useCallback(() => {
    setThemePicker({ current: null });
    rpc
      .call("theme", null)
      .then((theme) => setThemePicker((state) => (state === null ? null : { current: theme.pair })))
      .catch((error: unknown) => console.warn("[erwin-editor] could not read BB's theme", error));
  }, [rpc]);
  const [focusNonce, setFocusNonce] = useState(0);
  const treeRequested = useRef(false);

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

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const compact = width > 0 && width < COMPACT_BREAKPOINT_PX;
  const effectiveTreeWidth = compact ? width : clampTreeWidth(treeWidth, width || Number.POSITIVE_INFINITY);

  // Deferred directories load on expand; one request per path until it lands.
  const deferredRequests = useRef(new Set<string>());
  // A refresh starts a new generation; deferred results from before it are dropped.
  const treeGeneration = useRef(0);
  const loadTree = useCallback(() => {
    treeGeneration.current += 1;
    const generation = treeGeneration.current;
    deferredRequests.current.clear();
    setTree((current) => ({ ...current, isLoading: true, error: null }));
    return rpc
      .call("tree", { source })
      .then((result) => {
        if (generation !== treeGeneration.current) return;
        setTree({ entries: result.entries, root: result.root, truncated: result.truncated, isLoading: false, error: null });
      })
      .catch((error: unknown) => {
        if (generation !== treeGeneration.current) return;
        treeRequested.current = false;
        setTree({ ...EMPTY_TREE, error: error instanceof Error ? error.message : "Could not list files" });
      });
  }, [rpc, source]);

  const loadDirectory = useCallback(
    (subpath: string) => {
      if (deferredRequests.current.has(subpath)) return;
      deferredRequests.current.add(subpath);
      const generation = treeGeneration.current;
      rpc
        .call("tree", { source, subpath })
        .then((result) => {
          if (generation !== treeGeneration.current) return;
          setTree((current) => {
            const prefix = `${subpath}/`;
            const kept = current.entries.filter((entry) => entry.path !== subpath && !entry.path.startsWith(prefix));
            return { ...current, entries: [...kept, { path: subpath, kind: "directory" }, ...result.entries] };
          });
          if (result.truncated) toast.message(`Showing the first entries of ${subpath}; it is larger.`);
        })
        .catch((error: unknown) => {
          if (generation !== treeGeneration.current) return;
          deferredRequests.current.delete(subpath);
          toast.error(error instanceof Error ? error.message : `Could not list ${subpath}`);
        });
    },
    [rpc, source],
  );

  const needTree = treeOpen || quickOpen;
  useEffect(() => {
    if (!needTree || treeRequested.current) return;
    treeRequested.current = true;
    void loadTree();
  }, [needTree, loadTree]);

  const openInTab = useCallback(
    (path: string) => {
      if (source.kind !== "workspace" || source.environmentId === null) return false;
      return navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId: source.environmentId, path },
        location: null,
      });
    },
    [navigate, source],
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
        paneRef.current?.focus();
        return;
      }
      if (paneRef.current?.isDirty()) {
        setPendingOpen(pending);
        if (compact) setTreeOpen(false);
        return;
      }
      navigateTo(pending);
    },
    [activePath, compact, navigateTo],
  );

  const guardedShow = useCallback(
    (path: string, options: { record: boolean }) => guardedNavigate({ path, record: options.record, historyIndex: null }),
    [guardedNavigate],
  );

  const openFile = useCallback(
    (path: string, options: { newTab: boolean }) => {
      if (options.newTab && openInTab(path)) return;
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
      await loadTree();
      if (kind === "file") guardedShow(path, { record: true });
      else toast.success(`Created ${path}/`);
    },
    [guardedShow, loadTree, rpc, source],
  );

  const renameEntry = useCallback(
    async (path: string, newPath: string, kind: CreateKind) => {
      const prefix = `${path}/`;
      const movesOpenFile =
        activePath !== null && (activePath === path || (kind === "directory" && activePath.startsWith(prefix)));
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
      if (movesOpenFile && activePath !== null) show(renamed(activePath), { record: false });
      await loadTree();
    },
    [activePath, loadTree, rpc, show, source],
  );

  const deleteEntry = useCallback(
    async (path: string, kind: CreateKind) => {
      const removed = (entry: string) => entry === path || (kind === "directory" && entry.startsWith(`${path}/`));
      const gone = activePath !== null && removed(activePath);
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
      await loadTree();
      // Deleted paths leave history; the index stays on the same entry.
      setHistory((current) => {
        const paths = current.paths.filter((entry) => !removed(entry));
        if (gone) return { paths, index: paths.length - 1 };
        const removedBefore = current.paths.slice(0, current.index).filter(removed).length;
        return { paths, index: current.index - removedBefore };
      });
      toast.success(`Deleted ${path}`);
    },
    [activePath, loadTree, rpc, source],
  );

  const toggleTree = useCallback(() => {
    setTreeOpen((open) => {
      storeTreeOpen(surface, !open);
      return !open;
    });
  }, [surface]);

  // The handle's pointer listeners are bound when the drag starts, so they
  // read the width through a ref rather than the render they closed over.
  const treeWidthRef = useRef(treeWidth);
  treeWidthRef.current = treeWidth;
  const resizeStart = useRef(treeWidth);
  const treeOnRight = prefs.fileTreeSide === "right";
  const resizeBy = (delta: number) => {
    const next = clampTreeWidth(resizeStart.current + (treeOnRight ? -delta : delta), width);
    treeWidthRef.current = next;
    setTreeWidth(next);
  };
  const resizeEnd = () => {
    resizeStart.current = treeWidthRef.current;
    storeTreeWidth(treeWidthRef.current);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const inMonaco = (event.target as HTMLElement | null)?.closest(".monaco-editor") !== null;
    if (inMonaco) return;
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
        truncated={tree.truncated}
        activePath={activePath}
        onOpenFile={openFile}
        onRefresh={() => void loadTree()}
        onExpandDeferred={loadDirectory}
        onCreate={createEntry}
        onRename={renameEntry}
        onDelete={deleteEntry}
      />
      {compact ? null : (
        <ResizeHandle
          side={treeOnRight ? "left" : "right"}
          onResizeStart={() => {
            resizeStart.current = treeWidth;
          }}
          onResize={resizeBy}
          onResizeEnd={resizeEnd}
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
            Open {pendingOpen.path.split("/").at(-1)} and discard your unsaved changes?
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
          history={{ canBack: history.index > 0, canForward: history.index < history.paths.length - 1, back: goBack, forward: goForward }}
          onSetPref={onSetPref}
          themePreview={themePreview}
          onPickTheme={openThemePicker}
          Original={Original}
          focusNonce={focusNonce}
        />
      </div>
    )
  ) : null;

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background text-foreground"
      onKeyDown={onKeyDown}
      data-surface={surface}
    >
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
      {quickOpen ? <QuickOpen entries={tree.entries} onOpen={openFile} onClose={() => setQuickOpen(false)} /> : null}
      {themePicker !== null ? (
        <ThemePicker
          mode={bbTheme.mode}
          current={themePicker.current}
          onPreview={(pair) => setThemePreview(pair === null ? null : themeNameFor(pair, bbTheme.mode))}
          onChoose={(pair) => {
            // Keep the preview up until BB's theme arrives, so the switch does not flash.
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

function ResizeHandle({
  side,
  onResizeStart,
  onResize,
  onResizeEnd,
}: {
  /** Edge of the tree column the handle sits on. */
  side: "left" | "right";
  onResizeStart: () => void;
  onResize: (deltaX: number) => void;
  onResizeEnd: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    setDragging(true);
    onResizeStart();
    target.setPointerCapture(pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) onResize(moveEvent.clientX - startX);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setDragging(false);
      onResizeEnd();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };
  const grow = side === "right" ? 1 : -1;
  return (
    <div
      role="separator"
      aria-label="Resize the file tree"
      aria-orientation="vertical"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onResize(-KEYBOARD_RESIZE_STEP_PX * grow);
        else if (event.key === "ArrowRight") onResize(KEYBOARD_RESIZE_STEP_PX * grow);
        else return;
        event.preventDefault();
        onResizeEnd();
      }}
      className={cn(
        "absolute top-0 z-10 h-full w-px bg-transparent transition-colors",
        side === "right" ? "-right-px" : "-left-px",
        "hover:bg-ring/50 focus-visible:bg-ring focus-visible:outline-none",
        dragging && "bg-ring/60",
      )}
    >
      <div
        aria-hidden
        onPointerDown={handlePointerDown}
        className={cn("absolute top-0 h-full w-2.5 cursor-col-resize touch-none bg-transparent", side === "right" ? "-right-1" : "-left-1")}
      />
    </div>
  );
}
