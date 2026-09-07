// Thread-scoped business logic: round creation, drafts, attachments,
// workspace path search, and the submission outbox. The service never picks
// a thread itself; every entry point receives the thread the caller resolved
// from its own context (agent tool context, CLI context, or the panel).
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type Answer,
  type AnswerState,
  type Question,
  type QuestionMode,
  type Round,
  type Submission,
  type ThreadState,
  type ChangeSignal,
  DIRECTIVE_NAME,
  LIMITS,
  answerSchema,
  answerStatus,
  answersEqual,
  emptyAnswer,
  findQuestion,
  hasContent,
  isImageMime,
  normalizeAnswer,
  questionLabels,
} from "../lib/model";
import { buildSubmissionMessage } from "../lib/message";
import { QuestionsStore, type SaveDraftResult } from "./store";


/** What an agent or the CLI may pass to create a round. */
export const askInputSchema = z.object({
  mode: z.enum(["panel", "inline"]).default("panel"),
  intro: z.string().trim().max(LIMITS.introChars).optional(),
  questions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(LIMITS.titleChars),
        help: z.string().trim().max(LIMITS.helpChars).optional(),
        options: z
          .array(
            z.union([
              z.string().trim().min(1).max(LIMITS.optionChars),
              z.object({ label: z.string().trim().min(1).max(LIMITS.optionChars) }),
            ]),
          )
          .max(LIMITS.optionsPerQuestion)
          .optional(),
        select: z.enum(["single", "multiple"]).optional(),
        cites: z.array(z.string().trim().min(1)).max(10).optional(),
        attachments: z.boolean().optional(),
        references: z.boolean().optional(),
        confidence: z.boolean().optional(),
      }),
    )
    .min(1),
});
export type AskInput = z.infer<typeof askInputSchema>;

export class QuestionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionsError";
  }
}

export interface AskResult {
  round: Round;
  labels: string[];
  directive: string;
}

export interface SubmitItem {
  questionId: string;
  expectedVersion: number;
}

export type SubmitResult =
  | { outcome: "submitted"; submission: Submission }
  | { outcome: "conflict"; questionIds: string[]; states: AnswerState[] }
  | { outcome: "in-flight"; questionIds: string[] }
  | { outcome: "nothing" };

export interface PathHit {
  path: string;
  name: string;
  kind: "file" | "directory";
}
export interface PathSearchResult {
  environmentId: string | null;
  hostId: string | null;
  hits: PathHit[];
  truncated: boolean;
  /** Present when the thread has no workspace to search. */
  unavailable: string | null;
}

function directiveFor(roundId: string): string {
  return `::${DIRECTIVE_NAME}{round="${roundId}"}`;
}

/** Sort out what a failed `threads.send` means for the outbox row. */
export function classifySendError(error: unknown): { state: "failed" | "uncertain"; message: string } {
  const named = error as { name?: unknown; status?: unknown; message?: unknown } | null;
  const message =
    named && typeof named.message === "string" ? named.message : String(error);
  if (named && named.name === "BbHttpError" && typeof named.status === "number") {
    // The server answered: a 4xx (other than a timeout) means it refused the
    // message before accepting it. 5xx and 408 leave the outcome unknown.
    if (named.status >= 400 && named.status < 500 && named.status !== 408) {
      return { state: "failed", message };
    }
    return { state: "uncertain", message };
  }
  return { state: "uncertain", message };
}

export interface ServiceDeps {
  sdk: BbPluginApi["sdk"];
  log: BbPluginApi["log"];
  publish: (signal: ChangeSignal) => void;
  now?: () => number;
  newId?: (prefix: string) => string;
}

export class QuestionsService {
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;

