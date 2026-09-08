import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  acquireFileSession,
  dirtyPaths,
  memoryDraftStore,
  normalizePath,
  peekFileSession,
  refreshOpenFiles,
  resetFileSessions,
  sessionKeyFor,
  setDraftStore,
  type DraftStore,
  type FileSessionIo,
  type FileSessionSource,
  type ReadResult,
  type WriteResult,
} from "./file-session";

const WORKSPACE: FileSessionSource = {
  kind: "workspace",
  threadId: null,
  environmentId: "env_1",
  projectId: "proj_1",
};

/** A stand-in content hash: any change of the text changes it. */
function hash(text: string): string {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) | 0;
  return `${text.length}:${value}`;
}

/** A file on a fake disk whose reads and writes can be held open. */
class Disk implements FileSessionIo {
  content: string;
  unsupported: string | null = null;
  writeError: string | null = null;
  readError: string | null = null;
  reads = 0;
  writes = 0;
  /** Text each held write carried, in call order. */
  written: string[] = [];
  private heldReads: Array<() => void> = [];
  private heldWrites: Array<() => void> = [];
  holdReads = false;
  holdWrites = false;

  constructor(content = "one\n") {
    this.content = content;
  }

  async read(input: { path: string }): Promise<ReadResult> {
    this.reads += 1;
    if (this.holdReads) await new Promise<void>((resolve) => this.heldReads.push(resolve));
    if (this.readError !== null) throw new Error(this.readError);
    if (this.unsupported !== null) return { kind: "unsupported", reason: this.unsupported };
    return {
      kind: "text",
      content: this.content,
      sha256: hash(this.content),
      absolutePath: `/workspace/${input.path}`,
      relativePath: input.path,
    };
  }

  async write(input: { content: string; expectedSha256: string | null }): Promise<WriteResult> {
    this.writes += 1;
    this.written.push(input.content);
    if (this.holdWrites) await new Promise<void>((resolve) => this.heldWrites.push(resolve));
    if (this.writeError !== null) throw new Error(this.writeError);
    if (input.expectedSha256 !== null && input.expectedSha256 !== hash(this.content)) {
      return { outcome: "conflict", currentSha256: hash(this.content) };
    }
    this.content = input.content;
    return { outcome: "written", sha256: hash(this.content) };
  }

  releaseReads(): void {
    const held = this.heldReads;
    this.heldReads = [];
    for (const resolve of held) resolve();
  }

  releaseWrites(): void {
    const held = this.heldWrites;
    this.heldWrites = [];
    for (const resolve of held) resolve();
  }
}

