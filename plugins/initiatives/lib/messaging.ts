import { z } from "zod";
import type { Store, Membership } from "./store";
import { ProjectError, errorMessage, isDefiniteRejection, textInput, type Sdk, type ThreadDto } from "./bb";

/** The default depends on the pair (messageMode): a lead steers a worker, everyone else queues. */
export const MODE_HELP = "Default: steer from a lead to a worker, so a correction or new fact arrives mid-turn in the order sent; queue otherwise. queue holds the message until the recipient's turn ends: use it only for what must wait.";
export const messageSchema = z.object({
  /** v9: "lead" is a worker's lead (§5.1); a worker's "coordinator" means the same. */
  target: z.union([z.literal("coordinator"), z.literal("lead"), z.string().max(32).regex(/^W[1-9]\d*$/, "Use a current W#, lead or coordinator.")]),
  text: z.string().trim().min(1).max(20000),
  mode: z.enum(["steer", "queue"]).optional().describe(MODE_HELP),
}).strict();
export type InitiativeMessage = z.infer<typeof messageSchema>;
/**
 * A queued message to a busy worker is held until its turn ends, so a later steer overtakes it and
 * the stale one then starts a new turn on dropped work. A lead therefore steers by default; a
 * recipient that has not started (pending) can only queue. An explicit mode always wins.
 */
export function messageMode(explicit: "steer" | "queue" | undefined, fromLead: boolean, toWorker: boolean, targetStatus?: string): "steer" | "queue" {
  if (explicit) return explicit;
  return fromLead && toWorker && targetStatus !== "pending" ? "steer" : "queue";
}
const isLead = (m: Membership) => m.kind === "coordinator" || !!m.discussion;
const activeStates = ["dispatching", "queued", "running", "idle_no_report", "stopped"];

/** Cheap bounded assignment/task references, with no report or usage projection. */
export function workerWork(store: Store, projectId: string, num: number, generation: number) {
  const rows = store.db.prepare(`SELECT num,state,task_nums,cancel_requested FROM assignments WHERE project_id=? AND worker_num=? AND generation=? AND state IN (${activeStates.map(() => "?").join(",")}) ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END,num ASC LIMIT 4`)
    .all(projectId, num, generation, ...activeStates) as { num: number; state: string; task_nums: string; cancel_requested: number }[];
  return { assignments: rows.slice(0, 3).map(a => {
    const tasks = JSON.parse(a.task_nums) as number[];
    return { ref: `A${a.num}`, state: a.state, cancelled: !!a.cancel_requested, tasks: tasks.slice(0, 5).map(n => `T${n}`), ...(tasks.length > 5 ? { tasksTruncated: true } : {}) };
  }), assignmentsTruncated: rows.length > 3 };
}

export function currentIdentity(store: Store, m: Membership) {
  return { initiative: m.project.id, coordinator: m.project.coordinatorThreadId,
    ...(m.worker ? { worker: m.worker.ref, role: m.worker.role, generation: m.worker.generation, threadId: m.worker.threadId,
      ...workerWork(store, m.project.id, m.worker.num, m.worker.generation) } : { role: "coordinator", threadId: m.project.coordinatorThreadId }) };
}

function currentMember(store: Store, threadId: string) {
  const m = store.membership(threadId);
  // A discussion is the user's own thread that may message the coordinator (D480).
  if (!m || m.former || m.kind === "adhoc" && !m.discussion) throw new ProjectError("Messages require current managed Initiative membership; former and user-owned threads cannot use this wrapper.");
  if (m.worker) {
    // T136: a worker stays reachable after it reports, until it is retired or stopped.
    const w = m.worker;
    if (w.threadId !== threadId || w.userStopped || w.state === "retired") throw new ProjectError(`${w.ref} is stopped, retired or no longer current.`);
    // A Stop or an unconfirmed start that has not settled must not be woken by a message.
    const latest = store.latestAssignment(m.project.id, w.num);
    if (latest && ((latest.cancelRequested && latest.state !== "cancelled") || ["pending", "uncertain"].includes(latest.opState)))
      throw new ProjectError(`${w.ref}'s ${latest.ref} is being stopped or is not confirmed yet; message it once that settles.`);
    const a = store.openAssignment(m.project.id, w.num);
    return { m, assignment: a && a.generation === w.generation ? a.ref : null };
  }
  return { m, assignment: null };
}
/** Whether this wrapper's own membership checks would admit the caller now; no native read. */
export function messageCallerAdmitted(store: Store, threadId: string): boolean {
  try { currentMember(store, threadId); return true; } catch { return false; }
}
function nativeAvailable(thread: ThreadDto, m: Membership, pendingQueue = false) {
  if (thread.archivedAt !== null || thread.deletedAt !== null || !(pendingQueue ? ["idle", "active", "starting", "pending"] : ["idle", "active", "starting"]).includes(thread.status) || !m.project.memberProjectIds.includes(thread.projectId))
    throw new ProjectError(`Native caller/target is unavailable (status ${thread.status}), archived, deleted or outside this Initiative. Pending recipients support queue mode only; messaging cannot resume stopped/finished work.`);
}

