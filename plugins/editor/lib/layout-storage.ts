/** Persisted workbench layout: tree width and whether the tree is shown. */

const PREFIX = "bb-plugin-erwin-editor:";

export const DEFAULT_TREE_WIDTH = 200;
export const MIN_TREE_WIDTH = 140;
export const MIN_EDITOR_WIDTH = 200;

export function clampTreeWidth(width: number, available: number): number {
  const max = Math.max(MIN_TREE_WIDTH, available - MIN_EDITOR_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_TREE_WIDTH), max));
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {}
}

export function readTreeWidth(): number {
  const raw = read("tree-width");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, MIN_TREE_WIDTH) : DEFAULT_TREE_WIDTH;
}

export function storeTreeWidth(width: number): void {
  write("tree-width", String(Math.round(width)));
}

export function readTreeOpen(surface: "opener" | "panel"): boolean {
  const raw = read(`tree-open:${surface}`);
  return raw === null ? surface === "panel" : raw === "1";
}

export function storeTreeOpen(surface: "opener" | "panel", open: boolean): void {
  write(`tree-open:${surface}`, open ? "1" : "0");
}

/** The file last shown in a Files panel, keyed by its workspace identity. */
export function readLastFile(workspaceKey: string): string | null {
  return read(`last-file:${workspaceKey}`);
}

export function storeLastFile(workspaceKey: string, path: string | null): void {
  if (path === null) {
    try {
      window.localStorage.removeItem(`${PREFIX}last-file:${workspaceKey}`);
    } catch {}
    return;
  }
  write(`last-file:${workspaceKey}`, path);
}