/** Let queued promises settle. */
async function settle(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function open(disk: Disk, path = "a.txt", drafts?: DraftStore) {
  const session = acquireFileSession({ source: WORKSPACE, path, io: disk, drafts });
  const detach = session.attach("view-1");
  return { session, detach };
}

afterEach(() => {
  resetFileSessions();
  setDraftStore(memoryDraftStore());
});

test("a stale draft requires a choice before edits, saves, or file actions", async () => {
  const drafts = memoryDraftStore();
  const key = sessionKeyFor(WORKSPACE, "a.txt");
  const original = { content: "earlier work", baseSha256: hash("old disk"), savedAt: 1 };
  drafts.write(key, original);
  const disk = new Disk("new disk");
  const { session, detach } = open(disk, "a.txt", drafts);
  await settle();
  session.setContent("new typing", "view-1");
  session.flushDraft();
  assert.equal(session.getSnapshot().content, "new disk");
  assert.equal(await session.save(), false);
  assert.equal(await session.overwrite(), false);
  await assert.rejects(session.mutateFile({ content: "new disk", sha256: hash("new disk") }, async () => {
    assert.fail("a file action must wait for the draft choice");
  }), /Restore or discard/);
  detach();
  resetFileSessions();
  assert.deepEqual(drafts.read(key), original);
  const reopened = open(disk, "a.txt", drafts).session;
  await settle();
  reopened.restoreDraft();
  assert.equal(reopened.getSnapshot().content, "earlier work");
  reopened.setContent("earlier work plus typing", "view-1");
  reopened.flushDraft();
  assert.equal(drafts.read(key)?.content, "earlier work plus typing");
  reopened.discardDraft();
  reopened.setContent("fresh work", "view-1");
  assert.equal(reopened.getSnapshot().content, "fresh work");
});

for (const outcome of ["text", "error", "unsupported"] as const) {
  test(`a seed wins over a pending read that returns ${outcome}`, async () => {
    const disk = new Disk("old read");
    disk.holdReads = true;
    const { session } = open(disk);
    const seed = { content: "comparison text", sha256: hash("comparison text"), absolutePath: "/workspace/a.txt", relativePath: "a.txt" };
    session.seed(seed);
    assert.equal(session.getSnapshot().load.kind, "ready");
    if (outcome === "error") disk.readError = "offline";
    if (outcome === "unsupported") disk.unsupported = "binary";
    disk.releaseReads();
    await settle();
    assert.equal(session.getSnapshot().load.kind, "ready");
    assert.equal(session.getSnapshot().content, seed.content);
  });
}

for (const outcome of ["error", "unsupported"] as const) {
  test(`a seed recovers an ${outcome} load and restores a matching draft`, async () => {
    const disk = new Disk("disk");
    if (outcome === "error") disk.readError = "offline";
    else disk.unsupported = "binary";
    const drafts = memoryDraftStore();
    drafts.write(sessionKeyFor(WORKSPACE, "a.txt"), { content: "my draft", baseSha256: hash("disk"), savedAt: 1 });
    const { session } = open(disk, "a.txt", drafts);
    await settle();
    assert.equal(session.getSnapshot().load.kind, outcome);
    session.seed({ content: "disk", sha256: hash("disk"), absolutePath: "/workspace/a.txt", relativePath: "a.txt" });
    assert.equal(session.getSnapshot().load.kind, "ready");
    assert.equal(session.getSnapshot().content, "my draft");
    assert.equal(session.getSnapshot().draft.kind, "restored");
  });
}

test("an unchanged seed recovers a previously loaded file that became unsupported", async () => {
  const disk = new Disk("disk");
  const { session } = open(disk);
  await settle();
  disk.unsupported = "temporarily unavailable";
  await session.reload();
  assert.equal(session.getSnapshot().load.kind, "unsupported");
  session.seed({ content: "disk", sha256: hash("disk"), absolutePath: "/workspace/a.txt", relativePath: "a.txt" });
  assert.equal(session.getSnapshot().load.kind, "ready");
  assert.equal(session.getSnapshot().content, "disk");
});

test("one file has one session key, whichever caller resolved the source", () => {
  const fromPanel: FileSessionSource = { ...WORKSPACE, threadId: "thr_1" };
  const fromOpener: FileSessionSource = { ...WORKSPACE, threadId: null };
  const withHost: FileSessionSource = { ...WORKSPACE, experimental_hostId: "host_1" };
  assert.equal(sessionKeyFor(fromPanel, "src/a.ts"), sessionKeyFor(fromOpener, "src/a.ts"));
  assert.equal(sessionKeyFor(withHost, "src/a.ts"), sessionKeyFor(fromOpener, "src/a.ts"));
  assert.equal(sessionKeyFor(fromOpener, "./src//a.ts"), sessionKeyFor(fromOpener, "src/a.ts"));
  assert.notEqual(sessionKeyFor(fromOpener, "src/a.ts"), sessionKeyFor(fromOpener, "src/b.ts"));
});

test("a project without an environment keeps the host in its key", () => {
  const base: FileSessionSource = { kind: "workspace", threadId: null, environmentId: null, projectId: "proj_1" };
  const one = sessionKeyFor({ ...base, experimental_hostId: "host_1" }, "a.ts");
  const two = sessionKeyFor({ ...base, experimental_hostId: "host_2" }, "a.ts");
  assert.notEqual(one, two);
});

test("a host source falls back to its environment, and thread storage to its thread", () => {
  const host: FileSessionSource = { kind: "host", threadId: null, environmentId: "env_1", projectId: null };
  assert.equal(sessionKeyFor(host, "/tmp/a"), sessionKeyFor({ ...host, environmentId: "env_1" }, "/tmp/a"));
  assert.notEqual(sessionKeyFor(host, "/tmp/a"), sessionKeyFor({ ...host, environmentId: "env_2" }, "/tmp/a"));
  const storage: FileSessionSource = { kind: "thread-storage", threadId: "thr_1", environmentId: null, projectId: null };
  assert.notEqual(sessionKeyFor(storage, "a"), sessionKeyFor({ ...storage, threadId: "thr_2" }, "a"));
  assert.equal(normalizePath("dir/"), "dir");
});

test("the first attach reads the file and the text starts clean", async () => {
  const disk = new Disk("hello\n");
  const { session } = open(disk);
  await settle();
  const state = session.getSnapshot();
  assert.equal(state.load.kind, "ready");
  assert.equal(state.content, "hello\n");
  assert.equal(state.dirty, false);
  assert.equal(state.relativePath, "a.txt");
  assert.equal(state.absolutePath, "/workspace/a.txt");
});

test("dirty state follows the text, so undo back to the saved text is clean", async () => {
  const disk = new Disk("hello\n");
  const { session } = open(disk);
  await settle();
  session.setContent("hello world\n", "view-1");
  assert.equal(session.getSnapshot().dirty, true);
  session.setContent("hello\n", "view-1");
  assert.equal(session.getSnapshot().dirty, false);
  assert.equal(session.getSnapshot().save.kind, "clean");
});

test("saves are serialized, and text typed during a save stays unsaved", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  disk.holdWrites = true;
  session.setContent("two\n", "view-1");
  const first = session.save();
  await settle();
  assert.equal(disk.writes, 1, "the first save is in flight");

  // Typing during the write, then asking for a second save.
  session.setContent("three\n", "view-1");
  const second = session.save();
  await settle();
  assert.equal(disk.writes, 1, "the second save waits for the first");
  assert.equal(session.getSnapshot().save.kind, "saving");

  disk.holdWrites = false;
  disk.releaseWrites();
  assert.equal(await first, true);
  await settle();
  assert.equal(await second, true);
  assert.deepEqual(disk.written, ["two\n", "three\n"]);
  assert.equal(disk.content, "three\n");
  assert.equal(session.getSnapshot().dirty, false);
});

