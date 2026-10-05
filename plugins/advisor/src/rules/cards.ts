// Non-edit evidence cards and watch eligibility (A140 §3.1–3.2).

import { enc } from "./packet.js";

export const OUTPUT_EDGE = 1024;
export const CLAIM_CAP = 2048;

export type CommandOutput =
  | { output: string; outputTruncated: false }
  | { head: string; tail: string; outputTruncated: true; omittedBytes: number };

/** First and last 1 KiB of a command's output, cut on character boundaries. */
export function boundOutput(output: string): CommandOutput {
  const b = Buffer.from(output, "utf8");
  if (b.length <= 2 * OUTPUT_EDGE) return { output, outputTruncated: false };
  let end = OUTPUT_EDGE;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  let start = b.length - OUTPUT_EDGE;
  while (start < b.length && (b[start]! & 0xc0) === 0x80) start++;
  const head = b.subarray(0, end).toString("utf8");
  const tail = b.subarray(start).toString("utf8");
  return { head, tail, outputTruncated: true, omittedBytes: b.length - end - (b.length - start) };
}

export function commandCardText(command: string, exitCode: number | null, durationMs: number | null, out: CommandOutput): string {
  const lines = [
    `$ ${command}`,
    `exit ${exitCode ?? "unknown"}${durationMs === null ? "" : ` · ${Math.round(durationMs)} ms`}`,
  ];
  if (out.outputTruncated) {
    lines.push(out.head, `[output truncated: ${out.omittedBytes} bytes not shown]`, out.tail);
  } else if (out.output) {
    lines.push(out.output);
  }
  return lines.join("\n");
}

/** A completion claim: the turn's final agent message, cut to CLAIM_CAP encoded bytes. */
export function claimText(text: string): { text: string; truncated: boolean } {
  if (enc(text) <= CLAIM_CAP) return { text, truncated: false };
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (enc(cps.slice(0, mid).join("")) <= CLAIM_CAP - 40) lo = mid;
    else hi = mid - 1;
  }
  return { text: cps.slice(0, lo).join("") + "\n[claim truncated]", truncated: true };
}

/**
 * Any thread may be watched, hidden ones included. Threads the Advisor itself
 * owns are refused, so it never reviews its own work; archived threads are not
 * watched (ThreadResponse.archivedAt: number | null).
 */
export function eligible(thread: { pluginMetadata?: Record<string, unknown> | null; archivedAt?: number | null }): [boolean, string] {
  if ((thread.pluginMetadata ?? {})["advisorOwned"]) return [false, "advisor-owned"];
  if (thread.archivedAt !== undefined && thread.archivedAt !== null) return [false, "archived"];
  return [true, "ok"];
}

/** Worker rows cap at 3 assignments x 5 tasks; expand exact assignment refs. */
export function expandProjects(
  workerRow: { assignments: Array<{ ref: string; tasks: string[]; tasksTruncated?: boolean }>; assignmentsTruncated?: boolean },
  assignmentRows: Record<string, { tasks: string[]; truncatedFields?: string[] }>,
): { assignments: string[]; tasks: string[]; coverage: "partial" | "complete"; gaps: string[] } {
  const gaps: string[] = [];
  if (workerRow.assignmentsTruncated) gaps.push("assignments-truncated");
  const tasks: string[] = [];
  for (const a of workerRow.assignments) {
    if (a.tasksTruncated) {
      const row = assignmentRows[a.ref];
      if (!row) {
        gaps.push(`${a.ref}-unreadable`);
        continue;
      }
      tasks.push(...row.tasks);
      if (row.truncatedFields?.includes("tasks")) gaps.push(`${a.ref}-tasks-trimmed`);
    } else {
      tasks.push(...a.tasks);
    }
  }
  return { assignments: workerRow.assignments.map((a) => a.ref), tasks, coverage: gaps.length > 0 ? "partial" : "complete", gaps };
}
