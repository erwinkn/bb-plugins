import { z } from "zod";
import { PR_NOTE_KINDS } from "./pr-notes";

// The coordinator's record of each pull request in the Initiative, by PR URL
// (initiative_pr, `bb initiative pr`): its workflow stage, a free-form
// category ("Security", "CI"), and where it stands (what it waits on, changes
// requested, the last decision, who works on it), beside its notes log
// (pr-notes.ts: notes, comments and questions). The merge
// queue groups by stage and category and guesses a stage from GitHub when none
// is recorded. Shared by the server and (as types) the dashboard; writes live
// in pr-records.ts.

/** Stages in merge-queue order: what needs the user first. */
export const PR_STAGES = [
  { id: "ready-for-erwin", label: "Ready for you" },
  { id: "in-review", label: "In review" },
  { id: "ready-for-review", label: "Ready for review" },
  { id: "working", label: "Being worked on" },
  { id: "experiment", label: "Experiments" },
] as const;
export type PrStage = (typeof PR_STAGES)[number]["id"];
export const PR_STAGE_IDS = PR_STAGES.map((s) => s.id) as [PrStage, ...PrStage[]];

/** The last decision about a PR, and where it was made: a URL, a thread id or a ref like D437. */
export interface PrDecision {
  text: string;
  link: string | null;
  at: number;
}

/** Where a PR stands, as the coordinator keeps it (D438). Empty fields are null or []. */
export interface PrState {
  /** One short line: "W188: move the lock to resume". */
  waitingOn: string | null;
  /** Pending changes requested, one line each. */
  changes: string[];
  decision: PrDecision | null;
  /** D439 hook: the PR's discussion thread, once "Discuss" exists; nothing writes it yet. */
  discussionThreadId: string | null;
}

/** Everything the coordinator recorded for one PR. */
export interface PrRecord extends PrState {
  url: string;
  /** null: no stage recorded; the merge queue guesses one from GitHub. */
  stage: PrStage | null;
  /** The note given with the stage; a new stage replaces it. */
  note: string | null;
  /** When the stage was set. */
  setAt: number | null;
  category: string | null;
  /** The worker on it (W12) and its assignment (A301), when the coordinator named them. */
  worker: string | null;
  assignment: string | null;
  updatedAt: number;
}

export const blankPrRecord = (url: string, at: number): PrRecord => ({
  url, stage: null, note: null, setAt: null, category: null, waitingOn: null, changes: [],
  decision: null, discussionThreadId: null, worker: null, assignment: null, updatedAt: at,
});

/**
 * The canonical form of a GitHub PR reference, used as its key:
 * `https://github.com/owner/repo/pull/N`, lower case. Accepts a PR URL with
 * any suffix (`/files`, `?diff=split`, `#discussion…`) or `owner/repo#N`.
 */
export function canonicalPrUrl(ref: string): string | null {
  const trimmed = ref.trim();
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed) ??
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(trimmed);
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${Number(match[3])}`.toLowerCase() : null;
}

const line = (max: number) => z.string().trim().min(1).max(max);
/** The name the PRs without a category are shown under; no category can take it. */
export const UNCATEGORIZED = "Uncategorized";
const categorySchema = line(40).refine((name) => name.toLowerCase() !== UNCATEGORIZED.toLowerCase(), {
  message: `"${UNCATEGORIZED}" is where PRs without a category show; clear a category with category:null`,
});

/** The fields of a PR record initiative_pr patches besides the stage; null clears one. */
export const PR_STATE_FIELDS = ["category", "waitingOn", "changes", "decision", "worker", "assignment"] as const;
/** What initiative_pr does besides patching the record: append notes, answer questions. */
export const PR_NOTE_FIELDS = ["notes", "answered"] as const;
/** A note's text; a worker report's summary is clipped to it. */
export const PR_NOTE_MAX = 1000;

export const prToolSchema = z
  .object({
    prs: z
      .array(
        z
          .object({
            url: z.string().min(1).max(300).refine((url) => canonicalPrUrl(url) !== null, {
              message: "Expected a GitHub PR URL (https://github.com/owner/repo/pull/12) or owner/repo#12",
            }),
            stage: z.enum([...PR_STAGE_IDS, "clear"]).optional(),
            note: z.string().trim().max(200).optional(),
            category: categorySchema.nullable().optional(),
            waitingOn: line(160).nullable().optional(),
            changes: z.array(line(200)).max(10).nullable().optional(),
            decision: z.object({ text: line(300), link: line(300).optional() }).strict().nullable().optional(),
            worker: z.string().regex(/^W\d+$/i, "Expected a worker ref like W12").nullable().optional(),
            assignment: z.string().regex(/^A\d+$/i, "Expected an assignment ref like A301").nullable().optional(),
            notes: z
              .array(z.object({ kind: z.enum(PR_NOTE_KINDS).optional(), text: line(PR_NOTE_MAX), link: line(300).optional() }).strict())
              .min(1).max(10).optional(),
            answered: z.array(z.object({ n: z.number().int().positive(), text: line(300).optional() }).strict()).min(1).max(10).optional(),
          })
          .strict()
          .refine((pr) => pr.stage !== undefined || [...PR_STATE_FIELDS, ...PR_NOTE_FIELDS].some((field) => pr[field] !== undefined), {
            message: `Give a stage or one of ${[...PR_STATE_FIELDS, ...PR_NOTE_FIELDS].join(", ")}`,
          })
          .refine((pr) => pr.note === undefined || pr.stage !== undefined, { message: "A note goes with a stage", path: ["note"] }),
      )
      .min(1)
      .max(100)
      .optional(),
    rename: z.array(z.object({ from: categorySchema, to: categorySchema }).strict()).min(1).max(20).optional(),
  })
  .strict()
  .refine((input) => input.prs || input.rename, { message: "Give prs, rename or both" });
export type PrToolInput = z.infer<typeof prToolSchema>;

/**
 * A category as stored: single-spaced, and spelled like a known one that
 * differs only in case, so "ci" joins "CI" rather than starting a near-duplicate.
 */
export function categoryName(raw: string, known: Iterable<string>): string {
  const name = raw.trim().replace(/\s+/g, " ");
  for (const k of known) if (k.toLowerCase() === name.toLowerCase()) return k;
  return name;
}