test("a save that lands while the user types leaves the file dirty", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  disk.holdWrites = true;
  session.setContent("two\n", "view-1");
  const saving = session.save();
  await settle();
  session.setContent("two and a half\n", "view-1");
  disk.holdWrites = false;
  disk.releaseWrites();
  assert.equal(await saving, true);
  const state = session.getSnapshot();
  assert.equal(disk.content, "two\n");
  assert.equal(state.save.kind, "dirty");
  assert.equal(state.content, "two and a half\n");
  assert.equal(state.savedContent, "two\n");
});

test("a changed file gives a conflict, and only an explicit overwrite passes it", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  session.setContent("mine\n", "view-1");
  disk.content = "theirs\n"; // an agent wrote the file
  assert.equal(await session.save(), false);
  const conflicted = session.getSnapshot();
  assert.equal(conflicted.save.kind, "conflict");
  assert.equal(conflicted.staleBase, true);
  assert.equal(disk.content, "theirs\n", "a conflict never overwrites");

  assert.equal(await session.overwrite(), true);
  assert.equal(disk.content, "mine\n");
  assert.equal(session.getSnapshot().save.kind, "clean");
});

test("reload after a conflict takes the file on disk and drops the edits", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  session.setContent("mine\n", "view-1");
  disk.content = "theirs\n";
  await session.save();
  const outcome = await session.reload();
  assert.deepEqual(outcome, { ok: true });
  const state = session.getSnapshot();
  assert.equal(state.content, "theirs\n");
  assert.equal(state.dirty, false);
  assert.equal(state.staleBase, false);
});

