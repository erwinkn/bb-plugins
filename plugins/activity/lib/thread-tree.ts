import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { compareThreads, STATUSES, type SortBy, type Status } from "./status";

export interface ThreadNode {
  thread: PluginSidebarThread;
  status: Status;
  children: ThreadNode[];
}

export const CHILD_PAGE_SIZE = 3;
export const MAX_NESTING_DEPTH = 2;

// Preserve family order and true parentThreadId, but stop adding visual levels.
export function flattenDescendants(nodes: ThreadNode[]): ThreadNode[] {
  const result: ThreadNode[] = [];
  const pending = [...nodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    result.push({ ...node, children: [] });
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push(node.children[i]);
    }
  }
  return result;
}

export function containsThread(node: ThreadNode, id: string | null): boolean {
  if (!id) return false;
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.thread.id === id) return true;
    for (const child of current.children) pending.push(child);
  }
  return false;
}

// Build after visibility filtering: a missing or hidden parent must not hide a
// visible child. Sorting applies to roots and siblings, never across a family.
export function buildThreadTree(
  rows: { thread: PluginSidebarThread; status: Status }[],
  sortBy: SortBy,
): ThreadNode[] {
  const nodes = new Map<string, ThreadNode>(
    rows.map((row) => [row.thread.id, { ...row, children: [] }]),
  );
  const roots: ThreadNode[] = [];
  const attachedParents = new Map<string, string>();
  for (const node of nodes.values()) {
    const parent = nodes.get(node.thread.parentThreadId ?? "");
    let ancestor = parent?.thread.id;
    while (ancestor && ancestor !== node.thread.id) {
      ancestor = attachedParents.get(ancestor);
    }
    if (parent && ancestor !== node.thread.id) {
      parent.children.push(node);
      attachedParents.set(node.thread.id, parent.thread.id);
    } else {
      roots.push(node);
    }
  }
  const sort = (siblings: ThreadNode[]) => {
    siblings.sort((a, b) => compareThreads(a.thread, b.thread, sortBy));
    for (const node of siblings) sort(node.children);
  };
  sort(roots);
  return roots;
}

// Family priority follows the visible category order, without changing any
// thread's own status or unread state.
export function familyStatus(node: ThreadNode): Status {
  return node.children.reduce((highest, child) => {
    const next = familyStatus(child);
    return STATUSES.indexOf(next) < STATUSES.indexOf(highest) ? next : highest;
  }, node.status);
}
