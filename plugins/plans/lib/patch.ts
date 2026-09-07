import { createTwoFilesPatch } from "diff";

export const PLAN_DIFF_PATH = "plan.md";

/**
 * A unified patch between two plan versions, shaped for the host diff viewer.
 * Returns null when the versions are identical so the caller can show an
 * explicit "no changes" state instead of an empty diff.
 */
export function createVersionPatch(
  oldMarkdown: string,
  newMarkdown: string,
  oldLabel: string,
  newLabel: string,
): string | null {
  if (oldMarkdown === newMarkdown) return null;
  return createTwoFilesPatch(
    `a/${PLAN_DIFF_PATH}`,
    `b/${PLAN_DIFF_PATH}`,
    ensureTrailingNewline(oldMarkdown),
    ensureTrailingNewline(newMarkdown),
    oldLabel,
    newLabel,
    { context: 3 },
  );
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
