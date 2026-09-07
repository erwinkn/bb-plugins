import { toast } from "sonner";
import type { PierreSurfaceHandle } from "@/components/PierreSurface";

/**
 * The editor pane that had focus last, and the actions the command palette can
 * run on it. The pane registers itself on focus and removes itself when it goes
 * away, so a command never reaches a pane that is closed or off screen.
 */
export interface ActiveEditor {
  /** This pane's id, and the key `forgetEditor` removes it by. */
  id: string;
  /** The pane's root element. A pane that is not on screen takes no command. */
  element: HTMLElement | null;
  /** Null until the editor surface is ready. */
  handle: PierreSurfaceHandle | null;
  absolutePath: string;
  relativePath: string;
  save: () => void;
  quickOpen: (() => void) | null;
  toggleTree: (() => void) | null;
  goToLine: (() => void) | null;
  toggleWordWrap: (() => void) | null;
}

let lastFocused: ActiveEditor | null = null;

export function markEditorActive(active: ActiveEditor): void {
  lastFocused = active;
}

export function forgetEditor(id: string): void {
  if (lastFocused?.id === id) lastFocused = null;
}

function targetEditor(): ActiveEditor | null {
  const element = lastFocused?.element;
  if (!element || !element.isConnected || element.offsetParent === null) return null;
  return lastFocused;
}

function ready(active: ActiveEditor): PierreSurfaceHandle | null {
  return active.handle?.status().kind === "ready" ? active.handle : null;
}

export interface EditorCommand {
  id: string;
  title: string;
  precondition?: (active: ActiveEditor) => boolean;
  run: (active: ActiveEditor) => void | Promise<void>;
}

/** A command that needs the editor surface itself. */
function surfaceCommand(
  id: string,
  title: string,
  run: (handle: PierreSurfaceHandle) => void,
  precondition?: (handle: PierreSurfaceHandle) => boolean,
): EditorCommand {
  return {
    id,
    title,
    precondition: (active) => {
      const handle = ready(active);
      return handle !== null && (precondition?.(handle) ?? true);
    },
    run: (active) => {
      const handle = ready(active);
      if (handle === null) return;
      run(handle);
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
  surfaceCommand("find", "Editor: find in file", (handle) => {
    handle.focus();
    handle.openSearch();
  }),
  surfaceCommand("find-replace", "Editor: find and replace in file", (handle) => {
    handle.focus();
    handle.openSearchReplace();
  }),
  surfaceCommand("find-next", "Editor: find next match", (handle) => handle.findNext()),
  surfaceCommand("find-previous", "Editor: find previous match", (handle) => handle.findNext(true)),
  {
    id: "go-to-line",
    title: "Editor: go to line",
    precondition: (active) => active.goToLine !== null && ready(active) !== null,
    run: (active) => active.goToLine?.(),
  },
  surfaceCommand(
    "undo",
    "Editor: undo",
    (handle) => {
      handle.focus();
      handle.undo();
    },
    (handle) => handle.canUndo(),
  ),
  surfaceCommand(
    "redo",
    "Editor: redo",
    (handle) => {
      handle.focus();
      handle.redo();
    },
    (handle) => handle.canRedo(),
  ),
  {
    id: "toggle-word-wrap",
    title: "Editor: toggle word wrap",
    precondition: (active) => active.toggleWordWrap !== null,
    run: (active) => active.toggleWordWrap?.(),
  },
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
