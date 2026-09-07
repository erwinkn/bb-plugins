// SQLite persistence for rounds, drafts, submissions, and summaries. Every
// row is scoped by thread id; callers pass the thread they resolved from
// context so a client can never read or write another thread's data.
import type Database from "better-sqlite3";
import {
  type Answer,
  type AnswerState,
  type Round,
  type Submission,
  type SubmissionState,
  type Summary,
  answerSchema,
  questionSchema,
} from "../lib/model";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    mode TEXT NOT NULL,
    intro TEXT,
    questions_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rounds_thread ON rounds(thread_id, number)`,
  `CREATE TABLE IF NOT EXISTS answers (
    question_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    draft_json TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    submitted_json TEXT,
    submitted_at INTEGER,
    submission_id TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS answers_thread ON answers(thread_id)`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    state TEXT NOT NULL,
    question_ids_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    error TEXT,
    retry_of TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS submissions_thread ON submissions(thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS summaries (
    thread_id TEXT PRIMARY KEY,
    markdown TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `UPDATE rounds SET mode = 'panel' WHERE mode = 'notebook'`,
];

interface RoundRow {
  id: string;
  thread_id: string;
  project_id: string;
  number: number;
  mode: string;
  intro: string | null;
  questions_json: string;
  created_at: number;
}
interface AnswerRow {
  question_id: string;
  thread_id: string;
  round_id: string;
  draft_json: string | null;
  version: number;
  submitted_json: string | null;
  submitted_at: number | null;
  submission_id: string | null;
}
interface SubmissionRow {
  id: string;
  thread_id: string;
  state: string;
  question_ids_json: string;
  snapshot_json: string;
  error: string | null;
  retry_of: string | null;
  created_at: number;
  settled_at: number | null;
}

export class StoredDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredDataError";
  }
}

function parseAnswer(json: string | null, where: string): Answer | null {
  if (json === null) return null;
  const parsed = answerSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new StoredDataError(`Stored answer for ${where} is not readable: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

function rowToRound(row: RoundRow): Round {
  if (row.mode !== "inline" && row.mode !== "panel") throw new StoredDataError(`Stored round ${row.id} has an invalid display mode.`);
  const parsedQuestions = questionSchema.array().safeParse(JSON.parse(row.questions_json));
  if (!parsedQuestions.success) {
    throw new StoredDataError(`Stored questions for round ${row.id} are not readable.`);
  }
  const questions = parsedQuestions.data;
  return {
    id: row.id,
    threadId: row.thread_id,
    number: row.number,
    mode: row.mode,
    intro: row.intro,
    questions,
    createdAt: row.created_at,
  };
}

function rowToAnswer(row: AnswerRow): AnswerState {
  return {
    questionId: row.question_id,
    roundId: row.round_id,
    draft: parseAnswer(row.draft_json, `question ${row.question_id} (draft)`),
    version: row.version,
    submitted: parseAnswer(row.submitted_json, `question ${row.question_id} (submitted)`),
    submittedAt: row.submitted_at,
    submissionId: row.submission_id,
  };
}

function rowToSubmission(row: SubmissionRow): Submission {
  const snapshotRaw = JSON.parse(row.snapshot_json) as Record<string, unknown>;
  const snapshot: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(snapshotRaw)) {
    const parsed = answerSchema.safeParse(value);
    if (!parsed.success) {
      throw new StoredDataError(`Stored submission ${row.id} has an unreadable answer for ${id}.`);
    }
    snapshot[id] = parsed.data;
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    state: row.state as SubmissionState,
    questionIds: JSON.parse(row.question_ids_json) as string[],
    snapshot,
    error: row.error,
    retryOf: row.retry_of,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export type SaveDraftResult =
  | { outcome: "saved"; state: AnswerState }
  | { outcome: "conflict"; state: AnswerState };

export class QuestionsStore {
  constructor(private readonly db: Database.Database) {}

  deleteThread(threadId: string): void {
    this.db.transaction(() => {
      for (const table of ["answers", "submissions", "rounds", "summaries"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
      }
    })();
  }

  /** Any later attempt supersedes a retry of older answers for the same question. */
  hasNewerAttempt(threadId: string, submissionId: string, questionIds: string[]): boolean {
    const query = this.db.prepare<[string, string, string], { found: number }>(
      `SELECT 1 AS found FROM submissions s
       WHERE s.thread_id = ? AND s.rowid > (SELECT rowid FROM submissions WHERE id = ?)
         AND EXISTS (SELECT 1 FROM json_each(s.question_ids_json) WHERE value = ?)
       LIMIT 1`,
    );
    return questionIds.some((id) => query.get(threadId, submissionId, id) !== undefined);
  }

  /** Insert a round with the next number for its thread. */
  createRound(input: {
    id: string;
    threadId: string;
    projectId: string;
    mode: Round["mode"];
    intro: string | null;
    questions: Round["questions"];
    createdAt: number;
  }): Round {
    const insert = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], { next: number }>(
          "SELECT COALESCE(MAX(number), 0) + 1 AS next FROM rounds WHERE thread_id = ?",
        )
        .get(input.threadId);
      const number = row?.next ?? 1;
      this.db
        .prepare(
          `INSERT INTO rounds (id, thread_id, project_id, number, mode, intro, questions_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.threadId,
          input.projectId,
          number,
          input.mode,
          input.intro,
          JSON.stringify(input.questions),
          input.createdAt,
        );
      return number;
    });
    const number = insert();
    return {
      id: input.id,
      threadId: input.threadId,
      number,
      mode: input.mode,
      intro: input.intro,
      questions: input.questions,
      createdAt: input.createdAt,
    };
  }

  listRounds(threadId: string): Round[] {
    const rows = this.db
      .prepare<[string], RoundRow>("SELECT * FROM rounds WHERE thread_id = ? ORDER BY number ASC")
      .all(threadId);
    return rows.map(rowToRound);
  }

  getRound(threadId: string, roundId: string): Round | null {
    const row = this.db
      .prepare<[string, string], RoundRow>("SELECT * FROM rounds WHERE id = ? AND thread_id = ?")
      .get(roundId, threadId);
    return row ? rowToRound(row) : null;
  }

  roundProjectId(roundId: string): string | null {
    const row = this.db
      .prepare<[string], { project_id: string }>("SELECT project_id FROM rounds WHERE id = ?")
      .get(roundId);
    return row ? row.project_id : null;
  }

  listAnswers(threadId: string): AnswerState[] {
    const rows = this.db
      .prepare<[string], AnswerRow>("SELECT * FROM answers WHERE thread_id = ?")
      .all(threadId);
    return rows.map(rowToAnswer);
  }

  getAnswer(threadId: string, questionId: string): AnswerState | null {
    const row = this.db
      .prepare<[string, string], AnswerRow>(
        "SELECT * FROM answers WHERE question_id = ? AND thread_id = ?",
      )
      .get(questionId, threadId);
    return row ? rowToAnswer(row) : null;
  }

  /**
   * Compare-and-swap draft write. `expectedVersion` must equal the stored
   * version (0 when no row exists yet); otherwise the caller receives the
   * server copy and nothing changes.
   */
  saveDraft(input: {
    threadId: string;
    roundId: string;
    questionId: string;
    draft: Answer;
    expectedVersion: number;
    now: number;
  }): SaveDraftResult {
    const write = this.db.transaction((): SaveDraftResult => {
      const current = this.getAnswer(input.threadId, input.questionId);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        return {
          outcome: "conflict",
          state: current ?? {
            questionId: input.questionId,
            roundId: input.roundId,
            draft: null,
            version: 0,
            submitted: null,
            submittedAt: null,
            submissionId: null,
          },
        };
      }
      const nextVersion = currentVersion + 1;
      const draftJson = JSON.stringify(input.draft);
      if (current === null) {
        this.db
          .prepare(
            `INSERT INTO answers (question_id, thread_id, round_id, draft_json, version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(input.questionId, input.threadId, input.roundId, draftJson, nextVersion, input.now);
      } else {
        this.db
          .prepare(
            `UPDATE answers SET draft_json = ?, version = ?, updated_at = ?
             WHERE question_id = ? AND thread_id = ?`,
          )
          .run(draftJson, nextVersion, input.now, input.questionId, input.threadId);
      }
      const state = this.getAnswer(input.threadId, input.questionId);
      if (state === null) throw new Error("draft row vanished during save");
      return { outcome: "saved", state };
    });
    return write();
  }

  /** Question ids covered by submissions that are still in flight. */
  inFlightQuestionIds(threadId: string): Set<string> {
    const rows = this.db
      .prepare<[string], { question_ids_json: string }>(
        "SELECT question_ids_json FROM submissions WHERE thread_id = ? AND state = 'pending'",
      )
      .all(threadId);
    const ids = new Set<string>();
    for (const row of rows) {
      for (const id of JSON.parse(row.question_ids_json) as string[]) ids.add(id);
    }
    return ids;
  }

  /**
   * Insert the frozen snapshot before any send happens. Runs inside a
   * transaction together with the CAS checks the service performs.
   */
  createSubmission(input: {
    id: string;
    threadId: string;
    questionIds: string[];
    snapshot: Record<string, Answer>;
    retryOf: string | null;
    createdAt: number;
  }): Submission {
    this.db
      .prepare(
        `INSERT INTO submissions (id, thread_id, state, question_ids_json, snapshot_json, error, retry_of, created_at, settled_at)
         VALUES (?, ?, 'pending', ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.threadId,
        JSON.stringify(input.questionIds),
        JSON.stringify(input.snapshot),
        input.retryOf,
        input.createdAt,
      );
    const submission = this.getSubmission(input.threadId, input.id);
    if (submission === null) throw new Error("submission row vanished during insert");
    return submission;
  }

  getSubmission(threadId: string, submissionId: string): Submission | null {
    const row = this.db
      .prepare<[string, string], SubmissionRow>(
        "SELECT * FROM submissions WHERE id = ? AND thread_id = ?",
      )
      .get(submissionId, threadId);
    return row ? rowToSubmission(row) : null;
  }

  listSubmissions(threadId: string, limit: number): Submission[] {
    const rows = this.db
      .prepare<[string, number], SubmissionRow>(
        `SELECT * FROM submissions s WHERE thread_id = ? AND (
          rowid IN (SELECT rowid FROM submissions WHERE thread_id = s.thread_id ORDER BY created_at DESC, rowid DESC LIMIT ?)
          OR (state IN ('pending', 'uncertain', 'failed') AND EXISTS (
            SELECT 1 FROM json_each(s.question_ids_json) old_question
            WHERE NOT EXISTS (
              SELECT 1 FROM submissions newer, json_each(newer.question_ids_json) new_question
              WHERE newer.thread_id = s.thread_id AND newer.rowid > s.rowid
                AND new_question.value = old_question.value
            )
          ))
        ) ORDER BY created_at DESC, rowid DESC`,
      )
      .all(threadId, limit);
    return rows.map(rowToSubmission);
  }

  /** Delivery succeeded: freeze the snapshot as the submitted answer. */
  settleDelivered(input: {
    threadId: string;
    submission: Submission;
    state: "sent" | "queued";
    settledAt: number;
  }): void {
    const settle = this.db.transaction(() => {
      this.db
        .prepare("UPDATE submissions SET state = ?, error = NULL, settled_at = ? WHERE id = ? AND thread_id = ?")
        .run(input.state, input.settledAt, input.submission.id, input.threadId);
      for (const questionId of input.submission.questionIds) {
        const answer = input.submission.snapshot[questionId];
        if (!answer) continue;
        this.db
          .prepare(
            `UPDATE answers SET submitted_json = ?, submitted_at = ?, submission_id = ?, updated_at = ?
             WHERE question_id = ? AND thread_id = ?`,
          )
          .run(
            JSON.stringify(answer),
            input.settledAt,
            input.submission.id,
            input.settledAt,
            questionId,
            input.threadId,
          );
      }
    });
    settle();
  }

  /** Delivery failed or is unknown: keep drafts, record the outcome. */
  settleUndelivered(input: {
    threadId: string;
    submissionId: string;
    state: "failed" | "uncertain";
    error: string;
    settledAt: number;
  }): void {
    this.db
      .prepare("UPDATE submissions SET state = ?, error = ?, settled_at = ? WHERE id = ? AND thread_id = ?")
      .run(input.state, input.error, input.settledAt, input.submissionId, input.threadId);
  }

  /**
   * A row still pending after a reload or crash has an unknown outcome. It
   * becomes uncertain so the user decides; it is never re-sent automatically.
   */
  markStalePendingUncertain(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE submissions SET state = 'uncertain', settled_at = ?,
           error = 'The server restarted before delivery was confirmed.'
         WHERE state = 'pending'`,
      )
      .run(now);
    return result.changes;
  }

  getSummary(threadId: string): Summary | null {
    const row = this.db
      .prepare<[string], { markdown: string; updated_at: number }>(
        "SELECT markdown, updated_at FROM summaries WHERE thread_id = ?",
      )
      .get(threadId);
    return row ? { markdown: row.markdown, updatedAt: row.updated_at } : null;
  }

  setSummary(threadId: string, markdown: string, now: number): Summary {
    this.db
      .prepare(
        `INSERT INTO summaries (thread_id, markdown, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
      )
      .run(threadId, markdown, now);
    return { markdown, updatedAt: now };
  }

  clearSummary(threadId: string): void {
    this.db.prepare("DELETE FROM summaries WHERE thread_id = ?").run(threadId);
  }

  /** Runs `work` in one SQLite transaction. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
}
