export type EntryKind = "file" | "directory";

/** A symbolic link's target as written in the link; `broken` when nothing is there. */
export interface LinkInfo {
  target: string;
  broken?: true;
}

export interface FlatEntry {
  path: string;
  kind: EntryKind;
  /** Directory whose contents are not listed yet (see the `tree` RPC). */
  deferred?: true;
  /** Set for a symbolic link; `kind` is then its target's kind. */
  link?: LinkInfo;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: EntryKind;
  children: TreeNode[];
  /** Contents not listed yet; expanding the node requests them. */
  deferred: boolean;
  /** The symbolic link this entry is, or null for a regular entry. */
  link: LinkInfo | null;
}

export function buildTree(entries: readonly FlatEntry[]): TreeNode[] {
  const root: TreeNode = { path: "", name: "", kind: "directory", children: [], deferred: false, link: null };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const directoryAt = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(separator === -1 ? "" : path.slice(0, separator));
    const node: TreeNode = { path, name: path.slice(separator + 1), kind: "directory", children: [], deferred: false, link: null };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const entry of entries) {
    const path = normalize(entry.path);
    if (path === "") continue;
    if (entry.kind === "directory") {
      const node = directoryAt(path);
      node.deferred = entry.deferred === true;
      node.link = entry.link ?? null;
      continue;
    }
    if (byPath.has(path)) continue;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(separator === -1 ? "" : path.slice(0, separator));
    const node: TreeNode = { path, name: path.slice(separator + 1), kind: "file", children: [], deferred: false, link: entry.link ?? null };
    byPath.set(path, node);
    parent.children.push(node);
  }

  sortRecursively(root);
  return root.children;
}

function normalize(path: string): string {
  return path.replace(/^\.?\//, "").replace(/\/+$/, "");
}

function sortRecursively(node: TreeNode): void {
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  for (const child of node.children) sortRecursively(child);
}

/**
 * Folds a `tree(subpath)` response into the flat entries. The directory's
 * direct children come from the response — a child missing there was deleted
 * — while deeper levels it does not cover keep their fetched entries: a
 * re-requested directory must not drop grandchildren another expand listed.
 */
export function mergeListing(
  entries: readonly FlatEntry[],
  subpath: string,
  listing: readonly FlatEntry[],
): FlatEntry[] {
  const prefix = `${subpath}/`;
  const depth = (entryPath: string) => entryPath.slice(prefix.length).split("/").length;
  const direct = new Set(
    listing.filter((entry) => entry.path.startsWith(prefix) && depth(entry.path) === 1).map((entry) => entry.path),
  );
  // The directory resolves, keeping what its own listing said about it (a
  // symbolic link's target) since the level below does not describe it.
  const { deferred: _deferred, ...self } = entries.find((entry) => entry.path === subpath) ?? { path: subpath, kind: "directory" as const };
  const out: FlatEntry[] = [{ ...self, kind: "directory" }, ...listing];
  const seen = new Set(out.map((entry) => entry.path));
  for (const entry of entries) {
    if (entry.path === subpath || seen.has(entry.path)) continue;
    if (entry.path.startsWith(prefix) && depth(entry.path) === 1 && !direct.has(entry.path)) continue;
    out.push(entry);
    seen.add(entry.path);
  }
  return out;
}

/** The last segment of a path and what precedes it, without the slash. */
export function splitPath(path: string): { directory: string; name: string } {
  const name = path.split("/").at(-1) ?? path;
  return { directory: path.slice(0, path.length - name.length).replace(/\/$/, ""), name };
}

export function ancestorsOf(path: string): string[] {
  const segments = normalize(path).split("/");
  segments.pop();
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
}

export interface FilteredTree {
  nodes: TreeNode[];
  expand: Set<string>;
  matchCount: number;
}

export function filterTree(nodes: readonly TreeNode[], query: string): FilteredTree {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { nodes: [...nodes], expand: new Set(), matchCount: 0 };

  const expand = new Set<string>();
  let matchCount = 0;

  const visit = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") {
      if (!node.path.toLowerCase().includes(needle)) return null;
      matchCount += 1;
      return node;
    }
    const children = node.children.map(visit).filter((child): child is TreeNode => child !== null);
    if (children.length === 0) return null;
    expand.add(node.path);
    return { ...node, children };
  };

  return {
    nodes: nodes.map(visit).filter((node): node is TreeNode => node !== null),
    expand,
    matchCount,
  };
}

/**
 * Subsequence match for quick open: every query character must appear in
 * order; runs of consecutive matches and matches at path boundaries score
 * higher. Returns null when the path does not match.
 */
export function fuzzyScore(path: string, query: string): number | null {
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (needle === "") return 0;
  let score = 0;
  let index = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found === -1) return null;
    score += found === previous + 1 ? 3 : 1;
    if (found === 0 || "/-_.".includes(haystack[found - 1] ?? "")) score += 2;
    previous = found;
    index = found + 1;
  }
  const name = haystack.slice(haystack.lastIndexOf("/") + 1);
  if (name.replace(/[-_. ]/g, "").includes(needle)) score += 5;
  return score - haystack.length / 100;
}
