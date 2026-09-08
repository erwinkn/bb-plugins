import { useEffect, useRef, useState } from "react";
import type { FileDiff, FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import { loadPierre, type PierreRuntime } from "@/lib/pierre-loader";
import {
  applyPierreTheme, CACHE_NAMESPACE, describeError, nextCacheRevision, PIERRE_HOST_CSS, pierreCssVariables,
  synchronizePierreTheme, type PierreThemeInput,
} from "@/lib/pierre-theme";
import { fileDiffFromPatch, loadedSides, patchRowEstimate, type DiffSide } from "@/lib/bb-diff";
import { cn } from "@/lib/utils";

export type PierreDiffBlockStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface PierreDiffBlockProps {
  /** The asset base from the server's `assets` RPC. Treated as opaque. */
  baseUrl: string;
  /** One file's complete unified patch. */
  patch: string;
  /** Both complete sides, when the caller has them. */
  sides: { old: DiffSide; new: DiffSide } | null;
  view: "split" | "unified";
  wrap: boolean;
  lineNumbers: boolean;
  fontSize: number;
  lineHeight: number;
  fontFamily?: string;
  theme: PierreThemeInput;
  onStatusChange?: (status: PierreDiffBlockStatus) => void;
  className?: string;
}

interface BlockState {
  runtime: PierreRuntime;
  view: FileDiff;
  /** Identity of the patch on screen. */
  docKey: string;
  fileDiff: FileDiffMetadata | null;
  optionsKey: string;
  publish(status: PierreDiffBlockStatus): void;
}

/**
 * One read-only diff that takes the height of its rows, for a page that
 * scrolls itself: BB's timeline and the bodies of its diff panel.
 *
 * `PierreSurface` fills a pane and virtualizes through Pierre's `CodeView`,
 * which needs a scroll container of its own. This block uses Pierre's plain
 * `FileDiff` instead, so many of them can sit in one scrolling column. The
 * patch is the source of the rows; complete sides, when they agree with it,
 * add the unchanged lines between hunks so they can be expanded.
 */
export function PierreDiffBlock(props: PierreDiffBlockProps) {
  const { baseUrl, className, fontSize, lineHeight, fontFamily, patch } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<BlockState | null>(null);
  const [status, setStatus] = useState<PierreDiffBlockStatus>({ kind: "loading" });
  const latest = useRef(props);
  latest.current = props;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let disposed = false;
    let created: FileDiff | null = null;
    const publish = (next: PierreDiffBlockStatus) => {
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
        if (disposed || hostRef.current === null) return;
        const view = new runtime.FileDiff(buildOptions(runtime, latest, null), runtime.workerPool ?? undefined);
        created = view;
        stateRef.current = { runtime, view, docKey: "", fileDiff: null, optionsKey: "", publish };
        sync(stateRef.current, hostRef.current, latest);
      })
      .catch((error: unknown) => {
        publish({ kind: "error", message: describeError(error) });
      });
    return () => {
      disposed = true;
      created?.cleanUp();
      stateRef.current = null;
    };
  }, [baseUrl]);

  const docKey = documentKey(props);
  useEffect(() => {
    const state = stateRef.current;
    const host = hostRef.current;
    if (state === null || host === null) return;
    let cancelled = false;
    void synchronizePierreTheme(state.runtime, props.theme)
      .then(() => {
        if (cancelled || stateRef.current !== state) return;
        sync(state, host, latest);
      })
      .catch((error: unknown) => {
        if (cancelled || stateRef.current !== state) return;
        state.publish({ kind: "error", message: describeError(error) });
      });
    return () => { cancelled = true; };
  }, [docKey, optionsKeyOf(props)]);

  // Until Pierre draws, the block holds the rows' height so the page does not jump.
  const placeholderHeight = status.kind === "ready" ? undefined : patchRowEstimate(patch) * lineHeight;

  return (
    <div
      ref={hostRef}
      data-pierre-status={status.kind}
      className={cn("min-w-0 w-full", className)}
      style={{
        ...pierreCssVariables({ fontSize, lineHeight, fontFamily }),
        minHeight: placeholderHeight,
      }}
    />
  );
}

/** Applies the current props: new options, then the current patch. */
function sync(state: BlockState, host: HTMLElement, latest: { current: PierreDiffBlockProps }): void {
  const props = latest.current;
  const optionsKey = optionsKeyOf(props);
  const docKey = documentKey(props);
  let force = false;
  if (state.docKey !== docKey) {
    state.docKey = docKey;
    state.fileDiff = fileDiffFromPatch(state.runtime.parsePatchFiles, props.patch, `${CACHE_NAMESPACE}\0${nextCacheRevision()}`);
    state.publish({ kind: "loading" });
  }
  if (state.optionsKey !== optionsKey) {
    state.optionsKey = optionsKey;
    force = true;
  }
  if (state.fileDiff === null) {
    state.publish({ kind: "error", message: "This text is not a single-file patch" });
    return;
  }
  // The sides go with the patch, so the options follow every document change.
  state.view.setOptions(buildOptions(state.runtime, latest, state));
  state.view.onThemeChange();
  state.view.render({ fileDiff: state.fileDiff, containerWrapper: host, forceRender: force });
}

function buildOptions(
  runtime: PierreRuntime,
  latest: { current: PierreDiffBlockProps },
  state: BlockState | null,
): FileDiffOptions<undefined, undefined> {
  const props = latest.current;
  const loaded = state?.fileDiff == null ? null : loadedSides(state.fileDiff, props.sides);
  return {
    theme: applyPierreTheme(runtime, props.theme),
    themeType: props.theme.type,
    diffStyle: props.view,
    overflow: props.wrap ? "wrap" : "scroll",
    disableLineNumbers: !props.lineNumbers,
    disableFileHeader: true,
    unsafeCSS: PIERRE_HOST_CSS,
    hunkSeparators: "line-info-basic",
    enableGutterUtility: false,
    expansionLineCount: 20,
    lineHoverHighlight: "number",
    loadDiffFiles: loaded === null ? undefined : () => Promise.resolve(loaded),
    onPostRender: (node, _instance, phase) => {
      if (state === null || phase === "unmount") return;
      const message = node.shadowRoot?.querySelector("[data-error-message]")?.textContent;
      if (message) {
        state.publish({ kind: "error", message });
        return;
      }
      state.publish({ kind: "ready" });
    },
  };
}

function documentKey(props: PierreDiffBlockProps): string {
  const sides = props.sides === null ? "" : `${props.sides.old.path}\0${props.sides.old.content.length}\0${props.sides.new.path}\0${props.sides.new.content.length}`;
  return `${props.patch}\0${sides}`;
}

function optionsKeyOf(props: PierreDiffBlockProps): string {
  return [props.theme.id, props.theme.type, props.view, props.wrap, props.lineNumbers].join("|");
}
