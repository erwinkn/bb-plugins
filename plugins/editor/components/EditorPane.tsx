import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ComponentType, Ref } from "react";
import { Markdown, useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { AUTO_SAVE_DELAY_MS, lineHeightFor, monoFontFamily, type EditorPrefs, type TreeSide } from "@/lib/editor-options";
import { copyText, forgetEditor, markEditorActive, type ActiveEditor } from "@/lib/editor-commands";
import { useFileSession } from "@/lib/use-file-session";
import type { FileSessionSnapshot } from "@/lib/file-session";
import { usePierreTheme } from "@/lib/pierre-theme";
import { cn } from "@/lib/utils";
import PierreSurface, { type PierreSurfaceHandle, type PierreSurfaceStatus } from "./PierreSurface";
import type { MenuItem } from "./ContextMenu";
import { GoToLine } from "./GoToLine";
import { Toolbar, type SaveIndicator } from "./Toolbar";

/** Files that open as a rendered preview, with the editor one switch away. */
const PREVIEW_EXTENSIONS = new Set(["md", "markdown"]);

export function hasPreview(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && PREVIEW_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Which previewed files the user switched to the editor, for this page. */
const editingByPath = new Map<string, boolean>();

export interface EditorPaneHandle {
  isDirty(): boolean;
  save(): Promise<boolean>;
  focus(): void;
}

export type PrefToggle = "wordWrap" | "lineNumbers";
/** A preference write from the editor chrome: key and the value it takes. */
export type PrefWrite = [PrefToggle, boolean] | ["autoSave", "off" | "afterDelay"];
export type SetPref = (...write: PrefWrite) => void;

export interface EditorPaneProps {
  paneId: string;
  source: PluginFileOpenerSource;
  path: string;
  prefs: EditorPrefs;
  treeOpen: boolean;
  treeSide: TreeSide;
  onToggleTree: () => void;
  onQuickOpen: (() => void) | null;
  onOpenInTab: (() => void) | null;
  history: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void };
  onSetPref: SetPref;
  /** A Pierre theme name being previewed by the picker; null follows BB. */
  themePreview: string | null;
  onPickTheme: () => void;
  /** BB's preview for this file; rendered when the file is not editable text. */
  Original?: ComponentType;
  /** Changes when the user opened the file deliberately; the editor takes focus. */
  focusNonce?: number;
  ref?: Ref<EditorPaneHandle>;
}

/**
 * One file, open for editing.
 *
 * The buffer, the save queue and the draft live in the shared file session
 * (`lib/file-session.ts`), not in this component, so the same file opened in
 * the Changes tab is the same buffer with the same unsaved work. This
 * component owns the chrome: the toolbar, the banners and the editor surface.
 */
export function EditorPane({
  paneId,
  source,
  path,
  prefs,
  treeOpen,
  treeSide,
  onToggleTree,
  onQuickOpen,
  onOpenInTab,
  history,
  onSetPref,
  themePreview,
  onPickTheme,
  Original,
  focusNonce = 0,
  ref,
}: EditorPaneProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<PierreSurfaceHandle | null>(null);
  const [assets, setAssets] = useState<{ baseUrl: string } | { error: string } | null>(null);
  const [surfaceStatus, setSurfaceStatus] = useState<PierreSurfaceStatus>({ kind: "loading" });
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  // A Markdown file opens as its rendered preview. The editor is one switch
  // away and the choice is remembered for the file while the page lives.
  const previewable = hasPreview(path);
  const [, rerender] = useState(0);
  const editing = !previewable || (editingByPath.get(path) ?? false);
  /** Set by a switch to the editor: the caret goes there once it exists. */
  const focusEditor = useRef(false);
  const setEditing = (next: boolean) => {
    editingByPath.set(path, next);
    focusEditor.current = next;
    rerender((n) => n + 1);
  };

  const file = useFileSession({ source, path });
  const state = file.state;
  const { save, overwrite, reload, discard, setContent, claimEditor, isEditor } = file;

  const theme = usePierreTheme(themePreview);

  useEffect(() => {
    let cancelled = false;
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
  }, [rpc]);

  // Auto save. The timer restarts on every keystroke, so it fires once the
  // user stops. Only a plain dirty file is saved: a conflict or a failed save
  // waits for the user, and a save in flight settles itself.
  useEffect(() => {
    if (prefs.autoSave !== "afterDelay" || state?.save.kind !== "dirty") return;
    const timer = setTimeout(() => void save(), AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [prefs.autoSave, save, state?.save.kind, state?.content]);

  useImperativeHandle(
    ref,
    () => ({
      // A save in flight still counts: its outcome is not known yet.
      isDirty: () => file.session?.getSnapshot().dirty ?? false,
      save,
      focus: () => void surfaceRef.current?.focus(),
    }),
    [file.session, save],
  );

  const reloadFile = useCallback(() => {
    void reload().then((outcome) => {
      if (!outcome.ok && outcome.reason === "changed-while-reading") toast.message(outcome.message);
    });
  }, [reload]);
  const discardEdits = useCallback(() => {
    void discard().then((outcome) => {
      if (!outcome.ok && outcome.reason === "changed-while-reading") toast.message(outcome.message);
    });
  }, [discard]);

  // The command palette acts on the pane that had focus last. The registered
  // object is stable and its fields are refreshed, so a command run later
  // still sees the file that is open now.
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
    active.absolutePath = state?.absolutePath || path;
    active.relativePath = state?.relativePath || path;
    active.save = () => void save();
    active.quickOpen = onQuickOpen;
    active.toggleTree = onToggleTree;
    active.goToLine = () => setGoToLineOpen(true);
    active.toggleWordWrap = () => onSetPref("wordWrap", !prefs.wordWrap);
  });
  useEffect(() => () => forgetEditor(paneId), [paneId]);

  // Focus follows a deliberate open, once the surface can take it.
  const focused = useRef(0);
  useEffect(() => {
    if (surfaceStatus.kind !== "ready" || !editing) return;
    if (focusEditor.current) {
      focusEditor.current = false;
      if (surfaceRef.current?.focus()) focused.current = focusNonce;
      return;
    }
    if (focusNonce === focused.current) return;
    if (surfaceRef.current?.focus()) focused.current = focusNonce;
  }, [focusNonce, surfaceStatus.kind, path, editing]);

  const lineCount = useMemo(() => (state?.content ?? "").split("\n").length, [state?.content]);
  const unsupported = state?.load.kind === "unsupported";
  const readOnly = !isEditor || unsupported;

  // Find, replace and go-to-line need the editor, so they leave the preview.
  const withEditor = (run: () => void) => {
    if (editing) run();
    else setEditing(true);
  };

  const menuItems: MenuItem[] = [
    { label: "Save file", shortcut: "⌘S", disabled: !(state?.dirty ?? false), onSelect: () => void save() },
    { label: "Discard changes", disabled: !(state?.hasEdits ?? false), onSelect: discardEdits },
    { label: "Reload from disk", disabled: state?.hasEdits ?? true, onSelect: reloadFile },
    { type: "separator" },
    ...(previewable
      ? [{ type: "toggle", label: "Edit the source", checked: editing, onToggle: setEditing } satisfies MenuItem, { type: "separator" } satisfies MenuItem]
      : []),
    { label: "Find…", shortcut: "⌘F", onSelect: () => withEditor(() => runOnSurface(surfaceRef, (handle) => handle.openSearch())) },
    { label: "Find and replace…", onSelect: () => withEditor(() => runOnSurface(surfaceRef, (handle) => handle.openSearchReplace())) },
    { label: "Go to line…", onSelect: () => withEditor(() => setGoToLineOpen(true)) },
    { type: "separator" },
    ...(onOpenInTab === null ? [] : [{ label: "Open in new tab", onSelect: onOpenInTab } as MenuItem]),
    { label: "Copy relative path", onSelect: () => void copyText(state?.relativePath ?? path, "Relative path copied") },
    { label: "Copy absolute path", onSelect: () => void copyText(state?.absolutePath ?? path, "Absolute path copied") },
    { type: "separator" },
    { label: "Theme…", onSelect: onPickTheme },
    { type: "separator" },
    { type: "toggle", label: "Line numbers", checked: prefs.lineNumbers, onToggle: (next) => onSetPref("lineNumbers", next) },
    { type: "toggle", label: "Word wrap", checked: prefs.wordWrap, onToggle: (next) => onSetPref("wordWrap", next) },
    { type: "toggle", label: "Auto save", checked: prefs.autoSave !== "off", onToggle: (next) => onSetPref("autoSave", next ? "afterDelay" : "off") },
  ];

  const loading = state === null || state.load.kind === "loading" || (assets === null && !unsupported && editing);
  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <Toolbar
        path={path}
        indicator={indicatorFor(state, surfaceStatus)}
        canGoBack={history.canBack}
        canGoForward={history.canForward}
        onBack={history.back}
        onForward={history.forward}
        onFind={() => withEditor(() => runOnSurface(surfaceRef, (handle) => handle.openSearch()))}
        menuItems={menuItems}
        treeOpen={treeOpen}
        treeSide={treeSide}
        onToggleTree={onToggleTree}
        editing={previewable && !unsupported ? { active: editing, onToggle: () => setEditing(!editing) } : undefined}
      />
      <Notices
        state={state}
        assetsError={assets !== null && "error" in assets ? assets.error : null}
        surfaceStatus={surfaceStatus}
        isEditor={isEditor}
        onTakeOver={claimEditor}
        onOverwrite={() => void overwrite()}
        onReload={reloadFile}
        onDiscard={discardEdits}
        onRestoreDraft={file.restoreDraft}
        onDiscardDraft={file.discardDraft}
      />
      <div className="relative min-h-0 flex-1">
        {unsupported ? (
          <div className="absolute inset-0 overflow-auto bg-background">
            {Original ? <Original /> : <p className="p-4 text-sm text-muted-foreground">{state.load.reason}</p>}
          </div>
        ) : !editing && state !== null && state.load.kind === "ready" ? (
          // The preview follows the shared buffer, so unsaved edits from the
          // Changes tab or an earlier draft show here too.
          <div className="absolute inset-0 overflow-auto bg-background" data-testid="markdown-preview">
            <Markdown content={state.content} className="mx-auto max-w-3xl px-6 py-5" />
          </div>
        ) : assets !== null && "baseUrl" in assets && state !== null && state.load.kind === "ready" ? (
          <PierreSurface
            ref={surfaceRef}
            baseUrl={assets.baseUrl}
            viewId={file.viewId}
            name={state.relativePath || path}
            content={state.content}
            epoch={state.epoch}
            epochAuthor={state.epochAuthor}
            readOnly={readOnly}
            wrap={prefs.wordWrap}
            lineNumbers={prefs.lineNumbers}
            fontSize={prefs.fontSize}
            lineHeight={lineHeightFor(prefs.fontSize)}
            fontFamily={monoFontFamily()}
            theme={theme}
            onChange={setContent}
            onSave={() => void save()}
            onFocus={() => {
              claimEditor();
              markEditorActive(active);
            }}
            onBlur={() => {
              if (prefs.autoSave === "onBlur" && (file.session?.getSnapshot().save.kind ?? "clean") === "dirty") void save();
            }}
            onStatusChange={setSurfaceStatus}
            className="absolute inset-0"
          />
        ) : null}
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Loading editor…</div>
        ) : null}
        {goToLineOpen ? (
          <GoToLine
            lineCount={lineCount}
            onGo={(line, character) => {
              surfaceRef.current?.goToLine(line, character);
              surfaceRef.current?.focus({ lineNumber: line, character });
            }}
            onClose={() => setGoToLineOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function runOnSurface(ref: { current: PierreSurfaceHandle | null }, run: (handle: PierreSurfaceHandle) => void): void {
  const handle = ref.current;
  if (handle === null || handle.status().kind !== "ready") return;
  handle.focus();
  run(handle);
}

function indicatorFor(state: FileSessionSnapshot | null, surface: PierreSurfaceStatus): SaveIndicator {
  if (state === null) return "clean";
  if (state.load.kind === "error" || surface.kind === "error") return "error";
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

function Notices({
  state,
  assetsError,
  surfaceStatus,
  isEditor,
  onTakeOver,
  onOverwrite,
  onReload,
  onDiscard,
  onRestoreDraft,
  onDiscardDraft,
}: {
  state: FileSessionSnapshot | null;
  assetsError: string | null;
  surfaceStatus: PierreSurfaceStatus;
  isEditor: boolean;
  onTakeOver: () => void;
  onOverwrite: () => void;
  onReload: () => void;
  onDiscard: () => void;
  onRestoreDraft: () => void;
  onDiscardDraft: () => void;
}) {
  if (assetsError !== null) return <NoticeRow tone="error">{assetsError}</NoticeRow>;
  if (surfaceStatus.kind === "error") return <NoticeRow tone="error">{surfaceStatus.message}</NoticeRow>;
  if (state === null) return null;
  if (state.load.kind === "error") return <NoticeRow tone="error">{state.load.message}</NoticeRow>;
  if (state.save.kind === "conflict") {
    return (
      <NoticeRow tone="error">
        This file changed on disk since you opened it.
        <NoticeAction onClick={onDiscard}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>
    );
  }
  if (state.save.kind === "error") return <NoticeRow tone="error">{state.save.message}</NoticeRow>;
  if (state.draft.kind === "stale") {
    return (
      <NoticeRow tone="warning">
        Unsaved changes from an earlier session were made against another version of this file.
        <NoticeAction onClick={onRestoreDraft}>Restore them</NoticeAction>
        <NoticeAction onClick={onDiscardDraft}>Discard them</NoticeAction>
      </NoticeRow>
    );
  }
  if (state.staleBase) {
    return (
      <NoticeRow tone="warning">
        This file changed on disk while you were editing it. Saving will report a conflict.
        <NoticeAction onClick={onDiscard}>Take the file from disk</NoticeAction>
      </NoticeRow>
    );
  }
  if (state.draft.kind === "restored") {
    return (
      <NoticeRow tone="warning">
        Unsaved changes from an earlier session were restored.
        <NoticeAction onClick={onDiscardDraft}>Discard them</NoticeAction>
      </NoticeRow>
    );
  }
  if (state.draft.kind === "unstored") return <NoticeRow tone="warning">{state.draft.reason}</NoticeRow>;
  if (!isEditor) {
    return (
      <NoticeRow tone="warning">
        This file is being edited in another view.
        <NoticeAction onClick={onTakeOver}>Edit here</NoticeAction>
      </NoticeRow>
    );
  }
  return null;
}

export function NoticeRow({ children, tone }: { children: React.ReactNode; tone: "error" | "warning" }) {
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs",
        tone === "error" ? "bg-destructive/10 text-destructive" : "bg-surface-recessed text-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function NoticeAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-sm font-medium underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}
