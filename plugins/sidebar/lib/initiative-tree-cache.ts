import { treeSchema, type ProjectTree } from "./project-tree-schema";

const KEY = "bb-plugin-sidebar:initiative-tree:v1";

/**
 * The last Initiatives tree this client confirmed, in its displayed order, so
 * the Initiatives list draws at once on mount and the first read refreshes it
 * in the background. Null without a valid entry.
 */
export function cachedTree(): ProjectTree | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = treeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Null forgets the entry: Initiatives is not running. */
export function cacheTree(tree: ProjectTree | null) {
  try {
    if (tree) window.localStorage.setItem(KEY, JSON.stringify(tree));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* Memory-only mode: the next mount reads again. */
  }
}
