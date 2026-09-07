// Synchronous client store for one thread's controller. React reads it through
// a subscription; every mutation happens here so flush, submit, and upload
// see one consistent view instead of a React render in flight.
//
// Invariants:
// - A local edit remembers the server version it started from (baseVersion).
//   Saves send that version, so a change another client made in between is
//   reported as a conflict, never overwritten.
// - A conflict keeps the local text. The user resolves it (keep mine / use
//   saved); nothing is discarded silently.
// - Transport failures back off (1s → 30s) and never drop the edit. Backups
//   in browser storage survive close and reload; the footer says when the
//   browser has no storage.
import {
  type Answer,
  type AnswerState,
  type Round,
  type Submission,
  type ThreadState,
  answerSchema,
  answerStatus,
  emptyAnswer,
  pendingQuestionIds,
  questionLabels,
} from "./model";

/**
 * Combine two copies of one answer: the higher draft version wins the draft,
 * the newer submission wins the submitted fields. Neither can roll back.
 */
function mergeAnswerStates(known: AnswerState | undefined, incoming: AnswerState): AnswerState {
  if (!known) return incoming;
  const draftSide = incoming.version >= known.version ? incoming : known;
  const submittedSide = (incoming.submittedAt ?? -1) >= (known.submittedAt ?? -1) ? incoming : known;
  return {
    questionId: incoming.questionId,
    roundId: draftSide.roundId || known.roundId,
    draft: draftSide.draft,
    version: draftSide.version,
    submitted: submittedSide.submitted,
    submittedAt: submittedSide.submittedAt,
    submissionId: submittedSide.submissionId,
  };
}

/** Byte-exact comparison: drafts keep whitespace, so no normalization here. */
function sameDraft(a: Answer | null | undefined, b: Answer | null | undefined): boolean {
  // Local input can exceed schema limits before the server rejects a save.
  // Sort object keys without validating or changing any answer content.
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    }
    return value;
  };
  return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
}

export type SaveResponse =
  | { outcome: "saved"; state: AnswerState }
  | { outcome: "conflict"; state: AnswerState };

export interface DraftTransport {
  loadState(): Promise<ThreadState>;
  saveDraft(questionId: string, draft: Answer, expectedVersion: number): Promise<SaveResponse>;
}

export interface LocalEdit {
  answer: Answer;
  baseVersion: number;
  /** The server copy that was newer than baseVersion; set until resolved. */
  conflict: AnswerState | null;
}

export interface Backup {
  answer: Answer;
  baseVersion: number;
}

export interface BackupStorage {
  read(threadId: string): Map<string, Backup>;
  write(threadId: string, questionId: string, backup: Backup): boolean;
  remove(threadId: string, questionId: string): void;
}

export type SaveOutcome = "saved" | "conflict" | "failed" | "skipped";

export interface Notice {
  id: number;
  text: string;
}

export interface DraftStoreOptions {
  threadId: string;
  transport: DraftTransport;
  backups: BackupStorage | null;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const MAX_BACKOFF_MS = 30_000;

export class DraftStore {
  private flushing: Promise<void> | null = null;
  readonly threadId: string;
  private readonly transport: DraftTransport;
  private readonly backups: BackupStorage | null;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private server: ThreadState | null = null;
  private loadError: string | null = null;
  private readonly local = new Map<string, LocalEdit>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  private readonly heldSaves = new Set<string>();
  private readonly inFlight = new Map<string, Promise<SaveOutcome>>();
  private readonly listeners = new Set<() => void>();
  private failures = 0;
  private disposed = false;
  private loading = false;
  private reloadPending = false;
  private loadSeq = 0;
  private noticeSeq = 0;
  private notices: Notice[] = [];
  private version = 0;
  /** Backups read before the server state arrived; reconciled on load. */
  private pendingBackups: Map<string, Backup> | null = null;
  private backupUnavailable = false;

  constructor(options: DraftStoreOptions) {
    this.threadId = options.threadId;
    this.transport = options.transport;
    this.backups = options.backups;
    this.debounceMs = options.debounceMs ?? 450;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (this.backups) {
      try {
        this.pendingBackups = this.backups.read(this.threadId);
      } catch {
        this.pendingBackups = null;
        this.backupUnavailable = true;
      }
    } else {
      this.backupUnavailable = true;
    }
  }

