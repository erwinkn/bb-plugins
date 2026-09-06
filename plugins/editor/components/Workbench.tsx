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
  const [pendingOpen, setPendingOpen] = useState<{ path: string } | null>(null);
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

  useEffect(() => {
    if (initialPath !== null) show(initialPath, { record: true });
    // Only external path changes (a new file opened into this tab) re-run this.
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

  const loadTree = useCallback(() => {
    setTree((current) => ({ ...current, isLoading: true, error: null }));
    return rpc
      .call("tree", { source })
      .then((result) => {
        setTree({ entries: result.entries, root: result.root, truncated: result.truncated, isLoading: false, error: null });
      })
      .catch((error: unknown) => {
        treeRequested.current = false;
        setTree({ ...EMPTY_TREE, error: error instanceof Error ? error.message : "Could not list files" });
      });
  }, [rpc, source]);

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

  const guardedShow = useCallback(
    (path: string, options: { record: boolean }) => {
      if (path === activePath) {
        paneRef.current?.focus();
        return;
      }
      if (paneRef.current?.isDirty()) {
        setPendingOpen({ path });
        return;
      }
      show(path, options);
      if (compact) setTreeOpen(false);
    },
    [activePath, compact, show],
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
    setHistory({ ...history, index: history.index - 1 });
    guardedShow(path, { record: false });
  };
  const goForward = () => {
    if (history.index >= history.paths.length - 1) return;
    const path = history.paths[history.index + 1];
    if (path === undefined) return;
    setHistory({ ...history, index: history.index + 1 });
    guardedShow(path, { record: false });
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
      await rpc.call("rename", { path, source, newPath });
      await loadTree();
      const prefix = `${path}/`;
      if (activePath === path) show(newPath, { record: true });
      else if (kind === "directory" && activePath !== null && activePath.startsWith(prefix)) {
        show(`${newPath}/${activePath.slice(prefix.length)}`, { record: true });
      }
    },
    [activePath, loadTree, rpc, show, source],
  );

  const deleteEntry = useCallback(
    async (path: string, kind: CreateKind) => {
      await rpc.call("remove", { path, source, kind });
      await loadTree();
      const gone = activePath !== null && (activePath === path || (kind === "directory" && activePath.startsWith(`${path}/`)));
      if (gone) {
        setActivePath(null);
        setHistory((current) => {
          const paths = current.paths.filter((entry) => entry !== activePath && !(kind === "directory" && entry.startsWith(`${path}/`)));
          return { paths, index: paths.length - 1 };
        });
      }
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

  const resizeStart = useRef(treeWidth);
  const treeOnRight = prefs.fileTreeSide === "right";
  const resizeBy = (delta: number) => {
    setTreeWidth(clampTreeWidth(resizeStart.current + (treeOnRight ? -delta : delta), width));
  };
  const resizeEnd = () => {
    resizeStart.current = treeWidth;
    storeTreeWidth(treeWidth);
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
                const next = pendingOpen.path;
                setPendingOpen(null);
                void paneRef.current?.save().then((saved) => {
                  if (saved) show(next, { record: true });
                });
              }}
            >
              Save and open
            </NoticeAction>
            <NoticeAction
              onClick={() => {
                const next = pendingOpen.path;
                setPendingOpen(null);
                show(next, { record: true });
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
