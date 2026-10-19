// The slice of the Muse Session Protocol (MSP, `muse serve`) this bridge
// reads. Muse auto-updates in the background, so every shape is lenient:
// unknown fields pass, unknown enum values stay strings, and a frame that
// fails to parse is dropped with a stderr line rather than poisoning the
// stream. Types follow @muse-code/sdk 1.4.10 (`msp.d.ts`).

import { z } from "zod";

const looseString = z.string();
const optionalString = z.string().nullish();
const optionalNumber = z.number().nullish();

export const mspItemSchema = z
  .object({
    itemId: z.string().min(1),
    kind: looseString,
    status: looseString,
    revision: z.number().optional(),
    turnId: optionalString,
    text: optionalString,
    summary: z.array(z.string()).nullish(),
    messagePhase: optionalString,
    tool: optionalString,
    callId: optionalString,
    args: z.unknown().optional(),
    visibleOutput: optionalString,
    displayLabel: z
      .object({ active: optionalString, done: optionalString, neutral: optionalString })
      .passthrough()
      .nullish(),
    failureReason: optionalString,
    fallbackText: optionalString,
    background: z.boolean().nullish(),
    patchRef: z.object({ path: optionalString, byteLen: optionalNumber }).passthrough().nullish(),
    patchSummary: z
      .object({ files: optionalNumber, added: optionalNumber, removed: optionalNumber })
      .passthrough()
      .nullish(),
    // userShell
    commandText: optionalString,
    exitCode: optionalNumber,
    durationMs: optionalNumber,
    // subagent
    subagentId: optionalString,
    childSessionId: optionalString,
    objective: optionalString,
    role: optionalString,
    controlStatus: optionalString,
    result: z.object({ summary: optionalString, text: optionalString }).passthrough().nullish(),
    // compaction
    outcome: optionalString,
  })
  .passthrough();
export type MspItem = z.infer<typeof mspItemSchema>;

export const itemEventSchema = z
  .object({ sessionId: z.string(), item: mspItemSchema })
  .passthrough();

export const itemDeltaSchema = z
  .object({
    sessionId: z.string(),
    itemId: z.string(),
    field: optionalString,
    delta: z.string(),
  })
  .passthrough();

export const turnStartedSchema = z
  .object({ sessionId: z.string(), turnId: z.string(), commandId: optionalString })
  .passthrough();

export const turnErrorSchema = z
  .object({
    kind: optionalString,
    message: optionalString,
    retryable: z.boolean().nullish(),
    quota: z.object({ resetsAtMs: optionalNumber, limitKind: optionalString }).passthrough().nullish(),
  })
  .passthrough();
export type MspTurnError = z.infer<typeof turnErrorSchema>;

export const turnCompletedSchema = z
  .object({
    sessionId: z.string(),
    turnId: z.string(),
    terminal: looseString,
    error: turnErrorSchema.nullish(),
    reason: optionalString,
  })
  .passthrough();

export const turnRetrySchema = z
  .object({
    sessionId: z.string(),
    turnId: optionalString,
    reason: optionalString,
    nextAttempt: optionalNumber,
    attempt: optionalNumber,
    maxAttempts: optionalNumber,
    retryDelayMs: optionalNumber,
    errorKind: optionalString,
    httpStatus: optionalNumber,
  })
  .passthrough();

const tokenCountsSchema = z
  .object({
    inputTokens: optionalNumber,
    outputTokens: optionalNumber,
    cachedTokens: optionalNumber,
    cacheReadTokens: optionalNumber,
    cacheWriteTokens: optionalNumber,
    reasoningTokens: optionalNumber,
  })
  .passthrough();

export const tokenUsageSchema = z
  .object({
    sessionId: z.string(),
    turnId: optionalString,
    promptTokens: optionalNumber,
    totalTokens: optionalNumber,
    usage: tokenCountsSchema,
  })
  .passthrough();
export type MspTokenUsage = z.infer<typeof tokenUsageSchema>;

export const contextUsageSchema = z
  .object({
    sessionId: z.string(),
    usedTokens: z.number(),
    windowTokens: optionalNumber,
    pressure: optionalString,
  })
  .passthrough();

const usageWindowSchema = z
  .object({
    usedPercent: z.number(),
    resetsAtMs: optionalNumber,
    windowDurationMins: optionalNumber,
  })
  .passthrough();

