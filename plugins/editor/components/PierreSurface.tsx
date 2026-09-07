import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, Ref } from "react";
import type { CodeView, CodeViewItem, CodeViewOptions } from "@pierre/diffs";
import type { Editor, EditorFocusOptions, EditorKeymap, EditorViewState } from "@pierre/diffs/edit";
import { loadPierre, type PierreRuntime } from "@/lib/pierre-loader";
import { applyPierreTheme, synchronizePierreTheme, type PierreThemeInput } from "@/lib/pierre-theme";
import { cn } from "@/lib/utils";
import { revertHunkEdit } from "@/lib/revert-hunk";
import { createPierreItem } from "@/lib/pierre-item";
import { RevertGlyph } from "./icons";

// Pierre's single-theme renderer writes its own host background. Override it
// inside the shadow root so both BB color modes and user palettes stay intact.
// Token colors still come from the selected syntax theme.
const SURFACE_CSS = `
  :host {
    background-color: var(--background);
    --diffs-bg: var(--background);
    --diffs-bg-buffer-override: var(--background);
    --diffs-fg-number-override: color-mix(in srgb, var(--foreground) 55%, var(--background));
    --diffs-min-number-column-width: 2ch;
    --diffs-bg-selection-override: color-mix(in srgb, var(--foreground) 20%, var(--background));
    --diffs-bg-selection-number-override: var(--background);
    --diffs-selection-number-fg: var(--foreground);
  }
`;

/**
 * The changed rows under the pointer, as one block. The revert control sits
 * beside its first row and reverts the hunk that holds it.
 */
