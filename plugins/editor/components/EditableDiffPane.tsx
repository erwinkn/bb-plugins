/**
 * One file's comparison. The old side is always a fixed record. The new side
 * of a working file is the same file the Files tab edits, through the shared
 * session, so a draft made here is the same draft there. A saved revision has
 * no working file behind it and stays read-only.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { DiffEntry, DiffTarget } from "@/lib/diff-contract";
import { AUTO_SAVE_DELAY_MS, type EditorPrefs } from "@/lib/editor-options";
import { changeLabel, diffSessionSync, targetKey, unavailableReason, type DiffLayout } from "@/lib/diff-view-state";
import type { FileSessionSource, FileSessionSnapshot } from "@/lib/file-session";
import { useFileSession } from "@/lib/use-file-session";
import PierreSurface, { type PierreSurfaceHandle, type PierreSurfaceStatus } from "./PierreSurface";
import { usePierreTheme } from "@/lib/pierre-theme";
import { hasPreview, NoticeAction, NoticeRow, type SetPref } from "./EditorPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { workspaceRoot } from "@/lib/markdown-preview";
import { FileBar } from "./DiffToolbar";
import type { SaveIndicator } from "./Toolbar";
import type { MenuItem } from "./ContextMenu";
import { copyText, forgetEditor, markEditorActive, type ActiveEditor } from "@/lib/editor-commands";
import { cn } from "@/lib/utils";

/** The text branch of `diffRead`, named so the pane can hold it in state. */
interface DiffFileRead {
  source: FileSessionSource;
  path: string;
  previousPath: string | null;
  changeKind: DiffEntry["changeKind"];
  origin: DiffEntry["origin"];
  /** null means the side does not exist: an added file has no old side. */
  oldContent: string | null;
  newContent: string | null;
  editable: boolean;
  reason: string | null;
  sha256: string | null;
  absolutePath: string;
  relativePath: string;
}

type ReadState =
  | { kind: "loading" }
  | { kind: "ready"; data: DiffFileRead }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

/** Stands in while no file is readable; the session hook then holds nothing. */
const NO_SOURCE: FileSessionSource = { kind: "workspace", threadId: null, environmentId: null, projectId: null };

export interface EditableDiffPaneProps {
  threadId: string;
  target: DiffTarget;
  /** The list entry for `path`; it says what happened to the file. */
  entry: DiffEntry | null;
  path: string;
  prefs: EditorPrefs;
  onSetPref: SetPref;
  layout: DiffLayout;
  expandUnchanged: boolean;
  /** Where the Pierre bundle is served from; null while it is still unknown. */
  baseUrl: string | null;
  /** Rises when the user asks for a fresh comparison. */
  refreshNonce: number;
  navigation: { canPrevious: boolean; canNext: boolean; previous: () => void; next: () => void };
  listOpen: boolean;
  listSide: "left" | "right";
  onToggleList: () => void;
  /** Opens the same file in the Files tab; null when that is not possible. */
  onOpenFile: (() => void) | null;
  /** Opens another workspace file, for a link in the rendered preview. */
  onOpenPath: (path: string) => void;
  /** A save changed the file, so the change list needs new counts. */
  onSaved: () => void;
}

