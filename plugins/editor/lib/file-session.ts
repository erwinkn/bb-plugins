/**
 * Shared file sessions.
 *
 * One session holds the editable buffer for one file, whatever view shows it:
 * the Files editor, a second editor pane, or the editable side of a diff. A
 * session owns the text, the text last known to be on disk, the save queue and
 * the durable draft. It knows nothing about the editor engine, so it is
 * testable without a browser.
 *
 * Rules the layer keeps:
 *  - Dirty state comes from the text, not from an editor version id. Undo back
 *    to the saved text makes the file clean again.
 *  - Writes are serialized per file and use `expectedSha256`. A conflict is
 *    reported, never resolved by the layer.
 *  - Text typed while a save or a read is in flight is newer than the result.
 *  - Ending an edit session is not a save. Only `save` and `overwrite` write.
 */
import type { FileSource } from "../server";

export type FileSessionSource = FileSource;
/** A source for a view that has no file yet; nothing resolves against it. */
export const NO_SOURCE: FileSessionSource = { kind: "workspace", threadId: null, environmentId: null, projectId: null };

export interface ReadText {
  kind: "text";
  content: string;
  sha256: string;
  absolutePath: string;
  relativePath: string;
}
export type ReadResult = ReadText | { kind: "unsupported"; reason: string };
export type WriteResult =
  | { outcome: "written"; sha256: string }
  | { outcome: "conflict"; currentSha256: string | null };

/** The file transport, shaped like the plugin's `read` and `write` RPC. */
export interface FileSessionIo {
  read(input: { path: string; source: FileSessionSource }): Promise<ReadResult>;
  write(input: {
    path: string;
    source: FileSessionSource;
    content: string;
    expectedSha256: string | null;
  }): Promise<WriteResult>;
}

/** Content and hash a caller already read, used instead of a first read. */
export type SessionSeed = Omit<ReadText, "kind">;

export type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

export type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; currentSha256: string | null };

export type DraftState =
  | { kind: "none" }
  /** A draft of this file's saved state was found and applied. */
  | { kind: "restored" }
  /** A draft was found, but the file changed since it was written. */
  | { kind: "stale" }
  /** The edits cannot be kept for a later session. */
  | { kind: "unstored"; reason: string };

export interface FileSessionSnapshot {
  readonly key: string;
  readonly path: string;
  readonly source: FileSessionSource;
  readonly load: LoadState;
  readonly save: SaveState;
  /** The text on screen. Empty until the first read lands. */
  readonly content: string;
  /** The text last known to be on disk. */
  readonly savedContent: string;
  /** How the saved text and hash were obtained. Writes do not replace the editor. */
  readonly savedContentSource: "read" | "write";
  readonly sha256: string | null;
  readonly absolutePath: string;
  readonly relativePath: string;
  /** Unsaved work: edits, or a save whose outcome is not settled. */
  readonly dirty: boolean;
  /** The text differs from the saved text. */
  readonly hasEdits: boolean;
  /** Rises on each replacement of the text from outside the editing view. */
  readonly epoch: number;
  /** The view that caused the epoch; null for a read, a reload or a draft. */
  readonly epochAuthor: string | null;
  /** The one attached view that may edit. Others are read-only mirrors. */
  readonly editorId: string | null;
  readonly draft: DraftState;
  /** The file changed on disk while this session held unsaved edits. */
  readonly staleBase: boolean;
}

export type ReloadOutcome =
  | { ok: true }
  | { ok: false; reason: "changed-while-reading" | "unsupported" | "error"; message: string };

export interface FileSession {
  readonly key: string;
  readonly path: string;
  readonly source: FileSessionSource;
  /** True once the registry dropped this session. Acquire it again. */
  readonly disposed: boolean;
  getSnapshot(): FileSessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Point the session at a newer transport. A later view may hold one. */
  setIo(io: FileSessionIo): void;
  /** Register a view. The first attach starts the read. Call the result to detach. */
  attach(viewId: string): () => void;
  /** Make `viewId` the editing view. Call it when the view takes focus. */
  claimEditor(viewId: string): void;
  /** Report edited text from a view. */
  setContent(text: string, viewId: string): void;
  /** Serialize a confirmed file action with saves; keep any later typing. */
  mutateFile(expected: { content: string; sha256: string | null }, action: () => Promise<SessionSeed | null>): Promise<void>;
  /** Install a caller's read. It is ignored when the session has edits or a draft. */
  seed(seed: SessionSeed): void;
  /** Write with `expectedSha256`. Resolves true when the text reached disk. */
  save(): Promise<boolean>;
  /** Save now: cancels a pending auto save and writes if the file is dirty. */
  flush(): Promise<boolean>;
  /** Read the file as it is on disk now, without touching the buffer. */
  readDisk(): Promise<ReadResult | null>;
  /** Write without a hash check, after a reported conflict. */
  overwrite(): Promise<boolean>;
  /** Take the file from disk, dropping any edits. Refuses when the text changed while reading. */
  reload(): Promise<ReloadOutcome>;
  /** Apply a draft that the load kept back. */
  restoreDraft(): void;
  /** Forget the draft, and the edits when they came from it. */
  discardDraft(): void;
  /** Read the file again to find a change made outside the editor. */
  refresh(): Promise<boolean>;
  /** Write a pending draft to the store now. */
  flushDraft(): void;
}

