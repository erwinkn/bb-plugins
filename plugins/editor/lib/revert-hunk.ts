import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import type { TextEdit } from "@pierre/diffs/edit";

export interface HunkRuntime {
  parseDiffFromFile(oldFile: FileContents | null, newFile: FileContents | null): FileDiffMetadata;
  diffAcceptRejectHunk(diff: FileDiffMetadata, hunkIndex: number, type: "reject"): FileDiffMetadata;
}

/** Resolve against the live text, so an earlier edit cannot leave stale offsets. */
export function revertHunkEdit(runtime: HunkRuntime, name: string, old: string | null,
  current: string, lineNumber: number, side: "additions" | "deletions"): TextEdit | null {
  const diff = runtime.parseDiffFromFile(old === null ? null : { name, contents: old }, { name, contents: current });
  const index = diff.hunks.findIndex((hunk) => {
    // A pure insertion or deletion has a zero count on one side; it still owns one row there.
    const start = Math.max(1, side === "additions" ? hunk.additionStart : hunk.deletionStart);
    const count = Math.max(1, side === "additions" ? hunk.additionCount : hunk.deletionCount);
    return lineNumber >= start && lineNumber < start + count;
  });
  if (index < 0) return null;
  const next = runtime.diffAcceptRejectHunk(diff, index, "reject").additionLines.join("");
  // Edit positions count lines and characters, so both sides compare with one
  // line ending; the inserted text gets the document's own back at the end.
  const before = current.replace(/\r\n|\r/g, "\n");
  const after = next.replace(/\r\n|\r/g, "\n");
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const position = (offset: number) => {
    const lines = before.slice(0, offset).split("\n");
    return { line: lines.length - 1, character: lines.at(-1)!.length };
  };
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  return { range: { start: position(start), end: position(end) }, newText: after.slice(start, nextEnd).replace(/\n/g, eol) };
}
