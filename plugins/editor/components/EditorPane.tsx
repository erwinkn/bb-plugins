import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ComponentType } from "react";
import { experimental_useCodeTheme, useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import type { rpcContract } from "../server";
import { languageForPath } from "@/lib/languages";
import {
  loadEditor,
  overflowWidgetsNode,
  setOverflowWidgetsTheme,
  setTypeScriptDiagnostics,
  type EditorRuntime,
} from "@/lib/monaco-loader";
import { AUTO_SAVE_DELAY_MS, baseEditorOptions, prefEditorOptions, type EditorPrefs, type TreeSide } from "@/lib/editor-options";
import { copyText, forgetEditor, markEditorActive } from "@/lib/editor-commands";
import { resolveBbTokens } from "@/lib/bb-tokens";
import { FOLLOW_BB } from "@/lib/themes";
import { cn } from "@/lib/utils";
import type { MenuItem } from "./ContextMenu";
import { Toolbar, type SaveIndicator } from "./Toolbar";

export type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict" };

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

export interface EditorPaneHandle {
  isDirty(): boolean;
  save(): Promise<boolean>;
  focus(): void;
}

export type PrefToggle = "wordWrap" | "minimap" | "lineNumbers" | "formatOnSave";
/** A preference write from the editor chrome: key and the value it takes. */
export type PrefWrite = [PrefToggle, boolean] | ["autoSave", "off" | "afterDelay"] | ["darkTheme" | "lightTheme", string];
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
  /** A theme id being previewed by the picker; null shows the saved preference. */
  themePreview: string | null;
  onPickTheme: () => void;
  /** BB's preview for this file; rendered when the file is not editable text. */
  Original?: ComponentType;
  /** Changes when the user opened the file deliberately; the editor takes focus. */
  focusNonce?: number;
}

interface OpenFile {
  path: string;
  absolutePath: string;
  relativePath: string;
  model: MonacoNs.editor.ITextModel;
  sha256: string | null;
  savedVersionId: number;
}