export interface StoredDraft {
  content: string;
  /** The hash of the file when the draft was made. */
  baseSha256: string | null;
  savedAt: number;
}

export interface DraftStore {
  read(key: string): StoredDraft | null;
  write(key: string, draft: StoredDraft): void;
  remove(key: string): void;
}

// ---------------------------------------------------------------------------
// Plugin-wide session configuration and logging
// ---------------------------------------------------------------------------

export interface SessionLogFields {
  [key: string]: string | number | boolean | null | undefined;
}

/** One structured save-lifecycle event. Wired to the plugin log by the app. */
export type SessionLogger = (event: string, fields: SessionLogFields) => void;

let sessionLogger: SessionLogger | null = null;

/** The app installs this once; tests may install their own. */
export function setSessionLogger(logger: SessionLogger | null): void {
  sessionLogger = logger;
}

export interface SessionConfig {
  /**
   * "afterDelay" writes a dirty buffer shortly after the last keystroke, from
   * the session itself, so the timer survives its views. "off" leaves saving
   * to explicit actions and to lifecycle flushes.
   */
  autoSave: "off" | "afterDelay";
  autoSaveDelayMs: number;
  /** A failed write retries with backoff instead of waiting for the user. */
  retryFailedSaves: boolean;
}

const sessionConfig: SessionConfig = { autoSave: "off", autoSaveDelayMs: 400, retryFailedSaves: true };

/** The app applies the autoSave preference here; the pane owns no timer. */
export function configureFileSessions(next: Partial<SessionConfig>): void {
  Object.assign(sessionConfig, next);
}

/** Backoff for a failed write: 1 s, 2 s, 5 s, then every 15 s. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000] as const;

const DRAFT_PREFIX = "editor:draft:v1:";
const DRAFT_DEBOUNCE_MS = 400;
/** Bigger buffers are not kept for a later session; the store cannot hold them. */
const MAX_DRAFT_CHARS = 1_000_000;
/** Detached, clean sessions kept so a file reopens without a read. */
const MAX_IDLE_SESSIONS = 24;

/** The part of a session key that names the source, for grouping sessions by it. */
export function sourceKeyFor(source: FileSessionSource): string {
  return sessionKeyFor(source, "");
}

/**
 * A file's identity.
 *
 * It leaves out fields that name the caller rather than the file: the Files
 * panel resolves a source with a `threadId` and BB's file opener does not, and
 * both must reach the same session for the same file. An environment id is
 * unique across hosts, so a source that also names the host gives the same key
 * as one that does not. A project without an environment can have a checkout on
 * more than one host, so that key keeps the host.
 */
export function sessionKeyFor(source: FileSessionSource, path: string): string {
  const file = normalizePath(path);
  const host = source.experimental_hostId ?? "";
  switch (source.kind) {
    case "workspace":
      return source.environmentId !== null
        ? `workspace|env:${source.environmentId}|${file}`
        : `workspace|project:${source.projectId ?? ""}|host:${host}|${file}`;
    case "host":
      // A host source names its host, or the environment that resolved it.
      return `host|${source.experimental_hostId ?? source.environmentId ?? ""}|${file}`;
    case "thread-storage":
      return `thread-storage|${source.threadId ?? ""}|${file}`;
  }
}

/**
 * The path as the server sees it. A backslash is kept: it is a legal character
 * in a POSIX file name, and the server treats it literally, so replacing it
 * could join two different files into one session. `.` segments and interior
 * `..` pairs resolve lexically — `a/./b` and `a/../b` are the same file on
 * disk, so they must be the same session and the same draft. Leading `..`
 * segments stay: they escape any root the path is relative to.
 */
export function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  const trimmed = collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
  if (!/(^|\/)\.\.?($|\/)/.test(trimmed)) return trimmed;
  const out: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== ".." && last !== "") out.pop();
      else if (!trimmed.startsWith("/")) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  return trimmed.startsWith("/") && joined === "" ? "/" : joined;
}

export function memoryDraftStore(): DraftStore {
  const entries = new Map<string, StoredDraft>();
  return {
    read: (key) => entries.get(key) ?? null,
    write: (key, draft) => {
      entries.set(key, draft);
    },
    remove: (key) => {
      entries.delete(key);
    },
  };
}

/** Drafts in `localStorage`; they survive a reload of the BB window. */
function localDraftStore(): DraftStore {
  return {
    read(key) {
      try {
        const raw = localStorage.getItem(DRAFT_PREFIX + key);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { content, baseSha256, savedAt } = parsed as Partial<StoredDraft>;
        if (typeof content !== "string") return null;
        return {
          content,
          baseSha256: typeof baseSha256 === "string" ? baseSha256 : null,
          savedAt: typeof savedAt === "number" ? savedAt : 0,
        };
      } catch {
        return null;
      }
    },
    write(key, draft) {
      localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(draft));
    },
    remove(key) {
      try {
        localStorage.removeItem(DRAFT_PREFIX + key);
      } catch {
        // A store that cannot forget a draft is not worth an error.
      }
    },
  };
}

const NO_STORE_REASON = "This file is too large to keep unsaved changes for a later session.";

