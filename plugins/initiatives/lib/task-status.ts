import type { TaskStatus } from "./schema";
import { canonicalPrUrl } from "./pr-stages";

// v9 (D517, D522): a task's status is computed on read from the work that links it and the
// PRs that work names, unless someone set it by hand. Pure: the store gathers the facts.

/** What the hand may set; "auto" clears a hand-set status (Follow the work). */
export const HAND_STATUSES = ["planned", "cancelled", "done"] as const;
export type HandStatus = (typeof HAND_STATUSES)[number];

/** A PR's last known GitHub state; null when nothing has been looked up yet. */
export type PrState = "OPEN" | "MERGED" | "CLOSED" | null;

export interface LinkingWork {
  num: number;
  workerNum: number;
  state: string;
  report: { outcome: string; summary: string } | null;
  stopReason: string | null;
  /** Closed because its thread failed (not a refused or never-sent dispatch). */
  threadFailed: boolean;
  /** The PRs this work names: its PR records and the PRs its report names (reportPrs). */
  prs: { url: string; state: PrState; stage: string | null }[];
}

const OPEN = ["dispatching", "queued", "running", "idle_no_report", "stopped"];
const prName = (url: string) => {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i.exec(url);
  return match ? `#${match[2]}` : url;
};
const clip = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The shown status and why. `linking` holds the work assignments naming the task, any order.
 *
 * - hand-set: the stored status ("set by hand")
 * - no work: planned · open work: in progress
 * - else from the newest work: blocked or failed report → blocked; done with no PR → done; done
 *   with a PR open or unknown → in progress; done with every PR closed → done when one merged,
 *   else planned; no report and failed → blocked; no report and cancelled → planned.
 *
 * The newest work decides the outcome; the PRs are every linking work's, so a follow-up that
 * does not repeat its predecessor's PR still waits for that PR.
 */
export function computeTaskStatus(
  task: { status: TaskStatus; statusSetAt: number | null },
  linking: LinkingWork[],
): { status: TaskStatus; reason: string } {
  if (task.statusSetAt !== null) return { status: task.status, reason: "set by hand" };
  if (!linking.length) return { status: "planned", reason: "no worker yet" };
  const sorted = [...linking].sort((a, b) => a.num - b.num);
  const open = sorted.filter((a) => OPEN.includes(a.state));
  if (open.length) {
    const a = open.at(-1)!;
    return { status: "in_progress", reason: `W${a.workerNum} on A${a.num}` };
  }
  const a = sorted.at(-1)!;
  const worker = `W${a.workerNum}`;
  if (a.report) {
    if (a.report.outcome !== "succeeded") return { status: "blocked", reason: `${worker}: ${clip(a.report.summary)}` };
    // Newest work's PRs first, so the reason names the PR the latest work is about.
    const prs = [...new Map([...sorted].reverse().flatMap((w) => w.prs).map((pr) => [pr.url, pr])).values()];
    if (!prs.length) return { status: "done", reason: `${worker} reported done, no PR` };
    const pending = prs.find((pr) => pr.state !== "MERGED" && pr.state !== "CLOSED");
    if (pending)
      return { status: "in_progress", reason: `${prName(pending.url)} ${pending.state === "OPEN" ? "open" : "state not known yet"}${pending.stage ? ` · ${pending.stage.replace(/-/g, " ")}` : ""}` };
    const merged = prs.find((pr) => pr.state === "MERGED");
    if (merged) return { status: "done", reason: `${prName(merged.url)} merged` };
    return { status: "planned", reason: `${prs.map((pr) => prName(pr.url)).join(", ")} closed unmerged` };
  }
  if (a.state === "failed" && a.threadFailed) return { status: "blocked", reason: `${worker}: ${clip(a.stopReason ?? "failed")}` };
  if (a.state === "failed") return { status: "planned", reason: `${worker}'s work never started: ${clip(a.stopReason ?? "failed")}` };
  return { status: "planned", reason: `${worker} stopped${a.stopReason ? `: ${clip(a.stopReason)}` : ""}` };
}

/** A PR a text names by URL or as owner/repo#12; a number clipped by "…" names no PR. */
const PR_REF = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?![\d…])|\b[\w.-]+\/[\w.-]+#\d+(?![\d…])/gi;
/** The canonical URLs of the PRs a report names, by URL or owner/repo#12, once each. */
export function prsReferenced(text: string): string[] {
  return [...new Set([...text.matchAll(PR_REF)].flatMap((match) => canonicalPrUrl(match[0]) ?? []))];
}

/**
 * The PRs a report names anywhere in its text fields (summary, evidence, handoff, final
 * message), once each. The one extractor for both task status and the PR state lookup. Walks
 * the values rather than scanning JSON, where an escaped "\\n" would glue onto owner/repo#12.
 */
export function reportPrs(report: unknown): string[] {
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(report);
  return prsReferenced(texts.join("\n"));
}