  // ----- subscription -----

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Monotonic change counter for useSyncExternalStore. */
  snapshot(): number {
    return this.version;
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // ----- reads -----

  get status(): "loading" | "ready" | "error" {
    if (this.server) return "ready";
    return this.loadError === null ? "loading" : "error";
  }

  get error(): string | null {
    return this.loadError;
  }

  get rounds(): Round[] {
    return this.server?.rounds ?? [];
  }

  get submissions(): Submission[] {
    return this.server?.submissions ?? [];
  }

  get summary(): ThreadState["summary"] {
    return this.server?.summary ?? null;
  }

  get labels(): Map<string, string> {
    return questionLabels(this.rounds);
  }

  get saving(): boolean {
    return this.inFlight.size > 0;
  }

  get draftStatus(): "loading" | "saving" | "saved" | "unsaved" | "conflict" {
    if ([...this.local.values()].some((edit) => edit.conflict !== null)) return "conflict";
    if (this.loadError || (this.failures > 0 && this.local.size > 0)) return "unsaved";
    if (!this.server) return "loading";
    if (this.local.size > 0 || this.inFlight.size > 0) return "saving";
    return "saved";
  }

  get backupMode(): "browser" | "none" {
    return this.backupUnavailable ? "none" : "browser";
  }

  get currentNotices(): Notice[] {
    return this.notices;
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.emit();
  }

  serverAnswer(questionId: string): AnswerState | undefined {
    return this.server?.answers.find((item) => item.questionId === questionId);
  }

  localEdit(questionId: string): LocalEdit | undefined {
    return this.local.get(questionId);
  }

  draftOf(questionId: string): Answer {
    return this.local.get(questionId)?.answer ?? this.serverAnswer(questionId)?.draft ?? emptyAnswer();
  }

  /** Server state with local edits layered on top. */
  effectiveState(questionId: string): AnswerState | undefined {
    const server = this.serverAnswer(questionId);
    const edit = this.local.get(questionId);
    if (!edit) return server;
    const round = this.rounds.find((item) => item.questions.some((question) => question.id === questionId));
    return {
      questionId,
      roundId: server?.roundId ?? round?.id ?? "",
      draft: edit.answer,
      version: server?.version ?? 0,
      submitted: server?.submitted ?? null,
      submittedAt: server?.submittedAt ?? null,
      submissionId: server?.submissionId ?? null,
    };
  }

  statusOf(questionId: string): "empty" | "draft" | "done" {
    return answerStatus(this.effectiveState(questionId));
  }

  pendingIds(): string[] {
    const map = new Map<string, AnswerState>();
    for (const round of this.rounds) {
      for (const question of round.questions) {
        const state = this.effectiveState(question.id);
        if (state) map.set(question.id, state);
      }
    }
    return pendingQuestionIds(this.rounds, map);
  }

  /** Question ids whose local edit is unresolved (conflict or unsaved). */
  unresolvedIds(): string[] {
    return [...this.local.keys()];
  }

  conflicts(): string[] {
    return [...this.local.entries()].filter(([, edit]) => edit.conflict !== null).map(([id]) => id);
  }

  // ----- loading -----

  async load(): Promise<void> {
    if (this.loading) {
      this.reloadPending = true;
      return;
    }
    this.loading = true;
    const seq = (this.loadSeq += 1);
    try {
      const state = await this.transport.loadState();
      if (this.disposed || seq !== this.loadSeq) return;
      this.applyServerState(state);
      this.loadError = null;
    } catch (cause) {
      if (this.disposed || seq !== this.loadSeq) return;
      this.loadError = messageOf(cause);
    } finally {
      if (seq === this.loadSeq) this.loading = false;
      this.emit();
      if (this.reloadPending && !this.disposed) {
        this.reloadPending = false;
        void this.load();
      }
    }
  }

  private applyServerState(state: ThreadState): void {
    // A delayed load must not roll back an answer a save already advanced.
    const previous = this.server;
    const answers = state.answers.map((incoming) =>
      mergeAnswerStates(previous?.answers.find((item) => item.questionId === incoming.questionId), incoming),
    );
    for (const known of previous?.answers ?? []) {
      if (!answers.some((item) => item.questionId === known.questionId)) answers.push(known);
    }
    this.server = { ...state, answers };
    if (this.pendingBackups) {
      const backups = this.pendingBackups;
      this.pendingBackups = null;
      for (const [questionId, backup] of backups) this.restoreBackup(questionId, backup);
    }
    for (const [questionId, edit] of this.local) {
      if (edit.conflict !== null || this.inFlight.has(questionId) || this.heldSaves.has(questionId)) continue;
      const server = this.serverAnswer(questionId);
      const serverVersion = server?.version ?? 0;
      if (serverVersion > edit.baseVersion && server) {
        if (sameDraft(server.draft, edit.answer)) {
          this.local.delete(questionId);
          this.dirty.delete(questionId);
          this.cancelTimer(questionId);
          this.backups?.remove(this.threadId, questionId);
        } else {
          edit.conflict = server;
          this.cancelTimer(questionId);
          this.notify(`${this.labelOf(questionId)} was changed in another window. Choose which version to keep.`);
        }
      }
    }
  }

  private restoreBackup(questionId: string, backup: Backup): void {
    const known = this.rounds.some((round) => round.questions.some((question) => question.id === questionId));
    if (!known) {
      this.backups?.remove(this.threadId, questionId);
      return;
    }
    const server = this.serverAnswer(questionId);
    const serverVersion = server?.version ?? 0;
    if (sameDraft(server?.draft ?? null, backup.answer) || this.local.has(questionId)) {
      this.backups?.remove(this.threadId, questionId);
      return;
    }
    if (serverVersion === backup.baseVersion) {
      this.local.set(questionId, { answer: backup.answer, baseVersion: backup.baseVersion, conflict: null });
      this.dirty.add(questionId);
      this.scheduleSave(questionId);
      return;
    }
    this.local.set(questionId, {
      answer: backup.answer,
      baseVersion: backup.baseVersion,
      conflict: server ?? { questionId, roundId: "", draft: null, version: serverVersion, submitted: null, submittedAt: null, submissionId: null },
    });
    this.notify(`${this.labelOf(questionId)} has an unsaved edit from an earlier session that no longer matches the saved answer. Choose which version to keep.`);
  }

  // ----- edits -----

  edit(questionId: string, updater: (current: Answer) => Answer): void {
    if (this.disposed) return;
    const existing = this.local.get(questionId);
    const base = existing?.answer ?? this.serverAnswer(questionId)?.draft ?? emptyAnswer();
    const next: LocalEdit = existing
      ? { ...existing, answer: updater(base) }
      : { answer: updater(base), baseVersion: this.serverAnswer(questionId)?.version ?? 0, conflict: null };
    this.local.set(questionId, next);
    this.dirty.add(questionId);
    this.writeBackup(questionId, next);
    if (next.conflict === null) this.scheduleSave(questionId);
    this.emit();
  }

  clear(questionId: string): void {
    this.edit(questionId, () => emptyAnswer());
  }

  resolveConflict(questionId: string, choice: "mine" | "saved"): void {
    const edit = this.local.get(questionId);
    if (!edit || edit.conflict === null) return;
    if (choice === "mine") {
      edit.baseVersion = edit.conflict.version;
      edit.conflict = null;
      this.dirty.add(questionId);
      this.writeBackup(questionId, edit);
      this.scheduleSave(questionId);
    } else {
      this.replaceServerAnswer(edit.conflict);
      this.local.delete(questionId);
      this.dirty.delete(questionId);
      this.backups?.remove(this.threadId, questionId);
    }
    this.emit();
  }

  private writeBackup(questionId: string, edit: LocalEdit): void {
    if (!this.backups) return;
    const ok = this.backups.write(this.threadId, questionId, { answer: edit.answer, baseVersion: edit.baseVersion });
    if (!ok && !this.backupUnavailable) {
      this.backupUnavailable = true;
    }
  }

  private labelOf(questionId: string): string {
    return this.labels.get(questionId) ?? "An answer";
  }

  private notify(text: string): void {
    this.noticeSeq += 1;
    this.notices = [...this.notices, { id: this.noticeSeq, text }];
  }

  // ----- saving -----

  private cancelTimer(questionId: string): void {
    const timer = this.timers.get(questionId);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.timers.delete(questionId);
    }
  }