interface HoveredBlock {
  /** Identity of the block, so a move inside it does not re-render. */
  key: string;
  /** Offsets from the surface's own box. */
  top: number;
  bottom: number;
  lineNumber: number;
  side: "additions" | "deletions";
}

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
  allowRevertHunk?: boolean;
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
  revertHunk(): boolean;
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
  itemType: "file" | "diff";
  /** Bumped for every item replacement, so Pierre reconciles and re-caches. */
  version: number;
  epoch: number;
  /** Set only by Pierre's onAttach, after the editable DOM exists. */
  readyEditor: Editor | null;
  pendingFocus: { target?: PierreFocusTarget } | null;
  publish(status: PierreSurfaceStatus): void;
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
  const [fileComparison, setFileComparison] = useState(false);
  const [hovered, setHovered] = useState<HoveredBlock | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const revertButtonRef = useRef<HTMLButtonElement | null>(null);
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
      const previous = statusRef.current;
      if (previous.kind === next.kind && (next.kind !== "error" || (previous.kind === "error" && previous.message === next.message))) return;
      statusRef.current = next;
      setStatus(next);
      latest.current.onStatusChange?.(next);
    };
    publish({ kind: "loading" });
    loadPierre(baseUrl)
      .then(async (runtime) => {
        await synchronizePierreTheme(runtime, latest.current.theme);
        const host = hostRef.current;
        if (disposed || host === null) return;
        const props = latest.current;
        const view = new runtime.CodeView<undefined, undefined>(
          buildOptions(runtime, latest, stateRef),
          runtime.workerPool ?? undefined,
        );
        created = view;
        const version = ++cacheRevision;
        const item = buildItem(runtime, props, version, null);
        setFileComparison(props.oldContent !== undefined && item.type === "file");
        stateRef.current = {
          runtime,
          view,
          docKey: documentKey(props),
          itemType: item.type,
          version,
          epoch: props.epoch,
          readyEditor: null,
          pendingFocus: null,
          publish,
          editableOverride: null,
        };
        view.setup(host);
        view.setItems([item]);
        // setItems schedules rendering. It does not mean that the file, its
        // highlighter, or the editable DOM exists yet. The callbacks below
        // report readiness after Pierre actually renders or attaches.
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
    props.allowRevertHunk,
    props.readOnly,
  ].join("|");
  useEffect(() => {
    const state = stateRef.current;
    if (state === null) return;
    let cancelled = false;
    state.view.setOptions(buildOptions(state.runtime, latest, stateRef));
    void synchronizePierreTheme(state.runtime, props.theme).then(() => {
      if (cancelled || stateRef.current !== state) return;
      state.view.onThemeChange();
      state.view.render();
      if (state.readyEditor !== null && statusRef.current.kind === "error") state.publish({ kind: "ready" });
    }).catch((error: unknown) => {
      if (cancelled || stateRef.current !== state) return;
      state.publish({ kind: "error", message: describe(error), error });
    });
    return () => { cancelled = true; };
  }, [optionsKey, status.kind]);

  // The document itself: a different file replaces the item, and everything
  // else updates it in place.
  const docKey = documentKey(props);
  useEffect(() => {
    setHovered(null);
    const state = stateRef.current;
    if (state === null) return;
    if (state.docKey !== docKey) {
      state.docKey = docKey;
      state.version = ++cacheRevision;
      state.epoch = props.epoch;
      state.editableOverride = null;
      state.readyEditor = null;
      state.pendingFocus = null;
      state.publish({ kind: "loading" });
      // setItems removes the old record, which ends its edit session and
      // releases its editor and undo history.
      const item = buildItem(state.runtime, latest.current, state.version, null);
      state.itemType = item.type;
      setFileComparison(props.oldContent !== undefined && item.type === "file");
      state.view.setItems([item]);
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
    state.view.updateItem(buildItem(state.runtime, latest.current, state.version, state.editableOverride, state.itemType));
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
        state.view.updateItem(buildItem(state.runtime, latest.current, state.version, editable, state.itemType));
      },
      focus: (target) => {
        const state = stateRef.current;
        const editor = editorOf(state);
        if (editor === null) {
          if (state !== null) state.pendingFocus = { target };
          return false;
        }
        editor.focus(target as EditorFocusOptions | undefined);
        return true;
      },
      blur: () => editorOf(stateRef.current)?.blur(),
      revertHunk: () => {
        const editor = editorOf(stateRef.current);
        const selection = editor?.getViewState().selections?.[0];
        return revertAtLine(stateRef.current, latest.current, (selection?.end.line ?? 0) + 1, "additions");
      },
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

  const revertable = props.allowRevertHunk === true && props.readOnly !== true && props.oldContent !== undefined;
  useEffect(() => {
    if (!revertable) setHovered(null);
  }, [revertable]);

  /** Follows the pointer into and out of changed rows; the button is part of the block. */
  const trackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!revertable || event.pointerType === "touch") return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    const path = event.nativeEvent.composedPath();
    const block = hoveredBlockAt(path, surface);
    if (block !== null) {
      setHovered((current) => (current?.key === block.key ? current : block));
      return;
    }
    const onButton = revertButtonRef.current !== null && path.includes(revertButtonRef.current);
    if (onButton) return;
    const y = event.clientY - surface.getBoundingClientRect().top;
    setHovered((current) => (current !== null && y >= current.top && y < current.bottom ? current : null));
  };
  const revertHovered = () => {
    if (hovered === null) return;
    setHovered(null);
    revertAtLine(stateRef.current, latest.current, hovered.lineNumber, hovered.side);
  };

  return (
    <div
      ref={surfaceRef}
      className={cn("relative flex h-full w-full min-h-0 flex-col", className)}
      style={cssVariables(style, { fontSize, lineHeight, fontFamily, tabSize })}
      data-pierre-status={status.kind}
      onPointerMove={trackPointer}
      onPointerLeave={() => setHovered(null)}
      onScroll={() => setHovered(null)}
      onKeyDown={(event) => {
        // Typing moves the rows, so the control waits for the next pointer move.
        setHovered(null);
        // Pierre has no save command, so the surface owns this one shortcut and
        // stops the browser from opening its own save dialog.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          latest.current.onSave?.();
        }
      }}
    >
      {fileComparison ? (
        <div className="shrink-0 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
          {props.content === "" && props.oldContent === null ? "Empty added file" :
            props.content === null && props.oldContent === "" ? "Empty deleted file" :
              props.content === props.oldContent ? "No text changes · File contents" : "File contents"}
        </div>
      ) : null}
      <div ref={hostRef} className="relative min-h-0 w-full flex-1 overflow-auto" />
      {hovered !== null ? (
        <button
          ref={revertButtonRef}
          type="button"
          data-testid="revert-hunk"
          title="Revert this hunk"
          aria-label={`Revert the hunk at line ${hovered.lineNumber}`}
          // As tall as one row, so it sits on the block's first line.
          style={{ top: hovered.top, height: lineHeight ?? 20 }}
          className={cn(
            "absolute right-4 z-10 flex cursor-pointer items-center gap-1 rounded-md border border-border bg-background pr-1.5 pl-1",
            "text-[11px] leading-none text-muted-foreground shadow-sm hover:bg-state-hover hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none animate-in fade-in-0 duration-100",
          )}
          // The editor keeps its focus and selection; the click is the whole gesture.
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            revertHovered();
          }}
        >
          <RevertGlyph className="size-3" />
          Revert
        </button>
      ) : null}
    </div>
  );
}

/**
 * The block of changed rows under the pointer, from the event's composed
 * path into Pierre's shadow root. Pierre renders each row as one element with
 * `data-line-type`: content rows carry `data-line`, and the line-number
 * gutter rows carry `data-column-number`. The rows of one column are
 * siblings, in both the unified and the split layout. A context row or the
 * gap between hunks gives null.
 */
