/**
 * The Changes tab: what is compared, the files in it, and one file's
 * comparison. It is the same shape as the Files tab — a list beside a pane,
 * which take turns in a narrow panel — so the two tabs feel like one editor.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FileSource } from "../server";
import type { DiffEntry, DiffTarget } from "@/lib/diff-contract";
import type { EditorPrefs } from "@/lib/editor-options";
import type { FileSessionSource } from "@/lib/file-session";
import { useDirtyPaths } from "@/lib/use-file-session";
import {
  clampTreeWidth,
  DEFAULT_TARGET,
  describeTarget,
  effectiveLayout,
  findEntry,
  isCompact,
  needsBranch,
  neighbourPath,
  parseDiffParams,
  readLastPath,
  readLastTarget,
  readViewPrefs,
  sameTarget,
  selectionAfterRefresh,
  storeLastPath,
  storeLastTarget,
  storeViewPrefs,
  summarize,
  targetKey,
  type DiffViewPrefs,
} from "@/lib/diff-view-state";
import { cn } from "@/lib/utils";
import { NoticeAction, NoticeRow, type SetPref } from "./EditorPane";
import { DiffFileList } from "./DiffFileList";
import { EditableDiffPane } from "./EditableDiffPane";
import { ScopeBar, type ScopePrompt } from "./DiffToolbar";
import { FolderIcon } from "./icons";

const KEYBOARD_RESIZE_STEP_PX = 24;

/** Stands in until the first list arrives; no session belongs to it. */
const NO_SOURCE: FileSessionSource = { kind: "workspace", threadId: null, environmentId: null, projectId: null };

interface ListState {
  files: readonly DiffEntry[];
  source: FileSource | null;
  root: string;
  label: string;
  baseBranch: string | null;
  truncated: boolean;
  message: string | null;
  isLoading: boolean;
  error: string | null;
}

const EMPTY_LIST: ListState = {
  files: [],
  source: null,
  root: "",
  label: "",
  baseBranch: null,
  truncated: false,
  message: null,
  isLoading: true,
  error: null,
};

export interface DiffWorkbenchProps {
  threadId: string;
  /** Panel parameters: an optional comparison and file. Untrusted. */
  params: unknown;
  prefs: EditorPrefs;
  onSetPref: SetPref;
}

