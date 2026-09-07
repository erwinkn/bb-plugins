// Shared data model for the Questions plugin. This module is imported by the
// server (server.ts) and the frontend (app.tsx), so it must stay free of Node
// and DOM APIs. Zod schemas double as the wire validation for untrusted input.
import { z } from "zod";

/** Realtime channel the server publishes on after every change. */
export const REALTIME_CHANNEL = "questions-changed";
/** Message directive name: `::questions{round="rnd_…"}`. */
export const DIRECTIVE_NAME = "questions";

export type ChangeKind = "round-created" | "answers" | "submission" | "summary";
export interface ChangeSignal {
  threadId: string;
  kind: ChangeKind;
  roundId?: string;
  submissionId?: string;
}

export const QUESTION_MODES = ["panel", "inline"] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Byte and count bounds. Question count in the side panel is not capped. */
export const LIMITS = {
  inlineMaxQuestions: 5,
  roundQuestionsBytes: 256 * 1024,
  titleChars: 500,
  helpChars: 2000,
  introChars: 4000,
  optionChars: 300,
  optionsPerQuestion: 20,
  answerTextChars: 20_000,
  detailChars: 4000,
  summaryChars: 8000,
  attachmentBytes: 8 * 1024 * 1024,
  attachmentsPerQuestion: 10,
  referencesPerQuestion: 20,
  previewImageBytes: 400 * 1024,
  submissionsListed: 20,
} as const;

export const questionOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(LIMITS.optionChars),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const questionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(LIMITS.titleChars),
  help: z.string().max(LIMITS.helpChars).nullable(),
  group: z.string().trim().max(120).nullable(),
  /** null means a text-only question. */
  select: z.enum(["single", "multiple"]).nullable(),
  options: z.array(questionOptionSchema).max(LIMITS.optionsPerQuestion),
  /** Ids of earlier questions whose submitted answers this question quotes. */
  cites: z.array(z.string()).max(10),
  attachments: z.boolean(),
  references: z.boolean(),
  confidence: z.boolean(),
});
export type Question = z.infer<typeof questionSchema>;

export const roundSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  number: z.number().int().positive(),
  mode: z.enum(QUESTION_MODES),
  intro: z.string().nullable(),
  questions: z.array(questionSchema),
  createdAt: z.number(),
});
export type Round = z.infer<typeof roundSchema>;

export const attachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  /** Server-managed relative attachment path returned by the upload. */
  path: z.string().min(1),
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().max(200).nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const referenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    path: z.string().min(1).max(1024),
    entryKind: z.enum(["file", "directory"]),
    environmentId: z.string().min(1),
    hostId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("url"),
    url: z
      .string()
      .max(2048)
      .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), "Only http(s) links are accepted."),
  }),
  z.object({ kind: z.literal("custom"), path: z.string().min(1).max(1024) }),
]);
export type Reference = z.infer<typeof referenceSchema>;

export const answerSchema = z.object({
  selected: z.array(z.string().max(64)).max(LIMITS.optionsPerQuestion),
  details: z.record(z.string().max(64), z.string().max(LIMITS.detailChars)),
  text: z.string().max(LIMITS.answerTextChars),
  attachments: z.array(attachmentSchema).max(LIMITS.attachmentsPerQuestion),
  references: z.array(referenceSchema).max(LIMITS.referencesPerQuestion),
  confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
});
export type Answer = z.infer<typeof answerSchema>;

export const answerStateSchema = z.object({
  questionId: z.string(),
  roundId: z.string(),
  /** Current editable draft; null when nothing was ever saved. */
  draft: answerSchema.nullable(),
  /** Compare-and-swap version of the draft; 0 before the first save. */
  version: z.number().int().nonnegative(),
  /** Frozen copy of the last delivered answer; never mutated by drafts. */
  submitted: answerSchema.nullable(),
  submittedAt: z.number().nullable(),
  submissionId: z.string().nullable(),
});
export type AnswerState = z.infer<typeof answerStateSchema>;

export const SUBMISSION_STATES = [
  "pending",
  "sent",
  "queued",
  "uncertain",
  "failed",
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const submissionSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  state: z.enum(SUBMISSION_STATES),
  questionIds: z.array(z.string()),
  /** Frozen answers as they were at submit time, keyed by question id. */
  snapshot: z.record(z.string(), answerSchema),
  error: z.string().nullable(),
  /** The id of the submission this one retried, if any. */
  retryOf: z.string().nullable(),
  createdAt: z.number(),
  settledAt: z.number().nullable(),
});
export type Submission = z.infer<typeof submissionSchema>;

export const summarySchema = z.object({
  markdown: z.string(),
  updatedAt: z.number(),
});
export type Summary = z.infer<typeof summarySchema>;

