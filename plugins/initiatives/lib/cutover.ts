import type { AssignmentRecord, Store } from "./store";
import { workerRef } from "./store";

// v9's switch to worker-owned reviews (§12). Work the previous build gave out is marked by
// reply_to IS NULL: that build never writes the column and v9 writes it on every assignment.
// Only assignments are classified, never sessions.

/** Present once v9 has loaded; its time moves on each cutover. */
export const CUTOVER_FLAG = "loops-v5";

export const isPreSwitch = (a: Pick<AssignmentRecord, "replyTo">) => a.replyTo === null;

/** The one line every place a lead reads a pre-switch report carries. */
export function preSwitchLine(a: Pick<AssignmentRecord, "replyTo" | "role" | "workerNum">): string | null {
  if (!isPreSwitch(a)) return null;
  const w = workerRef(a.workerNum);
  return a.role === "review"
    ? "A review given out before the switch. Pass it to the worker it reviewed with initiative_message work:true."
    : `Given out before the switch to worker-owned reviews: ${w} did not review this itself. For a code change, unless the report names a clean independent review of its final head, send it back to ${w} with initiative_message work:true to review and fix it. An analysis needs no review. Leads no longer start reviewers.`;
}

const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

/** Sent once per cutover to each live lead tab, steering, so it lands before anything queued. */
export function cutoverInstruction(at: number): string {
  return `Initiatives switched to worker-owned reviews at ${hhmm(at)} UTC. Workers now start their own reviewers and report once: done after a clean review, or blocked. Reports on work given out before the switch, including any already waiting in your queue, come from the old loop: for a code change, "done" there doesn't mean independently reviewed. Unless such a report names a clean independent review of its final head, send it back to the same worker with initiative_message work:true to review and fix it. An analysis needs no review. Don't start reviewers. If your tools lack initiative_spawn or initiative_rule, this session predates the switch: use \`bb initiative command '<json>'\` (examples: \`bb initiative describe\`).`;
}

/**
 * The Initiatives this load is a cutover for: every one when the flag is absent (the first
 * switch), else those with pre-switch work created after the flag's time (the previous build ran
 * and gave out work since). An ordinary reload matches nothing.
 */
export function cutoverProjects(store: Store): string[] {
  const since = store.flagSetAt(CUTOVER_FLAG);
  const live = store.projects().map((p) => p.id);
  if (since === null) return live;
  const rows = store.db
    .prepare(`SELECT DISTINCT project_id FROM assignments WHERE reply_to IS NULL AND created_at > ?`)
    .all(since) as { project_id: string }[];
  const changed = new Set(rows.map((r) => r.project_id));
  return live.filter((id) => changed.has(id));
}

/**
 * The block a coordinator's first message ends with when a worker that isn't retired has a
 * pre-switch latest assignment: the cutover paragraph, then each such assignment's line.
 */
export function preSwitchBlock(store: Store, projectId: string, at: number | null): string | null {
  const lines: string[] = [];
  for (const worker of store.workers(projectId)) {
    if (worker.state === "retired") continue;
    const latest = store.latestAssignment(projectId, worker.num);
    if (!latest || !isPreSwitch(latest)) continue;
    const report = latest.report;
    const summary = report ? (report.handoff.summary.length > 300 ? `${report.handoff.summary.slice(0, 299).trimEnd()}…` : report.handoff.summary) : null;
    lines.push(`- ${worker.ref} · ${latest.ref} · ${report ? `reported ${report.outcome === "succeeded" ? "done" : report.outcome}${latest.reportedAt ? ` ${hhmm(latest.reportedAt)} UTC` : ""} · "${summary}"\n  ${preSwitchLine(latest)}` : `${latest.state}, no report yet`}`);
  }
  if (!lines.length) return null;
  return [`Work given out before the switch to worker-owned reviews (${lines.length} worker${lines.length === 1 ? "" : "s"}):`, cutoverInstruction(at ?? store.now()), ...lines].join("\n");
}
