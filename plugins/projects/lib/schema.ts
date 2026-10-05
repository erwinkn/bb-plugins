import { z } from "zod";

// Shared value schemas. Server code validates with them; frontend code imports
// only their inferred types.

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const profileSchema = z
  .object({
    providerId: z.string().min(1).max(80),
    model: z.string().min(1).max(120),
    reasoningLevel: z.enum(REASONING_LEVELS),
    // Omitted preserves native defaults/inheritance; explicit choices travel
    // with the profile, including user task overrides.
    serviceTier: z.enum(["default", "fast"]).optional(),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;

/** What a work assignment is for; selects its default profile. */
export const WORK_KINDS = [
  "implementation",
  "experiment",
  "investigation",
  "straightforward",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Immutable for the life of a worker, across reuse, forks, and generations. */
export const ROLES = ["work", "review"] as const;
export type Role = (typeof ROLES)[number];

/** Checkout coordination metadata, independent of native permissions. */
export const ASSIGNMENT_ACCESS = ["read-only", "write"] as const;
export type AssignmentAccess = (typeof ASSIGNMENT_ACCESS)[number];

export const PROFILE_KEYS = [
  "coordinator",
  ...WORK_KINDS,
  "reviewOfClaude",
  "reviewOfGpt",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export const DEFAULT_PROFILES: Record<ProfileKey, Profile> = {
  coordinator: {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
  },
  // Good: Opus for implementation and experiments.
  implementation: {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
  },
  experiment: {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
  },
  // Fast: GPT Sol for investigations and straightforward work.
  investigation: {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "high",
  },
  straightforward: {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "high",
  },
  reviewOfClaude: {
    providerId: "codex",
    model: "gpt-6-astra",
    reasoningLevel: "xhigh",
  },
  reviewOfGpt: {
    providerId: "claude-code",
    model: "claude-fable-5-1",
    reasoningLevel: "xhigh",
  },
};

/**
 * Only profiles remain tunable; batching, retention and warming are gone —
 * BB owns message delivery and native lifecycle. Old stored policies carrying
 * the removed keys are normalized on read by `storedPolicySchema`.
 */
export const policySchema = z
  .object({
    profiles: z.partialRecord(z.enum(PROFILE_KEYS), profileSchema).default({}),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export const DEFAULT_POLICY: Policy = policySchema.parse({});
/** Reads historical policy blobs; unknown removed keys are dropped. */
export const storedPolicySchema = z.object({
  profiles: z.partialRecord(z.enum(PROFILE_KEYS), profileSchema).default({}),
});

const line = (max: number) => z.string().trim().min(1).max(max);

/** User-editable project framing, shown in the panel and seeds a fresh coordinator. */
export const projectContextSchema = z
  .object({
    vision: z.string().trim().max(2000).default(""),
    objectives: z.array(line(500)).max(12).default([]),
    ideas: z.array(line(500)).max(12).default([]),
  })
  .strict();
export type ProjectContext = z.infer<typeof projectContextSchema>;
export const EMPTY_PROJECT_CONTEXT: ProjectContext = {
  vision: "",
  objectives: [],
  ideas: [],
};

export const briefSchema = z
  .object({
    objective: line(4000),
    acceptanceCriteria: z.array(line(1000)).min(1).max(20),
    contextRefs: z.array(line(500)).max(30).default([]),
    areas: z
      .array(
        z
          .object({
            bbProjectId: line(80),
            paths: z.array(line(300)).max(20).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    constraints: z.array(line(1000)).max(20).default([]),
    verification: z.array(line(1000)).min(1).max(20),
  })
  .strict();
export type Brief = z.infer<typeof briefSchema>;

export const handoffSchema = z
  .object({
    summary: line(4000),
    workspaceRevision: line(200),
    files: z.array(line(300)).max(30).default([]),
    openQuestions: z.array(line(500)).max(10).default([]),
    nextSteps: z.array(line(500)).max(10).default([]),
    dirtyFiles: z.array(line(300)).max(30).default([]),
    recoveryArtifacts: z.array(line(500)).max(10).default([]),
    pendingCommands: z.array(line(1000)).max(10).default([]),
    verificationRevision: line(200).optional(),
  })
  .strict();
export type Handoff = z.infer<typeof handoffSchema>;

export const reportSchema = z
  .object({
    outcome: z.enum(["succeeded", "blocked", "failed"]),
    summary: line(2000),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["check", "artifact", "observation"]),
            label: line(300),
            result: z.enum(["passed", "failed", "skipped"]).optional(),
            detail: z.string().max(1000).optional(),
            ref: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    blocker: z
      .object({ question: line(1000), context: line(2000) })
      .strict()
      .optional(),
    handoff: handoffSchema,
    pendingBackgroundWork: z.array(line(300)).max(10).default([]),
  })
  .strict()
  .refine((report) => report.outcome !== "blocked" || report.blocker, {
    message: "A blocked report needs a blocker question and context.",
    path: ["blocker"],
  });
export type Report = z.infer<typeof reportSchema>;

export const HUMAN_ATTENTION = [
  "none",
  "needs-opinion",
  "second-pass",
] as const;
export type HumanAttention = (typeof HUMAN_ATTENTION)[number];

export const lightweightDecisionSchema = z.object({
  description: line(2000),
  madeBy: z.enum(["user", "agent"]),
}).strict();
export type LightweightDecision = z.infer<typeof lightweightDecisionSchema>;

export const decisionFieldsSchema = z
  .object({
    title: line(200),
    humanAttention: z.enum(HUMAN_ATTENTION).default("none"),
    blocksTaskIds: z.array(line(40)).max(20).default([]),
    // An open question for the user.
    question: z.string().max(1000).optional(),
    context: z.string().max(2000).optional(),
    options: z
      .array(
        z
          .object({ label: line(200), consequences: z.string().max(1000) })
          .strict(),
      )
      .max(6)
      .default([]),
    recommendation: z.string().max(1000).optional(),
    // A decision already taken.
    outcome: z.string().max(1000).optional(),
    rationale: z.string().max(2000).optional(),
    tradeoff: z.string().max(1000).optional(),
    revisitReason: z.string().max(1000).optional(),
    deadline: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export const decisionSchema = decisionFieldsSchema.superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.options.forEach((option, index) => {
    const key = option.label.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key))
      ctx.addIssue({
        code: "custom",
        path: ["options", index, "label"],
        message: `Option labels must be unique; "${option.label}" repeats an earlier option.`,
      });
    seen.add(key);
  });
  if (value.humanAttention === "needs-opinion") {
    if (!value.question?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["question"],
        message: "A question for the user is required.",
      });
    if (!value.context?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["context"],
        message: "Explain the context in plain words.",
      });
  } else {
    if (!value.outcome?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "State the decision that was taken.",
      });
    if (!value.rationale?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["rationale"],
        message: "Explain why.",
      });
  }
  if (value.humanAttention === "second-pass" && !value.revisitReason?.trim())
    ctx.addIssue({
      code: "custom",
      path: ["revisitReason"],
      message: "Say why it deserves a second pass.",
    });
});
export type Decision = z.infer<typeof decisionSchema>;

/** Historical only: retained workers are gone, but old rows still carry the blob. */
export const retentionSchema = z
  .object({
    reason: line(500),
    wakeCondition: line(500),
    deadline: z.string().datetime({ offset: true }),
  })
  .strict();
export type Retention = z.infer<typeof retentionSchema>;

/** Where a new native thread runs. Reuse pins a known environment id. */
export const environmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({ type: z.literal("reuse"), environmentId: line(80) }).strict(),
  z.object({ type: z.literal("worktree") }).strict(),
]);
export type EnvironmentChoice = z.infer<typeof environmentSchema>;

export const TASK_STATUSES = [
  "planned",
  "in_progress",
  "blocked",
  "awaiting_acceptance",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ASSIGNMENT_STATES = [
  // Recorded before the BB call; a crash here leaves an uncertain operation.
  "dispatching",
  // The brief is in BB's native queue behind a busy worker.
  "queued",
  "running",
  // Historical: idle without a report is now derived from native status, not stored.
  "idle_no_report",
  "reported",
  "accepted",
  "rejected",
  // Historical: a user stop is recorded as "cancelled" now; native Stop belongs to BB.
  "stopped",
  "cancelled",
  "failed",
] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const WORKER_STATES = [
  // Live rows are written as "active" or "retired"; native status is read live.
  // "idle", "retained" and "retiring" survive only on historical rows.
  "active",
  "idle",
  "retained",
  "retiring",
  "retired",
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const ROUTES = ["fresh", "continue", "fork", "generation", "checkpoint"] as const;
export type Route = (typeof ROUTES)[number];