function hoveredBlockAt(path: EventTarget[], surface: HTMLElement): HoveredBlock | null {
  const row = path.find(
    (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.lineType !== undefined && lineOf(node) !== undefined,
  );
  if (row === undefined || !isChangedRow(row)) return null;
  let first = row;
  while (first.previousElementSibling instanceof HTMLElement && isChangedRow(first.previousElementSibling)) {
    first = first.previousElementSibling;
  }
  let last = row;
  while (last.nextElementSibling instanceof HTMLElement && isChangedRow(last.nextElementSibling)) {
    last = last.nextElementSibling;
  }
  const lineNumber = Number(lineOf(first));
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const origin = surface.getBoundingClientRect().top;
  const top = first.getBoundingClientRect().top - origin;
  const bottom = last.getBoundingClientRect().bottom - origin;
  const side = first.dataset.lineType === "change-deletion" ? "deletions" : "additions";
  return { key: `${side}:${lineNumber}:${Math.round(top)}`, top, bottom, lineNumber, side };
}

function lineOf(element: HTMLElement): string | undefined {
  return element.dataset.line ?? element.dataset.columnNumber;
}

function isChangedRow(element: HTMLElement): boolean {
  const type = element.dataset.lineType;
  return type === "change-addition" || type === "change-deletion";
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
    unsafeCSS: SURFACE_CSS,
    hunkSeparators: "line-info-basic",
    // The hunk revert control is BB's own overlay (see `hoveredBlockAt`), so
    // Pierre's per-line gutter utility stays off.
    enableGutterUtility: false,
    expansionLineCount: 20,
    lineHoverHighlight: "number",
    expandUnchanged: props.expandUnchanged ?? false,
    stickyHeaders: props.stickyHeader ?? false,
    // One item fills the pane, so none of Pierre's list spacing applies.
    layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    onPostRender: (node, _instance, phase, context) => {
      const state = stateRef.current;
      if (state === null || phase === "unmount" || context.item.id !== state.docKey) return;
      // Pierre has no render-error callback. Its default error renderer puts
      // the message in this node (verified against the pinned 1.4.1 source).
      // Surface the same error so the panel's loading layer cannot hide it.
      const message = node.shadowRoot?.querySelector("[data-error-message]")?.textContent;
      if (message) {
        state.publish({ kind: "error", message, error: new Error(message) });
        return;
      }
      // Editable items render before CodeView attaches their editor. Their
      // onAttach callback below is the point at which focus can succeed.
      if (context.item.edit !== true) state.publish({ kind: "ready" });
    },
    // Sessions retain text across mounts. Undo history belongs to this editor
    // instance; retaining it under a changing epoch can restore stale text.
    createEditor: (editorType, options) =>
      new runtime.Editor(editorType, {
        ...options,
        keymap: RESERVED_KEYMAP,
        onAttach: (editor) => {
          const state = stateRef.current;
          if (state === null || state.view.getEditor(state.docKey) !== editor) return;
          state.readyEditor = editor;
          const focus = state.pendingFocus;
          state.pendingFocus = null;
          state.publish({ kind: "ready" });
          if (focus !== null) editor.focus(focus.target as EditorFocusOptions | undefined);
        },
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
      if ("fileDiff" in event) {
        event.fileDiff.cacheKey = `${CACHE_NAMESPACE}\0${item.id}\0diff\0${version}`;
      } else {
        event.file.cacheKey = `${CACHE_NAMESPACE}\0${item.id}\0file\0${version}`;
      }
      // onItemEditChange already delivered each text change. Completion can
      // run while a newer external document replaces this editor; echoing
      // its old text here would overwrite that document and re-arm auto save.
      // Accept only into Pierre's cache, never back into the file session.
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
  renderType?: "file" | "diff",
): CodeViewItem<undefined> {
  const id = itemIdOf(props);
  return createPierreItem({
    id,
    name: props.name,
    oldName: props.oldName,
    content: props.content,
    oldContent: props.oldContent,
    cachePrefix: `${CACHE_NAMESPACE}\0${id}`,
    version,
    editable: editableOverride ?? props.readOnly !== true,
    renderType,
  }, runtime.parseDiffFromFile);
}

function editorOf(state: SurfaceState | null): Editor | null {
  if (state === null) return null;
  const editor = (state.view.getEditor(state.docKey) as Editor | undefined) ?? null;
  return editor === state.readyEditor ? editor : null;
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

/** Apply through Pierre's edit API to keep the cursor and the undo timeline. */
function revertAtLine(state: SurfaceState | null, props: PierreSurfaceProps, line: number, side: "additions" | "deletions"): boolean {
  const editor = editorOf(state);
  if (!state || !editor || !props.allowRevertHunk || props.readOnly || props.oldContent === undefined) return false;
  const edit = revertHunkEdit(state.runtime, props.name, props.oldContent, editor.getText(), line, side);
  if (!edit) return false;
  editor.applyEdits([edit]);
  editor.focus();
  return true;
}