  constructor(
    private readonly store: QuestionsStore,
    private readonly deps: ServiceDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, "")}`);
  }

  /** Called once at load: no pending row may survive a restart as pending. */
  recoverStalePending(): number {
    return this.store.markStalePendingUncertain(this.now());
  }

  state(threadId: string): ThreadState {
    return {
      threadId,
      rounds: this.store.listRounds(threadId),
      answers: this.store.listAnswers(threadId),
      summary: this.store.getSummary(threadId),
      submissions: this.store.listSubmissions(threadId, LIMITS.submissionsListed),
    };
  }

  ask(threadId: string, projectId: string, rawInput: unknown): AskResult {
    const parsed = askInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new QuestionsError(
        `Invalid questions: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`,
      );
    }
    const input = parsed.data;
    const mode: QuestionMode = input.mode;
    if (mode === "inline" && input.questions.length > LIMITS.inlineMaxQuestions) {
      throw new QuestionsError(
        `Inline rounds hold at most ${LIMITS.inlineMaxQuestions} questions. Use mode "panel" for more, or ask another round later.`,
      );
    }
    const existing = this.store.listRounds(threadId);
    const labels = questionLabels(existing);
    const byLabel = new Map<string, string>();
    for (const [id, label] of labels) byLabel.set(label.toUpperCase(), id);
    const questions: Question[] = input.questions.map((item, index) => {
      const options = (item.options ?? []).map((option, optionIndex) => ({
        id: `o${optionIndex + 1}`,
        label: typeof option === "string" ? option : option.label,
      }));
      const select = options.length > 0 ? (item.select ?? "single") : null;
      if (mode === "inline") {
        const advanced = ["help", "cites", "attachments", "references", "confidence"].filter(
          (key) => {
            const value = item[key as keyof typeof item];
            return Array.isArray(value) ? value.length > 0 : Boolean(value);
          },
        );
        if (advanced.length > 0) {
          throw new QuestionsError(
            `Question ${index + 1}: inline mode does not support ${advanced.join(", ")}. Use mode "panel".`,
          );
        }
      }
      const cites = (item.cites ?? []).map((cite) => {
        const trimmed = cite.trim();
        const resolved = byLabel.get(trimmed.toUpperCase()) ?? (labels.has(trimmed) ? trimmed : null);
        if (resolved === null) {
          throw new QuestionsError(
            `Question ${index + 1} cites "${cite}", which is not a question from an earlier round. Use labels like "Q3" from questions_read.`,
          );
        }
        return resolved;
      });
      return {
        id: this.newId("q"),
        title: item.title,
        help: item.help && item.help !== "" ? item.help : null,
        select,
        options,
        cites: [...new Set(cites)],
        attachments: item.attachments ?? false,
        references: item.references ?? false,
        confidence: item.confidence ?? false,
      };
    });
    const bytes = Buffer.byteLength(JSON.stringify(questions), "utf8");
    if (bytes > LIMITS.roundQuestionsBytes) {
      throw new QuestionsError(
        `This round is ${Math.round(bytes / 1024)} KB of questions; the limit is ${Math.round(LIMITS.roundQuestionsBytes / 1024)} KB. Split it into several rounds.`,
      );
    }
    const round = this.store.createRound({
      id: this.newId("rnd"),
      threadId,
      projectId,
      mode,
      intro: input.intro && input.intro !== "" ? input.intro : null,
      questions,
      createdAt: this.now(),
    });
    const allLabels = questionLabels([...existing, round]);
    const roundLabels = round.questions.map((question) => allLabels.get(question.id) ?? question.id);
    this.deps.publish({ threadId, kind: "round-created", roundId: round.id });
    return { round, labels: roundLabels, directive: directiveFor(round.id) };
  }

  /** Bounded text report of every submitted answer, for the agent and CLI. */
  read(threadId: string, roundId: string | null, after: string | null = null): string {
    const rounds = this.store.listRounds(threadId);
    if (rounds.length === 0) return "No question rounds exist in this thread yet.";
    const answers = new Map(this.store.listAnswers(threadId).map((item) => [item.questionId, item]));
    const labels = questionLabels(rounds);
    const selected = roundId === null ? rounds : rounds.filter((round) => round.id === roundId);
    if (selected.length === 0) return `No round with id ${roundId} in this thread.`;
    const entries = selected.flatMap((round) => round.questions.map((question) => ({ round, question })));
    const cursor = after === null ? -1 : entries.findIndex(({ question }) => question.id === after || labels.get(question.id) === after);
    if (after !== null && cursor === -1) throw new QuestionsError("Unknown answer cursor in this thread/round.");
    const lines: string[] = [];
    let bytes = 0;
    let last: string | null = null;
    for (const { round, question } of entries.slice(cursor + 1)) {
        const label = labels.get(question.id) ?? question.id;
        const state = answers.get(question.id);
        const status = answerStatus(state);
        const submitted = state?.submitted ?? null;
        const entry = JSON.stringify({
          round: round.id, roundNumber: round.number, questionId: question.id, label,
          question: question.title, options: question.options,
          submitted, submittedAt: state?.submittedAt ?? null,
          hasUnsentChanges: status === "draft",
        });
        // Whole answers, never a clipped value. A single answer may exceed
        // the page target; field bounds still keep it below the CLI ceiling.
        // A cursor makes every later answer reachable.
        if (last !== null && bytes + Buffer.byteLength(entry, "utf8") > 512 * 1024) {
          lines.push(`More answers: call questions_read with after=${JSON.stringify(last)}${roundId ? ` and round=${JSON.stringify(roundId)}` : ""}.`);
          break;
        }
        lines.push(entry);
        bytes += Buffer.byteLength(entry, "utf8") + 1;
        last = question.id;
    }
    return lines.join("\n") || "No more answers.";
  }

  setSummary(threadId: string, markdown: string | null): void {
    if (markdown === null || markdown.trim() === "") {
      this.store.clearSummary(threadId);
    } else {
      if (markdown.length > LIMITS.summaryChars) {
        throw new QuestionsError(`Summary is limited to ${LIMITS.summaryChars} characters.`);
      }
      this.store.setSummary(threadId, markdown, this.now());
    }
    this.deps.publish({ threadId, kind: "summary" });
  }

  private requireQuestion(threadId: string, questionId: string): { round: Round; question: Question } {
    const found = findQuestion(this.store.listRounds(threadId), questionId);
    if (!found) throw new QuestionsError("Unknown question for this thread.");
    return found;
  }

  async saveDraft(input: {
    threadId: string;
    questionId: string;
    draft: unknown;
    expectedVersion: number;
  }): Promise<SaveDraftResult> {
    const { round, question } = this.requireQuestion(input.threadId, input.questionId);
    const parsed = answerSchema.safeParse(input.draft);
    if (!parsed.success) throw new QuestionsError("Invalid draft.");
    const draft = await this.sanitizeDraft(question, parsed.data, input.threadId);
    const result = this.store.saveDraft({
      threadId: input.threadId,
      roundId: round.id,
      questionId: question.id,
      draft,
      expectedVersion: input.expectedVersion,
      now: this.now(),
    });
    if (result.outcome === "saved") this.deps.publish({ threadId: input.threadId, kind: "answers" });
    return result;
  }

  /** Drop anything the question did not ask for or that the client may not set. */
  private async sanitizeDraft(question: Question, draft: Answer, threadId: string): Promise<Answer> {
    const optionIds = new Set(question.options.map((option) => option.id));
    if (draft.selected.some((id) => !optionIds.has(id)) || Object.keys(draft.details).some((id) => !optionIds.has(id))) {
      throw new QuestionsError("Draft contains an unknown choice.");
    }
    const selected = question.options.filter((option) => draft.selected.includes(option.id)).map((option) => option.id);
    if (question.select === "single" && selected.length > 1) throw new QuestionsError("Choose one option for this question.");
    if (question.select === "single" && draft.other && selected.length > 0) throw new QuestionsError("Other cannot be combined with another single-choice option.");
    if (!question.attachments && draft.attachments.length || !question.references && draft.references.length || !question.confidence && draft.confidence !== null) {
      throw new QuestionsError("Draft uses controls this question does not offer.");
    }
    const workspaceRefs = draft.references.filter((ref) => ref.kind === "workspace");
    if (workspaceRefs.length) {
      const target = await this.threadEnvironment(threadId);
      for (const ref of workspaceRefs) {
        if (ref.environmentId !== target.environmentId || ref.hostId !== target.hostId || ref.path.startsWith("/") || ref.path.includes("\\") || ref.path.split("/").includes("..") || /[\x00-\x1f]/.test(ref.path)) {
          throw new QuestionsError("File reference does not belong to this thread workspace.");
        }
      }
    }
    const known = this.store.getAnswer(threadId, question.id);
    const knownAttachments = new Map<string, Answer["attachments"][number]>();
    for (const item of [...(known?.draft?.attachments ?? []), ...(known?.submitted?.attachments ?? [])]) {
      knownAttachments.set(item.path, item);
    }
    // Attachments enter through uploadAttachment only; a draft may keep or
    // remove ones this question already owns, never invent new paths.
    const attachments = question.attachments
      ? draft.attachments.flatMap((item) => {
          const owned = knownAttachments.get(item.path);
            if (!owned) throw new QuestionsError("Unknown attachment for this question.");
            return [owned];
        })
      : [];
    return {
      selected,
      ...(draft.other !== undefined ? { other: draft.other } : {}),
      details: draft.details,
      text: draft.text,
      attachments,
      references: question.references ? draft.references : [],
      confidence: question.confidence ? draft.confidence : null,
    };
  }

  async uploadAttachment(input: {
    threadId: string;
    questionId: string;
    expectedVersion: number;
    name: string;
    mimeType: string | null;
    dataBase64: string;
  }): Promise<SaveDraftResult> {
    const { round, question } = this.requireQuestion(input.threadId, input.questionId);
    if (!question.attachments) throw new QuestionsError("This question does not accept attachments.");
    if (input.dataBase64.length > Math.ceil(LIMITS.attachmentBytes / 3) * 4) throw new QuestionsError("File exceeds the upload byte limit.");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.toString("base64") !== input.dataBase64) {
      throw new QuestionsError("Invalid file encoding.");
    }
    if (bytes.byteLength > LIMITS.attachmentBytes) {
      throw new QuestionsError(`Files are limited to ${Math.round(LIMITS.attachmentBytes / (1024 * 1024))} MB.`);
    }
    const current = this.store.getAnswer(input.threadId, input.questionId);
    if ((current?.version ?? 0) !== input.expectedVersion) {
      return {
        outcome: "conflict",
        state: current ?? {
          questionId: question.id,
          roundId: round.id,
          draft: null,
          version: 0,
          submitted: null,
          submittedAt: null,
          submissionId: null,
        },
      };
    }
    const existing = current?.draft ?? emptyAnswer();
    if (existing.attachments.length >= LIMITS.attachmentsPerQuestion) {
      throw new QuestionsError(`At most ${LIMITS.attachmentsPerQuestion} files per question.`);
    }
    const projectId = this.roundProjectId(round);
    const filename = input.name.replace(/[\\/]/g, "_").slice(0, 255) || "attachment";
    const uploaded = await this.deps.sdk.projects.attachments.upload({
      projectId,
      clientFile: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      filename,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    });
    const attachment = {
      type: isImageMime(uploaded.mimeType ?? input.mimeType) ? ("localImage" as const) : ("localFile" as const),
      path: uploaded.path,
      name: uploaded.name || filename,
      sizeBytes: uploaded.sizeBytes,
      mimeType: uploaded.mimeType ?? input.mimeType,
    };
    const next: Answer = { ...existing, attachments: [...existing.attachments, attachment] };
    const result = this.store.saveDraft({
      threadId: input.threadId,
      roundId: round.id,
      questionId: question.id,
      draft: next,
      expectedVersion: input.expectedVersion,
      now: this.now(),
    });
    if (result.outcome === "saved") this.deps.publish({ threadId: input.threadId, kind: "answers" });
    return result;
  }

  private roundProjectId(round: Round): string {
    const projectId = this.store.roundProjectId(round.id);
    if (projectId === null) throw new QuestionsError("Round has no project.");
    return projectId;
  }

  /** Small image bytes for a preview, only for a path this question owns. */
  async readAttachmentPreview(input: {
    threadId: string;
    questionId: string;
    path: string;
  }): Promise<{ dataUrl: string } | { dataUrl: null; reason: string }> {
    const { round } = this.requireQuestion(input.threadId, input.questionId);
    const state = this.store.getAnswer(input.threadId, input.questionId);
    const owned = [...(state?.draft?.attachments ?? []), ...(state?.submitted?.attachments ?? [])].find(
      (item) => item.path === input.path,
    );
    if (!owned) throw new QuestionsError("Unknown attachment for this question.");
    if (owned.type !== "localImage") return { dataUrl: null, reason: "not-image" };
    if (owned.sizeBytes > LIMITS.previewImageBytes) return { dataUrl: null, reason: "too-large" };
    const read = await this.deps.sdk.projects.attachments.read({
      projectId: this.roundProjectId(round),
      path: owned.path,
    });
    if (read.sizeBytes > LIMITS.previewImageBytes) return { dataUrl: null, reason: "too-large" };
    const base64 = Buffer.from(read.bytes).toString("base64");
    return { dataUrl: `data:${read.mimeType};base64,${base64}` };
  }

  private async threadEnvironment(threadId: string): Promise<{ environmentId: string | null; hostId: string | null }> {
    const thread = await this.deps.sdk.threads.get({ threadId });
    const environmentId = thread.environmentId;
    let hostId: string | null = null;
    if (environmentId !== null) {
      const environment = await this.deps.sdk.environments.get({ environmentId });
      hostId = environment.hostId;
    }
    return { environmentId, hostId };
  }

  async searchPaths(threadId: string, query: string): Promise<PathSearchResult> {
    const { environmentId, hostId } = await this.threadEnvironment(threadId);
    if (query.trim() === "") return { environmentId, hostId, hits: [], truncated: false, unavailable: null };
    if (environmentId === null) {
      return { environmentId: null, hostId: null, hits: [], truncated: false, unavailable: "This thread has no workspace." };
    }
    const result = await this.deps.sdk.environments.paths({
      environmentId,
      query: query.trim(),
      includeFiles: "true",
      includeDirectories: "true",
      limit: "20",
    });
    return {
      environmentId,
      hostId,
      hits: result.paths.map((item) => ({ path: item.path, name: item.name, kind: item.kind })),
      truncated: result.truncated,
      unavailable: null,
    };
  }

  /**
   * Freeze, record, then send. The outbox row exists before the send so a
   * crash mid-flight leaves an uncertain row instead of a silent loss or a
   * silent duplicate.
   */
  async submit(input: {
    threadId: string;
    submissionId: string;
    items: SubmitItem[];
    retryOf: string | null;
  }): Promise<SubmitResult> {
    const existing = this.store.getSubmission(input.threadId, input.submissionId);
    if (existing) return { outcome: "submitted", submission: existing };
    const rounds = this.store.listRounds(input.threadId);

    const prepared = this.store.transaction((): SubmitResult => {
      const inFlight = this.store.inFlightQuestionIds(input.threadId);
      let questionIds: string[];
      let snapshot: Record<string, Answer>;
      if (input.retryOf !== null) {
        const previous = this.store.getSubmission(input.threadId, input.retryOf);
        if (!previous) throw new QuestionsError("Unknown submission to retry.");
        if (previous.state !== "uncertain" && previous.state !== "failed") {
          throw new QuestionsError("Only an uncertain or failed submission can be retried.");
        }
        if (this.store.hasNewerAttempt(input.threadId, previous.id, previous.questionIds)) {
          throw new QuestionsError("This submission has a newer attempt. Retry the latest attempt instead.");
        }
        questionIds = previous.questionIds;
        snapshot = previous.snapshot;
      } else {
        const conflicts: AnswerState[] = [];
        questionIds = [];
        snapshot = {};
        const uniqueItems = new Map(input.items.map((item) => [item.questionId, item]));
        for (const item of uniqueItems.values()) {
          const found = findQuestion(rounds, item.questionId);
          if (!found) throw new QuestionsError("Unknown question for this thread.");
          const state = this.store.getAnswer(input.threadId, item.questionId);
          if ((state?.version ?? 0) !== item.expectedVersion) {
            conflicts.push(state ?? {
              questionId: item.questionId, roundId: found.round.id, draft: null,
              version: 0, submitted: null, submittedAt: null, submissionId: null,
            });
            continue;
          }
          if (!state || !hasContent(state.draft) || answersEqual(state.draft, state.submitted)) continue;
          questionIds.push(item.questionId);
          snapshot[item.questionId] = normalizeAnswer(state.draft as Answer);
        }
        if (conflicts.length > 0) {
          return { outcome: "conflict", questionIds: conflicts.map((state) => state.questionId), states: conflicts };
        }
      }
      const overlapping = questionIds.filter((id) => inFlight.has(id));
      if (overlapping.length > 0) return { outcome: "in-flight", questionIds: overlapping };
      if (questionIds.length === 0) return { outcome: "nothing" };
      const submission = this.store.createSubmission({
        id: input.submissionId,
        threadId: input.threadId,
        questionIds,
        snapshot,
        retryOf: input.retryOf,
        createdAt: this.now(),
      });
      return { outcome: "submitted", submission };
    });
    if (prepared.outcome !== "submitted") return prepared;

    const submission = prepared.submission;
    const message = buildSubmissionMessage(rounds, submission.snapshot, submission.questionIds, submission.id);
    const parts: Parameters<ServiceDeps["sdk"]["threads"]["send"]>[0]["input"] = [
      { type: "text", text: message.text, mentions: [] },
      ...message.attachments.map((attachment) =>
        attachment.type === "localImage"
          ? ({ type: "localImage", path: attachment.path } as const)
          : ({
              type: "localFile",
              path: attachment.path,
              name: attachment.name,
              sizeBytes: attachment.sizeBytes,
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            } as const),
      ),
    ];
    try {
      const response = await this.deps.sdk.threads.send({
        threadId: input.threadId,
        mode: "queue-if-active",
        input: parts,
      });
      const state = response.delivery === "queued" ? "queued" : "sent";
      this.store.settleDelivered({ threadId: input.threadId, submission, state, settledAt: this.now() });
    } catch (error) {
      const classified = classifySendError(error);
      this.deps.log.warn(
        `submission ${submission.id} ${classified.state}: ${classified.message}`,
      );
      this.store.settleUndelivered({
        threadId: input.threadId,
        submissionId: submission.id,
        state: classified.state,
        error: classified.message,
        settledAt: this.now(),
      });
    }
    this.deps.publish({ threadId: input.threadId, kind: "submission", submissionId: submission.id });
    this.deps.publish({ threadId: input.threadId, kind: "answers" });
    const settled = this.store.getSubmission(input.threadId, submission.id);
    return { outcome: "submitted", submission: settled ?? submission };
  }
}
