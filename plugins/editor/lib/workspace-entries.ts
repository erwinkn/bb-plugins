/**
 * Workspace picker entries, shaped from native thread data plus the Initiatives
 * plugin's tree. Everything here is pure so the naming and availability
 * rules are testable without a BB host.
 *
 * The Initiatives tree v1 is authoritative for Initiative membership: its nodes
 * name the coordinator, work, review and adhoc threads of an Initiative
 * with stable labels and worker refs, across every member BB project. When
 * Initiatives is absent the per-thread metadata tag
 * (`pluginMetadata` under the "initiatives" plugin id, or "projects" before the move:
 * `{role: "coordinator"|"worker"|"adhoc", projectId, worker?, v}`) still
 * applies; an unmanaged thread falls back to the native title and role
 * "thread" — nothing is invented.
 */

/** The subset of `bb.sdk.threads.list` rows the picker needs. */
export interface WorkspaceThreadRow {
  id: string;
  parentThreadId: string | null;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  status: string;
  environmentId: string | null;
  environmentHostId: string | null;
  environmentBranchName: string | null;
  environmentIsWorktree: boolean | null;
  environmentName: string | null;
  environmentPath: string | null;
  environmentWorkspaceDisplayKind: string | null;
}

/** Initiatives' per-thread tag, as much of it as the picker reads. */
export interface WorkspaceThreadMetadata {
  role?: unknown;
  projectId?: unknown;
  worker?: unknown;
}

/** The fields of a Initiatives tree v1 node the picker reads. */
export interface WorkspaceTreeNode {
  label: string;
  role: "coordinator" | "work" | "review" | "adhoc";
  worker: string | null;
  state: string;
  bbProjectId: string;
}

export type WorkspaceRole = "coordinator" | "worker" | "review" | "adhoc" | "thread";

export interface WorkspaceEntry {
  threadId: string;
  role: WorkspaceRole;
  /** The Initiatives worker ref ("W8"); null for unmanaged threads. */
  workerRef: string | null;
  /** Logical label: the Initiatives label when the title carries one. */
  label: string;
  /** The full native thread title, for tooltips and unmanaged rows. */
  title: string | null;
  /** The BB project the thread belongs to, per the Initiatives tree. */
  bbProjectId: string | null;
  status: string;
  archived: boolean;
  environmentId: string | null;
  hostId: string | null;
  branch: string | null;
  isWorktree: boolean | null;
  workspaceKind: string | null;
  environmentName: string | null;
  environmentPath: string | null;
  /** False rows stay listed — selected or stale targets must not vanish. */
  available: boolean;
  reason: string | null;
}

/** Managed titles carry the worker ref: "W22 · Editor scrolling" or "bb-plugins · W33 Control Room feedback". */
const WORKER_REF = /\bW(\d+)\b/;

/**
 * The logical label a managed title carries: the text after the W ref and
 * its separator, minus a trailing " — purpose" tail. Anything unparseable
 * stays the whole title.
 */
function labelFromTitle(title: string | null): string | null {
  if (title === null) return null;
  const ref = WORKER_REF.exec(title);
  const body = ref === null ? title : title.slice(ref.index + ref[0].length);
  const trimmed = body.replace(/^\s*[·\-—:]\s*/, "").replace(/\s+—\s+.*$/, "").trim();
  return trimmed === "" ? title : trimmed;
}

function titleWorkerRef(title: string | null): string | null {
  if (title === null) return null;
  const ref = WORKER_REF.exec(title);
  return ref === null ? null : `W${ref[1]}`;
}

function metadataRole(metadata: WorkspaceThreadMetadata | null): WorkspaceRole | null {
  const role = metadata?.role;
  return role === "coordinator" || role === "worker" || role === "review" || role === "adhoc" ? role : null;
}

function metadataWorkerRef(metadata: WorkspaceThreadMetadata | null): string | null {
  const worker = metadata?.worker;
  return typeof worker === "number" && Number.isInteger(worker) && worker > 0 ? `W${worker}` : null;
}

/**
 * One pickable workspace. `row` comes from `threads.list`/`threads.get`;
 * `node` is the thread's Initiatives tree membership (null when the tree did
 * not name it), `metadata` the older per-thread tag fallback, and
 * `coordinator` marks the panel's owning coordinator.
 */
export function shapeWorkspaceEntry(
  row: WorkspaceThreadRow,
  metadata: WorkspaceThreadMetadata | null,
  options: { coordinator?: boolean; node?: WorkspaceTreeNode | null } = {},
): WorkspaceEntry {
  const node = options.node ?? null;
  const role: WorkspaceRole =
    node !== null
      ? node.role === "work"
        ? "worker"
        : node.role
      : (metadataRole(metadata) ?? (options.coordinator === true ? "coordinator" : "thread"));
  const workerRef = node?.worker ?? metadataWorkerRef(metadata);
  const title = row.title ?? row.titleFallback;
  // The tree node's label is the stable logical name; the mutable native
  // title only fills in when no Initiatives naming applies.
  const label = role === "coordinator" ? "Coordinator" : (node?.label ?? labelFromTitle(title) ?? row.id);
  const archived = row.archivedAt !== null;
  const deleted = row.deletedAt !== null;
  let reason: string | null = null;
  if (deleted) reason = "This thread was deleted";
  else if (archived) reason = "This thread is archived";
  else if (row.environmentId === null) reason = "This thread has no workspace";
  else if (row.environmentPath === null) reason = "This workspace has no filesystem path";
  return {
    threadId: row.id,
    role,
    workerRef: workerRef ?? titleWorkerRef(title),
    label,
    title,
    bbProjectId: node?.bbProjectId ?? null,
    status: row.status,
    archived,
    environmentId: row.environmentId,
    hostId: row.environmentHostId,
    branch: row.environmentBranchName,
    isWorktree: row.environmentIsWorktree,
    workspaceKind: row.environmentWorkspaceDisplayKind,
    environmentName: row.environmentName,
    environmentPath: row.environmentPath,
    available: reason === null,
    reason,
  };
}

/**
 * Picker order: the coordinator first, then numbered workers and reviewers
 * ascending, then adhoc and unmanaged threads by label. Unavailable rows
 * keep their place; the menu disables them rather than hiding what a tab
 * may point at.
 */
export function orderWorkspaceEntries(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
  const rank = (entry: WorkspaceEntry): number =>
    entry.role === "coordinator" ? 0 : entry.workerRef !== null ? 1 : entry.role === "adhoc" ? 2 : 3;
  const workerNum = (ref: string | null): number => (ref === null ? 0 : Number.parseInt(ref.slice(1), 10) || 0);
  return [...entries].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byWorker = workerNum(a.workerRef) - workerNum(b.workerRef);
    if (byWorker !== 0) return byWorker;
    return a.label.localeCompare(b.label);
  });
}

/** How a menu row reads: "W16 · Finish cancellation evidence". */
export function entryDisplayName(entry: Pick<WorkspaceEntry, "role" | "workerRef" | "label">): string {
  if (entry.role === "coordinator") return "Coordinator";
  return entry.workerRef !== null ? `${entry.workerRef} · ${entry.label}` : entry.label;
}
