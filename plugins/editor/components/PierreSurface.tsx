import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, Ref } from "react";
import type { CodeView, CodeViewItem, CodeViewOptions, FileContents } from "@pierre/diffs";
import type { Editor, EditorFocusOptions, EditorKeymap, EditorViewState } from "@pierre/diffs/edit";
import { loadPierre, type PierreRuntime } from "@/lib/pierre-loader";
import { applyPierreTheme, type PierreThemeInput } from "@/lib/pierre-theme";
import { cn } from "@/lib/utils";

/** Where the caret goes when the surface takes focus. */
export interface PierreFocusTarget {
  /** One-based document line, or the first editable line that is on screen. */
  lineNumber?: number | "first-visible";
  /** Zero-based character offset on `lineNumber`. */
  character?: number;
  /** CSS pixels to leave above the line. */
  offset?: number;
}

export type PierreSurfaceStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string; error: unknown };

/** The editor's restorable selections and scroll position. */
export type PierreViewState = EditorViewState;

export interface PierreSurfaceProps {
  /** The asset base from the server's `assets` RPC. Treated as opaque. */
  baseUrl: string;
  /**
   * A stable id for this mounted view. Two views that are on screen at the same
   * time must not share one, because Pierre refuses to attach two editors to
   * one retained edit state.
   */
  viewId: string;
  /** The path or file name. It sets the header text and picks the language. */
  name: string;
  /** The writable side. null means a deleted file, which is always read only. */
  content: string | null;
  /** Increase to replace the document from outside. */
  epoch: number;
  /** The view that caused `epoch`. This surface ignores its own changes. */
  epochAuthor?: string | null;
  /**
   * undefined renders a plain file. A string renders a diff against it. null
   * renders a diff of an added file, which has no old side.
   */
  oldContent?: string | null;
  /** The old side's name, for a rename. Defaults to `name`. */
  oldName?: string;
  readOnly?: boolean;
  diffStyle?: "split" | "unified";
  wrap?: boolean;
  lineNumbers?: boolean;
  fileHeader?: boolean;
  expandUnchanged?: boolean;
  stickyHeader?: boolean;
  fontSize?: number;
  lineHeight?: number;
  fontFamily?: string;
  tabSize?: number;
  theme: PierreThemeInput;
  autoFocus?: PierreFocusTarget;
  /** Every document change. Never feed this text back into `content`. */
  onChange?: (text: string, viewId: string) => void;
  /** The save shortcut was pressed inside the surface. */
  onSave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onStatusChange?: (status: PierreSurfaceStatus) => void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<PierreSurfaceHandle>;
}

