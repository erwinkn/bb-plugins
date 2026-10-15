// Server side of the coordinator's PR records (D437, D438) and notes (D442):
// initiative_pr's writes, and the worker each PR's assignments point at.
import { ProjectError } from "./bb";
import type { Store } from "./store";
import type { PrNotes } from "./pr-notes";
import type { PrOwners } from "./pr-owners";
import type { PrLinks } from "./merge-queue";
import { PR_NOTE_MAX, blankPrRecord, canonicalPrUrl, categoryName, type PrToolInput } from "./pr-stages";

/** Who calls initiative_pr: the coordinator, a worker (notes only), a discussion (notes and answers) or the user's terminal. */
export interface PrCaller {
  /** "coordinator", "user", "discussion", or the worker's ref (W12). */
  author: string;
  /** Set for a worker: it may only add notes, to the PRs `owns` admits. */
  worker: { ref: string; owns: (url: string) => boolean } | null;
  /** Historical (D480): a discussion is a lead since v9 and sets everything. */
  discussion?: boolean;
  /** The caller's thread: a note's link when it gives none. */
  threadId: string | null;
}
export const COORDINATOR: PrCaller = { author: "coordinator", worker: null, threadId: null };

/**
 * R2: the open Initiative `name` names, by id or by its name in any case. A
 * name two Initiatives share must be given as an id.
 */