/**
 * One native send, with caller provenance and no plugin inbox, retry or wake on reads. v9: a
 * worker's "lead" (or "coordinator") goes to its lead, resolved by `workerLead` (§5.1); a lead's
 * "coordinator" is the coordinator tab; any lead may message any worker.
 */
export async function sendInitiativeMessage(store: Store, sdk: Sdk, caller: string, input: InitiativeMessage, projectId?: string,
  workerLead?: (m: Membership) => Promise<string | null>) {
  const sender = currentMember(store, caller);
  const toLead = !!sender.m.worker && (input.target === "lead" || input.target === "coordinator");
  const leadId = toLead && workerLead ? await workerLead(sender.m) : null;
  const resolve = () => {
    const from = currentMember(store, caller);
    if (projectId && from.m.project.id !== projectId) throw new ProjectError("Cannot message another Initiative.");
    const byRef = input.target !== "coordinator" && input.target !== "lead";
    const id = !byRef
      ? (toLead ? leadId ?? from.m.project.coordinatorThreadId : from.m.project.coordinatorThreadId)
      : store.worker(from.m.project.id, Number(input.target.slice(1)))?.threadId;
    if (!id) throw new ProjectError("Target has no current native thread. Read workers and ask a lead.");
    if (id === caller) throw new ProjectError("Don't send yourself a message.");
    const to = currentMember(store, id);
    if (to.m.project.id !== from.m.project.id || byRef && to.m.worker?.ref !== input.target)
      throw new ProjectError("Target is not a current member of this Initiative.");
    if (from.m.worker?.role === "review" && !isLead(to.m) || to.m.worker?.role === "review" && !isLead(from.m))
      throw new ProjectError("Independent reviewers communicate through a lead; direct peer messages are for work workers.");
    return { from, to, id, generation: to.m.worker?.generation ?? null };
  };
  const initial = resolve();
  const [senderThread, target] = await Promise.all([sdk.threads.get({ threadId: caller }), sdk.threads.get({ threadId: initial.id })]);
  const fresh = resolve();
  if (fresh.id !== initial.id || fresh.generation !== initial.generation || fresh.from.assignment !== initial.from.assignment || fresh.to.assignment !== initial.to.assignment || fresh.from.m.worker?.generation !== initial.from.m.worker?.generation)
    throw new ProjectError("Caller, target or assignment changed while checking native state; read current membership before a new message.");
  if (senderThread.id !== caller || target.id !== fresh.id) throw new ProjectError("Native lookup did not confirm caller/target identity; no message sent.");
  const mode = messageMode(input.mode, isLead(fresh.from.m), !!fresh.to.m.worker, target.status);
  nativeAvailable(senderThread, fresh.from.m); nativeAvailable(target, fresh.to.m, mode === "queue");
  const identity = fresh.from.m.worker ? `${fresh.from.m.worker.ref} (${fresh.from.m.worker.role})`
    : fresh.from.m.discussion ? `lead tab "${senderThread.title ?? caller}"` : "coordinator";
  try {
    const receipt = await sdk.threads.send({ threadId: fresh.id, senderThreadId: caller,
      mode: mode === "steer" ? "steer-if-active" : "queue-if-active",
      input: textInput(`Initiative · ${fresh.from.m.project.name} · From ${identity}\n\n${input.text}`) });
    return { target: input.target, threadId: fresh.id, generation: fresh.generation, receipt };
  } catch (error) {
    throw new ProjectError(`Native message ${isDefiniteRejection(error) ? "refused" : "delivery uncertain"} to ${input.target} at ${fresh.id}${fresh.generation === null ? "" : ` generation ${fresh.generation}`}: ${errorMessage(error)}. Inspect native receipts before another send; no automatic retry.`);
  }
}