export interface PierreSurfaceHandle {
  status(): PierreSurfaceStatus;
  /**
   * The live document text. A read-only surface has no editor, so it reports
   * the `content` prop instead. null only before the runtime loads.
   */
  getText(): string | null;
  /** Turns editing on or off until the `readOnly` prop next changes. */
  setEditable(editable: boolean): void;
  focus(target?: PierreFocusTarget): boolean;
  blur(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  openSearch(): boolean;
  openSearchReplace(): boolean;
  findNext(previous?: boolean): boolean;
  goToLine(lineNumber: number, character?: number): boolean;
  getViewState(): PierreViewState | null;
  setViewState(state: PierreViewState): void;
  scrollToLine(lineNumber: number, align?: "start" | "center" | "end" | "nearest"): void;
}

/**
 * Pierre 1.4.1 runs search from its keymap only: `Editor` keeps `#runCommand`
 * private, and the search panel opens from a keydown on the editable element.
 * These bindings go into the editor's keymap, which the resolver checks before
 * the defaults, so the user's own Cmd+F still opens the same panel and these
 * reserved chords are what `openSearch` dispatches.
 */
const CACHE_NAMESPACE = globalThis.crypto.randomUUID();
let cacheRevision = 0;

const RESERVED_KEYMAP: EditorKeymap = [
  { bindings: { "cmdOrCtrl+F9": "openSearchPanel", "cmdOrCtrl+F10": "openSearchReplacePanel" } },
];

interface SurfaceState {
  runtime: PierreRuntime;
  view: CodeView;
  /** Identity of the document on screen. A change means a different file. */
  docKey: string;
  /** Bumped for every item replacement, so Pierre reconciles and re-caches. */
  version: number;
  epoch: number;
  /** Set by `setEditable`, cleared whenever the `readOnly` prop changes. */
  editableOverride: boolean | null;
}

/**
 * A Pierre file or diff view, editable or read only.
 *
 * The Pierre code lives in a lazily imported bundle (see `lib/pierre-loader.ts`),
 * so nothing here imports Pierre at run time; the imports above are types only.
 * That keeps Pierre and its grammars out of the plugin's app bundle and keeps a
 * second React copy out of the page.
 *
 * The document is controlled by `epoch`, not by the identity of `content`.
 * `onChange` is a notification: putting its text back into `content` would fight
 * the editor. A raised `epoch` from another author replaces the text through
 * Pierre's external-document path, which keeps the change undoable and remaps
 * live selections instead of dropping them. A changed `name` or `viewId` is a
 * different document: the old edit session ends and a new editor starts, so no
 * undo step of one file can ever reach another.
 */
export default function PierreSurface(props: PierreSurfaceProps) {
  const { baseUrl, className, style, fontSize, lineHeight, fontFamily, tabSize, ref } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<PierreSurfaceStatus>({ kind: "loading" });
  const stateRef = useRef<SurfaceState | null>(null);
  // Pierre's callbacks outlive the render that created them, so they read the
  // current props from here instead of closing over that render's values.
  const latest = useRef(props);
  latest.current = props;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let disposed = false;
    let created: CodeView | null = null;
    const publish = (next: PierreSurfaceStatus) => {
      if (disposed) return;
      setStatus(next);
      latest.current.onStatusChange?.(next);
    };
    publish({ kind: "loading" });
    loadPierre(baseUrl)
      .then((runtime) => {
        const host = hostRef.current;
        if (disposed || host === null) return;
        const props = latest.current;
        const view = new runtime.CodeView<undefined, undefined>(
          buildOptions(runtime, latest, stateRef),
          runtime.workerPool ?? undefined,
        );
        created = view;
        const version = ++cacheRevision;
        stateRef.current = {
          runtime,
          view,
          docKey: documentKey(props),
          version,
          epoch: props.epoch,
          editableOverride: null,
        };
        view.setup(host);
        view.setItems([buildItem(runtime, props, version, null)]);
        publish({ kind: "ready" });
      })
      .catch((error: unknown) => {
        // The panel draws the failure. Reporting it as a value keeps a missing
        // asset route from tearing down the surrounding tree.
        publish({ kind: "error", message: describe(error), error });
      });
    return () => {
      disposed = true;
      // cleanUp ends the edit session, so the last onChange has already run.
      created?.cleanUp();
      stateRef.current = null;
    };
  }, [baseUrl]);

  // Options apply separately from the document. Replacing them must not rebuild
  // the item, or a theme change would reset the scroll position and the caret.
  const optionsKey = [
    props.theme.id,
    props.theme.type,
    props.diffStyle,
    props.wrap,
    props.lineNumbers,
    props.fileHeader,
    props.expandUnchanged,
    props.stickyHeader,
  ].join("|");
  useEffect(() => {
    const state = stateRef.current;
    if (state === null) return;
    state.view.setOptions(buildOptions(state.runtime, latest, stateRef));
    state.view.onThemeChange();
    state.view.render();
  }, [optionsKey, status.kind]);

  // The document itself: a different file replaces the item, and everything
  // else updates it in place.
  const docKey = documentKey(props);
  useEffect(() => {
    const state = stateRef.current;
    if (state === null) return;
    if (state.docKey !== docKey) {
      state.docKey = docKey;
      state.version = ++cacheRevision;
      state.epoch = props.epoch;
      state.editableOverride = null;
      // setItems removes the old record, which ends its edit session and
      // releases its editor and undo history.
      state.view.setItems([buildItem(state.runtime, latest.current, state.version, null)]);
      return;
    }
    const sameEpoch = props.epoch === state.epoch;
    // Only another author's change re-seeds. A render during typing, and this
    // view's own echo, change nothing.
    if (sameEpoch && props.readOnly === undefined) return;
    if (!sameEpoch) {
      state.epoch = props.epoch;
      if (props.epochAuthor === props.viewId) return;
    }
    state.version = ++cacheRevision;
    state.view.updateItem(buildItem(state.runtime, latest.current, state.version, state.editableOverride));
  }, [docKey, props.epoch, props.epochAuthor, props.readOnly, props.viewId, status.kind]);

  // A changed readOnly prop takes back any imperative override.
  useEffect(() => {
    if (stateRef.current !== null) stateRef.current.editableOverride = null;
  }, [props.readOnly]);

  useEffect(() => {
    if (status.kind !== "ready" || props.autoFocus === undefined) return;
    editorOf(stateRef.current)?.focus(props.autoFocus as EditorFocusOptions);
  }, [status.kind, props.autoFocus]);

  useImperativeHandle(
    ref,
    (): PierreSurfaceHandle => ({
      status: () => statusRef.current,
      getText: () => {
        const editor = editorOf(stateRef.current);
        if (editor !== null) return editor.getText();
        return stateRef.current === null ? null : latest.current.content;
      },
      setEditable: (editable) => {
        const state = stateRef.current;
        if (state === null) return;
        state.editableOverride = editable;
        state.version = ++cacheRevision;
        state.view.updateItem(buildItem(state.runtime, latest.current, state.version, editable));
      },
      focus: (target) => {
        const editor = editorOf(stateRef.current);
        if (editor === null) return false;
        editor.focus(target as EditorFocusOptions | undefined);
        return true;
      },
      blur: () => editorOf(stateRef.current)?.blur(),
      undo: () => run(stateRef.current, (editor) => editor.undo()),
      redo: () => run(stateRef.current, (editor) => editor.redo()),
      canUndo: () => editorOf(stateRef.current)?.canUndo ?? false,
      canRedo: () => editorOf(stateRef.current)?.canRedo ?? false,
      openSearch: () => sendCommandKey(stateRef.current, "F9"),
      openSearchReplace: () => sendCommandKey(stateRef.current, "F10"),
      // Cmd/Ctrl+G is Pierre's find-again shortcut and needs no custom binding.
      findNext: (previous = false) => sendCommandKey(stateRef.current, "g", previous),
      goToLine: (lineNumber, character = 0) =>
        run(stateRef.current, (editor) => editor.focus({ lineNumber, character })),
      getViewState: () => editorOf(stateRef.current)?.getViewState() ?? null,
      setViewState: (state) => editorOf(stateRef.current)?.setViewState(state),
      scrollToLine: (lineNumber, align = "center") => {
        stateRef.current?.view.scrollTo({ type: "line", id: itemIdOf(latest.current), lineNumber, align });
      },
    }),
    [],
  );

  return (
    <div
      ref={hostRef}
      className={cn("relative h-full w-full min-h-0", className)}
      style={cssVariables(style, { fontSize, lineHeight, fontFamily, tabSize })}
      data-pierre-status={status.kind}
      onKeyDown={(event) => {
        // Pierre has no save command, so the surface owns this one shortcut and
        // stops the browser from opening its own save dialog.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          latest.current.onSave?.();
        }
      }}
    />
  );
}

