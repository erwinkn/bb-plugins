/**
 * Interactive-rendering limits, measured against the real Pierre 1.4.1 bundle
 * (September 2026, this machine — see the plugin's limit notes in git history).
 *
 * The transport limit (8 MB, enforced by the server) only says what may reach
 * the browser. What the measurements showed:
 *
 * - Pierre never threw or blanked at any size up to the transport cap; first
 *   render stays under ~110 ms even for a 32 MB / 1M-line file, because
 *   rendering is virtualized. The 459 KB / 10.5k-line file that crashed the
 *   pane once opens in ~1.1 s with instant typing — size alone was not the
 *   crash.
 * - What scales badly is *syntax highlighting*: the editor attaches only
 *   after the worker pool finishes the file, which costs roughly 2.5 s per
 *   MB of JavaScript (4 MB ≈ 10 s). Highlighting is skipped entirely for
 *   files over Pierre's own 100k-line cap and for very long lines, which is
 *   why those files still attach fast.
 * - Keystroke cost stays under ~150 ms for everything except absurd single
 *   lines: an 8M-character line takes ~300 ms unwrapped, and with word wrap
 *   on a wrapped line re-lays out per keystroke at a quadratic rate —
 *   100k chars ≈ 185 ms, 400k ≈ 2.3 s, 1M ≈ 15.7 s.
 *
 * Three tiers come out of that: full editor, editor without highlighting,
 * and read-only plain text. Plus a wrap override, since wrap — not size —
 * is what makes long lines unusable.
 */
export interface ContentShape {
  bytes: number;
  lines: number;
  maxLineLength: number;
}

export interface SizeLimits {
  bytes: number;
  lines: number;
  maxLineLength: number;
}

export interface EditorLimits {
  /** Above these the file opens read-only: Pierre measured unusable there. */
  interactive: SizeLimits;
  /** Above these the file stays editable but highlighting is off. */
  highlight: { bytes: number; lines: number };
  /** A line longer than this never soft-wraps: wrap cost is quadratic. */
  wrapMaxLineLength: number;
}

export const DEFAULT_EDITOR_LIMITS: EditorLimits = {
  interactive: {
    // Matches the transport cap; a bigger file never reaches the browser.
    bytes: 8 * 1024 * 1024,
    // 1M lines measured fine (unhighlighted); this is only a backstop.
    lines: 2_000_000,
    // 4M chars measured ~150 ms per keystroke; 8M crossed 300 ms.
    maxLineLength: 4_000_000,
  },
  highlight: {
    // JavaScript at 1 MB took ~2.7 s to become editable; 2 MB took ~5.3 s.
    bytes: 1024 * 1024,
    // 10k lines ≈ 1.5 s, 50k ≈ 9.6 s; grammars cheaper than JS go further.
    lines: 20_000,
  },
  // 50k chars ≈ 72 ms per keystroke wrapped, 100k ≈ 185 ms, 400k ≈ 2.3 s.
  wrapMaxLineLength: 50_000,
};

/** Cheap single pass over the buffer; avoids `split` until a caller needs lines. */
export function contentShape(content: string): ContentShape {
  let lines = 1;
  let bytes = 0;
  let maxLineLength = 0;
  let lineStart = 0;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : code >= 0xdc00 && code <= 0xdfff ? 0 : 3;
    if (code === 10) {
      lines += 1;
      maxLineLength = Math.max(maxLineLength, index - lineStart);
      lineStart = index + 1;
    }
  }
  maxLineLength = Math.max(maxLineLength, content.length - lineStart);
  return { bytes, lines, maxLineLength };
}

export type LimitTier = "editor" | "unhighlighted" | "read-only";

export interface LimitTierResult {
  tier: LimitTier;
  shape: ContentShape;
  /** Why the read-only tier was chosen, or null. */
  reason: string | null;
  /** What crossed the highlight bound, e.g. "4.2 MB" or "52,000 lines". */
  highlightDetail: string | null;
}

function describeShape(shape: ContentShape, limits: SizeLimits): string[] {
  const reasons: string[] = [];
  if (shape.bytes > limits.bytes) reasons.push(`${Math.round(shape.bytes / 1024)} KB`);
  if (shape.lines > limits.lines) reasons.push(`${shape.lines.toLocaleString()} lines`);
  if (shape.maxLineLength > limits.maxLineLength)
    reasons.push(`a ${shape.maxLineLength.toLocaleString()}-character line`);
  return reasons;
}

/** Which of the three rendering tiers a buffer of this shape belongs in. */
export function limitTierForShape(shape: ContentShape, limits: EditorLimits = DEFAULT_EDITOR_LIMITS): LimitTierResult {
  // The highlight bound is computed even for read-only files: a file forced
  // open past the read-only tier still should not run the highlight pass.
  const highlightReasons = describeShape(shape, { ...limits.highlight, maxLineLength: Infinity });
  const highlightDetail = highlightReasons.length > 0 ? highlightReasons.join(", ") : null;
  const reasons = describeShape(shape, limits.interactive);
  if (reasons.length > 0) {
    return { tier: "read-only", shape, reason: `This file is too large for the editor (${reasons.join(", ")})`, highlightDetail };
  }
  if (highlightDetail !== null) {
    return { tier: "unhighlighted", shape, reason: null, highlightDetail };
  }
  return { tier: "editor", shape, reason: null, highlightDetail: null };
}

/** The tier for a buffer. Prefer `limitTierForShape` when the shape is known. */
export function limitTier(content: string, limits: EditorLimits = DEFAULT_EDITOR_LIMITS): LimitTierResult {
  return limitTierForShape(contentShape(content), limits);
}
