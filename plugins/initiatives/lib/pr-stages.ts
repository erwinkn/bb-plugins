import { z } from "zod";

// Workflow stages of the Initiative's pull requests. The coordinator records
// them per PR URL (initiative_pr, `bb initiative pr`); the merge queue groups
// by them and guesses one from GitHub when none is recorded.

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

/** A stage the coordinator recorded for one PR. */
export interface PrStageRecord {
  url: string;
  stage: PrStage;
  note: string | null;
  setAt: number;
}

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

export const prToolSchema = z
  .object({
    prs: z
      .array(
        z
          .object({
            url: z.string().min(1).max(300).refine((url) => canonicalPrUrl(url) !== null, {
              message: "Expected a GitHub PR URL (https://github.com/owner/repo/pull/12) or owner/repo#12",
            }),
            stage: z.enum([...PR_STAGE_IDS, "clear"]),
            note: z.string().trim().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type PrToolInput = z.infer<typeof prToolSchema>;