export const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(function EditorPane(
  { paneId, source, path, prefs, treeOpen, treeSide, onToggleTree, onQuickOpen, onOpenInTab, history, onSetPref, themePreview, onPickTheme, Original, focusNonce = 0 },
  ref,
) {
  const rpc = useRpc<typeof rpcContract>();
  const codeTheme = experimental_useCodeTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<EditorRuntime | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef<OpenFile | null>(null);
  const viewStates = useRef(new Map<string, MonacoNs.editor.ICodeEditorViewState>());
  const saveStateRef = useRef<SaveState>({ kind: "clean" });
  const [saveState, setSaveStateValue] = useState<SaveState>({ kind: "clean" });
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The theme to show: the picker's preview, else the saved choice for BB's mode.
  const themeChoice = themePreview ?? (codeTheme.mode === "dark" ? prefs.darkTheme : prefs.lightTheme);
  const latest = useRef({ prefs, onToggleTree, onQuickOpen, codeTheme, themeChoice, focusNonce });
  latest.current = { prefs, onToggleTree, onQuickOpen, codeTheme, themeChoice, focusNonce };
  const focusedNonce = useRef(focusNonce);

  const setSaveState = useCallback((next: SaveState) => {
    saveStateRef.current = next;
    setSaveStateValue(next);
  }, []);

  const write = useCallback(
    async (expectedSha256: string | null): Promise<boolean> => {
      const file = fileRef.current;
      if (file === null || saveStateRef.current.kind === "saving") return false;
      if (latest.current.prefs.formatOnSave) {
        // No-op for languages without a formatter; the TS/JSON/CSS/HTML workers provide one.
        await editorRef.current?.getAction("editor.action.formatDocument")?.run();
        if (fileRef.current !== file) return false;
      }
      const versionId = file.model.getAlternativeVersionId();
      setSaveState({ kind: "saving" });
      try {
        const result = await rpc.call("write", {
          path: file.path,
          source,
          content: file.model.getValue(),
          expectedSha256,
        });
        if (fileRef.current !== file) return false;
        if (result.outcome === "conflict") {
          setSaveState({ kind: "conflict" });
          return false;
        }
        file.sha256 = result.sha256;
        file.savedVersionId = versionId;
        setSaveState(file.model.getAlternativeVersionId() === versionId ? { kind: "clean" } : { kind: "dirty" });
        return true;
      } catch (error) {
        if (fileRef.current === file) {
          setSaveState({ kind: "error", message: error instanceof Error ? error.message : "Save failed" });
        }
        return false;
      }
    },
    [rpc, setSaveState, source],
  );

  const save = useCallback(() => write(fileRef.current?.sha256 ?? null), [write]);
  const overwrite = useCallback(() => write(null), [write]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const reloadFromDisk = useCallback(async () => {
    const file = fileRef.current;
    if (file === null) return;
    try {
      const result = await rpc.call("read", { path: file.path, source });
      if (fileRef.current !== file || result.kind !== "text") return;
      file.model.setValue(result.content);
      file.sha256 = result.sha256;
      file.savedVersionId = file.model.getAlternativeVersionId();
      setSaveState({ kind: "clean" });
    } catch (error) {
      setSaveState({ kind: "error", message: error instanceof Error ? error.message : "Reload failed" });
    }
  }, [rpc, setSaveState, source]);

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => saveStateRef.current.kind !== "clean" && saveStateRef.current.kind !== "saving",
      save,
      focus: () => editorRef.current?.focus(),
    }),
    [save],
  );

  // Create the editor once per pane; models come and go with `path`.
  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (container === null) return;
    void (async () => {
      try {
        const { baseUrl } = await rpc.call("assets");
        const runtime = await loadEditor(baseUrl);
        if (disposed) return;
        runtimeRef.current = runtime;
        const { monaco } = runtime;
        const { name: themeName, type: themeType } = await resolveTheme(runtime, latest.current.codeTheme, latest.current.themeChoice, container);
        if (disposed) return;
        setOverflowWidgetsTheme(themeType === "light" ? "vs" : "vs-dark");
        const editor = monaco.editor.create(container, {
          ...baseEditorOptions(latest.current.prefs, overflowWidgetsNode()),
          theme: themeName,
          model: null,
        });
        editorRef.current = editor;
        setTypeScriptDiagnostics(monaco, latest.current.prefs.typescriptDiagnostics);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => latest.current.onQuickOpen?.());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => latest.current.onToggleTree());
        editor.onDidChangeModelContent(() => {
          const file = fileRef.current;
          if (file === null) return;
          const dirty = file.model.getAlternativeVersionId() !== file.savedVersionId;
          const current = saveStateRef.current.kind;
          if (current === "saving" || current === "conflict") return;
          if (dirty && current !== "dirty" && current !== "error") setSaveState({ kind: "dirty" });
          if (!dirty && current === "dirty") setSaveState({ kind: "clean" });
          if (latest.current.prefs.autoSave === "afterDelay" && dirty) {
            if (autosaveTimer.current !== null) clearTimeout(autosaveTimer.current);
            autosaveTimer.current = setTimeout(() => void saveRef.current(), AUTO_SAVE_DELAY_MS);
          }
        });
        editor.onDidBlurEditorWidget(() => {
          if (latest.current.prefs.autoSave === "onBlur" && saveStateRef.current.kind === "dirty") void saveRef.current();
        });
        editor.onDidFocusEditorWidget(() => {
          const file = fileRef.current;
          if (file === null) return;
          markEditorActive({
            editor,
            absolutePath: file.absolutePath,
            relativePath: file.relativePath,
            save: () => void saveRef.current(),
            quickOpen: latest.current.onQuickOpen,
            toggleTree: latest.current.onToggleTree,
          });
        });
        setStatus({ kind: "ready" });
      } catch (error) {
        if (disposed) return;
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not start the editor" });
      }
    })();
    return () => {
      disposed = true;
      if (autosaveTimer.current !== null) clearTimeout(autosaveTimer.current);
      const editor = editorRef.current;
      if (editor !== null) forgetEditor(editor);
      fileRef.current?.model.dispose();
      fileRef.current = null;
      editor?.dispose();
      editorRef.current = null;
    };
  }, [rpc, setSaveState]);

  // Open `path` in the editor whenever it, or the editor, changes.
  const editorReady = status.kind === "ready" || status.kind === "unsupported";
  useEffect(() => {
    if (!editorReady) return;
    const runtime = runtimeRef.current;
    const editor = editorRef.current;
    if (runtime === null || editor === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await rpc.call("read", { path, source });
        if (cancelled) return;
        const previous = fileRef.current;
        if (previous !== null) {
          const viewState = editor.saveViewState();
          if (viewState !== null) viewStates.current.set(previous.path, viewState);
          fileRef.current = null;
          editor.setModel(null);
          previous.model.dispose();
        }
        if (result.kind === "unsupported") {
          setSaveState({ kind: "clean" });
          setStatus({ kind: "unsupported", reason: result.reason });
          return;
        }
        const { monaco, shiki } = runtime;
        const language = languageForPath(path);
        const uri = monaco.Uri.from({ scheme: "bb-editor", authority: paneId, path: toUriPath(result.absolutePath) });
        monaco.editor.getModel(uri)?.dispose();
        const model = monaco.editor.createModel(result.content, language.id, uri);
        const file: OpenFile = {
          path,
          absolutePath: result.absolutePath,
          relativePath: result.relativePath,
          model,
          sha256: result.sha256,
          savedVersionId: model.getAlternativeVersionId(),
        };
        fileRef.current = file;
        editor.setModel(model);
        const viewState = viewStates.current.get(path);
        if (viewState !== undefined) editor.restoreViewState(viewState);
        setSaveState({ kind: "clean" });
        setStatus({ kind: "ready" });
        if (latest.current.focusNonce !== focusedNonce.current) {
          focusedNonce.current = latest.current.focusNonce;
          editor.focus();
        }
        markEditorActive({
          editor,
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          save: () => void saveRef.current(),
          quickOpen: latest.current.onQuickOpen,
          toggleTree: latest.current.onToggleTree,
        });
        void shiki.ensureLanguage(language).catch((error: unknown) => {
          console.warn(`[erwin-editor] grammar for ${language.id} did not load`, error);
        });
      } catch (error) {
        if (cancelled) return;
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not open this file" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `editorReady` flips once the editor exists; `status` itself must not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorReady, paneId, path, rpc, setSaveState, source]);

  // Follow the chosen theme: BB's own (with light/dark switches and palette
  // changes), a bundled one, or the picker's preview.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime === null || status.kind === "loading") return;
    let cancelled = false;
    void (async () => {
      const { name, type } = await resolveTheme(runtime, codeTheme, themeChoice, containerRef.current);
      if (cancelled) return;
      runtime.monaco.editor.setTheme(name);
      setOverflowWidgetsTheme(type === "light" ? "vs" : "vs-dark");
    })().catch((error: unknown) => {
      console.warn("[erwin-editor] could not apply the code theme", error);
    });
    return () => {
      cancelled = true;
    };
    // The hook may hand back the previous document while a switch is in
    // flight, so the name and mode are dependencies of their own.
  }, [codeTheme, codeTheme.name, codeTheme.mode, codeTheme.theme, themeChoice, status.kind]);

  useEffect(() => {
    editorRef.current?.updateOptions(prefEditorOptions(prefs));
    const runtime = runtimeRef.current;
    if (runtime !== null) setTypeScriptDiagnostics(runtime.monaco, prefs.typescriptDiagnostics);
  }, [prefs, status.kind]);

  const dirty = saveState.kind === "dirty" || saveState.kind === "error";
  const menuItems: MenuItem[] = [
    { label: "Save file", shortcut: "⌘S", disabled: !dirty, onSelect: () => void save() },
    { label: "Discard changes", disabled: !dirty, onSelect: () => void reloadFromDisk() },
    { label: "Reload from disk", disabled: dirty, onSelect: () => void reloadFromDisk() },
    { type: "separator" },
    ...(onOpenInTab === null ? [] : [{ label: "Open in new tab", onSelect: onOpenInTab }]),
    { label: "Copy relative path", onSelect: () => void copyText(fileRef.current?.relativePath ?? path, "Relative path copied") },
    { label: "Copy absolute path", onSelect: () => void copyText(fileRef.current?.absolutePath ?? path, "Absolute path copied") },
    { type: "separator" },
    { label: "Theme…", onSelect: onPickTheme },
    { type: "separator" },
    { type: "toggle", label: "Line numbers", checked: prefs.lineNumbers, onToggle: (next) => onSetPref("lineNumbers", next) },
    { type: "toggle", label: "Word wrap", checked: prefs.wordWrap, onToggle: (next) => onSetPref("wordWrap", next) },
    { type: "toggle", label: "Minimap", checked: prefs.minimap, onToggle: (next) => onSetPref("minimap", next) },
    { type: "toggle", label: "Auto save", checked: prefs.autoSave !== "off", onToggle: (next) => onSetPref("autoSave", next ? "afterDelay" : "off") },
    { type: "toggle", label: "Format on save", checked: prefs.formatOnSave, onToggle: (next) => onSetPref("formatOnSave", next) },
  ];

  const unsupported = status.kind === "unsupported";
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <Toolbar
        path={path}
        indicator={indicatorFor(saveState, status)}
        canGoBack={history.canBack}
        canGoForward={history.canForward}
        onBack={history.back}
        onForward={history.forward}
        onFind={() => {
          editorRef.current?.focus();
          void editorRef.current?.getAction("actions.find")?.run();
        }}
        menuItems={menuItems}
        treeOpen={treeOpen}
        treeSide={treeSide}
        onToggleTree={onToggleTree}
      />
      <Notice status={status} saveState={saveState} onOverwrite={() => void overwrite()} onReload={() => void reloadFromDisk()} />
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className={cn("absolute inset-0", unsupported && "invisible")} />
        {unsupported ? (
          <div className="absolute inset-0 overflow-auto bg-background">
            {Original ? (
              <Original />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">{status.reason}</p>
            )}
          </div>
        ) : null}
        {status.kind === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Loading editor…
          </div>
        ) : null}
      </div>
    </div>
  );
});

