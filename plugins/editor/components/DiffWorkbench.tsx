/**
 * The Changes tab: what is compared, the files in it, and one file's
 * comparison. It is the same shape as the Files tab — a list beside a pane,
 * which take turns in a narrow panel — so the two tabs feel like one editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FileSource } from "../server";
import type { DiffEntry, DiffTarget } from "@/lib/diff-contract";
import type { EditorPrefs } from "@/lib/editor-options";
import { NO_SOURCE } from "@/lib/file-session";
import { useElementWidth } from "@/lib/use-element-width";
import { useAssets } from "@/lib/use-assets";
import { useDirtyPaths } from "@/lib/use-file-session";
import { clampTreeWidth } from "@/lib/layout-storage";
import {
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
import { ResizeHandle } from "./ResizeHandle";
import { FolderIcon } from "./icons";
import { useFileWatch } from "@/lib/file-watch";


/** Stands in until the first list arrives; no session belongs to it. */

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
  const [assetsNonce, setAssetsNonce] = useState(0);
  const assets = useAssets(assetsNonce);
  const width = useElementWidth(rootRef);

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

  // `key` stands for `target` in these dependency lists: the target is a new
  // object on every render, its key is not.
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
  const refreshListKeepingSelection = useCallback(() => {
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

  // Any change on disk can move a file into or out of the comparison, or
  // change its counts, so the list follows; the selection stays.
  const listReload = useRef<ReturnType<typeof setTimeout> | null>(null);
  useFileWatch(list.source, () => {
    if (listReload.current !== null) clearTimeout(listReload.current);
    listReload.current = setTimeout(() => {
      listReload.current = null;
      refreshListKeepingSelection();
    }, 500);
  });

  const entry = findEntry(list.files, selected);
  const summary = list.error === null ? summarize(list.files) : null;
  const layout = effectiveLayout(view.layout, compact ? width : Math.max(width - view.listWidth, 0));
  const wording = describeTarget(target, list.baseBranch);

  /** Opens a workspace file in the Files tab, or in BB's own preview when the tab is unavailable. */
  const openPath = useCallback(
    (path: string) => {
      if (navigate.openThreadPanel({ actionId: "files", params: { path } })) return;
      const environmentId = list.source?.environmentId ?? null;
      if (environmentId !== null) {
        navigate.experimental_openFilePreview({ target: { kind: "workspace", environmentId, path }, location: null });
      }
    },
    [navigate, list.source],
  );
  const openFile = useMemo(() => (selected === null ? null : () => openPath(selected)), [openPath, selected]);

  const listWidth = compact ? width : clampTreeWidth(view.listWidth, width || Number.POSITIVE_INFINITY);
  const listOpen = view.listOpen || (compact && selected === null);
  const showPane = !compact || !listOpen;

  const listColumn = listOpen ? (
    <div
      style={{ width: listWidth }}
      className={cn("relative flex h-full shrink-0 flex-col", !compact && (listOnRight ? "border-l border-border/60" : "border-r border-border/60"))}
    >
      <DiffFileList
        threadId={threadId}
        target={target}
        onChanged={refresh}
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
          label="Resize the change list"
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
        baseUrl={assets.kind === "ready" ? assets.baseUrl : null}
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
        onOpenPath={openPath}
        onSaved={refreshListKeepingSelection}
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
      {assets.kind === "error" ? (
        <NoticeRow tone="error">
          The comparison viewer could not be loaded: {assets.message}
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