export const threadStateSchema = z.object({
  threadId: z.string(),
  rounds: z.array(roundSchema),
  answers: z.array(answerStateSchema),
  summary: summarySchema.nullable(),
  submissions: z.array(submissionSchema),
});
export type ThreadState = z.infer<typeof threadStateSchema>;

export function emptyAnswer(): Answer {
  return {
    selected: [],
    details: {},
    text: "",
    attachments: [],
    references: [],
    confidence: null,
  };
}

export function hasContent(answer: Answer | null | undefined): boolean {
  if (!answer) return false;
  return (
    answer.selected.length > 0 ||
    answer.text.trim() !== "" ||
    answer.attachments.length > 0 ||
    answer.references.length > 0
  );
}

/** Canonical form used for equality; drops empty details and whitespace. */
export function normalizeAnswer(answer: Answer): Answer {
  const details: Record<string, string> = {};
  for (const id of answer.selected) {
    const detail = answer.details[id]?.trim() ?? "";
    if (detail !== "") details[id] = detail;
  }
  return {
    selected: [...answer.selected],
    details,
    text: answer.text.trim(),
    attachments: answer.attachments.map((item) => ({ ...item })),
    references: answer.references.map((item) => ({ ...item })),
    confidence: answer.confidence,
  };
}

export function answersEqual(a: Answer | null, b: Answer | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(normalizeAnswer(a)) === JSON.stringify(normalizeAnswer(b));
}

export type AnswerStatus = "empty" | "draft" | "done";

/** empty: nothing typed; done: submitted and unchanged; draft: otherwise. */
export function answerStatus(state: AnswerState | undefined): AnswerStatus {
  if (!state) return "empty";
  const draft = state.draft;
  if (!hasContent(draft)) return "empty";
  if (state.submitted !== null && answersEqual(draft, state.submitted)) return "done";
  return "draft";
}

/** Question ids whose draft differs from what was last submitted. */
export function pendingQuestionIds(
  rounds: Round[],
  answers: Map<string, AnswerState>,
): string[] {
  const ids: string[] = [];
  for (const round of rounds) {
    for (const question of round.questions) {
      const state = answers.get(question.id);
      if (!state) continue;
      if (answerStatus(state) === "draft" && hasContent(state.draft)) ids.push(question.id);
    }
  }
  return ids;
}

/** "Q1", "Q2", … numbered across every round of the thread, in order. */
export function questionLabels(rounds: Round[]): Map<string, string> {
  const labels = new Map<string, string>();
  let index = 0;
  for (const round of [...rounds].sort((a, b) => a.number - b.number)) {
    for (const question of round.questions) {
      index += 1;
      labels.set(question.id, `Q${index}`);
    }
  }
  return labels;
}

export function findQuestion(rounds: Round[], questionId: string): { round: Round; question: Question } | null {
  for (const round of rounds) {
    const question = round.questions.find((item) => item.id === questionId);
    if (question) return { round, question };
  }
  return null;
}

export function referenceLabel(reference: Reference): string {
  if (reference.kind === "url") return reference.url;
  return reference.path;
}

export function referenceName(reference: Reference): string {
  const label = referenceLabel(reference).replace(/\/$/, "");
  const last = label.split("/").pop();
  return last === undefined || last === "" ? label : last;
}

/** One-line rendering of an answer, used in summaries and citations. */
export function answerText(question: Question, answer: Answer | null): string {
  if (!answer || !hasContent(answer)) return "";
  const parts: string[] = [];
  if (answer.selected.length > 0) {
    parts.push(
      answer.selected
        .map((id) => {
          const option = question.options.find((item) => item.id === id);
          const detail = (answer.details[id] ?? "").trim();
          return (option ? option.label : id) + (detail ? ` — ${detail}` : "");
        })
        .join(", "),
    );
  }
  if (answer.text.trim() !== "") parts.push(answer.text.trim());
  if (answer.attachments.length > 0) {
    parts.push(`${answer.attachments.length} file${answer.attachments.length > 1 ? "s" : ""}`);
  }
  if (answer.references.length > 0) {
    parts.push(`${answer.references.length} ref${answer.references.length > 1 ? "s" : ""}`);
  }
  return parts.join(" · ");
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && /^image\//i.test(mimeType);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Failed or uncertain attempts that still own the latest attempt for at
 * least one of their questions. A later successful send of other questions
 * never hides them; an attempt fully superseded by newer ones is not listed.
 */
export function actionableFailures(submissions: Submission[]): Submission[] {
  return submissions.filter((submission) => {
    if (submission.state !== "uncertain" && submission.state !== "failed") return false;
    return submission.questionIds.some(
      (questionId) =>
        !submissions.some(
          (other) =>
            other.id !== submission.id &&
            other.createdAt >= submission.createdAt &&
            other.state !== "failed" &&
            other.questionIds.includes(questionId),
        ),
    );
  });
}