export function DiffWorkbench({ threadId, params, prefs, onSetPref }: DiffWorkbenchProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const initial = useMemo(() => parseDiffParams(params), [params]);
  const [target, setTarget] = useState<DiffTarget>(() => initial.target ?? readLastTarget(threadId) ?? DEFAULT_TARGET);
  const [selected, setSelected] = useState<string | null>(() => initial.path ?? readLastPath(threadId, target));
  const [view, setView] = useState<DiffViewPrefs>(readViewPrefs);
  const [prompt, setPrompt] = useState<ScopePrompt | null>(null);
  const [list, setList] = useState<ListState>(EMPTY_LIST);
  const [listNonce, setListNonce] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [assets, setAssets] = useState<{ baseUrl: string } | { error: string } | null>(null);
  const [assetsNonce, setAssetsNonce] = useState(0);
  const [width, setWidth] = useState(0);

  const key = targetKey(target);
  const compact = isCompact(width);
  const listSide = prefs.fileTreeSide;
  const listOnRight = listSide === "right";

  // A later comparison or file in the panel parameters wins over what the
  // tab was showing, so a link always lands where it points.
  const appliedParams = useRef(initial);
  useEffect(() => {
    if (appliedParams.current === initial) return;
    appliedParams.current = initial;
    if (initial.target !== null) setTarget(initial.target);
    if (initial.path !== null) setSelected(initial.path);
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    void rpc
      .call("assets", null)
      .then((result) => {
        if (!cancelled) setAssets({ baseUrl: result.baseUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) setAssets({ error: error instanceof Error ? error.message : "Could not reach the editor assets" });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, assetsNonce]);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => storeLastTarget(threadId, target), [threadId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => storeLastPath(threadId, target, selected), [threadId, key, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => storeViewPrefs(view), [view]);

  /** The order the previous list had, so a file that goes away hands over to its neighbour. */
  const previousFiles = useRef<readonly DiffEntry[]>([]);

  // A refresh replaces the list; results from an earlier one are dropped, and
  // the file stays open when the new list still has it.
  const generation = useRef(0);
  const savedSelection = useRef<{ key: string; path: string | null } | null>(null);
  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    const savedPath = savedSelection.current?.key === key ? savedSelection.current.path : null;
    savedSelection.current = null;
    setList((current) => ({ ...current, isLoading: true, error: null }));
    void rpc
      .call("diffList", { threadId, target })
      .then((result) => {
        if (mine !== generation.current) return;
        setList({
          files: result.files,
          source: result.source,
          root: result.root,
          label: result.label,
          baseBranch: result.baseBranch,
          truncated: result.truncated,
          message: result.message,
          isLoading: false,
          error: null,
        });
        setSelected((current) => selectionAfterRefresh(result.files, current, previousFiles.current, savedPath));
        previousFiles.current = result.files;
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        setList({ ...EMPTY_LIST, isLoading: false, error: error instanceof Error ? error.message : "This comparison could not be listed" });
      });
    // `key` stands for `target`, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, threadId, key, listNonce]);

  const chooseTarget = useCallback(
    (next: DiffTarget) => {
      if (sameTarget(target, next)) return;
      setTarget(next);
      setSelected(readLastPath(threadId, next));
    },
    [target, threadId],
  );

  const refresh = useCallback(() => {
    savedSelection.current = null;
    setListNonce((nonce) => nonce + 1);
    setRefreshNonce((nonce) => nonce + 1);
  }, []);
  const refreshListAfterSave = useCallback(() => {
    savedSelection.current = { key, path: selected };
    setListNonce((nonce) => nonce + 1);
  }, [key, selected]);
  const refreshList = useCallback(() => {
    savedSelection.current = null;
    setListNonce((nonce) => nonce + 1);
  }, []);

  const setViewPref = useCallback(<K extends keyof DiffViewPrefs>(prefKey: K, value: DiffViewPrefs[K]) => {
    setView((current) => ({ ...current, [prefKey]: value }));
  }, []);

  const select = useCallback(
    (path: string) => {
      setSelected(path);
      if (compact) setViewPref("listOpen", false);
    },
    [compact, setViewPref],
  );

  // Unsaved work lives in the shared sessions, so the marks cover files that
  // the Files tab has open too, not only the file this pane shows.
  const dirtyPaths = useDirtyPaths(list.source ?? NO_SOURCE);

  const entry = findEntry(list.files, selected);
  const summary = list.error === null ? summarize(list.files) : null;
  const layout = effectiveLayout(view.layout, compact ? width : Math.max(width - view.listWidth, 0));
  const wording = describeTarget(target, list.baseBranch);

  const openFile = useMemo(() => {
    if (selected === null) return null;
    return () => {
      if (navigate.openThreadPanel({ actionId: "files", params: { path: selected } })) return;
      const environmentId = list.source?.environmentId ?? null;
      if (environmentId !== null) {
        navigate.experimental_openFilePreview({ target: { kind: "workspace", environmentId, path: selected }, location: null });
      }
    };
  }, [navigate, selected, list.source]);

  const listWidth = compact ? width : clampTreeWidth(view.listWidth, width || Number.POSITIVE_INFINITY);
  const listOpen = view.listOpen || (compact && selected === null);
  const showPane = !compact || !listOpen;

  const listColumn = listOpen ? (
    <div
      style={{ width: listWidth }}
      className={cn("relative flex h-full shrink-0 flex-col", !compact && (listOnRight ? "border-l border-border/60" : "border-r border-border/60"))}
    >
      <DiffFileList
        files={list.files}
        title={wording.label}
        activePath={selected}
        dirtyPaths={dirtyPaths}
        isLoading={list.isLoading}
        error={list.error}
        message={list.message}
        truncated={list.truncated}
        onSelect={select}
        onRefresh={refreshList}
      />
      {compact ? null : (
        <ResizeHandle
          side={listOnRight ? "left" : "right"}
          width={view.listWidth}
          available={width}
          onResize={(next) => setViewPref("listWidth", next)}
        />
      )}
    </div>
  ) : null;

  const paneColumn = showPane ? (
    selected === null ? (
      <EmptyPane
        listOpen={listOpen}
        hasFiles={list.files.length > 0}
        onShowList={() => setViewPref("listOpen", true)}
      />
    ) : (
      <EditableDiffPane
        key={`${key}:${selected}`}
        threadId={threadId}
        target={target}
        entry={entry}
        path={selected}
        prefs={prefs}
        onSetPref={onSetPref}
        layout={layout}
        expandUnchanged={view.expandUnchanged}
        baseUrl={assets !== null && "baseUrl" in assets ? assets.baseUrl : null}
        refreshNonce={refreshNonce}
        navigation={{
          canPrevious: neighbourPath(list.files, selected, -1) !== null,
          canNext: neighbourPath(list.files, selected, 1) !== null,
          previous: () => {
            const path = neighbourPath(list.files, selected, -1);
            if (path !== null) setSelected(path);
          },
          next: () => {
            const path = neighbourPath(list.files, selected, 1);
            if (path !== null) setSelected(path);
          },
        }}
        listOpen={listOpen}
        listSide={listSide}
        onToggleList={() => setViewPref("listOpen", !view.listOpen)}
        onOpenFile={openFile}
        onSaved={refreshListAfterSave}
      />
    )
  ) : null;

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <ScopeBar
        threadId={threadId}
        target={target}
        baseBranch={list.baseBranch}
        summary={summary}
        isLoading={list.isLoading}
        onChooseTarget={chooseTarget}
        onRefresh={refresh}
        view={view}
        onSetView={setViewPref}
        prefs={prefs}
        onSetPref={onSetPref}
        layout={layout}
        prompt={prompt}
        onPrompt={setPrompt}
      />
      {assets !== null && "error" in assets ? (
        <NoticeRow tone="error">
          The comparison viewer could not be loaded: {assets.error}
          <NoticeAction onClick={() => setAssetsNonce((nonce) => nonce + 1)}>Try again</NoticeAction>
        </NoticeRow>
      ) : null}
      {list.error !== null && needsBranch(target, list.baseBranch) && (target.type === "all" || target.type === "branch_committed") ? (
        <NoticeRow tone="error">
          {list.error}
          <NoticeAction onClick={() => setPrompt({ kind: "branch", scope: target.type })}>Choose a branch</NoticeAction>
        </NoticeRow>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {listOnRight ? (
          <>
            {paneColumn}
            {listColumn}
          </>
        ) : (
          <>
            {listColumn}
            {paneColumn}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyPane({
  listOpen,
  hasFiles,
  onShowList,
}: {
  listOpen: boolean;
  hasFiles: boolean;
  onShowList: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
      <FolderIcon className="size-5 text-subtle-foreground" />
      <p className="text-sm">{hasFiles ? "Select a file to see what changed" : "Nothing changed in this comparison"}</p>
      {hasFiles && !listOpen ? (
        <button
          type="button"
          onClick={onShowList}
          className={cn(
            "cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-foreground",
            "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          Show the change list
        </button>
      ) : null}
    </div>
  );
}

/** The draggable edge of the change list. Arrow keys move it too. */
function ResizeHandle({
  side,
  width,
  available,
  onResize,
}: {
  side: "left" | "right";
  width: number;
  available: number;
  onResize: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef(width);
  const latest = useRef(width);
  latest.current = width;
  const grow = side === "right" ? 1 : -1;

  const applyDelta = (delta: number) => onResize(clampTreeWidth(start.current + delta * grow, available));

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    start.current = latest.current;
    setDragging(true);
    target.setPointerCapture(pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) applyDelta(moveEvent.clientX - startX);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setDragging(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };

  return (
    <div
      role="separator"
      aria-label="Resize the change list"
      aria-orientation="vertical"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        start.current = latest.current;
        applyDelta(event.key === "ArrowLeft" ? -KEYBOARD_RESIZE_STEP_PX : KEYBOARD_RESIZE_STEP_PX);
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