export function EditableDiffPane({
  threadId,
  target,
  entry,
  path,
  prefs,
  onSetPref,
  layout,
  expandUnchanged,
  baseUrl,
  refreshNonce,
  navigation,
  listOpen,
  listSide,
  onToggleList,
  onOpenFile,
  onOpenPath,
  onSaved,
}: EditableDiffPaneProps) {
  const rpc = useRpc<typeof rpcContract>();
  const theme = usePierreTheme();
  const paneId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<PierreSurfaceHandle | null>(null);
  const [read, setRead] = useState<ReadState>({ kind: "loading" });
  const [surfaceStatus, setSurfaceStatus] = useState<PierreSurfaceStatus>({ kind: "loading" });
  // A Markdown comparison opens as a diff; its rendered new side is one switch away.
  const [previewing, setPreviewing] = useState(false);
  /** Rises when the pane itself asks for the comparison again. */
  const [resyncNonce, setResyncNonce] = useState(0);
  const key = targetKey(target);

  // The list already knows about files with no line comparison, so the pane
  // says so at once instead of asking the server for a body it cannot use.
  const listedReason = entry === null ? null : unavailableReason(entry);

  useEffect(() => {
    if (listedReason !== null) {
      setRead({ kind: "unavailable", reason: listedReason });
      return;
    }
    let cancelled = false;
    setRead({ kind: "loading" });
    void rpc
      .call("diffRead", { threadId, target, path })
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "unsupported") setRead({ kind: "unavailable", reason: result.reason });
        else setRead({ kind: "ready", data: result });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRead({ kind: "error", message: error instanceof Error ? error.message : "This comparison could not be read" });
      });
    return () => {
      cancelled = true;
    };
    // `key` stands for `target`, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, threadId, key, path, refreshNonce, resyncNonce, listedReason]);

  const data = read.kind === "ready" ? read.data : null;
  const editable = data?.editable === true;
  /** Saves one read: the session takes this text unless it already has its own. */
  const seed = useMemo(
    () =>
      data === null || !data.editable || data.newContent === null || data.sha256 === null
        ? null
        : { content: data.newContent, sha256: data.sha256, absolutePath: data.absolutePath, relativePath: data.relativePath },
    [data],
  );
  const file = useFileSession({
    source: data?.source ?? NO_SOURCE,
    path: editable ? path : null,
    seed,
  });
  const { state, viewId, isEditor } = file;

  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const saveFile = file.save;
  const overwriteFile = file.overwrite;
  const save = useCallback(() => {
    void saveFile().then((written) => {
      if (written) savedRef.current();
    });
  }, [saveFile]);
  const overwrite = useCallback(() => {
    void overwriteFile().then((written) => {
      if (written) savedRef.current();
    });
  }, [overwriteFile]);

  // A refresh looks for a change made outside the editor too, so the
  // comparison and the working file agree afterwards. Only a new request
  // counts; `refresh` is stable, so a render alone does not read the file.
  const handledRefresh = useRef(refreshNonce);
  const refreshFile = file.refresh;
  useEffect(() => {
    if (refreshNonce === handledRefresh.current) return;
    handledRefresh.current = refreshNonce;
    void refreshFile();
  }, [refreshNonce, refreshFile]);

  /** Saves keep the live editor; external reads still revalidate the comparison. */
  const resynced = useRef<string | null>(null);
  useEffect(() => {
    if (data === null || state === null || state.load.kind !== "ready") return;
    const action = diffSessionSync(data.sha256, state);
    if (action === "none") return;
    if (action === "saved") {
      // Pierre already has the edited document. A successful save changes
      // the disk hash, not the baseline, cursor, selection, scroll or history.
      setRead((current) => current.kind === "ready" && current.data === data
        ? { kind: "ready", data: { ...data, sha256: state.sha256, newContent: state.savedContent } }
        : current);
      return;
    }
    const pair = `${data.sha256}|${state.sha256}`;
    if (resynced.current === pair) return;
    resynced.current = pair;
    setResyncNonce((nonce) => nonce + 1);
  }, [data, state]);

  // Auto save waits for a pause in typing, and re-arms while the text keeps changing.
  const saveKind = state?.save.kind;
  useEffect(() => {
    if (prefs.autoSave !== "afterDelay" || saveKind !== "dirty") return;
    const timer = setTimeout(save, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [prefs.autoSave, saveKind, state?.content, save]);

  const dirty = state?.dirty === true;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const conflicted = state?.save.kind === "conflict";
  const readOnly = !editable || !isEditor;
  const indicator = indicatorFor(read, state);

  /** A read refuses while the user is typing; say so instead of doing nothing. */
  const discardFile = file.discard;
  const reloadFile = file.reload;
  const reload = useCallback(
    (discardEdits: boolean) => {
      void (discardEdits ? discardFile() : reloadFile()).then((outcome) => {
        if (!outcome.ok) toast.message(outcome.message);
      });
    },
    [discardFile, reloadFile],
  );

  // The command palette acts on the pane that had focus last. The Changes tab
  // registers the same way the Files tab does, so Save, Find and Go to line
  // reach the comparison the user is in.
  const active = useRef<ActiveEditor>({
    id: paneId,
    element: null,
    handle: null,
    absolutePath: path,
    relativePath: path,
    save: () => {},
    quickOpen: null,
    toggleTree: null,
    goToLine: null,
    toggleWordWrap: null,
  }).current;
  useEffect(() => {
    active.element = rootRef.current;
    active.handle = surfaceRef.current;
    active.absolutePath = data?.absolutePath || path;
    active.relativePath = data?.relativePath || path;
    active.save = save;
    active.toggleTree = onToggleList;
    active.toggleWordWrap = () => onSetPref("wordWrap", !prefs.wordWrap);
  });
  useEffect(() => () => forgetEditor(paneId), [paneId]);

  const menuItems: MenuItem[] = [
    { label: "Revert hunk at cursor", disabled: readOnly, onSelect: () => {
      if (!surfaceRef.current?.revertHunk()) toast.info("Place the cursor in a changed hunk first");
    } },
    { label: "Save file", shortcut: "⌘S", disabled: !dirty || conflicted, onSelect: save },
    { label: "Discard changes", disabled: !dirty, onSelect: () => reload(true) },
    { label: "Reload from disk", disabled: dirty || !editable, onSelect: () => reload(false) },
    { type: "separator" },
    ...(onOpenFile === null ? [] : [{ label: "Open in the Files tab", onSelect: onOpenFile } satisfies MenuItem]),
    { label: "Copy relative path", onSelect: () => void copyText(data?.relativePath ?? path, "Relative path copied") },
    { label: "Copy absolute path", disabled: data === null, onSelect: () => void copyText(data?.absolutePath ?? path, "Absolute path copied") },
    { type: "separator" },
    { type: "toggle", label: "Word wrap", checked: prefs.wordWrap, onToggle: (next) => onSetPref("wordWrap", next) },
    { type: "toggle", label: "Auto save", checked: prefs.autoSave !== "off", onToggle: (next) => onSetPref("autoSave", next ? "afterDelay" : "off") },
  ];

  // The old side is the record the server read; a null side means the file
  // did not exist there. The new side is the working file when there is one,
  // so the comparison follows what the user types.
  const oldSide = data?.oldContent ?? null;
  const newSide = data === null ? null : editable && state !== null ? state.content : data.newContent;
  const previewable = hasPreview(path) && newSide !== null;
  const showPreview = previewable && previewing;
  // A working file must finish its session load before it can accept edits.
  // Otherwise a slow read exposes the session's initial empty document, and
  // typing into it invalidates the read that would have loaded the file.
  const sessionReady = !editable || state?.load.kind === "ready";
  const visibleRead: ReadState = sessionReady || read.kind !== "ready"
    ? read
    : state?.load.kind === "error"
      ? { kind: "error", message: state.load.message }
      : state?.load.kind === "unsupported"
        ? { kind: "unavailable", reason: state.load.reason }
        : { kind: "loading" };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <FileBar
        entry={entry}
        path={path}
        indicator={indicator}
        canPrevious={navigation.canPrevious}
        canNext={navigation.canNext}
        onPrevious={navigation.previous}
        onNext={navigation.next}
        onOpenFile={onOpenFile}
        menuItems={menuItems}
        listOpen={listOpen}
        listSide={listSide}
        onToggleList={onToggleList}
        preview={previewable ? { active: previewing, onToggle: () => setPreviewing((value) => !value) } : undefined}
      />
      <Notices
        read={read}
        state={state}
        isEditor={isEditor}
        onSave={save}
        onOverwrite={overwrite}
        onReload={() => reload(false)}
        onRestoreDraft={file.restoreDraft}
        onDiscardDraft={file.discardDraft}
        onTakeOver={() => {
          file.claimEditor();
          surfaceRef.current?.focus();
        }}
        onOpenFile={onOpenFile}
      />
      <div className="relative min-h-0 flex-1">
        {showPreview && data !== null && newSide !== null ? (
          // The new side as it renders, following the shared buffer like the Files tab.
          <MarkdownPreview
            source={data.source}
            path={path}
            relativePath={data.relativePath || path}
            rootPath={workspaceRoot(data.absolutePath, data.relativePath)}
            content={newSide}
            onOpenPath={onOpenPath}
          />
        ) : data !== null && baseUrl !== null && sessionReady ? (
          <PierreSurface
            ref={surfaceRef}
            baseUrl={baseUrl}
            viewId={viewId}
            name={path}
            content={newSide}
            epoch={state?.epoch ?? 0}
            epochAuthor={state?.epochAuthor ?? null}
            oldContent={oldSide}
            oldName={data.previousPath ?? undefined}
            readOnly={readOnly}
            allowRevertHunk={!readOnly}
            diffStyle={layout}
            wrap={prefs.wordWrap}
            lineNumbers={prefs.lineNumbers}
            fileHeader={false}
            expandUnchanged={expandUnchanged}
            fontSize={prefs.fontSize}
            lineHeight={Math.round(prefs.fontSize * 1.5)}
            theme={theme}
            onChange={(text) => file.setContent(text)}
            onSave={save}
            onFocus={() => {
              markEditorActive(active);
              file.claimEditor();
            }}
            onBlur={() => {
              if (prefs.autoSave === "onBlur" && dirtyRef.current) save();
            }}
            onStatusChange={setSurfaceStatus}
            className="absolute inset-0"
          />
        ) : null}
        {showPreview ? null : <PaneState read={visibleRead} surface={surfaceStatus} entry={entry} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}

/** What the pane shows in place of a comparison: loading, a reason, an error. */
function PaneState({
  read,
  surface,
  entry,
  onOpenFile,
}: {
  read: ReadState;
  surface: PierreSurfaceStatus;
  entry: DiffEntry | null;
  onOpenFile: (() => void) | null;
}) {
  if (read.kind === "ready" && surface.kind === "ready") return null;
  const problem =
    read.kind === "error"
      ? { message: read.message, tone: "error" as const }
      : read.kind === "unavailable"
        ? { message: read.reason, tone: "muted" as const }
        : surface.kind === "error" && read.kind === "ready"
          ? { message: surface.message, tone: "error" as const }
          : null;
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center",
        problem === null && "pointer-events-none",
      )}
    >
      <p className={cn("max-w-sm text-sm", problem?.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
        {problem?.message ?? "Loading the comparison…"}
      </p>
      {problem !== null && entry !== null ? <p className="text-xs text-subtle-foreground">{changeLabel(entry)}</p> : null}
      {problem !== null && onOpenFile !== null ? (
        <button
          type="button"
          onClick={onOpenFile}
          className={cn(
            "cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-foreground",
            "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          Open this file
        </button>
      ) : null}
    </div>
  );
}

function Notices({
  read,
  state,
  isEditor,
  onSave,
  onOverwrite,
  onReload,
  onRestoreDraft,
  onDiscardDraft,
  onTakeOver,
  onOpenFile,
}: {
  read: ReadState;
  state: FileSessionSnapshot | null;
  isEditor: boolean;
  onSave: () => void;
  onOverwrite: () => void;
  onReload: () => void;
  onRestoreDraft: () => void;
  onDiscardDraft: () => void;
  onTakeOver: () => void;
  onOpenFile: (() => void) | null;
}) {
  const rows: React.ReactNode[] = [];
  if (state?.save.kind === "conflict") {
    rows.push(
      <NoticeRow key="conflict" tone="error">
        This file changed on disk since you opened it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>,
    );
  } else if (state?.save.kind === "error") {
    rows.push(
      <NoticeRow key="save-error" tone="error">
        {state.save.message}
        <NoticeAction onClick={onSave}>Try again</NoticeAction>
      </NoticeRow>,
    );
  } else if (state?.staleBase === true) {
    // Found by the session's own check, before any save was tried.
    rows.push(
      <NoticeRow key="stale" tone="warning">
        This file changed on disk while you were editing it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onSave}>Keep mine</NoticeAction>
      </NoticeRow>,
    );
  }
  if (state?.draft.kind === "stale") {
    rows.push(
      <NoticeRow key="draft-stale" tone="warning">
        The file changed on disk after your unsaved changes were kept.
        <NoticeAction onClick={onRestoreDraft}>Restore them</NoticeAction>
        <NoticeAction onClick={onDiscardDraft}>Discard them</NoticeAction>
      </NoticeRow>,
    );
  } else if (state?.draft.kind === "restored") {
    rows.push(
      <NoticeRow key="draft-restored" tone="warning">
        Unsaved changes from earlier were put back.
        <NoticeAction onClick={onDiscardDraft}>Discard them</NoticeAction>
      </NoticeRow>,
    );
  } else if (state?.draft.kind === "unstored") {
    rows.push(
      <NoticeRow key="draft-unstored" tone="warning">
        Unsaved changes are not being kept: {state.draft.reason}
      </NoticeRow>,
    );
  }
  if (state !== null && !isEditor) {
    rows.push(
      <NoticeRow key="owner" tone="warning">
        This file is being edited in another view.
        <NoticeAction onClick={onTakeOver}>Edit it here</NoticeAction>
      </NoticeRow>,
    );
  }
  if (state?.load.kind === "error") {
    rows.push(
      <NoticeRow key="load-error" tone="error">
        The working file could not be read: {state.load.message}
        <NoticeAction onClick={onReload}>Try again</NoticeAction>
      </NoticeRow>,
    );
  }
  // A read that succeeded but refuses editing says why, once.
  if (read.kind === "ready" && !read.data.editable && read.data.reason !== null) {
    rows.push(
      <NoticeRow key="read-only" tone="warning">
        {read.data.reason}
        {onOpenFile === null ? null : <NoticeAction onClick={onOpenFile}>Open this file</NoticeAction>}
      </NoticeRow>,
    );
  }
  return <>{rows}</>;
}

function indicatorFor(read: ReadState, state: FileSessionSnapshot | null): SaveIndicator {
  if (read.kind === "error") return "error";
  if (state === null) return "clean";
  switch (state.save.kind) {
    case "saving":
      return "saving";
    case "dirty":
      return "dirty";
    case "error":
    case "conflict":
      return "error";
    default:
      return "clean";
  }
}