test("a reload refuses its own result when the text changed while it read", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  disk.holdReads = true;
  const reloading = session.reload();
  await settle();
  session.setContent("typed while reading\n", "view-1");
  disk.content = "from disk\n";
  disk.holdReads = false;
  disk.releaseReads();
  const outcome = await reloading;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "changed-while-reading");
  assert.equal(session.getSnapshot().content, "typed while reading\n");
});

test("a result of an older read cannot replace the file", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  disk.holdReads = true;
  const first = session.reload();
  await settle();
  disk.content = "second\n";
  const second = session.reload();
  disk.holdReads = false;
  disk.releaseReads();
  await settle();
  disk.releaseReads();
  await first;
  await second;
  assert.equal(session.getSnapshot().content, "second\n");
});

test("two views share one session; only the editing view writes text", async () => {
  const disk = new Disk("one\n");
  const first = acquireFileSession({ source: WORKSPACE, path: "a.txt", io: disk });
  const detachFirst = first.attach("files");
  const second = acquireFileSession({ source: { ...WORKSPACE, threadId: "thr_9" }, path: "a.txt", io: disk });
  const detachSecond = second.attach("changes");
  assert.equal(first, second, "one file, one session");
  await settle();
  assert.equal(disk.reads, 1, "the second view reuses the first read");
  assert.equal(first.getSnapshot().editorId, "files");

  second.setContent("from the mirror\n", "changes");
  assert.equal(first.getSnapshot().content, "one\n", "a mirror cannot write text");

  second.claimEditor("changes");
  second.setContent("from the diff tab\n", "changes");
  assert.equal(first.getSnapshot().content, "from the diff tab\n");
  assert.equal(first.getSnapshot().epochAuthor, "changes");
  assert.equal(first.getSnapshot().dirty, true);

  detachSecond();
  assert.equal(first.getSnapshot().editorId, "files", "editing returns to the view left open");
  detachFirst();
});

test("a session with unsaved work outlives its views, and a clean one is dropped", async () => {
  const disk = new Disk("one\n");
  const dirty = open(disk, "dirty.txt");
  const clean = open(disk, "clean.txt");
  await settle();
  dirty.session.setContent("edited\n", "view-1");
  dirty.detach();
  clean.detach();
  assert.equal(peekFileSession(WORKSPACE, "dirty.txt")?.getSnapshot().dirty, true);
  assert.deepEqual([...dirtyPaths(WORKSPACE)], ["dirty.txt"]);
  for (let index = 0; index < 30; index++) open(disk, `filler-${index}.txt`).detach();
  assert.equal(peekFileSession(WORKSPACE, "clean.txt"), null, "the oldest clean session is evicted");
  assert.notEqual(peekFileSession(WORKSPACE, "dirty.txt"), null);
});

test("a draft survives the view and comes back when the file is unchanged", async () => {
  const drafts = memoryDraftStore();
  setDraftStore(drafts);
  const disk = new Disk("one\n");
  const first = open(disk);
  await settle();
  first.session.setContent("work in progress\n", "view-1");
  first.detach(); // an unmount flushes the draft
  resetFileSessions(); // a reload of the BB window

  const second = open(disk);
  await settle();
  const state = second.session.getSnapshot();
  assert.equal(state.content, "work in progress\n");
  assert.equal(state.dirty, true);
  assert.equal(state.draft.kind, "restored");
});

test("a draft of another version of the file is kept back for the user", async () => {
  const drafts = memoryDraftStore();
  setDraftStore(drafts);
  const disk = new Disk("one\n");
  const first = open(disk);
  await settle();
  first.session.setContent("my draft\n", "view-1");
  first.detach();
  resetFileSessions();
  disk.content = "an agent rewrote this\n";

  const second = open(disk);
  await settle();
  let state = second.session.getSnapshot();
  assert.equal(state.content, "an agent rewrote this\n", "the draft is not applied on its own");
  assert.equal(state.draft.kind, "stale");
  assert.equal(state.dirty, false);

  second.session.restoreDraft();
  state = second.session.getSnapshot();
  assert.equal(state.content, "my draft\n");
  assert.equal(state.dirty, true);
  assert.equal(state.staleBase, true, "saving it will meet the hash check");

  second.session.discardDraft();
  state = second.session.getSnapshot();
  assert.equal(state.content, "an agent rewrote this\n");
  assert.equal(state.draft.kind, "none");
});