function toUriPath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function indicatorFor(saveState: SaveState, status: Status): SaveIndicator {
  if (status.kind === "error") return "error";
  switch (saveState.kind) {
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

function Notice({
  status,
  saveState,
  onOverwrite,
  onReload,
}: {
  status: Status;
  saveState: SaveState;
  onOverwrite: () => void;
  onReload: () => void;
}) {
  if (status.kind === "error") return <NoticeRow tone="error">{status.message}</NoticeRow>;
  if (saveState.kind === "conflict") {
    return (
      <NoticeRow tone="error">
        This file changed on disk since you opened it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>
    );
  }
  if (saveState.kind === "error") return <NoticeRow tone="error">{saveState.message}</NoticeRow>;
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

/**
 * Registers and returns the Monaco theme for `choice`: `bb` (or an unknown
 * or unloadable id) paints with BB's document; otherwise the bundled theme.
 * Without any document, Monaco's built-in themes stand in.
 */
async function resolveTheme(
  runtime: EditorRuntime,
  bb: ReturnType<typeof experimental_useCodeTheme>,
  choice: string,
  host: HTMLElement | null,
): Promise<{ name: string; type: "dark" | "light" }> {
  let document = bb.theme;
  if (choice !== FOLLOW_BB) {
    const bundled = await runtime.loadTheme(choice).catch((error: unknown) => {
      console.warn(`[erwin-editor] theme "${choice}" did not load`, error);
      return null;
    });
    if (bundled !== null) document = bundled;
  }
  if (document === null) {
    return bb.mode === "dark" ? { name: "vs-dark", type: "dark" } : { name: "vs", type: "light" };
  }
  const name = await runtime.shiki.applyTheme(document, host === null ? null : resolveBbTokens(host));
  return { name, type: document.type };
}