export const accountUsageSchema = z
  .object({
    window: usageWindowSchema.nullish(),
    weekly: usageWindowSchema.nullish(),
    tier: optionalString,
    observedAtMs: optionalNumber,
  })
  .passthrough();
export type MspAccountUsage = z.infer<typeof accountUsageSchema>;

export const todoListSchema = z
  .object({
    sessionId: z.string(),
    items: z.array(
      z.object({ text: z.string(), status: looseString, activeForm: optionalString }).passthrough(),
    ),
  })
  .passthrough();

export const sessionClosedSchema = z
  .object({ sessionId: z.string(), reason: optionalString })
  .passthrough();

const approvalChoiceSchema = z
  .object({
    choiceId: z.string(),
    decision: looseString,
    label: optionalString,
    scope: optionalString,
  })
  .passthrough();

const requirementIdSchema = z.unknown();

export const approvalRequestedSchema = z
  .object({
    approvalId: z.string(),
    sessionId: z.string(),
    turnId: optionalString,
    itemId: optionalString,
    toolName: optionalString,
    rawArgs: z.unknown().optional(),
    judgeEscalated: z.boolean().nullish(),
    subagentOrigin: z.object({ subagentId: optionalString }).passthrough().nullish(),
    currentRequirementId: requirementIdSchema,
    availableChoices: z.array(approvalChoiceSchema),
    reason: optionalString,
    subject: z
      .object({
        kind: looseString,
        access: optionalString,
        command: optionalString,
        path: optionalString,
        host: optionalString,
        target: optionalString,
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type MspApproval = z.infer<typeof approvalRequestedSchema>;
export type MspApprovalChoice = z.infer<typeof approvalChoiceSchema>;

export const approvalUpdatedSchema = z
  .object({
    approvalId: z.string(),
    sessionId: z.string(),
    currentRequirementId: requirementIdSchema,
    availableChoices: z.array(approvalChoiceSchema).optional(),
  })
  .passthrough();

export const approvalResolvedSchema = z
  .object({ approvalId: z.string(), sessionId: z.string() })
  .passthrough();

export const userInputRequestedSchema = z
  .object({
    userInputId: z.string(),
    sessionId: z.string(),
    turnId: optionalString,
    questions: z.array(
      z
        .object({
          id: z.string(),
          header: optionalString,
          question: z.string(),
          options: z
            .array(z.object({ label: z.string(), description: optionalString }).passthrough())
            .nullish(),
          selection: z
            .object({ mode: optionalString, maxSelections: optionalNumber })
            .passthrough()
            .nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type MspUserInput = z.infer<typeof userInputRequestedSchema>;

export const userInputSettledSchema = z
  .object({ userInputId: z.string(), sessionId: z.string() })
  .passthrough();

/** `turn/unqueued`: a queued turn that will never run. */
export const turnUnqueuedSchema = z
  .object({ sessionId: z.string(), turnId: z.string() })
  .passthrough();

export const turnStartAckSchema = z
  .object({ turnId: z.string(), disposition: optionalString })
  .passthrough();

export const sessionResultSchema = z
  .object({
    session: z
      .object({ sessionId: z.string(), modelId: optionalString, providerId: optionalString })
      .passthrough(),
  })
  .passthrough();

export const modelListSchema = z
  .object({
    models: z.array(
      z
        .object({
          modelId: z.string().min(1),
          displayLabel: optionalString,
          description: optionalString,
          providerId: optionalString,
          isDefault: z.boolean().nullish(),
          contextLimit: optionalNumber,
          variants: z.union([z.array(z.string()), z.string()]).nullish(),
          defaultReasoningEffort: optionalString,
          reasoningEffortVariants: z
            .array(z.object({ tier: z.string(), description: optionalString }).passthrough())
            .nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type MspModelList = z.infer<typeof modelListSchema>;

export const initializeResultSchema = z
  .object({
    grantedCapabilities: z.array(z.string()).nullish(),
    serverInfo: z.object({ version: optionalString }).passthrough().nullish(),
  })
  .passthrough();

/** Parse one frame, logging (not throwing) a mismatch. */
export function parseFrame<T>(schema: z.ZodType<T>, method: string, params: unknown): T | null {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  process.stderr.write(
    `muse bridge: dropped an unreadable ${method} frame: ${parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}\n`,
  );
  return null;
}
