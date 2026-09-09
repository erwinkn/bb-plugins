/**
 * Turns what BB hands its diff renderer into what Pierre renders.
 *
 * BB supplies one file's unified patch, and sometimes both complete sides. The
 * patch is the record of what changed, so its hunks are what gets drawn; the
 * sides only add the unchanged lines around them, and only after they are
 * checked against the patch. BB's own renderer makes the same check, and the
 * SDK asks a replacement to make it too.
 */
import type { FileContents, FileDiffLoadedFiles, FileDiffMetadata, ParsedPatch } from "@pierre/diffs";

/** One resolved side, as BB's `ExperimentalDiffFileContent`. */
export interface DiffSide {
  path: string;
  content: string;
}

/** The first file of a single-file patch, or null when there is none to draw. */
export function fileDiffFromPatch(
  parse: (patch: string, cacheKeyPrefix?: string, throwOnError?: boolean) => ParsedPatch[],
  patch: string,
  cacheKeyPrefix: string,
): FileDiffMetadata | null {
  let parsed: ParsedPatch[];
  try {
    parsed = parse(patch, cacheKeyPrefix, true);
  } catch {
    return null;
  }
  const file = parsed.flatMap((entry) => entry.files)[0];
  return file === undefined ? null : file;
}

/**
 * Whether both sides line up with every hunk: each context, deleted and added
 * line of the patch must be at the line the hunk header says it is. A side
 * that disagrees, or that ends early, is not this diff's file.
 */
export function sidesMatchPatch(fileDiff: FileDiffMetadata, oldSide: string, newSide: string): boolean {
  const oldLines = splitLines(oldSide);
  const newLines = splitLines(newSide);
  for (const hunk of fileDiff.hunks) {
    let oldAt = hunk.deletionStart - 1;
    let newAt = hunk.additionStart - 1;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        if (!sameRun(fileDiff.deletionLines, block.deletionLineIndex, oldLines, oldAt, block.lines)) return false;
        if (!sameRun(fileDiff.additionLines, block.additionLineIndex, newLines, newAt, block.lines)) return false;
        oldAt += block.lines;
        newAt += block.lines;
        continue;
      }
      if (!sameRun(fileDiff.deletionLines, block.deletionLineIndex, oldLines, oldAt, block.deletions)) return false;
      if (!sameRun(fileDiff.additionLines, block.additionLineIndex, newLines, newAt, block.additions)) return false;
      oldAt += block.deletions;
      newAt += block.additions;
    }
  }
  return true;
}

/**
 * The complete sides for Pierre's `loadDiffFiles`, or null when they cannot
 * stand in for the patch. An added or deleted file already has its one side
 * in the patch, so it needs nothing.
 */
export function loadedSides(
  fileDiff: FileDiffMetadata,
  sides: { old: DiffSide; new: DiffSide } | null,
): FileDiffLoadedFiles | null {
  if (sides === null || fileDiff.type === "new" || fileDiff.type === "deleted") return null;
  if (!sidesMatchPatch(fileDiff, sides.old.content, sides.new.content)) return null;
  const oldFile: FileContents = { name: sides.old.path, contents: sides.old.content };
  const newFile: FileContents = { name: sides.new.path, contents: sides.new.content };
  return { oldFile, newFile };
}

/**
 * How many rows a unified rendering of `patch` takes, counted from the text
 * alone so a block can hold its height before Pierre has loaded. Each hunk
 * adds one row for its separator.
 */
export function patchRowEstimate(patch: string): number {
  let rows = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      rows += 1;
    } else if (inHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      rows += 1;
    } else if (line.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return rows;
}

function sameRun(patchLines: string[], patchFrom: number, fileLines: string[], fileFrom: number, count: number): boolean {
  if (count === 0) return true;
  if (fileFrom < 0 || fileFrom + count > fileLines.length) return false;
  for (let index = 0; index < count; index += 1) {
    const patchLine = patchLines[patchFrom + index];
    if (patchLine === undefined || bare(patchLine) !== fileLines[fileFrom + index]) return false;
  }
  return true;
}

/** Lines without their terminators; a final newline adds no empty line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map(bare);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Pierre keeps each patch line's own terminator; the comparison ignores it. */
function bare(line: string): string {
  return line.replace(/\r\n$|\r$|\n$/, "");
}