/**
 * The identity of the document on screen. A change here means a different file,
 * which must get its own editor, its own undo history, and its own draft.
 */
function documentKey(props: PierreSurfaceProps): string {
  return [props.viewId, props.name, props.oldContent === undefined ? "file" : "diff"].join("\0");
}

/** The CodeView item id. It is the document identity, so a file switch swaps items. */
function itemIdOf(props: PierreSurfaceProps): string {
  return documentKey(props);
}

/**
 * The Pierre custom properties for the requested typography. They are set on
 * the host because custom properties cross the shadow boundary, and Pierre's
 * own stylesheet lives inside `<diffs-container>`.
 */
function cssVariables(
  style: CSSProperties | undefined,
  values: { fontSize?: number; lineHeight?: number; fontFamily?: string; tabSize?: number },
): CSSProperties {
  const next: Record<string, string | number> = { ...(style as Record<string, string | number> | undefined) };
  if (values.fontSize !== undefined) next["--diffs-font-size"] = `${values.fontSize}px`;
  if (values.lineHeight !== undefined) next["--diffs-line-height"] = `${values.lineHeight}px`;
  if (values.fontFamily !== undefined) next["--diffs-font-family"] = values.fontFamily;
  if (values.tabSize !== undefined) next["--diffs-tab-size"] = String(values.tabSize);
  return next as CSSProperties;
}

/**
 * The CodeView options for the current props.
 *
 * Every callback reads `latest.current` when it runs. Reading the props once
 * here would give an editor created for one file the name, the epoch, and the
 * change handler of whichever file was open when the options were last built.
 */
