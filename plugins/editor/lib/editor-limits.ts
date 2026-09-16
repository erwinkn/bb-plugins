/**
 * The interactive-rendering soft limit.
 *
 * The transport limit (8 MB, enforced by the server) only says what may reach
 * the browser. Pierre's synchronous render path can still fall over on a much
 * smaller file — the crash report that prompted this was a generated
 * 459,211-byte validator of 10,546 lines with a 1,184-character longest line.
 * Above these bounds a file opens in the virtualized plain-text view, with an
 * explicit escape back into the editor.
 */
export interface ContentShape {
  bytes: number;
  lines: number;
  maxLineLength: number;
}

export const INTERACTIVE_LIMITS = {
  bytes: 256 * 1024,
  lines: 8_000,
  maxLineLength: 1_000,
} as const;

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

export interface OverLimit {
  shape: ContentShape;
  reason: string;
}

/** The reason a buffer is too big for the editor, or null when it fits. */
export function exceedsInteractiveLimits(content: string): OverLimit | null {
  const shape = contentShape(content);
  const reasons: string[] = [];
  if (shape.bytes > INTERACTIVE_LIMITS.bytes) reasons.push(`${Math.round(shape.bytes / 1024)} KB`);
  if (shape.lines > INTERACTIVE_LIMITS.lines) reasons.push(`${shape.lines.toLocaleString()} lines`);
  if (shape.maxLineLength > INTERACTIVE_LIMITS.maxLineLength)
    reasons.push(`a ${shape.maxLineLength.toLocaleString()}-character line`);
  if (reasons.length === 0) return null;
  return { shape, reason: `This file is too large for the editor (${reasons.join(", ")})` };
}
