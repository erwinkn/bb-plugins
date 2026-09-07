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

/** The subset of BB's file source that identifies a file. */
export interface FileSessionSource {
  kind: "workspace" | "host" | "thread-storage";
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
  experimental_hostId?: string | undefined;
}

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
export interface SessionSeed {
  content: string;
  sha256: string;
  absolutePath: string;
  relativePath: string;
}

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
  /** Install a caller's read. It is ignored when the session has edits or a draft. */
  seed(seed: SessionSeed): void;
  /** Write with `expectedSha256`. Resolves true when the text reached disk. */
  save(): Promise<boolean>;
  /** Write without a hash check, after a reported conflict. */
  overwrite(): Promise<boolean>;
  /** Read the file again. Refuses when the text changed while reading. */
  reload(): Promise<ReloadOutcome>;
  /** Drop the edits and take the file from disk. */
  discard(): Promise<ReloadOutcome>;
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

const DRAFT_PREFIX = "erwin-editor:draft:v1:";
const DRAFT_DEBOUNCE_MS = 400;
/** Bigger buffers are not kept for a later session; the store cannot hold them. */
export const MAX_DRAFT_CHARS = 1_000_000;
/** Detached, clean sessions kept for their undo history and view state. */
const MAX_IDLE_SESSIONS = 24;

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
 * could join two different files into one session.
 */
export function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
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
export function localDraftStore(): DraftStore {
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
    if (this.disposed || text === this.snapshot.content) return;
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
      draft: this.snapshot.draft.kind === "stale" ? this.snapshot.draft : { kind: "none" },
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
    if (this.snapshot.load.kind !== "ready") return;
    if (this.snapshot.dirty || this.snapshot.draft.kind !== "none") {
      // Never replace unsaved work. Report a moved base instead.
      if (seed.sha256 !== this.snapshot.sha256) this.patch({ staleBase: true });
      return;
    }
    if (seed.sha256 === this.snapshot.sha256 && seed.content === this.snapshot.content) return;
    this.installDisk({ kind: "text", ...seed }, { applyDraft: false });
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
    try {
      const version = this.version;
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
      if (this.disposed) return;
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

  save(): Promise<boolean> {
    return this.write(false);
  }

  overwrite(): Promise<boolean> {
    return this.write(true);
  }

  private write(force: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.disposed || this.snapshot.load.kind !== "ready") return false;
      // A reported conflict waits for the user: reload, or an explicit
      // overwrite. Auto save must not settle it on its own.
      if (!force && (this.snapshot.save.kind === "conflict" || this.draftBaseSha256 !== this.snapshot.sha256)) {
        if (this.snapshot.save.kind !== "conflict") {
          this.patch({ save: { kind: "conflict", currentSha256: this.snapshot.sha256 }, staleBase: true });
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
          return false;
        }
        // Text typed during the write is newer than what reached disk.
        const stillDirty = this.version !== version;
        this.draftBaseSha256 = result.sha256;
        this.patch({
          savedContent: content,
          savedContentSource: "write",
          sha256: result.sha256,
          save: stillDirty ? { kind: "dirty" } : { kind: "clean" },
          draft: stillDirty ? this.snapshot.draft : { kind: "none" },
          staleBase: false,
        });
        if (stillDirty) this.persistDraftSoon();
        else this.clearDraft();
        return true;
      } catch (error) {
        if (!this.disposed) this.patch({ save: previousSave.kind === "conflict" ? previousSave : { kind: "error", message: messageOf(error, "Save failed") } });
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
    return this.read();
  }

  /** The same operation under the name the discard action uses. */
  discard(): Promise<ReloadOutcome> {
    return this.read();
  }

  private read(): Promise<ReloadOutcome> {
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

  dispose(): void {
    this.disposed = true;
    if (this.draftTimer !== null) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.listeners.clear();
  }

  private patch(next: Partial<FileSessionSnapshot>): void {
    const merged = { ...this.snapshot, ...next };
    const hasEdits = merged.content !== merged.savedContent;
    const unsettled = merged.save.kind === "saving" || merged.save.kind === "error" || merged.save.kind === "conflict";
    this.snapshot = { ...merged, hasEdits, dirty: hasEdits || unsettled };
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

/**
 * Keep a bounded number of detached, clean sessions so that going back to a
 * file keeps its undo history and view state. Sessions with unsaved work stay.
 */
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
  const named = sessionKeyFor(options.source, options.path);
  const key = aliases.get(named) ?? named;
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
  const named = sessionKeyFor(source, path);
  return sessions.get(aliases.get(named) ?? named) ?? null;
}

/** Listen for any change in any session; for lists that mark unsaved files. */
export function subscribeSessions(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

/** The paths with unsaved work in one workspace, for a file list marker. */
export function dirtyPaths(source: FileSessionSource): ReadonlySet<string> {
  const prefix = sessionKeyFor(source, "");
  const paths = new Set<string>();
  for (const session of sessions.values()) {
    if (!session.key.startsWith(prefix)) continue;
    if (session.getSnapshot().dirty) paths.add(session.path);
  }
  return paths;
}

/** Write every pending draft now. The window calls this before it goes away. */
export function flushAllDrafts(): void {
  for (const session of sessions.values()) session.flushDraft();
}

/** Drop every session. Tests call this between cases. */
export function resetFileSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  aliases.clear();
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
 * This is a poll. A host file watch is a separate, larger piece of work.
 */
export const REFRESH_INTERVAL_MS = 5_000;
export const LARGE_FILE_CHARS = 512 * 1024;
export const SLOW_REFRESH_INTERVAL_MS = 30_000;

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
    const interval = snapshot.savedContent.length > LARGE_FILE_CHARS ? SLOW_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
    if (options.force !== true && now - (refreshedAt.get(session.key) ?? 0) < interval) continue;
    refreshedAt.set(session.key, now);
    void session.refresh().then(
      () => refreshedAt.set(session.key, Date.now()),
      () => refreshedAt.set(session.key, Date.now()),
    );
  }
}

function ensureExternalWatch(): void {
  if (typeof window === "undefined") return;
  if (!watchBound) {
    watchBound = true;
    window.addEventListener("pagehide", flushAllDrafts);
    window.addEventListener("focus", () => refreshOpenFiles({ force: true }));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAllDrafts();
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
