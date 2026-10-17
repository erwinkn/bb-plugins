// Server side of the coordinator's PR records (D437, D438) and notes (D442):
// initiative_pr's writes, and the worker each PR's assignments point at.
import { ProjectError } from "./bb";
import type { Store } from "./store";
import type { PrNotes } from "./pr-notes";
import type { PrOwners } from "./pr-owners";
import type { PrLinks } from "./merge-queue";
import { PR_NOTE_MAX, blankPrRecord, canonicalPrUrl, categoryName, type PrToolInput } from "./pr-stages";

/** Who calls initiative_pr: the coordinator, a worker (its own PRs) or the user's terminal. */
export interface PrCaller {
  /** "coordinator", "user", or the worker's ref (W12). */
  author: string;
  /**
   * Set for a worker: it keeps its PRs' stage and notes and moves them. `heldBy` names who else
   * holds a PR ("W43: A812 names it"), or null when it is this worker's or nobody's yet.
   */
  worker: { ref: string; heldBy: (url: string) => string | null } | null;
  /** The caller's thread: a note's link when it gives none. */
  threadId: string | null;
}
/** What a worker sets on its own PRs; the rest of initiative_pr is a lead's. */
export const WORKER_PR_FIELDS = ["url", "stage", "note", "notes", "initiative"] as const;
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
  // v9: a worker keeps its own PRs' stage and notes, and moves them (R2); every other field is the
  // coordinator's, which sets everything. W492: a worker's lead-only
  // fields are left out with a note rather than failing the whole call.
  const ignored = new Set<string>();
  if (caller.worker) {
    const self = caller.worker.ref.toUpperCase();
    if (input.rename) ignored.add("rename");
    // An entry left with only its url records nothing, and claims nothing.
    const prs = (input.prs ?? []).map((pr) => Object.fromEntries(Object.entries(pr).filter(([key, value]) => {
      // Its own ref as the PR's worker claims the PR, as any write of its own does.
      if (WORKER_PR_FIELDS.includes(key as typeof WORKER_PR_FIELDS[number]) || key === "worker" && typeof value === "string" && value.toUpperCase() === self) return true;
      ignored.add(key);
      return false;
    })) as NonNullable<PrToolInput["prs"]>[number]).filter((pr) => Object.keys(pr).length > 1);
    if (!prs.length)
      throw new ProjectError(`Workers set their PRs' stage, add notes and move them to an Adventure ({prs:[{url,stage,notes,initiative}]}); ${[...ignored].join(", ")} ${ignored.size === 1 ? "is" : "are"} a lead's to set.`);
    input = { prs };
    const held = prs.flatMap((pr) => {
      const holder = caller.worker!.heldBy(canonicalPrUrl(pr.url)!);
      return holder ? [`${pr.url} (${holder})`] : [];
    });
    if (held.length)
      throw new ProjectError(`${caller.worker.ref} keeps only its own PRs: those its assignments name, it opened or recorded first. Not ${held.join(", ")}. Tell your lead instead.`);
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
    // W492: a worker's write claims a PR no one holds yet, so its next call needs no other proof.
    const claim = caller.worker && !records.get(key)?.worker ? caller.worker.ref : null;
    const patched = stage !== undefined || category !== undefined || worker !== undefined || assignment !== undefined || claim !== null
      || Object.values(state).some((value) => value !== undefined);
    if (!patched) return receipt;
    const r = { ...(records.get(key) ?? blankPrRecord(key, at)), updatedAt: at };
    if (claim) r.worker = claim;
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
  const note = ignored.size ? `Left out ${[...ignored].join(", ")}: ${ignored.size === 1 ? "it is" : "they are"} a lead's to set; tell your lead if ${ignored.size === 1 ? "it needs" : "they need"} changing. Everything else was recorded.` : null;
  if (caller.worker) return { prs, ...(note ? { note } : {}) };
  // A Map: category names are free-form, and "constructor" or "__proto__" must count like any other.
  const counts = new Map<string, number>();
  for (const r of records.values()) if (r.category) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const sorted = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  return { prs, ...(renamed.length ? { renamed } : {}), ...(counts.size ? { categories: sorted } : {}) };
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
 * Fills the worker the coordinator hasn't named. W506: reads the refs Store
 * indexed when each brief and report was written, never the texts themselves.
 */
export class AssignedPrs {
  constructor(private store: Pick<Store, "prRefs" | "workerPrRefs" | "latestPrRef">) {}

  read(projectId: string): ReadonlyMap<string, PrWork> {
    const latest = new Map<string, Omit<PrWork, "links">>();
    // Sets while reading: thousands of assignments can name one base PR.
    const workers = new Map<string, Set<string>>();
    const assignments = new Map<string, Set<string>>();
    for (const ref of this.store.prRefs(projectId, "named")) {
      latest.set(ref.url, { worker: `W${ref.workerNum}`, assignment: `A${ref.num}`, role: ref.role });
      workers.set(ref.url, (workers.get(ref.url) ?? new Set<string>()).add(`W${ref.workerNum}`));
      assignments.set(ref.url, (assignments.get(ref.url) ?? new Set<string>()).add(`A${ref.num}`));
    }
    return new Map([...latest].map(([url, work]) =>
      [url, { ...work, links: { workers: [...workers.get(url)!], assignments: [...assignments.get(url)!] } }]));
  }

  /** Every PR any of this worker's assignments names, by URL or owner/repo#12, latest or not. */
  ofWorker(projectId: string, workerNum: number): ReadonlySet<string> {
    return new Set(this.store.workerPrRefs(projectId, workerNum));
  }

  /** W492: the latest assignment naming a PR, by URL or owner/repo#12. */
  referencing(projectId: string, url: string): Omit<PrWork, "links"> | null {
    const ref = this.store.latestPrRef(projectId, url);
    return ref ? { worker: `W${ref.workerNum}`, assignment: `A${ref.num}`, role: ref.role } : null;
  }
}

/** A worker report's summary as a note: its first PR_NOTE_MAX characters. */
export const reportNote = (summary: string) =>
  summary.length > PR_NOTE_MAX ? `${summary.slice(0, PR_NOTE_MAX - 1).trimEnd()}…` : summary;
