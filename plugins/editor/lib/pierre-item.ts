import type { CodeViewItem, FileContents, FileDiffMetadata } from "@pierre/diffs";

export interface PierreItemInput {
  id: string;
  name: string;
  oldName?: string;
  content: string | null;
  oldContent?: string | null;
  cachePrefix: string;
  version: number;
  editable: boolean;
  /** Keep the mounted editor's type stable while the user types. */
  renderType?: "file" | "diff";
  /**
   * False forces lang "text": no grammar load, no worker highlight pass. For
   * a file over the highlight tier that stays editable (see editor-limits).
   */
  highlight?: boolean;
}

/** Empty comparisons have no Pierre diff rows; show the existing file instead. */
export function createPierreItem(
  input: PierreItemInput,
  parseDiff: (oldFile: FileContents | null, newFile: FileContents | null) => FileDiffMetadata,
): CodeViewItem<undefined> {
  const { id, name, version, cachePrefix } = input;
  const edit = input.editable && input.content !== null;
  const lang = input.highlight === false ? ("text" as const) : undefined;
  const newFile: FileContents | null = input.content === null ? null : {
    name, contents: input.content, cacheKey: `${cachePrefix}\0new\0${version}`, lang,
  };
  const oldFile: FileContents | null = input.oldContent == null ? null : {
    name: input.oldName ?? name, contents: input.oldContent, cacheKey: `${cachePrefix}\0old\0${version}`, lang,
  };
  const fileItem = (): CodeViewItem<undefined> => ({
    id, type: "file", version, edit,
    file: newFile ?? oldFile ?? { name, contents: "", cacheKey: `${cachePrefix}\0empty\0${version}` },
  });
  if (input.oldContent === undefined || input.renderType === "file") return fileItem();
  const fileDiff = parseDiff(oldFile, newFile);
  if (input.renderType === undefined && fileDiff.hunks.length === 0) return fileItem();
  return { id, type: "diff", fileDiff, version, edit };
}
