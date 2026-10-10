// T156: everything the Initiative knows about one pull request, for its detail
// panel. Local state only, never GitHub (D441; the dashboard already holds the
// GitHub side in the merge queue): the coordinator's record and its stage
// history (T157), the notes log, and the assignments, workers, decisions and
// updates linked to the PR or naming it. No tasks (D506): what matters about a PR is on its record and notes.
// Long lists keep their newest entries and say how many there are.
import type { Store } from "./store";
import type { PrNote, PrNotes } from "./pr-notes";
import type { PrRecord, PrStageChange } from "./pr-stages";
import { prsNamed } from "./pr-records";
import { branchThreadId } from "./merge-queue";

/**
 * How an assignment, worker or decision is tied to the PR: the coordinator's
 * record, a brief or report naming its URL, a note on it, the worker whose
 * branch opened it, a linked assignment, or a text that only mentions `#N`.
 */
export type PrVia = "record" | "brief" | "report" | "note" | "branch" | "assignment" | "mention";

/** The newest `items` of `total`. */
export interface Clipped<T> {
  items: T[];
  total: number;
}

export interface PrDetailAssignment {
  ref: string;
  worker: string;
  role: string;
  state: string;
  via: PrVia[];
  threadId: string | null;
  createdAt: number;
  reportedAt: number | null;
  /** The report's outcome and summary, once filed. */
  outcome: string | null;
  summary: string | null;
}

export interface PrDetailWorker {
  ref: string;
  label: string;
  role: string;
  state: string;
  threadId: string | null;
  model: string | null;
}

export interface PrDetailDecision {
  ref: string;
  title: string;
  status: string;
  madeBy: "user" | "agent" | null;
  description: string;
  createdAt: number;
  via: PrVia[];
}

export interface PrDetailUpdate {
  ref: string;
  summary: string;
  createdAt: number;
}

export interface PrDetail {
  url: string;
  record: PrRecord | null;
  /** T157: who changed its stage, and when; oldest first. */
  stages: Clipped<PrStageChange>;
  notes: Clipped<PrNote>;
  assignments: Clipped<PrDetailAssignment>;
  workers: PrDetailWorker[];
  decisions: Clipped<PrDetailDecision>;
  updates: Clipped<PrDetailUpdate>;
}

export const DETAIL_LIMITS = { stages: 50, notes: 200, assignments: 60, decisions: 40, updates: 10 } as const;
const TEXT_MAX = 1200;

const clip = (text: string, max = TEXT_MAX) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const newest = <T,>(items: T[], limit: number): Clipped<T> => ({ items: items.slice(0, limit), total: items.length });

/**
 * "#2251", "PR#2251", "equisafe-market#2251" or "equisafe/equisafe-market#2251"
 * for `equisafe/equisafe-market`; not "#22510" nor "other-repo#2251".
 */
export function mentionsNumber(text: string, repo: string, number: number): boolean {
  const [owner, name] = repo.toLowerCase().split("/");
  // From each "#N", back over its prefix but not into the previous "#N": a
  // regex starting at every character would rescan each word.
  let end = 0;
  for (const match of text.matchAll(new RegExp(`#${number}(?!\\d)`, "g"))) {
    let start = match.index;
    while (start > end && /[\w./-]/.test(text[start - 1]!)) start--;
    const prefix = text.slice(start, match.index).toLowerCase();
    if (!prefix || prefix === "pr" || prefix === name || prefix === `${owner}/${name}`) return true;
    end = match.index + match[0].length;
  }
  return false;
}

/** The numbers of the D12 refs a text names. */
const decisionsIn = (text: string) => [...text.matchAll(/\bD(\d+)\b/g)].map((match) => Number(match[1]));

/** Records how `key` is tied to the PR. */
const tie = <K,>(map: Map<K, Set<PrVia>>, key: K, via: PrVia) => map.set(key, (map.get(key) ?? new Set()).add(via));
/** Newest (highest number) first. */
const byNewest = <V,>(map: Map<number, V>) => [...map].sort(([a], [b]) => b - a);

/**
 * Read one PR's detail. `url` is canonical; `head` is its branch when the merge
 * queue's cache knows it, for the worker whose BB worktree opened it. Every
 * linked assignment and decision is counted from a projection; only those
 * returned are read whole.
 */