test("a saved file leaves no draft behind", async () => {
  const drafts = memoryDraftStore();
  setDraftStore(drafts);
  const disk = new Disk("one\n");
  const { session, detach } = open(disk);
  await settle();
  session.setContent("saved text\n", "view-1");
  session.flushDraft();
  assert.notEqual(drafts.read(sessionKeyFor(WORKSPACE, "a.txt")), null);
  await session.save();
  detach();
  assert.equal(drafts.read(sessionKeyFor(WORKSPACE, "a.txt")), null);
});

test("a check for outside changes reloads a clean file and only warns a dirty one", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  disk.content = "an agent edited this\n";
  await session.refresh();
  assert.equal(session.getSnapshot().content, "an agent edited this\n");
  assert.equal(session.getSnapshot().dirty, false);

  session.setContent("my unsaved work\n", "view-1");
  disk.content = "the agent edited it again\n";
  await session.refresh();
  const state = session.getSnapshot();
  assert.equal(state.content, "my unsaved work\n", "unsaved text is never replaced");
  assert.equal(state.staleBase, true);
});

test("the poll only reads files that a view holds open", async () => {
  const disk = new Disk("one\n");
  const { session, detach } = open(disk);
  await settle();
  const readsAfterOpen = disk.reads;
  refreshOpenFiles({ force: true });
  await settle();
  assert.equal(disk.reads, readsAfterOpen + 1);
  detach();
  refreshOpenFiles({ force: true });
  await settle();
  assert.equal(disk.reads, readsAfterOpen + 1, "a closed file is not polled");
  assert.equal(session.getSnapshot().load.kind, "ready");
});

test("a seed stands in for the first read, and never replaces unsaved work", async () => {
  const disk = new Disk("on disk\n");
  const session = acquireFileSession({
    source: WORKSPACE,
    path: "a.txt",
    io: disk,
    seed: { content: "from the diff\n", sha256: hash("from the diff\n"), absolutePath: "/workspace/a.txt", relativePath: "a.txt" },
  });
  session.attach("changes");
  await settle();
  assert.equal(disk.reads, 0, "the seed saved a read");
  assert.equal(session.getSnapshot().content, "from the diff\n");

  session.claimEditor("changes");
  session.setContent("edited\n", "changes");
  session.seed({ content: "newer on disk\n", sha256: hash("newer on disk\n"), absolutePath: "/workspace/a.txt", relativePath: "a.txt" });
  const state = session.getSnapshot();
  assert.equal(state.content, "edited\n");
  assert.equal(state.staleBase, true, "the caller's newer hash is reported, not applied");
});

test("a failed write is reported and the text stays dirty", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  disk.writeError = "the host is not reachable";
  session.setContent("two\n", "view-1");
  assert.equal(await session.save(), false);
  const state = session.getSnapshot();
  assert.equal(state.save.kind, "error");
  assert.equal(state.save.kind === "error" && state.save.message, "the host is not reachable");
  assert.equal(state.dirty, true);

  disk.writeError = null;
  assert.equal(await session.save(), true);
  assert.equal(disk.content, "two\n");
});

test("a file the server cannot edit is reported, not opened", async () => {
  const disk = new Disk("one\n");
  disk.unsupported = "This file is not text";
  const { session } = open(disk);
  await settle();
  const state = session.getSnapshot();
  assert.equal(state.load.kind, "unsupported");
  assert.equal(state.load.kind === "unsupported" && state.load.reason, "This file is not text");
  assert.equal(await session.save(), false, "an unsupported file is never written");
  assert.equal(disk.writes, 0);
});