  private scheduleSave(questionId: string, delay = this.debounceMs): void {
    this.cancelTimer(questionId);
    if (this.heldSaves.has(questionId)) return;
    const handle = this.setTimer(() => {
      this.timers.delete(questionId);
      void this.save(questionId);
    }, delay);
    this.timers.set(questionId, handle);
  }

  /** Keep edits local while an upload owns this answer's saved version. */
  holdSaves(questionId: string): () => void {
    this.heldSaves.add(questionId);
    this.cancelTimer(questionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.heldSaves.delete(questionId);
      if (this.local.get(questionId)?.conflict === null) {
        if (this.disposed) void this.save(questionId);
        else this.scheduleSave(questionId, 0);
      }
    };
  }

  /** Save one question's local edit now; resolves when the attempt settles. */
  save(questionId: string): Promise<SaveOutcome> {
    if (this.heldSaves.has(questionId)) return Promise.resolve("skipped");
    const existing = this.inFlight.get(questionId);
    if (existing) return existing;
    const edit = this.local.get(questionId);
    if (!edit) return Promise.resolve("skipped");
    if (edit.conflict !== null) return Promise.resolve("conflict");
    this.cancelTimer(questionId);
    this.dirty.delete(questionId);
    const sent = edit.answer;
    const baseVersion = edit.baseVersion;
    const run = this.transport
      .saveDraft(questionId, sent, baseVersion)
      .then((result): SaveOutcome => {
        this.failures = 0;
        const current = this.local.get(questionId);
        if (result.outcome === "saved") {
          this.replaceServerAnswer(result.state);
          if (current && this.dirty.has(questionId)) {
            current.baseVersion = result.state.version;
            this.writeBackup(questionId, current);
            if (!this.disposed) this.scheduleSave(questionId);
          } else {
            this.local.delete(questionId);
            this.backups?.remove(this.threadId, questionId);
          }
          return "saved";
        }
        if (current && sameDraft(result.state.draft, current.answer)) {
          this.replaceServerAnswer(result.state);
          this.local.delete(questionId);
          this.dirty.delete(questionId);
          this.cancelTimer(questionId);
          this.backups?.remove(this.threadId, questionId);
          return "saved";
        }
        if (current) {
          current.conflict = result.state;
          this.notify(`${this.labelOf(questionId)} was changed in another window. Choose which version to keep.`);
        }
        return "conflict";
      })
      .catch((cause: unknown): SaveOutcome => {
        this.dirty.add(questionId);
        this.failures += 1;
        if (this.failures === 1) {
          this.notify(`Could not save a draft: ${messageOf(cause)}. It is kept here and will be retried.`);
        }
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures - 1, 5));
        if (!this.disposed) this.scheduleSave(questionId, delay);
        return "failed";
      })
      .finally(() => {
        this.inFlight.delete(questionId);
        this.emit();
      });
    this.inFlight.set(questionId, run);
    this.emit();
    return run;
  }

  /** Retry failed saves at once, e.g. when the connection returns. */
  retryNow(): void {
    this.failures = 0;
    for (const questionId of this.dirty) {
      if (!this.inFlight.has(questionId)) this.scheduleSave(questionId, 0);
    }
  }

  /**
   * Persist every local edit. Rejects when an edit could not be saved or a
   * conflict is unresolved, so callers never send stale drafts.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.flushPending().finally(() => { this.flushing = null; });
    this.flushing = run;
    return run;
  }

  private async flushPending(): Promise<void> {
    if (this.heldSaves.size > 0) throw new Error("Wait for the attachment upload to finish before submitting.");
    for (const questionId of [...this.timers.keys()]) this.cancelTimer(questionId);
    // Loop only for edits that arrived during a successful save; a failed
    // transport rejects at once and leaves the backoff timer in charge.
    let rounds = 0;
    while (rounds < 5) {
      rounds += 1;
      const ids = [...this.local.keys()].filter((id) => this.local.get(id)?.conflict === null);
      const outcomes = await Promise.all(ids.map((id) => this.inFlight.get(id) ?? this.save(id)));
      if (outcomes.includes("failed")) break;
      const remaining = [...this.local.keys()].filter((id) => this.dirty.has(id) && this.local.get(id)?.conflict === null);
      if (remaining.length === 0) break;
    }
    const conflicts = this.conflicts();
    if (conflicts.length > 0) {
      throw new Error(`${conflicts.map((id) => this.labelOf(id)).join(", ")} changed in another window. Resolve the conflict first.`);
    }
    const unsaved = [...this.local.keys()];
    if (unsaved.length > 0) {
      throw new Error(`${unsaved.map((id) => this.labelOf(id)).join(", ")} could not be saved to the server yet.`);
    }
  }

  /** Monotonic: an older reply never rolls back a newer draft or submission. */
  replaceServerAnswer(state: AnswerState): void {
    if (!this.server) return;
    const known = this.server.answers.find((item) => item.questionId === state.questionId);
    const merged = mergeAnswerStates(known, state);
    const others = this.server.answers.filter((item) => item.questionId !== state.questionId);
    this.server = { ...this.server, answers: [...others, merged] };
  }

  /**
   * After an upload changed the server draft, keep the newest local text and
   * adopt the server's attachment list on top of the new version.
   */
  mergeUploaded(state: AnswerState, beforePaths?: string[]): void {
    const previous = new Set(beforePaths ?? this.serverAnswer(state.questionId)?.draft?.attachments.map((item) => item.path) ?? []);
    this.replaceServerAnswer(state);
    const edit = this.local.get(state.questionId);
    if (edit && state.draft) {
      const kept = new Set(edit.answer.attachments.map((item) => item.path));
      const added = state.draft.attachments.filter((item) => !previous.has(item.path) && !kept.has(item.path));
      edit.answer = { ...edit.answer, attachments: [...edit.answer.attachments, ...added] };
      edit.baseVersion = state.version;
      this.dirty.add(state.questionId);
      this.writeBackup(state.questionId, edit);
      this.scheduleSave(state.questionId);
    }
    this.emit();
  }

  /** Reload from the server; local edits are reconciled, never dropped. */
  refresh(): void {
    void this.load();
  }

  /**
   * Cancel debounces and start saving what is still dirty; responses keep
   * landing in this store. Reversible through `activate` (React StrictMode
   * runs effect cleanup and setup twice).
   */
  dispose(): void {
    this.disposed = true;
    for (const questionId of [...this.timers.keys()]) {
      this.cancelTimer(questionId);
      if (this.local.get(questionId)?.conflict === null) void this.save(questionId);
    }
  }

  /** Resume after `dispose`; pending edits get their saves rescheduled. */
  activate(): void {
    if (!this.disposed) return;
    this.disposed = false;
    for (const questionId of this.dirty) {
      if (!this.inFlight.has(questionId) && this.local.get(questionId)?.conflict === null) this.scheduleSave(questionId, 0);
    }
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Browser localStorage backups; returns null when storage is unusable. */
export function createLocalStorageBackups(prefix = "bb-questions-draft:v1"): BackupStorage | null {
  let storage: Storage;
  try {
    storage = window.localStorage;
    const probe = `${prefix}:probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
  } catch {
    return null;
  }
  const keyOf = (threadId: string, questionId: string) => `${prefix}:${threadId}:${questionId}`;
  return {
    read(threadId) {
      const found = new Map<string, Backup>();
      const head = `${prefix}:${threadId}:`;
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith(head)) keys.push(key);
      }
      for (const key of keys) {
        try {
          const parsed = JSON.parse(storage.getItem(key) ?? "null") as { answer?: unknown; baseVersion?: unknown } | null;
          const answer = parsed ? answerSchema.safeParse(parsed.answer) : null;
          if (parsed && answer?.success && typeof parsed.baseVersion === "number" && Number.isInteger(parsed.baseVersion)) {
            found.set(key.slice(head.length), { answer: answer.data, baseVersion: parsed.baseVersion });
          } else {
            storage.removeItem(key);
          }
        } catch {
          storage.removeItem(key);
        }
      }
      return found;
    },
    write(threadId, questionId, backup) {
      try {
        storage.setItem(keyOf(threadId, questionId), JSON.stringify(backup));
        return true;
      } catch {
        return false;
      }
    },
    remove(threadId, questionId) {
      try {
        storage.removeItem(keyOf(threadId, questionId));
      } catch {
        // Nothing to do: the backup is best effort.
      }
    },
  };
}