export function initiativeNamed(store: Pick<Store, "projects">, name: string): { id: string; name: string } {
  const open = store.projects();
  const byId = open.find((p) => p.id === name.trim());
  if (byId) return byId;
  const named = open.filter((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new ProjectError(`${named.length} open Adventures are named "${name}"; give one's id: ${named.map((p) => p.id).join(", ")}.`);
  throw new ProjectError(`No open Adventure is named "${name}". Open Adventures: ${open.map((p) => p.name).join(", ") || "none"}.`);
}

/**
 * Apply one initiative_pr call, in a transaction: renames first (into an
 * existing category merges them), then each PR's fields. Only the given fields
 * change; null clears one. A stage replaces its note; a changed stage or note
 * lands in the PR's stage history (T157). An assignment names its worker too,
 * unless the entry names one. Notes append to the PR's log and `answered`
 * closes its questions. `initiative` moves the PR to an Initiative, or out of
 * every one with null (R2); its records stay where they were written. The
 * result lists every category with its PR count, once there is one, so the
 * coordinator reuses them.
 */
export function recordPrs(
  store: Pick<Store, "prRecords" | "savePrRecord" | "addPrStageChange" | "renamePrCategory" | "worker" | "assignment" | "projects">,
  notes: Pick<PrNotes, "append" | "answer">,
  projectId: string,
  input: PrToolInput,
  at: number,
  caller: PrCaller = COORDINATOR,
  /** R2: moves, after `fits` refuses a destination the PR can't show in (it throws). */
  owners?: Pick<PrOwners, "move"> & { fits(target: { id: string; name: string }, url: string): void },
) {
  // v9: a worker keeps its own PRs' stage and notes, and moves them (R2); every other field is a
  // lead's. Leads (the coordinator and discussions) set everything.
  const own = caller.worker ? ["url", "stage", "note", "notes", "initiative"] : null;
  if (own) {
    const fields = [...new Set(input.rename ? ["rename"] : (input.prs ?? []).flatMap((pr) => Object.keys(pr).filter((k) => !own.includes(k))))];
    const is = `${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} a lead's to set`;
    if (fields.length)
      throw new ProjectError(`Workers set their PRs' stage, add notes and move them to an Adventure ({prs:[{url,stage,notes,initiative}]}); ${is}.`);
  }
  if (caller.worker) {
    const foreign = (input.prs ?? []).filter((pr) => !caller.worker!.owns(canonicalPrUrl(pr.url)!)).map((pr) => pr.url);
    if (foreign.length)
      throw new ProjectError(`${caller.worker.ref} keeps only PRs its assignments name or its branch opened, not ${foreign.join(", ")}. Tell your lead instead.`);
  }
  const categories = () => new Set([...store.prRecords(projectId).values()].flatMap((r) => (r.category ? [r.category] : [])));
  // A failure rolls the whole call back: name the categories as they were before it.
  const before = [...categories()].sort();
  const renamed = (input.rename ?? []).map(({ from, to }) => {
    const all = categories();
    const source = [...all].find((k) => k.toLowerCase() === from.trim().toLowerCase());
    if (!source) throw new ProjectError(`No PR has the category "${from}". Categories: ${before.join(", ") || "none yet"}.`);
    const target = categoryName(to, [...all].filter((k) => k !== source));
    return { from: source, to: target, prs: store.renamePrCategory(projectId, source, target) };
  });
  const records = store.prRecords(projectId);
  const names = categories();
  const prs = (input.prs ?? []).map(({ url, stage, note, category, worker, assignment, notes: added, answered, initiative, ...state }) => {
    const key = canonicalPrUrl(url)!;
    const target = initiative ? initiativeNamed(store, initiative) : null;
    if (initiative !== undefined) {
      if (!owners) throw new ProjectError("PRs can't be moved from here.");
      if (target) owners.fits(target, key);
      owners.move(key, target?.id ?? null, at);
    }
    const noted = (added ?? []).map((entry) =>
      notes.append(projectId, key, { at, author: caller.author, kind: entry.kind ?? "note", text: entry.text, link: entry.link ?? caller.threadId }));
    for (const { n, text } of answered ?? [])
      if (!notes.answer(projectId, key, n, { at, by: caller.author, text: text ?? null }))
        throw new ProjectError(`${key} has no question ${n}; initiative_read view prs with refs:["${key}"] lists its open ones.`);
    const receipt = {
      url: key,
      ...(initiative !== undefined ? { initiative: target?.name ?? null } : {}),
      ...(noted.length ? { noted } : {}),
      ...(answered?.length ? { answered: answered.map((a) => a.n) } : {}),
    };
    const patched = stage !== undefined || category !== undefined || worker !== undefined || assignment !== undefined
      || Object.values(state).some((value) => value !== undefined);
    if (!patched) return receipt;
    const r = { ...(records.get(key) ?? blankPrRecord(key, at)), updatedAt: at };
    const was = { stage: r.stage, note: r.note };
    if (stage !== undefined) {
      const set = stage === "clear" ? null : stage;
      const kept = set !== null && set === r.stage && (note || null) === r.note;
      Object.assign(r, { stage: set, note: set ? note || null : null, setAt: set ? (kept ? r.setAt ?? at : at) : null });
    }
    if (category !== undefined) r.category = category ? categoryName(category, names) : null;
    if (r.category) names.add(r.category);
    if (state.waitingOn !== undefined) r.waitingOn = state.waitingOn;
    if (state.changes !== undefined) r.changes = state.changes ?? [];
    if (state.decision !== undefined) r.decision = state.decision ? { text: state.decision.text, link: state.decision.link ?? null, at } : null;
    if (assignment !== undefined) {
      const a = assignment ? store.assignment(projectId, Number(assignment.slice(1))) : null;
      if (assignment && !a) throw new ProjectError(`Unknown assignment ${assignment} in this initiative.`);
      r.assignment = a ? a.ref : null;
      if (a && worker === undefined) r.worker = `W${a.workerNum}`;
    }
    if (worker !== undefined) {
      const w = worker ? store.worker(projectId, Number(worker.slice(1))) : null;
      if (worker && !w) throw new ProjectError(`Unknown worker ${worker} in this initiative.`);
      // The looked-up ref, so W001 is stored as the W1 its thread is known by.
      r.worker = w ? w.ref : null;
    }
    // T157: the PR's stage history, with who changed it; the same stage and note set again changes nothing.
    if (r.stage !== was.stage || r.note !== was.note)
      store.addPrStageChange(projectId, key, { at, author: caller.author, from: was.stage, to: r.stage, note: r.note });
    store.savePrRecord(projectId, r);
    records.set(key, r);
    const updated = (Object.keys(state) as (keyof typeof state)[]).filter((field) => state[field] !== undefined);
    return {
      ...receipt,
      ...(stage ? { stage } : {}),
      ...(note && stage && stage !== "clear" ? { note } : {}),
      ...(category !== undefined ? { category: r.category } : {}),
      ...(worker !== undefined || assignment !== undefined ? { worker: r.worker, assignment: r.assignment } : {}),
      ...(updated.length ? { updated } : {}),
    };
  });
  if (caller.worker || caller.discussion) return { prs };
  // A Map: category names are free-form, and "constructor" or "__proto__" must count like any other.
  const counts = new Map<string, number>();
  for (const r of records.values()) if (r.category) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const sorted = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  return { prs, ...(renamed.length ? { renamed } : {}), ...(counts.size ? { categories: sorted } : {}) };
}

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi;

/** The canonical URLs of the GitHub PRs a text names, in order, once each. */
export function prsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(PR_URL)].flatMap((match) => canonicalPrUrl(match[0]) ?? []))];
}

