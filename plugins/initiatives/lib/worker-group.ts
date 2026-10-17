/**
 * Where a current worker stands, derived once. The Workers tab, the overview the Threads
 * sidebar reads (`workerGroups`) and the sidebar's own rows all take their group from here, so
 * they cannot disagree about the same facts.
 */
/** A live turn waiting on the user (an approval or a question): BB's live view reports it, the server's copy has no such status. */
export const INPUT_THREAD = "waiting-for-input";
export const BUSY_THREAD = new Set(["active", "starting", "stopping", INPUT_THREAD]);
export const FAILED_THREAD = new Set(["error", "failed"]);

export type WorkerGroup = "needs" | "working" | "waiting" | "done" | "stopped" | "idle";

/** Why a worker is in its group: the finer cases the Workers tab words differently. */
export type WorkerKind = "asksUser" | "input" | "running" | "waiting" | "failed" | "idleNoReport" | "open" | "stopReason" | "done" | "onCoordinator" | "reported" | "none";

export const KIND_GROUP: Record<WorkerKind, WorkerGroup> = {
  asksUser: "needs",
  input: "needs",
  running: "working",
  waiting: "waiting",
  onCoordinator: "waiting",
  failed: "stopped",
  idleNoReport: "waiting",
  open: "stopped",
  stopReason: "stopped",
  done: "done",
  reported: "stopped",
  none: "idle",
};

export interface WorkerFacts {
  /**
   * Its blocker is an open question in the user's Inbox: a blocker card they have neither
   * answered nor dismissed, the rule the Inbox's Needs you count follows (needsYouCount).
   */
  asksUser: boolean;
  /** The thread's status (see `workerRuntime`). */
  runtime: string;
  /** A live descendant it waits on. */
  waiting: boolean;
  open: boolean;
  stopReason: boolean;
  /** The latest report's outcome, or null. */
  outcome: string | null;
}

export function workerKind(f: WorkerFacts): WorkerKind {
  if (f.asksUser) return "asksUser";
  if (f.runtime === INPUT_THREAD) return "input";
  if (BUSY_THREAD.has(f.runtime)) return "running";
  if (f.waiting) return "waiting";
  if (FAILED_THREAD.has(f.runtime)) return "failed";
  // Open work on a thread that went idle without reporting: it may have asked its lead by plain
  // message and stopped. It waits on someone; it is not working, and it does not need the user.
  if (f.open) return f.runtime === "idle" && !f.stopReason ? "idleNoReport" : "open";
  if (f.stopReason) return "stopReason";
  if (f.outcome === "done") return "done";
  // Blocked, with nothing left for the user to answer: the coordinator acts next.
  if (f.outcome === "blocked") return "onCoordinator";
  return f.outcome ? "reported" : "none";
}

export const workerGroup = (facts: WorkerFacts): WorkerGroup => KIND_GROUP[workerKind(facts)];

/** The fields of the host's live thread list (`experimental_useSidebarThreads`) a worker's status reads. */
export interface HostThread {
  isArchived: boolean;
  hasPendingInteraction: boolean;
  indicator: string;
  activity: object;
}

/** What the Threads sidebar counts as work: the same set as its own `statusOf`. */
const WORK_INDICATORS = new Set(["runtime", "background-agent", "background-command", "workflow", "plan-mode", "goal", "working-draft"]);

/** Whether the host counts work running on the thread (a turn, a background command, a workflow), whatever else it shows. */
export const hostWorks = (host: HostThread) =>
  WORK_INDICATORS.has(host.indicator) || Object.values(host.activity).some((count: unknown) => Number(count) > 0);

/**
 * A worker's thread status. BB's live view of the thread decides, since the host keeps it current
 * in real time while the server's copy is a cache: a thread the cache still reads as active (a
 * provider failure, a usage limit, no turn completion announced) is stopped once BB says so. The
 * precedence is the sidebar's `statusOf`: an unread error, then a pending question or approval,
 * then work. A quiet thread keeps what the server recorded, so an error survives the user reading
 * it. A thread BB does not list keeps the server's status.
 */