function buildOptions(
  runtime: PierreRuntime,
  latest: { current: PierreSurfaceProps },
  stateRef: { current: SurfaceState | null },
): CodeViewOptions<undefined, undefined> {
  const props = latest.current;
  return {
    theme: applyPierreTheme(runtime, props.theme),
    themeType: props.theme.type,
    diffStyle: props.diffStyle ?? "split",
    overflow: props.wrap === true ? "wrap" : "scroll",
    disableLineNumbers: props.lineNumbers === false,
    disableFileHeader: props.fileHeader !== true,
    expandUnchanged: props.expandUnchanged ?? false,
    stickyHeaders: props.stickyHeader ?? false,
    // One item fills the pane, so none of Pierre's list spacing applies.
    layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    // Sessions retain text across mounts. Undo history belongs to this editor
    // instance; retaining it under a changing epoch can restore stale text.
    createEditor: (editorType, options) =>
      new runtime.Editor(editorType, {
        ...options,
        keymap: RESERVED_KEYMAP,
        onFocus: () => latest.current.onFocus?.(),
        onBlur: () => latest.current.onBlur?.(),
      }),
    onItemEditChange: (event, item) => {
      // An item that is no longer on screen can still finish reporting. Its
      // text belongs to the file it came from, not to the one open now.
      if (item.id !== itemIdOf(latest.current)) return;
      latest.current.onChange?.(event.file.contents, latest.current.viewId);
    },
    onItemEditComplete: (event, item) => {
      // Pierre freezes the event and caches highlighting by cacheKey, so the
      // accepted value needs its own key or the old tokens come back.
      const state = stateRef.current;
      const version = ++cacheRevision;
      if (state !== null) state.version = version;
      const current = item.id === itemIdOf(latest.current);
      if ("fileDiff" in event) {
        event.fileDiff.cacheKey = `${CACHE_NAMESPACE}\0${item.id}\0diff\0${version}`;
        if (current && event.newFile !== null) {
          latest.current.onChange?.(event.newFile.contents, latest.current.viewId);
        }
      } else {
        event.file.cacheKey = `${CACHE_NAMESPACE}\0${item.id}\0file\0${version}`;
        if (current) latest.current.onChange?.(event.file.contents, latest.current.viewId);
      }
      // Completing an edit session is not a save; the owner decides that.
      return "accept";
    },
  };
}

/** The item for the current props: a plain file, or a diff of the two sides. */
function buildItem(
  runtime: PierreRuntime,
  props: PierreSurfaceProps,
  version: number,
  editableOverride: boolean | null,
): CodeViewItem<undefined> {
  const id = itemIdOf(props);
  const deleted = props.content === null;
  // A deleted file has no writable side at all, so no override can edit it.
  const edit = !deleted && (editableOverride ?? props.readOnly !== true);
  const newFile: FileContents | null = deleted
    ? null
    : { name: props.name, contents: props.content ?? "", cacheKey: `${CACHE_NAMESPACE}\0${id}\0new\0${version}` };
  if (props.oldContent === undefined) {
    return {
      id,
      type: "file",
      file: newFile ?? { name: props.name, contents: "", cacheKey: `${CACHE_NAMESPACE}\0${id}\0new\0${version}` },
      version,
      edit,
    };
  }
  const oldFile: FileContents | null =
    props.oldContent === null
      ? null
      : {
          name: props.oldName ?? props.name,
          contents: props.oldContent,
          cacheKey: `${CACHE_NAMESPACE}\0${id}\0old\0${version}`,
        };
  return { id, type: "diff", fileDiff: runtime.parseDiffFromFile(oldFile, newFile), version, edit };
}

function editorOf(state: SurfaceState | null): Editor | null {
  if (state === null) return null;
  return (state.view.getEditor(state.docKey) as Editor | undefined) ?? null;
}

function run(state: SurfaceState | null, action: (editor: Editor) => void): boolean {
  const editor = editorOf(state);
  if (editor === null) return false;
  action(editor);
  return true;
}

/**
 * Opens Pierre's search panel, or steps to the next match.
 *
 * Pierre exposes no method for this, so the surface focuses the editor and
 * sends the keydown its keymap answers. The event goes to the deepest focused
 * element, because Pierre only accepts a key whose composed path starts inside
 * the editable content. A read-only surface has no editor and returns false.
 */
function sendCommandKey(state: SurfaceState | null, key: string, shift = false): boolean {
  const editor = editorOf(state);
  if (editor === null) return false;
  editor.focus();
  const target = deepestActiveElement();
  if (target === null) return false;
  const isMac = navigator.platform.startsWith("Mac");
  // The editor calls preventDefault on a key it handled, so a cancelled event
  // is the signal that the command ran.
  return !target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.startsWith("F") ? key : `Key${key.toUpperCase()}`,
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

/** The focused element, following shadow roots into Pierre's container. */
function deepestActiveElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement != null) element = element.shadowRoot.activeElement;
  return element;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