class Session implements FileSession {
  readonly key: string;
  readonly path: string;
  readonly source: FileSessionSource;
  private io: FileSessionIo;
  private readonly drafts: DraftStore;
  private readonly listeners = new Set<() => void>();
  private readonly onChanged: (session: Session) => void;
  private readonly views: string[] = [];
  private snapshot: FileSessionSnapshot;
  /** Rises on every text change; guards results of older reads and writes. */
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingSeed: SessionSeed | null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private draftPending = false;
  /** A scheduled auto save; owned by the session so unmounting a view keeps it. */
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A scheduled retry of a failed write. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /** Lets a write queued by `dispose` run after the session is marked disposed. */
  private allowDisposedWrite = false;
  /** The disk version the current draft was based on, even after restoration. */
  private draftBaseSha256: string | null = null;
  private loading = false;
  disposed = false;
  /** Rises each time the session is detached; the registry evicts by it. */
  idleAt = 0;

  constructor(options: {
    key: string;
    path: string;
    source: FileSessionSource;
    io: FileSessionIo;
    drafts: DraftStore;
    seed: SessionSeed | null;
    onChanged: (session: Session) => void;
  }) {
    this.key = options.key;
    this.path = options.path;
    this.source = options.source;
    this.io = options.io;
    this.drafts = options.drafts;
    this.pendingSeed = options.seed;
    this.onChanged = options.onChanged;
    this.snapshot = {
      key: this.key,
      path: this.path,
      source: this.source,
      load: { kind: "idle" },
      save: { kind: "clean" },
      content: "",
      savedContent: "",
      savedContentSource: "read",
      sha256: null,
      absolutePath: "",
      relativePath: this.path,
      dirty: false,
      hasEdits: false,
      epoch: 0,
      epochAuthor: null,
      editorId: null,
      draft: { kind: "none" },
      staleBase: false,
    };
  }

  /** A later view may hold a fresher transport; the newest one wins. */
  setIo(io: FileSessionIo): void {
    this.io = io;
  }

  getSnapshot(): FileSessionSnapshot {
    return this.snapshot;
  }

  /** A save-lifecycle event for the plugin log: never carries file content. */
  private log(event: string, extra: SessionLogFields = {}): void {
    sessionLogger?.(event, {
      path: this.snapshot.relativePath || this.path,
      host: this.source.experimental_hostId ?? null,
      sourceKind: this.source.kind,
      revision: this.version,
      ...extra,
    });
  }