test("a restored draft of an older version cannot be saved without an overwrite", async () => {
  const drafts = memoryDraftStore();
  setDraftStore(drafts);
  const disk = new Disk("one\n");
  const first = open(disk);
  await settle();
  first.session.setContent("my draft\n", "view-1");
  first.detach();
  resetFileSessions();
  disk.content = "an agent rewrote this\n";

  const second = open(disk);
  await settle();
  second.session.restoreDraft();
  assert.equal(second.session.getSnapshot().save.kind, "conflict");

  // This is the auto-save path too: it must not replace the newer file.
  assert.equal(await second.session.save(), false);
  assert.equal(disk.writes, 0);
  assert.equal(disk.content, "an agent rewrote this\n");

  assert.equal(await second.session.overwrite(), true);
  assert.equal(disk.content, "my draft\n");
  assert.equal(second.session.getSnapshot().save.kind, "clean");
});

test("editing a restored stale draft keeps its old base across another restart", async () => {
  const drafts = memoryDraftStore();
  const key = sessionKeyFor(WORKSPACE, "a.txt");
  drafts.write(key, { content: "my old draft\n", baseSha256: hash("old disk\n"), savedAt: Date.now() });
  const disk = new Disk("new work on disk\n");
  const first = open(disk, "a.txt", drafts);
  await settle();
  first.session.restoreDraft();
  first.session.setContent("my old draft plus typing\n", "view-1");
  first.detach();
  assert.equal(drafts.read(key)?.baseSha256, hash("old disk\n"));
  resetFileSessions();

  const second = open(disk, "a.txt", drafts);
  await settle();
  assert.equal(second.session.getSnapshot().draft.kind, "stale");
  assert.equal(second.session.getSnapshot().content, "new work on disk\n");
  second.session.restoreDraft();
  assert.equal(second.session.getSnapshot().content, "my old draft plus typing\n");
  assert.equal(await second.session.save(), false);
  assert.equal(disk.writes, 0);
  assert.equal(await second.session.overwrite(), true);
  second.session.setContent("after explicit overwrite\n", "view-1");
  second.detach();
  assert.equal(drafts.read(key)?.baseSha256, hash("my old draft plus typing\n"));
});

test("failed reload or overwrite does not settle a restored stale draft conflict", async () => {
  const drafts = memoryDraftStore();
  drafts.write(sessionKeyFor(WORKSPACE, "a.txt"), {
    content: "my old draft\n", baseSha256: hash("old disk\n"), savedAt: Date.now(),
  });
  const disk = new Disk("new work on disk\n");
  const { session } = open(disk, "a.txt", drafts);
  await settle();
  session.restoreDraft();
  disk.readError = "temporary read failure";
  assert.equal((await session.reload()).ok, false);
  assert.equal(session.getSnapshot().save.kind, "conflict");
  assert.equal(await session.save(), false);
  assert.equal(disk.writes, 0);

  disk.writeError = "temporary write failure";
  assert.equal(await session.overwrite(), false);
  assert.equal(session.getSnapshot().save.kind, "conflict");
  disk.writeError = null;
  assert.equal(await session.save(), false);
  assert.equal(disk.writes, 1);
  assert.equal(disk.content, "new work on disk\n");
  disk.readError = null;
  assert.deepEqual(await session.reload(), { ok: true });
  session.setContent("edit after successful reload\n", "view-1");
  assert.equal(await session.save(), true);
});

test("a plain save waits for the user while a conflict is unsettled", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  session.setContent("mine\n", "view-1");
  disk.content = "theirs\n";
  await session.save();
  assert.equal(session.getSnapshot().save.kind, "conflict");
  const writes = disk.writes;
  session.setContent("mine, edited again\n", "view-1");
  assert.equal(await session.save(), false, "more typing does not settle a conflict");
  assert.equal(disk.writes, writes);
  assert.equal(disk.content, "theirs\n");
});

