export type EntryKind = "file" | "directory";

export interface FlatEntry {
  path: string;
  kind: EntryKind;
  /** Directory whose contents are not listed yet (see the `tree` RPC). */
  deferred?: true;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: EntryKind;
  children: TreeNode[];
  /** Contents not listed yet; expanding the node requests them. */
  deferred: boolean;
}

export function buildTree(entries: readonly FlatEntry[]): TreeNode[] {
  const root: TreeNode = { path: "", name: "", kind: "directory", children: [], deferred: false };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const directoryAt = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(separator === -1 ? "" : path.slice(0, separator));
    const node: TreeNode = { path, name: path.slice(separator + 1), kind: "directory", children: [], deferred: false };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const entry of entries) {
    const path = normalize(entry.path);
    if (path === "") continue;
    if (entry.kind === "directory") {
      directoryAt(path).deferred = entry.deferred === true;
      continue;
    }
    if (byPath.has(path)) continue;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(separator === -1 ? "" : path.slice(0, separator));
    const node: TreeNode = { path, name: path.slice(separator + 1), kind: "file", children: [], deferred: false };
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
 * Folds a `tree(subpath)` response into the flat entries — or, with
 * `subpath` "", a full reload into them. The level's direct children come
 * from the response — a child missing there was deleted, and what hung
 * below it goes with it — while deeper levels the response does not cover
 * keep their fetched entries: a relisted directory must not drop
 * grandchildren another request listed.
 */
export function mergeListing(
  entries: readonly FlatEntry[],
  subpath: string,
  listing: readonly FlatEntry[],
): FlatEntry[] {
  const prefix = subpath === "" ? "" : `${subpath}/`;
  const isDirectChild = (entryPath: string) =>
    entryPath.startsWith(prefix) && entryPath.slice(prefix.length).split("/").length === 1;
  const direct = new Set(listing.filter((entry) => isDirectChild(entry.path)).map((entry) => entry.path));
  const out: FlatEntry[] = subpath === "" ? [...listing] : [{ path: subpath, kind: "directory" }, ...listing];
  const seen = new Set(out.map((entry) => entry.path));
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    if (!entry.path.startsWith(prefix)) {
      out.push(entry);
      seen.add(entry.path);
      continue;
    }
    // Inside the relisted level an old entry survives only through a direct
    // child that is still listed: itself, or the directory it sits under.
    const top = entry.path.slice(prefix.length).split("/", 1)[0]!;
    if (direct.has(prefix + top)) {
      out.push(entry);
      seen.add(entry.path);
    }
  }
  return out;
}

/** Whether two flat listings hold the same paths with the same kinds and deferred flags. */
export function sameEntries(left: readonly FlatEntry[], right: readonly FlatEntry[]): boolean {
  if (left.length !== right.length) return false;
  const key = (entry: FlatEntry) => `${entry.kind === "directory" ? "d" : "f"}${entry.deferred === true ? "!" : ""}${entry.path}`;
  const keys = new Set(left.map(key));
  return right.every((entry) => keys.has(key(entry)));
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