export function workerRuntime(server: string, host: HostThread | undefined): string {
  if (!host) return server;
  if (host.isArchived) return "archived";
  if (host.indicator === "unread-error") return "error";
  if (host.hasPendingInteraction || host.indicator === "waiting-for-input") return INPUT_THREAD;
  if (hostWorks(host))
    return BUSY_THREAD.has(server) ? server : "active";
  return BUSY_THREAD.has(server) ? "idle" : server;
}

/** A thread of the host's live list, with what a worker's descendants are read from. */
export type LiveListThread = HostThread & { id: string; parentThreadId: string | null; title: string | null; titleFallback: string | null; updatedAt: number };

/** Whether a descendant counts as live work: running or asking for input; an unread error is neither, as in the sidebar. */
const liveChild = (thread: HostThread) =>
  !thread.isArchived && (thread.hasPendingInteraction || thread.indicator === "waiting-for-input" || (thread.indicator !== "unread-error" && workerRuntime("idle", thread) === "active"));

/** Whether anything still runs on the thread or waits on the user in it, whatever an unread error shows over it. */
const stillBusy = (thread: HostThread) =>
  !thread.isArchived && (hostWorks(thread) || thread.hasPendingInteraction || thread.indicator === "waiting-for-input");

/**
 * The first live descendant of `rootId` in the host's list, walking through archived threads in
 * between, or null. What the Workers tab and the sidebar's rows both read for "waits on a child".
 */
function liveDescendant(rootId: string, children: Map<string, LiveListThread[]>, live: (thread: HostThread) => boolean = liveChild): LiveListThread | null {
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length)
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      if (live(child)) return child;
      seen.add(child.id);
      queue.push(child.id);
    }
  return null;
}

/**
 * The overview with each current worker's, and the coordinator's, thread status, and the live
 * descendant each waits on, read from BB's live thread list, which the host keeps current in real
 * time, instead of the server's cached copy.
 */
export function withLiveRuntime<T extends {
  project: { coordinatorThreadId: string | null; coordinatorStatus: string };
  workers: { current: { ref: string; threadId: string | null; runtime: string; liveWork?: boolean }[] };
  workerWaiting?: Record<string, { on: { threadId: string; title: string; running: string; since: number } | null; checked: boolean; children?: number | null }>;
}>(overview: T, threads: readonly LiveListThread[]): T {
  const host = new Map(threads.map((t) => [t.id, t]));
  const children = new Map<string, LiveListThread[]>();
  for (const t of threads) if (t.parentThreadId) children.set(t.parentThreadId, [...(children.get(t.parentThreadId) ?? []), t]);
  const read = (threadId: string | null, status: string) => (threadId ? workerRuntime(status, host.get(threadId)) : status);
  let changed = false;
  let workerWaiting = overview.workerWaiting;
  const current = overview.workers.current.map((w) => {
    const runtime = read(w.threadId, w.runtime);
    const known = overview.workerWaiting?.[w.ref];
    const child = w.threadId && !known?.on ? liveDescendant(w.threadId, children) : null;
    if (child) {
      // The cache's child count predates this child: unknown until it lists again.
      workerWaiting = { ...workerWaiting, [w.ref]: { ...known, checked: true, children: null, on: { threadId: child.id, title: child.title?.trim() || child.titleFallback?.trim() || "Untitled thread", running: workerRuntime("idle", child) === INPUT_THREAD ? "pending" : "active", since: child.updatedAt } } };
      changed = true;
    }
    // An error masks work BB still counts on the thread or below it; Stop stays offered for it.
    const hosted = w.threadId ? host.get(w.threadId) : undefined;
    const liveWork = !!hosted && !BUSY_THREAD.has(runtime) &&
      (stillBusy(hosted) || liveDescendant(w.threadId!, children, stillBusy) !== null);
    if (runtime === w.runtime && !liveWork) return w;
    changed = true;
    return { ...w, runtime, ...(liveWork ? { liveWork } : {}) };
  });
  const coordinatorStatus = read(overview.project.coordinatorThreadId, overview.project.coordinatorStatus);
  if (!changed && coordinatorStatus === overview.project.coordinatorStatus) return overview;
  return { ...overview, project: { ...overview.project, coordinatorStatus }, workers: { ...overview.workers, current }, ...(workerWaiting ? { workerWaiting } : {}) };
}