test("discarding does not drop text typed while it read the file", async () => {
  const disk = new Disk("one\n");
  const { session } = open(disk);
  await settle();
  session.setContent("edited\n", "view-1");
  disk.holdReads = true;
  const discarding = session.reload();
  await settle();
  session.setContent("typed after pressing discard\n", "view-1");
  disk.holdReads = false;
  disk.releaseReads();
  const outcome = await discarding;
  assert.equal(outcome.ok, false);
  assert.equal(session.getSnapshot().content, "typed after pressing discard\n");
  assert.deepEqual(await session.reload(), { ok: true });
  assert.equal(session.getSnapshot().content, "one\n");
});

test("two names for one file reach one session", async () => {
  const disk = new Disk("one\n");
  const byRelative = acquireFileSession({ source: WORKSPACE, path: "a.txt", io: disk });
  byRelative.attach("tree");
  await settle();
  const byAbsolute = acquireFileSession({ source: WORKSPACE, path: "/workspace/a.txt", io: disk });
  assert.equal(byAbsolute, byRelative);
  assert.equal(peekFileSession(WORKSPACE, "/workspace/a.txt"), byRelative);
});

test("a backslash in a file name is kept, so two files stay apart", () => {
  assert.notEqual(sessionKeyFor(WORKSPACE, "a\\b.txt"), sessionKeyFor(WORKSPACE, "a/b.txt"));
  assert.equal(normalizePath("a\\b.txt"), "a\\b.txt");
});


test("saved text distinguishes a write from a later external read", async () => {
  const disk = new Disk();
  const { session } = open(disk);
  await settle();
  assert.equal(session.getSnapshot().savedContentSource, "read");
  session.setContent("local edit", "view-1");
  assert.equal(await session.save(), true);
  assert.equal(session.getSnapshot().savedContentSource, "write");
  disk.content = "external edit";
  await session.refresh();
  assert.equal(session.getSnapshot().savedContentSource, "read");
  assert.equal(session.getSnapshot().content, "external edit");
});

test("file action refuses edits made after its confirmation snapshot", async () => {
  const disk = new Disk(); const { session } = open(disk); await settle();
  const expected = session.getSnapshot();
  session.setContent("later typing", "view-1");
  await assert.rejects(() => session.mutateFile(expected, async () => { throw new Error("must not run"); }), /file changed/);
  assert.equal(session.getSnapshot().content, "later typing");
});

test("file action waits for a save and refuses the obsolete hash", async () => {
  const disk = new Disk(); const { session } = open(disk); await settle();
  session.setContent("edited", "view-1"); disk.holdWrites = true;
  const saved = session.save(); await settle();
  const mutation = session.mutateFile(session.getSnapshot(), async () => { throw new Error("must not run"); });
  const rejected = assert.rejects(() => mutation, /file changed/);
  disk.releaseWrites(); await saved; await rejected;
});

test("file revert updates shared views and keeps typing made during the action", async () => {
  const disk = new Disk(); const { session } = open(disk); await settle();
  let release!: () => void;
  const action = session.mutateFile(session.getSnapshot(), async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    disk.content = "baseline";
    return { content: disk.content, sha256: hash(disk.content), absolutePath: "/workspace/a.txt", relativePath: "a.txt" };
  });
  await settle(); session.setContent("typed during revert", "view-1"); release(); await action;
  assert.equal(session.getSnapshot().content, "typed during revert");
  assert.equal(session.getSnapshot().savedContent, "baseline");
  assert.equal(session.getSnapshot().dirty, true);
});

test("deletion prevents queued auto-save from recreating the file", async () => {
  const disk = new Disk(); const drafts = memoryDraftStore(); const { session } = open(disk, "a.txt", drafts); await settle();
  session.setContent("draft", "view-1"); session.flushDraft();
  await session.mutateFile(session.getSnapshot(), async () => null);
  assert.equal(await session.save(), false);
  assert.equal(disk.writes, 0);
  assert.equal(drafts.read(session.key), null);
  assert.equal(session.getSnapshot().load.kind, "unsupported");
});
