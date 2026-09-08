import { HIGHLIGHT_NAMES, supportsHighlights } from "./highlight-registry";
import type { QuoteMatch } from "./quote-anchor";

/**
 * What a reviewer can copy out of the plan panel when highlights or selection
 * misbehave on a device we cannot attach a debugger to. Every line answers one
 * question from the mobile investigation: is the API there, did the anchors
 * resolve, were they painted, and does the host shell let text be selected.
 */
export interface Diagnostics {
  highlightApi: boolean;
  anchored: number;
  ambiguous: number;
  missing: number;
  painted: number;
  /** Computed `user-select` of the document; WebKit skips highlights and selection under `none`. */
  userSelect: string | null;
  pointer: "coarse" | "fine" | "unknown";
  viewport: string;
  userAgent: string;
}

type RegistryLike = Iterable<[string, { size: number }]>;

export function collectDiagnostics(document: HTMLElement | null, anchors: Record<string, QuoteMatch>): Diagnostics {
  const matches = Object.values(anchors);
  const view = document?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
  const registry = (globalThis as { CSS?: { highlights?: RegistryLike } }).CSS?.highlights;
  let painted = 0;
  if (registry) {
    for (const [name, highlight] of registry) if (HIGHLIGHT_NAMES.has(name)) painted += highlight.size;
  }
  // `user-select` is not inherited, so a child computes to `auto` even when an
  // ancestor's `none` is what the engine applies. Report the nearest explicit value.
  let userSelect: string | null = null;
  for (let el: HTMLElement | null = document; el !== null && view !== null; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    const value = style.getPropertyValue("-webkit-user-select") || style.getPropertyValue("user-select");
    if (value !== "" && value !== "auto") {
      userSelect = value;
      break;
    }
    if (el.parentElement === null) userSelect = "auto";
  }
  const pointer = view ? (view.matchMedia("(pointer: coarse)").matches ? "coarse" : "fine") : "unknown";
  return {
    highlightApi: supportsHighlights(),
    anchored: matches.filter((match) => match.kind === "unique").length,
    ambiguous: matches.filter((match) => match.kind === "ambiguous").length,
    missing: matches.filter((match) => match.kind === "missing").length,
    painted,
    userSelect,
    pointer,
    viewport: view ? `${view.innerWidth}×${view.innerHeight}` : "unknown",
    userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
  };
}

export function diagnosticsLines(d: Diagnostics): Array<{ label: string; value: string; problem?: string }> {
  return [
    { label: "Highlight API", value: d.highlightApi ? "available" : "missing", problem: d.highlightApi ? undefined : "No CSS.highlights: anchors cannot be painted in this browser." },
    { label: "Anchors", value: `${d.anchored} resolved · ${d.ambiguous} ambiguous · ${d.missing} missing` },
    {
      label: "Painted",
      value: `${d.painted} range${d.painted === 1 ? "" : "s"}`,
      problem: d.highlightApi && d.painted < d.anchored ? "Fewer ranges painted than resolved." : undefined,
    },
    {
      label: "Text selection",
      value: d.userSelect ?? "unknown",
      problem: d.userSelect === "none" ? "The host sets user-select: none here; selection and WebKit highlights are blocked." : undefined,
    },
    { label: "Pointer", value: d.pointer },
    { label: "Viewport", value: d.viewport },
    { label: "Browser", value: d.userAgent },
  ];
}

export function formatDiagnostics(d: Diagnostics): string {
  return diagnosticsLines(d)
    .map((line) => `${line.label}: ${line.value}${line.problem ? ` (${line.problem})` : ""}`)
    .join("\n");
}