  /**
   * Timers follow the save state. A dirty, idle file gets the auto-save
   * pause; any other state cancels it. A failed write keeps its retry until
   * the save leaves the error state, and a clean file resets the backoff.
   */
  private syncTimers(): void {
    if (this.disposed) return;
    const kind = this.snapshot.save.kind;
    if (this.autoSaveTimer !== null && kind !== "dirty") {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.retryTimer !== null && kind !== "error") {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (kind === "clean") this.retryAttempt = 0;
    if (sessionConfig.autoSave === "afterDelay" && kind === "dirty" && this.autoSaveTimer === null) {
      this.log("save-scheduled", { delayMs: sessionConfig.autoSaveDelayMs });
      this.autoSaveTimer = setTimeout(() => {
        this.autoSaveTimer = null;
        if (this.snapshot.save.kind !== "dirty") return;
        void this.save();
      }, sessionConfig.autoSaveDelayMs);
    }
  }

  /** After a failed write: retry with backoff while the error stands. */
  private scheduleRetry(): void {
    if (!sessionConfig.retryFailedSaves || this.disposed || this.retryTimer !== null) return;
    const delayMs = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000;
    this.retryAttempt += 1;
    this.log("save-retry", { attempt: this.retryAttempt, delayMs });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.snapshot.save.kind !== "error") return;
      void this.save();
    }, delayMs);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get viewCount(): number {
    return this.views.length;
  }

  attach(viewId: string): () => void {
    if (!this.views.includes(viewId)) this.views.push(viewId);
    if (this.snapshot.editorId === null) this.patch({ editorId: viewId });
    else this.emit();
    void this.ensureLoaded();
    return () => this.detach(viewId);
  }

  private detach(viewId: string): void {
    const index = this.views.indexOf(viewId);
    if (index !== -1) this.views.splice(index, 1);
    this.flushDraft();
    if (this.snapshot.editorId === viewId) {
      this.patch({ editorId: this.views[this.views.length - 1] ?? null });
    } else {
      this.emit();
    }
  }

  claimEditor(viewId: string): void {
    if (this.snapshot.editorId === viewId) return;
    if (!this.views.includes(viewId)) this.views.push(viewId);
    this.patch({ editorId: viewId });
  }

  /**
   * Report edited text. Only the editing view may write. A mirror is rendered
   * read-only, so it has no keystrokes to lose, and a refusal here stops a
   * closing mirror from putting its older text over the editing view's newer
   * text when Pierre ends its session.
   */
  setContent(text: string, viewId: string): void {
    if (this.disposed || text === this.snapshot.content || this.snapshot.draft.kind === "stale") return;
    if (this.snapshot.editorId !== null && this.snapshot.editorId !== viewId) return;
    this.version += 1;
    const hasEdits = text !== this.snapshot.savedContent;
    const save = this.snapshot.save;
    // A save in flight settles itself; a conflict stays until the user decides.
    const nextSave: SaveState =
      save.kind === "saving" || save.kind === "conflict" ? save : hasEdits ? { kind: "dirty" } : { kind: "clean" };
    this.patch({
      content: text,
      save: nextSave,
      // The editing view already holds this text; only other views re-seed.
      epoch: this.snapshot.epoch + 1,
      epochAuthor: viewId,
      draft: { kind: "none" },
    });
    if (hasEdits) this.persistDraftSoon();
    else this.clearDraft();
  }

  seed(seed: SessionSeed): void {
    if (this.disposed) return;
    if (this.snapshot.load.kind === "idle") {
      this.pendingSeed = seed;
      void this.ensureLoaded();
      return;
    }
    if (this.snapshot.dirty || this.snapshot.draft.kind !== "none") {
      // Never replace unsaved work. Report a moved base instead.
      if (seed.sha256 !== this.snapshot.sha256) this.patch({ staleBase: true });
      return;
    }
    if (this.snapshot.load.kind === "ready" && seed.sha256 === this.snapshot.sha256 && seed.content === this.snapshot.content) return;
    this.installDisk({ kind: "text", ...seed }, { applyDraft: this.snapshot.load.kind !== "ready" });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.disposed || this.loading) return;
    if (this.snapshot.load.kind !== "idle" && this.snapshot.load.kind !== "error") return;
    const seed = this.pendingSeed;
    if (seed !== null) {
      this.pendingSeed = null;
      this.installDisk({ kind: "text", ...seed }, { applyDraft: true });
      return;
    }
    this.loading = true;
    this.patch({ load: { kind: "loading" } });
    const version = this.version;
    try {
      const result = await this.io.read({ path: this.path, source: this.source });
      if (this.disposed) return;
      // A seed or another read landed first; its text is the newer one.
      if (this.version !== version) return;
      if (result.kind === "unsupported") {
        this.patch({ load: { kind: "unsupported", reason: result.reason } });
        return;
      }
      this.installDisk(result, { applyDraft: true });
    } catch (error) {
      if (this.disposed || this.version !== version) return;
      this.patch({ load: { kind: "error", message: messageOf(error, "Could not open this file") } });
    } finally {
      this.loading = false;
    }
  }

  /**
   * Install the file as it is on disk. On the first load a draft of the same
   * disk state replaces the text; a draft of another state is kept back for
   * the user to restore or discard.
   */
  private installDisk(read: ReadText, options: { applyDraft: boolean }): void {
    const draft = options.applyDraft ? this.drafts.read(this.key) : null;
    let content = read.content;
    let draftState: DraftState = { kind: "none" };
    if (draft !== null && draft.content !== read.content) {
      if (draft.baseSha256 === read.sha256) {
        content = draft.content;
        draftState = { kind: "restored" };
      } else {
        draftState = { kind: "stale" };
      }
      this.log(draftState.kind === "restored" ? "draft-restored" : "draft-stale");
    } else if (draft !== null) {
      this.drafts.remove(this.key);
    }
    this.draftBaseSha256 = read.sha256;
    this.version += 1;
    const hasEdits = content !== read.content;
    this.patch({
      load: { kind: "ready" },
      save: hasEdits ? { kind: "dirty" } : { kind: "clean" },
      content,
      savedContent: read.content,
      savedContentSource: "read",
      sha256: read.sha256,
      absolutePath: read.absolutePath,
      relativePath: read.relativePath,
      epoch: this.snapshot.epoch + 1,
      epochAuthor: null,
      draft: draftState,
      staleBase: false,
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  mutateFile(expected: { content: string; sha256: string | null }, action: () => Promise<SessionSeed | null>): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || this.snapshot.content !== expected.content || this.snapshot.sha256 !== expected.sha256) {
        throw new Error("The file changed. Try the action again.");
      }
      if (this.snapshot.draft.kind === "stale") throw new Error("Restore or discard the earlier draft before editing");
      if (this.snapshot.save.kind === "conflict" || this.snapshot.staleBase) throw new Error("Resolve the file conflict first");
      const version = this.version;
      const result = await action();
      if (result === null) {
        const changed = this.version !== version;
        this.version += 1;
        this.patch({ load: { kind: "unsupported", reason: "This file was deleted. Reopen it after restoring it." },
          save: { kind: "clean" }, savedContent: changed ? "" : this.snapshot.content,
          sha256: null, staleBase: false });
        if (changed) this.flushDraft();
        else this.clearDraft();
      } else if (this.version === version) {
        this.clearDraft();
        this.installDisk({ kind: "text", ...result }, { applyDraft: false });
      } else {
        // Do not discard typing made while the remote action was in flight.
        this.draftBaseSha256 = result.sha256;
        this.patch({ savedContent: result.content, sha256: result.sha256, savedContentSource: "write", save: { kind: "dirty" } });
        this.persistDraftSoon();
      }
    });
  }

  save(): Promise<boolean> {
    return this.write(false);
  }

  flush(): Promise<boolean> {
    if (this.autoSaveTimer !== null) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    return this.save();
  }

  readDisk(): Promise<ReadResult | null> {
    return this.enqueue(async () => {
      try {
        return await this.io.read({ path: this.path, source: this.source });
      } catch {
        return null;
      }
    });
  }

  overwrite(): Promise<boolean> {
    return this.write(true);
  }

  private write(force: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      if ((this.disposed && !this.allowDisposedWrite) || this.snapshot.load.kind !== "ready" || this.snapshot.draft.kind === "stale") return false;
      // A reported conflict waits for the user: reload, or an explicit
      // overwrite. Auto save must not settle it on its own.
      if (!force && (this.snapshot.save.kind === "conflict" || this.draftBaseSha256 !== this.snapshot.sha256)) {
        if (this.snapshot.save.kind !== "conflict") {
          this.patch({ save: { kind: "conflict", currentSha256: this.snapshot.sha256 }, staleBase: true });
          this.log("save-conflict", { during: "precheck" });
        }
        return false;
      }
      if (!force && !this.snapshot.hasEdits && this.snapshot.save.kind !== "error") {
        if (this.snapshot.save.kind === "dirty") this.patch({ save: { kind: "clean" } });
        return this.snapshot.save.kind !== "conflict";
      }
      const version = this.version;
      const content = this.snapshot.content;
      const previousSave = this.snapshot.save;
      this.log("save-started", { force });
      this.patch({ save: { kind: "saving" } });
      try {
        const result = await this.io.write({
          path: this.path,
          source: this.source,
          content,
          expectedSha256: force ? null : this.snapshot.sha256,
        });
        if (this.disposed) return false;
        if (result.outcome === "conflict") {
          this.patch({ save: { kind: "conflict", currentSha256: result.currentSha256 }, staleBase: true });
          this.log("save-conflict", { currentSha256: result.currentSha256 });
          return false;
        }
        // Text typed during the write is newer than what reached disk.
        const stillDirty = this.version !== version;
        this.draftBaseSha256 = result.sha256;
        this.retryAttempt = 0;
        this.patch({
          savedContent: content,
          savedContentSource: "write",
          sha256: result.sha256,
          save: stillDirty ? { kind: "dirty" } : { kind: "clean" },
          draft: stillDirty ? this.snapshot.draft : { kind: "none" },
          staleBase: false,
        });
        this.log("save-succeeded", { stillDirty });
        if (stillDirty) this.persistDraftSoon();
        else this.clearDraft();
        return true;
      } catch (error) {
        if (!this.disposed) {
          this.log("save-error", { message: messageOf(error, "Save failed") });
          this.patch({ save: previousSave.kind === "conflict" ? previousSave : { kind: "error", message: messageOf(error, "Save failed") } });
          this.scheduleRetry();
        }
        return false;
      }
    });
  }

  /**
   * Read the file again and take its contents, dropping local edits and the
   * draft. It refuses when the text changed while the read ran, even when the
   * user asked to discard: those keystrokes are newer than the read, and the
   * user can ask again.
   */
  reload(): Promise<ReloadOutcome> {
    return this.enqueue(async () => {
      if (this.disposed) return { ok: false, reason: "error", message: "The file is closed" } as const;
      const version = this.version;
      try {
        const result = await this.io.read({ path: this.path, source: this.source });
        if (this.disposed) return { ok: false, reason: "error", message: "The file is closed" } as const;
        if (result.kind === "unsupported") {
          this.patch({ load: { kind: "unsupported", reason: result.reason } });
          return { ok: false, reason: "unsupported", message: result.reason } as const;
        }
        // Text typed while the read ran is newer than the text it returned.
        if (this.version !== version) {
          return {
            ok: false,
            reason: "changed-while-reading",
            message: "The file changed while reloading; reload again to replace it",
          } as const;
        }
        this.drafts.remove(this.key);
        this.installDisk(result, { applyDraft: false });
        return { ok: true } as const;
      } catch (error) {
        const message = messageOf(error, "Reload failed");
        if (!this.disposed && this.snapshot.save.kind !== "conflict") this.patch({ save: { kind: "error", message } });
        return { ok: false, reason: "error", message } as const;
      }
    });
  }

  /**
   * Look for a change made outside the editor, for example by an agent.
   *
   * A clean file takes the new contents. A file with unsaved work keeps its
   * text and only reports `staleBase`, so a save still meets the hash check
   * and offers reload or an explicit overwrite. Errors stay silent: the file
   * can be missing for a moment during an atomic replacement, and the save
   * path reports a real problem.
   */
  refresh(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.disposed || this.snapshot.load.kind !== "ready") return false;
      const version = this.version;
      let result: ReadResult;
      try {
        result = await this.io.read({ path: this.path, source: this.source });
      } catch {
        return false;
      }
      if (this.disposed || result.kind !== "text") return false;
      if (result.sha256 === this.snapshot.sha256) {
        if (this.snapshot.staleBase) this.patch({ staleBase: false });
        return false;
      }
      if (this.snapshot.dirty || this.snapshot.draft.kind === "stale") {
        this.patch({ staleBase: true });
        return false;
      }
      // Nothing was typed while the read ran, so the disk text is the newer one.
      if (this.version !== version) return false;
      this.installDisk(result, { applyDraft: false });
      return true;
    });
  }

  /**
   * Apply a draft the load kept back.
   *
   * A draft made against an older version of the file cannot be written by a
   * plain save: the hash the session holds is the hash of the file on disk, so
   * the write would pass its own check and replace work the user never saw.
   * The session goes to the conflict state at once, which stops auto save and
   * leaves the choice between reload and an explicit overwrite with the user.
   */
  restoreDraft(): void {
    const draft = this.drafts.read(this.key);
    if (draft === null) {
      this.patch({ draft: { kind: "none" } });
      return;
    }
    this.version += 1;
    const olderThanDisk = draft.baseSha256 !== this.snapshot.sha256;
    this.draftBaseSha256 = draft.baseSha256;
    const clean = draft.content === this.snapshot.savedContent;
    this.patch({
      content: draft.content,
      save: olderThanDisk
        ? { kind: "conflict", currentSha256: this.snapshot.sha256 }
        : clean
          ? { kind: "clean" }
          : { kind: "dirty" },
      epoch: this.snapshot.epoch + 1,
      epochAuthor: null,
      draft: { kind: "restored" },
      staleBase: olderThanDisk,
    });
  }

  discardDraft(): void {
    this.drafts.remove(this.key);
    this.draftBaseSha256 = this.snapshot.sha256;
    if (this.snapshot.content !== this.snapshot.savedContent) {
      this.version += 1;
      this.patch({
        content: this.snapshot.savedContent,
        save: { kind: "clean" },
        epoch: this.snapshot.epoch + 1,
        epochAuthor: null,
        draft: { kind: "none" },
      });
      return;
    }
    this.patch({ draft: { kind: "none" } });
  }

  private persistDraftSoon(): void {
    this.draftPending = true;
    if (this.draftTimer !== null) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.flushDraft();
    }, DRAFT_DEBOUNCE_MS);
  }

  flushDraft(): void {
    if (this.draftTimer !== null) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    if (!this.draftPending) return;
    this.draftPending = false;
    if (!this.snapshot.hasEdits) {
      this.drafts.remove(this.key);
      return;
    }
    if (this.snapshot.content.length > MAX_DRAFT_CHARS) {
      this.patch({ draft: { kind: "unstored", reason: NO_STORE_REASON } });
      return;
    }
    try {
      this.drafts.write(this.key, {
        content: this.snapshot.content,
        baseSha256: this.draftBaseSha256,
        savedAt: Date.now(),
      });
    } catch (error) {
      this.patch({ draft: { kind: "unstored", reason: messageOf(error, NO_STORE_REASON) } });
    }
  }

  private clearDraft(): void {
    this.draftPending = false;
    if (this.draftTimer !== null) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.drafts.remove(this.key);
  }

  /**
   * Disposal flushes, never cancels: the pending draft goes to the store and
   * a dirty buffer gets one last write through the queue. The hash check
   * still applies — a conflict stays a conflict rather than overwriting.
   */
  dispose(): void {
    if (this.disposed) return;
    this.flushDraft();
    if (this.autoSaveTimer !== null) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const needsWrite =
      this.snapshot.load.kind === "ready" &&
      this.snapshot.save.kind !== "conflict" &&
      this.snapshot.draft.kind !== "stale" &&
      (this.snapshot.hasEdits || this.snapshot.save.kind === "error");
    if (needsWrite) {
      this.log("save-flush", { reason: "dispose" });
      this.allowDisposedWrite = true;
      void this.write(false).finally(() => {
        this.allowDisposedWrite = false;
      });
    }
    this.disposed = true;
    this.listeners.clear();
  }

  private patch(next: Partial<FileSessionSnapshot>): void {
    const merged = { ...this.snapshot, ...next };
    const hasEdits = merged.content !== merged.savedContent;
    const unsettled = merged.save.kind === "saving" || merged.save.kind === "error" || merged.save.kind === "conflict";
    this.snapshot = { ...merged, hasEdits, dirty: hasEdits || unsettled };
    this.syncTimers();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
    this.onChanged(this);
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();
/**
 * Other names for an open file, pointing at its session key. BB's file opener
 * and the file tree can name one file differently (an absolute path and a
 * workspace-relative one), and two sessions for one file would each hold their
 * own draft. The first read reports both names, so the second caller finds the
 * session that already exists.
 */
const aliases = new Map<string, string>();
/**
 * Workspace roots learned from reads, by source: a session's absolute and
 * relative paths give the root between them. With the root known, a caller
 * naming the file by its other form reaches the existing session before any
 * read lands, not only after.
 */
const knownRoots = new Map<string, Set<string>>();
const registryListeners = new Set<() => void>();
let idleCounter = 0;
let defaultDrafts: DraftStore | null = null;

function draftStore(): DraftStore {
  if (defaultDrafts === null) {
    defaultDrafts = typeof localStorage === "undefined" ? memoryDraftStore() : localDraftStore();
  }
  return defaultDrafts;
}

/** Replace the store the registry uses. Tests and recovery call this. */
export function setDraftStore(store: DraftStore): void {
  defaultDrafts = store;
}

function recordAliases(session: Session): void {
  const { relativePath, absolutePath } = session.getSnapshot();
  for (const name of [relativePath, absolutePath]) {
    if (name === "" || name === session.path) continue;
    const key = sessionKeyFor(session.source, name);
    if (key !== session.key && !sessions.has(key)) aliases.set(key, session.key);
  }
  // Learn the workspace root so the other name form resolves before a read.
  if (absolutePath !== "" && relativePath !== "" && relativePath !== absolutePath) {
    const suffix = `/${relativePath}`;
    if (absolutePath.endsWith(suffix)) {
      const root = absolutePath.slice(0, -suffix.length);
      if (root !== "") {
        const roots = knownRoots.get(sourceKeyFor(session.source)) ?? new Set<string>();
        roots.add(root);
        knownRoots.set(sourceKeyFor(session.source), roots);
      }
    }
  }
}

function forgetSession(session: Session): void {
  sessions.delete(session.key);
  for (const [alias, key] of aliases) if (key === session.key) aliases.delete(alias);
}

function onSessionChanged(session: Session): void {
  recordAliases(session);
  if (session.viewCount === 0) {
    idleCounter += 1;
    session.idleAt = idleCounter;
  }
  for (const listener of registryListeners) listener();
  evictIdleSessions();
  if ([...sessions.values()].some((entry) => entry.viewCount > 0)) ensureExternalWatch();
  else stopExternalWatch();
}

/** Keep a bounded number of detached, clean sessions; those with unsaved work stay. */
function evictIdleSessions(): void {
  const idle = [...sessions.values()].filter((session) => session.viewCount === 0 && !session.getSnapshot().dirty);
  if (idle.length <= MAX_IDLE_SESSIONS) return;
  idle.sort((a, b) => a.idleAt - b.idleAt);
  for (const session of idle.slice(0, idle.length - MAX_IDLE_SESSIONS)) {
    session.flushDraft();
    session.dispose();
    forgetSession(session);
  }
}

export function acquireFileSession(options: {
  source: FileSessionSource;
  path: string;
  io: FileSessionIo;
  /** Content a caller already read. Used only when the session has no state. */
  seed?: SessionSeed | null;
  drafts?: DraftStore;
}): FileSession {
  const key = canonicalKey(options.source, options.path);
  const existing = sessions.get(key);
  if (existing !== undefined) {
    existing.setIo(options.io);
    if (options.seed != null) existing.seed(options.seed);
    return existing;
  }
  const session = new Session({
    key,
    path: options.path,
    source: options.source,
    io: options.io,
    drafts: options.drafts ?? draftStore(),
    seed: options.seed ?? null,
    onChanged: onSessionChanged,
  });
  sessions.set(key, session);
  return session;
}

/** The session for a file, without creating one. */
export function peekFileSession(source: FileSessionSource, path: string): FileSession | null {
  return sessions.get(canonicalKey(source, path)) ?? null;
}

function isAbsoluteName(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * The key a file's session is stored under, following a rename alias and —
 * through the roots reads have taught us — the other form of the same file's
 * name: a workspace-relative path and the absolute path share one session and
 * one draft.
 */
function canonicalKey(source: FileSessionSource, path: string): string {
  const normalized = normalizePath(path);
  const named = sessionKeyFor(source, normalized);
  const direct = aliases.get(named);
  if (direct !== undefined || sessions.has(named)) return direct ?? named;
  const roots = knownRoots.get(sourceKeyFor(source));
  if (roots !== undefined) {
    if (isAbsoluteName(normalized)) {
      for (const root of roots) {
        if (!normalized.startsWith(`${root}/`)) continue;
        const key = sessionKeyFor(source, normalized.slice(root.length + 1));
        if (sessions.has(key) || aliases.has(key)) return aliases.get(key) ?? key;
      }
    } else {
      for (const root of roots) {
        const key = sessionKeyFor(source, `${root}/${normalized}`);
        if (sessions.has(key) || aliases.has(key)) return aliases.get(key) ?? key;
      }
    }
  }
  return direct ?? named;
}

/** Listen for any change in any session; for lists that mark unsaved files. */
export function subscribeSessions(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

/** The paths with unsaved work in one workspace, for a file list marker. */
export function dirtyPaths(source: FileSessionSource): ReadonlySet<string> {
  const prefix = sourceKeyFor(source);
  const paths = new Set<string>();
  for (const session of sessions.values()) {
    if (!session.key.startsWith(prefix)) continue;
    if (session.getSnapshot().dirty) paths.add(session.path);
  }
  return paths;
}

/** Write every pending draft now. The window calls this before it goes away. */
function flushAllDrafts(): void {
  for (const session of sessions.values()) session.flushDraft();
}

/**
 * Write every dirty file now, wherever it is open — navigation, a window or
 * editor blur, the page hiding, or the panel closing call this so unsaved
 * work does not wait for a view. A conflict or a stale draft still waits for
 * the user. With `timeoutMs` the promise resolves when the writes settle or
 * the bound passes, whichever comes first; the writes continue either way.
 */
export function flushDirtySessions(options: { timeoutMs?: number; reason?: string } = {}): Promise<void> {
  const pending: Promise<boolean>[] = [];
  for (const session of sessions.values()) {
    const snapshot = session.getSnapshot();
    if (!snapshot.dirty || snapshot.save.kind === "conflict" || snapshot.draft.kind === "stale") continue;
    pending.push(session.flush());
  }
  if (pending.length === 0) return Promise.resolve();
  sessionLogger?.("flush", { reason: options.reason ?? "lifecycle", files: pending.length });
  const settled = Promise.allSettled(pending).then(() => undefined);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) return settled;
  return Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** One open file with unsettled work, for a plugin-wide indicator. */
export interface SessionOverviewEntry {
  key: string;
  path: string;
  sourceKind: FileSessionSource["kind"];
  save: SaveState["kind"];
  /** The save error's message, when there is one. */
  message: string | null;
}

/** Every file with unsaved work or a failed save, across all surfaces. */
export function sessionsOverview(): SessionOverviewEntry[] {
  const out: SessionOverviewEntry[] = [];
  for (const session of sessions.values()) {
    const snapshot = session.getSnapshot();
    if (!snapshot.dirty) continue;
    out.push({
      key: snapshot.key,
      path: snapshot.relativePath || snapshot.path,
      sourceKind: snapshot.source.kind,
      save: snapshot.save.kind,
      message: snapshot.save.kind === "error" ? snapshot.save.message : null,
    });
  }
  return out;
}

/** Drop every session. Tests call this between cases. */
export function resetFileSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  aliases.clear();
  knownRoots.clear();
  registryListeners.clear();
  refreshedAt.clear();
  idleCounter = 0;
  stopExternalWatch();
}

/** Report every dirty path in one workspace whenever the set can have changed. */
export function subscribeDirtyPaths(
  source: FileSessionSource,
  listener: (paths: ReadonlySet<string>) => void,
): () => void {
  let previous = dirtyPaths(source);
  listener(previous);
  return subscribeSessions(() => {
    const next = dirtyPaths(source);
    if (next.size === previous.size && [...next].every((path) => previous.has(path))) return;
    previous = next;
    listener(next);
  });
}

// ---------------------------------------------------------------------------
// External changes
// ---------------------------------------------------------------------------

/**
 * How often an open file is read again to find an edit made outside this
 * editor, for example by an agent. Five seconds keeps an agent's edit visible
 * quickly without a constant load: a check runs only for files that are open
 * in a mounted view, only while the BB window is visible, and it does nothing
 * more than compare a hash. A big file costs more to read, so it is checked
 * less often. A change on a file with unsaved work is never applied; it only
 * sets `staleBase`, and the save hash check still reports the conflict.
 *
 * This is a poll. A source with a live host watch (see `lib/file-watch.ts`)
 * is polled only slowly, as a backstop for a missed signal.
 */
const REFRESH_INTERVAL_MS = 5_000;
const LARGE_FILE_CHARS = 512 * 1024;
const SLOW_REFRESH_INTERVAL_MS = 30_000;

const watchedSources = new Set<string>();

/** Tell the poll that a source's files arrive by signal, or no longer do. */
export function setSourceWatched(source: FileSessionSource, watched: boolean): void {
  const key = sourceKeyFor(source);
  if (watched) watchedSources.add(key);
  else watchedSources.delete(key);
}

/** Re-read the named files of a source now, if they are open. */
export function refreshFiles(source: FileSessionSource, paths: readonly string[]): void {
  for (const path of paths) {
    const session = sessions.get(canonicalKey(source, path));
    if (session === undefined || session.viewCount === 0 || session.getSnapshot().load.kind !== "ready") continue;
    refreshedAt.set(session.key, Date.now());
    void session.refresh();
  }
}

const refreshedAt = new Map<string, number>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchBound = false;

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Check every open file now, or those whose interval has passed. */
export function refreshOpenFiles(options: { force?: boolean } = {}): void {
  if (!pageVisible()) return;
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.viewCount === 0) continue;
    const snapshot = session.getSnapshot();
    if (snapshot.load.kind !== "ready") continue;
    const slow = snapshot.savedContent.length > LARGE_FILE_CHARS || watchedSources.has(sourceKeyFor(session.source));
    const interval = slow ? SLOW_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
    if (options.force !== true && now - (refreshedAt.get(session.key) ?? 0) < interval) continue;
    refreshedAt.set(session.key, now);
    void session.refresh().then(() => refreshedAt.set(session.key, Date.now()));
  }
}

/** Drafts go to the store synchronously; dirty buffers get a last write. */
function flushOnLeave(reason: string): void {
  flushAllDrafts();
  void flushDirtySessions({ reason });
}

function ensureExternalWatch(): void {
  if (typeof window === "undefined") return;
  if (!watchBound) {
    watchBound = true;
    window.addEventListener("pagehide", () => flushOnLeave("pagehide"));
    window.addEventListener("blur", () => flushOnLeave("window-blur"));
    // Coming back retries a failed write; a reconnect does the same.
    window.addEventListener("online", () => void flushDirtySessions({ reason: "reconnect" }));
    window.addEventListener("focus", () => {
      void flushDirtySessions({ reason: "focus" });
      refreshOpenFiles({ force: true });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushOnLeave("hidden");
      else refreshOpenFiles({ force: true });
    });
  }
  if (watchTimer !== null) return;
  watchTimer = setInterval(() => refreshOpenFiles(), REFRESH_INTERVAL_MS);
}

function stopExternalWatch(): void {
  if (watchTimer === null) return;
  clearInterval(watchTimer);
  watchTimer = null;
}
