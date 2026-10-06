import { z } from "zod";
import type { Store, Membership } from "./store";
import { ProjectError, errorMessage, isDefiniteRejection, textInput, type Sdk, type ThreadDto } from "./bb";

export const messageSchema = z.object({
  target: z.union([z.literal("coordinator"), z.string().max(32).regex(/^W[1-9]\d*$/, "Use a current W# or coordinator.")]),
  text: z.string().trim().min(1).max(20000),
  mode: z.enum(["steer", "queue"]).default("queue").describe("steer: urgent corrections and blockers; queue (default): everything else."),
}).strict();
export type InitiativeMessage = z.infer<typeof messageSchema>;
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
  if (!m || m.former || m.kind === "adhoc") throw new ProjectError("Messages require current managed Initiative membership; former and user-owned threads cannot use this wrapper.");
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

/** One native send, with caller provenance and no plugin inbox, retry or wake on reads. */
export async function sendInitiativeMessage(store: Store, sdk: Sdk, caller: string, input: InitiativeMessage, projectId?: string) {
  const resolve = () => {
    const from = currentMember(store, caller);
    if (projectId && from.m.project.id !== projectId) throw new ProjectError("Cannot message another Initiative.");
    const id = input.target === "coordinator" ? from.m.project.coordinatorThreadId : store.worker(from.m.project.id, Number(input.target.slice(1)))?.threadId;
    if (!id) throw new ProjectError("Target has no current native thread. Read workers and ask the coordinator.");
    if (id === caller) throw new ProjectError("Don't send yourself a message.");
    const to = currentMember(store, id);
    if (to.m.project.id !== from.m.project.id || input.target !== "coordinator" && to.m.worker?.ref !== input.target)
      throw new ProjectError("Target is not a current member of this Initiative.");
    if (from.m.worker?.role === "review" && to.m.kind !== "coordinator" || to.m.worker?.role === "review" && from.m.kind !== "coordinator")
      throw new ProjectError("Independent reviewers communicate through the current coordinator; direct peer messages are for work workers.");
    return { from, to, id, generation: to.m.worker?.generation ?? null };
  };
  const initial = resolve();
  const [sender, target] = await Promise.all([sdk.threads.get({ threadId: caller }), sdk.threads.get({ threadId: initial.id })]);
  const fresh = resolve();
  if (fresh.id !== initial.id || fresh.generation !== initial.generation || fresh.from.assignment !== initial.from.assignment || fresh.to.assignment !== initial.to.assignment || fresh.from.m.worker?.generation !== initial.from.m.worker?.generation)
    throw new ProjectError("Caller, target or assignment changed while checking native state; read current membership before a new message.");
  if (sender.id !== caller || target.id !== fresh.id) throw new ProjectError("Native lookup did not confirm caller/target identity; no message sent.");
  nativeAvailable(sender, fresh.from.m); nativeAvailable(target, fresh.to.m, input.mode === "queue");
  const identity = fresh.from.m.worker ? `${fresh.from.m.worker.ref} (${fresh.from.m.worker.role})` : "coordinator";
  try {
    const receipt = await sdk.threads.send({ threadId: fresh.id, senderThreadId: caller,
      mode: input.mode === "steer" ? "steer-if-active" : "queue-if-active",
      input: textInput(`Initiative · ${fresh.from.m.project.name} · From ${identity}\n\n${input.text}`) });
    return { target: input.target, threadId: fresh.id, generation: fresh.generation, receipt };
  } catch (error) {
    throw new ProjectError(`Native message ${isDefiniteRejection(error) ? "refused" : "delivery uncertain"} to ${input.target} at ${fresh.id}${fresh.generation === null ? "" : ` generation ${fresh.generation}`}: ${errorMessage(error)}. Inspect native receipts before another send; no automatic retry.`);
  }
}