export function readPrDetail(
  store: Pick<Store, "prRecords" | "prStageChanges" | "prDetailRows" | "decisionsBy" | "listedDecisions" | "assignment" | "worker" | "decisionItem" | "membership">,
  notes: Pick<PrNotes, "list">,
  projectId: string,
  url: string,
  head: string | null,
): PrDetail {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
  if (!match) throw new Error(`Not a canonical PR URL: ${url}`);
  const [repo, number] = [match[1]!, Number(match[2])];
  const names = (text: string) => prsNamed(text).includes(url);
  const mentions = (text: string) => names(text) || mentionsNumber(text, repo, number);
  const record = store.prRecords(projectId).get(url) ?? null;
  const log = notes.list(projectId, url);
  const recordText = record ? [record.note, record.waitingOn, ...record.changes, record.decision?.text, record.decision?.link].filter(Boolean).join("\n") : "";
  const threadId = head ? branchThreadId(head) : null;
  const member = threadId ? store.membership(threadId) : null;

  // Assignments: the record's, those notes come from, those naming or mentioning the PR.
  const assignmentVia = new Map<number, Set<PrVia>>();
  if (record?.assignment) tie(assignmentVia, Number(record.assignment.slice(1)), "record");
  for (const note of log) if (note.link && /^A\d+$/.test(note.link)) tie(assignmentVia, Number(note.link.slice(1)), "note");
  const rows = store.prDetailRows(projectId, [`%/pull/${number}%`, `%#${number}%`], [...assignmentVia.keys()]);
  for (const row of rows.assignments) {
    const [brief, report] = [names(row.brief), names(row.report)];
    if (brief) tie(assignmentVia, row.num, "brief");
    if (report) tie(assignmentVia, row.num, "report");
    if (!brief && !report && (mentions(row.brief) || mentions(row.report))) tie(assignmentVia, row.num, "mention");
  }
  const projected = new Map(rows.assignments.map((row) => [row.num, row]));
  const assignments = byNewest(assignmentVia).flatMap(([num, via]) => {
    const row = projected.get(num);
    return row ? [{ row, via }] : [];
  });

  // Workers: the record's, note authors, the branch's, the assignments'.
  const workerVia = new Map<number, Set<PrVia>>();
  if (record?.worker) tie(workerVia, Number(record.worker.slice(1)), "record");
  for (const note of log) if (/^W\d+$/.test(note.author)) tie(workerVia, Number(note.author.slice(1)), "note");
  if (member && member.project.id === projectId && member.workerNum > 0) tie(workerVia, member.workerNum, "branch");
  for (const { row } of assignments) tie(workerVia, row.workerNum, "assignment");

  // Decisions: those the record and notes name, made by the assignments, naming the PR.
  const decisionVia = new Map<number, Set<PrVia>>();
  for (const num of decisionsIn(recordText)) tie(decisionVia, num, "record");
  for (const note of log) for (const num of decisionsIn(`${note.text}\n${note.link ?? ""}\n${note.answered?.text ?? ""}`)) tie(decisionVia, num, "note");
  for (const num of store.decisionsBy(projectId, assignments.map(({ row }) => row.num))) tie(decisionVia, num, "assignment");
  for (const row of rows.decisions) if (mentions(row.text)) tie(decisionVia, row.num, "mention");
  const decisions = store.listedDecisions(projectId, [...decisionVia.keys()]);

  return {
    url,
    record,
    stages: store.prStageChanges(projectId, url, DETAIL_LIMITS.stages),
    // Oldest first, like the log; the newest are kept.
    notes: { items: log.slice(-DETAIL_LIMITS.notes), total: log.length },
    assignments: {
      // The projection read these rows: each exists.
      items: assignments.slice(0, DETAIL_LIMITS.assignments).map(({ row, via }) => {
        const a = store.assignment(projectId, row.num)!;
        return {
          ref: a.ref, worker: `W${a.workerNum}`, role: a.role, state: a.state, via: [...via],
          threadId: a.threadId, createdAt: a.createdAt, reportedAt: a.reportedAt,
          outcome: a.report?.outcome ?? null, summary: a.report?.summary ? clip(a.report.summary) : null,
        };
      }),
      total: assignments.length,
    },
    workers: byNewest(workerVia).flatMap(([num]) => {
      const w = store.worker(projectId, num);
      return w ? [{ ref: w.ref, label: w.label, role: w.role, state: w.state, threadId: w.threadId, model: w.model }] : [];
    }),
    decisions: {
      // Listed from a projection: each exists.
      items: decisions.slice(0, DETAIL_LIMITS.decisions).map((num) => {
        const d = store.decisionItem(projectId, num)!;
        return { ref: d.ref, title: d.title, status: d.status, madeBy: d.madeBy, description: clip(d.description), createdAt: d.createdAt, via: [...decisionVia.get(num)!] };
      }),
      total: decisions.length,
    },
    updates: newest(rows.updates.filter((u) => mentions(u.text)).map(({ ref, summary, createdAt }) => ({ ref, summary, createdAt })), DETAIL_LIMITS.updates),
  };
}
