import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { useBbNavigate, useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
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
import { EditorPane, NoticeAction, NoticeRow, type EditorPaneHandle } from "./EditorPane";
import { FileTree } from "./FileTree";
import { QuickOpen } from "./QuickOpen";
import { FolderIcon, PanelLeftOpenIcon } from "./icons";

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

export function Workbench({ surface, source, initialPath, workspaceKey, label, prefs, Original }: WorkbenchProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const paneId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<EditorPaneHandle | null>(null);

  const [activePath, setActivePath] = useState<string | null>(
    () => initialPath ?? (surface === "panel" ? readLastFile(workspaceKey) : null),
  );
  const [pendingOpen, setPendingOpen] = useState<{ path: string } | null>(null);
  const [treeOpen, setTreeOpen] = useState(() => readTreeOpen(surface));
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
  const [width, setWidth] = useState(0);
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [quickOpen, setQuickOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const treeRequested = useRef(false);

  useEffect(() => {
    if (initialPath !== null) setActivePath(initialPath);
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
    void rpc
      .call("tree", { source })
      .then((result) => {
        setTree({ entries: result.entries, root: result.root, truncated: result.truncated, isLoading: false, error: null });
      })
      .catch((error: unknown) => {
        treeRequested.current = false;
        setTree({
          ...EMPTY_TREE,
          error: error instanceof Error ? error.message : "Could not list files",
        });
      });
  }, [rpc, source]);

  const needTree = treeOpen || quickOpen;
  useEffect(() => {
    if (!needTree || treeRequested.current) return;
    treeRequested.current = true;
    loadTree();
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

  const openFile = useCallback(
    (path: string, options: { newTab: boolean }) => {
      if (options.newTab && openInTab(path)) return;
      if (path === activePath) {
        paneRef.current?.focus();
        return;
      }
      if (paneRef.current?.isDirty()) {
        setPendingOpen({ path });
        return;
      }
      setActivePath(path);
      setFocusNonce((nonce) => nonce + 1);
      if (compact) setTreeOpen(false);
    },
    [activePath, compact, openInTab],
  );

  const toggleTree = useCallback(() => {
    setTreeOpen((open) => {
      storeTreeOpen(surface, !open);
      return !open;
    });
  }, [surface]);

  const resizeStart = useRef(treeWidth);
  const resizeBy = (delta: number) => {
    const next = clampTreeWidth(resizeStart.current + delta, width);
    setTreeWidth(next);
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

  const showTree = treeOpen;
  const showEditor = !compact || !treeOpen;
  const canOpenInTab = source.kind === "workspace" && source.environmentId !== null;

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background text-foreground"
      onKeyDown={onKeyDown}
      data-surface={surface}
    >
      {showTree ? (
        <div style={{ width: effectiveTreeWidth }} className="relative flex h-full shrink-0 flex-col">
          <FileTree
            entries={tree.entries}
            root={tree.root}
            label={label || (tree.root === "" ? "Files" : tree.root.split(/[\\/]/).at(-1) || "Files")}
            isLoading={tree.isLoading}
            error={tree.error}
            truncated={tree.truncated}
            activePath={activePath}
            onOpenFile={openFile}
            onClose={toggleTree}
            onRefresh={loadTree}
          />
          {compact ? null : (
            <ResizeHandle
              onResizeStart={() => {
                resizeStart.current = treeWidth;
              }}
              onResize={resizeBy}
              onResizeEnd={resizeEnd}
            />
          )}
        </div>
      ) : null}
      {showEditor ? (
        activePath === null ? (
          <EmptyState treeOpen={treeOpen} onShowTree={toggleTree} onQuickOpen={() => setQuickOpen(true)} />
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
                      if (saved) {
                        setActivePath(next);
                        setFocusNonce((nonce) => nonce + 1);
                      }
                    });
                  }}
                >
                  Save and open
                </NoticeAction>
                <NoticeAction
                  onClick={() => {
                    const next = pendingOpen.path;
                    setPendingOpen(null);
                    setActivePath(next);
                    setFocusNonce((nonce) => nonce + 1);
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
              onToggleTree={toggleTree}
              onQuickOpen={() => setQuickOpen(true)}
              onOpenInTab={canOpenInTab ? () => void openInTab(activePath) : null}
              Original={Original}
              focusNonce={focusNonce}
            />
          </div>
        )
      ) : null}
      {quickOpen ? <QuickOpen entries={tree.entries} onOpen={openFile} onClose={() => setQuickOpen(false)} /> : null}
    </div>
  );
}

function EmptyState({ treeOpen, onShowTree, onQuickOpen }: { treeOpen: boolean; onShowTree: () => void; onQuickOpen: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {treeOpen ? null : (
        <div className="flex h-9 shrink-0 items-center border-b border-border/60 bg-surface-raised pl-1">
          <button
            type="button"
            onClick={onShowTree}
            title="Show file tree (⌘B)"
            aria-label="Show file tree"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <PanelLeftOpenIcon />
          </button>
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
        <FolderIcon className="size-6 text-subtle-foreground" />
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
  onResizeStart,
  onResize,
  onResizeEnd,
}: {
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
  return (
    <div
      role="separator"
      aria-label="Resize the file tree"
      aria-orientation="vertical"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onResize(-KEYBOARD_RESIZE_STEP_PX);
        else if (event.key === "ArrowRight") onResize(KEYBOARD_RESIZE_STEP_PX);
        else return;
        event.preventDefault();
        onResizeEnd();
      }}
      className={cn(
        "absolute top-0 right-0 z-10 h-full w-px bg-border transition-colors",
        "hover:bg-ring/50 focus-visible:bg-ring focus-visible:outline-none",
        dragging && "bg-ring/60",
      )}
    >
      <div
        aria-hidden
        onPointerDown={handlePointerDown}
        className="absolute top-0 -right-1 h-full w-2.5 cursor-col-resize touch-none bg-transparent"
      />
    </div>
  );
}
