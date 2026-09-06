import { toast } from "sonner";
import type * as MonacoNs from "monaco-editor";

type Editor = MonacoNs.editor.IStandaloneCodeEditor;

export interface ActiveEditor {
  editor: Editor;
  absolutePath: string;
  relativePath: string;
  save: () => void;
  quickOpen: (() => void) | null;
  toggleTree: (() => void) | null;
}

let lastFocused: ActiveEditor | null = null;

export function markEditorActive(active: ActiveEditor): void {
  lastFocused = active;
}

export function forgetEditor(editor: Editor): void {
  if (lastFocused?.editor === editor) lastFocused = null;
}

function targetEditor(): ActiveEditor | null {
  const node = lastFocused?.editor.getDomNode();
  if (!node || !node.isConnected || node.offsetParent === null) return null;
  return lastFocused;
}

function hasMultiLineSelection({ editor }: ActiveEditor): boolean {
  return (
    editor
      .getSelections()
      ?.some((selection) => !selection.isEmpty() && selection.startLineNumber !== selection.endLineNumber) ?? false
  );
}

export interface EditorCommand {
  id: string;
  title: string;
  precondition?: (active: ActiveEditor) => boolean;
  run: (active: ActiveEditor) => void | Promise<void>;
}

function monacoAction(
  id: string,
  title: string,
  actionId: string,
  precondition?: (active: ActiveEditor) => boolean,
): EditorCommand {
  return {
    id,
    title,
    precondition,
    run: async ({ editor }) => {
      editor.focus();
      await editor.getAction(actionId)?.run();
    },
  };
}

export function copyText(text: string, successMessage: string): Promise<void> {
  return navigator.clipboard
    .writeText(text)
    .then(() => {
      toast.success(successMessage);
    })
    .catch(() => {
      toast.error("Failed to copy");
    });
}

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  { id: "save", title: "Editor: save file", run: (active) => active.save() },
  {
    id: "quick-open",
    title: "Editor: quick open file",
    precondition: (active) => active.quickOpen !== null,
    run: (active) => active.quickOpen?.(),
  },
  {
    id: "toggle-tree",
    title: "Editor: toggle file tree",
    precondition: (active) => active.toggleTree !== null,
    run: (active) => active.toggleTree?.(),
  },
  monacoAction("format", "Editor: format document", "editor.action.formatDocument"),
  monacoAction("go-to-symbol", "Editor: go to symbol", "editor.action.quickOutline"),
  monacoAction("go-to-line", "Editor: go to line", "editor.action.gotoLine"),
  monacoAction("command-palette", "Editor: Monaco command palette", "editor.action.quickCommand"),
  monacoAction("toggle-word-wrap", "Editor: toggle word wrap", "editor.action.toggleWordWrap"),
  ...[1, 2, 3, 4, 5].map((level) =>
    monacoAction(`fold-level-${level}`, `Editor: fold level ${level}`, `editor.foldLevel${level}`),
  ),
  monacoAction("fold-all", "Editor: fold all", "editor.foldAll"),
  monacoAction("unfold-all", "Editor: unfold all", "editor.unfoldAll"),
  monacoAction(
    "sort-lines-ascending",
    "Editor: sort selected lines ascending",
    "editor.action.sortLinesAscending",
    hasMultiLineSelection,
  ),
  monacoAction(
    "sort-lines-descending",
    "Editor: sort selected lines descending",
    "editor.action.sortLinesDescending",
    hasMultiLineSelection,
  ),
  {
    id: "copy-path",
    title: "Editor: copy path of current file",
    run: ({ absolutePath }) => copyText(absolutePath, "Absolute path copied"),
  },
  {
    id: "copy-relative-path",
    title: "Editor: copy relative path of current file",
    run: ({ relativePath }) => copyText(relativePath, "Relative path copied"),
  },
];

export function isCommandAvailable(command: EditorCommand): boolean {
  const active = targetEditor();
  if (!active) return false;
  return command.precondition?.(active) ?? true;
}

export async function runEditorCommand(command: EditorCommand): Promise<void> {
  const active = targetEditor();
  if (!active || !(command.precondition?.(active) ?? true)) return;
  await command.run(active);
}