/** The latest assignment about a PR: who works on it, through which assignment, in which role; and (T156) every assignment naming it. */
export interface PrWork {
  worker: string;
  assignment: string;
  role: string;
  links: PrLinks;
}

/**
 * Each PR's latest assignment, from what the assignments say: the PRs a brief
 * gave it and those its report opened or reviewed. A later assignment wins.
 * Fills the worker the coordinator hasn't named; recomputed only when an
 * assignment changes.
 */
export class AssignedPrs {
  private cache = new Map<string, { stamp: string; value: ReadonlyMap<string, PrWork>; byWorker: ReadonlyMap<number, ReadonlySet<string>> }>();

  constructor(private store: Pick<Store, "assignmentsStamp" | "prMentions">) {}

  private scan(projectId: string) {
    const stamp = this.store.assignmentsStamp(projectId);
    const cached = this.cache.get(projectId);
    if (cached?.stamp === stamp) return cached;
    const latest = new Map<string, Omit<PrWork, "links">>();
    const byWorker = new Map<number, Set<string>>();
    // Sets while scanning: thousands of assignments can name one base PR.
    const workers = new Map<string, Set<string>>();
    const assignments = new Map<string, Set<string>>();
    for (const row of this.store.prMentions(projectId))
      // Both: a review's report rarely repeats the PR its brief gave it.
      for (const url of prsNamed(`${row.brief}\n${row.report ?? ""}`)) {
        latest.set(url, { worker: `W${row.workerNum}`, assignment: `A${row.num}`, role: row.role });
        byWorker.set(row.workerNum, (byWorker.get(row.workerNum) ?? new Set()).add(url));
        workers.set(url, (workers.get(url) ?? new Set<string>()).add(`W${row.workerNum}`));
        assignments.set(url, (assignments.get(url) ?? new Set<string>()).add(`A${row.num}`));
      }
    const value = new Map([...latest].map(([url, work]) =>
      [url, { ...work, links: { workers: [...workers.get(url)!], assignments: [...assignments.get(url)!] } }]));
    const entry = { stamp, value, byWorker };
    this.cache.set(projectId, entry);
    return entry;
  }

  read(projectId: string): ReadonlyMap<string, PrWork> {
    return this.scan(projectId).value;
  }

  /** Every PR any of this worker's assignments names, latest or not. */
  ofWorker(projectId: string, workerNum: number): ReadonlySet<string> {
    return this.scan(projectId).byWorker.get(workerNum) ?? new Set();
  }
}

/** A worker report's summary as a note: its first PR_NOTE_MAX characters. */
export const reportNote = (summary: string) =>
  summary.length > PR_NOTE_MAX ? `${summary.slice(0, PR_NOTE_MAX - 1).trimEnd()}…` : summary;
