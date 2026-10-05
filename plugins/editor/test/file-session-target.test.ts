/**
 * Cross-workspace identity: two worktrees holding the same relative path are
 * different sessions, a workspace switch can park dirty buffers unsaved
 * instead of flushing them, and a scoped flush never writes another
 * workspace's file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileSession,
  dirtyPaths,
  flushDirtySessions,
  memoryDraftStore,
  parkDirtySessions,
  resetFileSessions,
  sessionKeyFor,
  type FileSessionIo,
  type FileSessionSource,
} from "@/lib/file-session";

const workspace = (environmentId: string): FileSessionSource => ({
  kind: "workspace",
  threadId: `thr_${environmentId}`,
  environmentId,
  projectId: "proj_1",
});

function io(content = "original"): FileSessionIo & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    read: vi.fn(async () => ({
      kind: "text" as const,
      content,
      sha256: "h1",
      absolutePath: "/w/a.ts",
      relativePath: "a.ts",
    })),
    write: vi.fn(async (input: { content: string }) => {
      writes.push(input.content);
      return { outcome: "written" as const, sha256: "h2" };
    }),
  };
}

async function dirtySession(source: FileSessionSource, path = "a.ts", transport = io()) {
  const session = acquireFileSession({ source, path, io: transport, drafts: memoryDraftStore() });
  const detach = session.attach("view");
  await vi.waitFor(() => expect(session.getSnapshot().load.kind).toBe("ready"));
  session.claimEditor("view");
  session.setContent("unsaved work", "view");
  return { session, detach, transport };
}

afterEach(() => {
  resetFileSessions();
});

describe("cross-workspace identity", () => {
  it("keys sessions by environment, not path or thread label", () => {
    expect(sessionKeyFor(workspace("env_a"), "a.ts")).not.toBe(sessionKeyFor(workspace("env_b"), "a.ts"));
    expect(sessionKeyFor(workspace("env_a"), "a.ts")).toContain("env_a");
  });

  it("keeps identical relative paths in different worktrees as separate sessions", async () => {
    const a = await dirtySession(workspace("env_a"));
    const b = await dirtySession(workspace("env_b"));
    expect(a.session.key).not.toBe(b.session.key);
    expect(dirtyPaths(workspace("env_a")).has("a.ts")).toBe(true);
    a.session.setContent("a edit", "view");
    expect(b.session.getSnapshot().content).toBe("unsaved work");
  });
});

describe("parked sessions across a workspace switch", () => {
  it("skips parked dirty sessions on flush and keeps their edits", async () => {
    const a = await dirtySession(workspace("env_a"));
    const b = await dirtySession(workspace("env_b"));
    const parked = parkDirtySessions(workspace("env_a"));
    expect(parked).toEqual(["a.ts"]);
    await flushDirtySessions();
    expect(a.transport.writes).toEqual([]);
    expect(b.transport.writes).toEqual(["unsaved work"]);
    expect(a.session.getSnapshot().dirty).toBe(true);
    expect(a.session.getSnapshot().content).toBe("unsaved work");
  });

  it("un-parks when a view attaches again, so later flushes write", async () => {
    const a = await dirtySession(workspace("env_a"));
    parkDirtySessions(workspace("env_a"));
    await flushDirtySessions();
    const detach = a.session.attach("reopened");
    detach();
    await flushDirtySessions();
    expect(a.transport.writes).toEqual(["unsaved work"]);
  });
});

describe("source-scoped flush", () => {
  it("writes only the named workspace's dirty files", async () => {
    const a = await dirtySession(workspace("env_a"));
    const b = await dirtySession(workspace("env_b"));
    await flushDirtySessions({ source: workspace("env_a") });
    expect(a.transport.writes).toEqual(["unsaved work"]);
    expect(b.transport.writes).toEqual([]);
    expect(b.session.getSnapshot().dirty).toBe(true);
  });
});

/**
 * Inspection mode is an execution-time property, not only hidden controls:
 * a view attached read-only cannot drive writes through any path — save,
 * flush, lifecycle flush, overwrite after a conflict, mutation, or the
 * write disposal sneaks in — and it cannot un-park the unsaved work another
 * view kept. An opted-in writable attach restores normal behavior.
 */
describe("read-only view capability", () => {
  it("a parked session keeps its edits and refuses every write while only read-only views attach", async () => {
    const a = await dirtySession(workspace("env_a"));
    a.detach();
    parkDirtySessions(workspace("env_a"));
    // Inspecting the foreign file reopens the parked session read-only.
    const inspect = a.session.attach("inspect", { writable: false });
    expect(a.session.getSnapshot().dirty).toBe(true);
    await a.session.save();
    await a.session.flush();
    await a.session.overwrite();
    await flushDirtySessions();
    await flushDirtySessions({ source: workspace("env_a") });
    expect(a.transport.writes).toEqual([]);
    expect(a.session.getSnapshot().content).toBe("unsaved work");
    expect(a.session.getSnapshot().dirty).toBe(true);
    inspect();
  });

  it("stays parked through a read-only reattach and un-parks only when a writable view attaches", async () => {
    const a = await dirtySession(workspace("env_a"));
    a.detach();
    parkDirtySessions(workspace("env_a"));
    a.session.attach("inspect", { writable: false })();
    await flushDirtySessions({ source: workspace("env_a") });
    // Still parked: the flush above skipped it.
    expect(a.transport.writes).toEqual([]);
    // Opting in attaches a writable view, which un-parks — then flush writes.
    a.session.attach("editor", { writable: true })();
    await flushDirtySessions({ source: workspace("env_a") });
    expect(a.transport.writes).toEqual(["unsaved work"]);
  });

  it("refuses reload while parked so inspected edits cannot be discarded", async () => {
    const a = await dirtySession(workspace("env_a"));
    a.detach();
    parkDirtySessions(workspace("env_a"));
    a.session.attach("inspect", { writable: false })();
    const outcome = await a.session.reload();
    expect(outcome.ok).toBe(false);
    expect(a.session.getSnapshot().content).toBe("unsaved work");
    expect(a.session.getSnapshot().dirty).toBe(true);
  });

  it("keeps a read-only view from claiming the editor or reporting content", async () => {
    const a = await dirtySession(workspace("env_a"));
    const ro = a.session.attach("ro", { writable: false });
    a.session.claimEditor("ro");
    a.session.setContent("inspect edit", "ro");
    expect(a.session.getSnapshot().content).toBe("unsaved work");
    expect(a.session.getSnapshot().editorId).toBe("view");
    ro();
  });

  it("a parked session survives disposal without leaking a write", async () => {
    const a = await dirtySession(workspace("env_a"));
    a.detach();
    parkDirtySessions(workspace("env_a"));
    // Registry eviction calls dispose; the parked flag still blocks the write.
    (a.session as { dispose(): void }).dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.transport.writes).toEqual([]);
    expect(a.session.getSnapshot().content).toBe("unsaved work");
  });

  it("autosave never fires for a parked session", async () => {
    const { configureFileSessions } = await import("@/lib/file-session");
    configureFileSessions({ autoSave: "afterDelay", autoSaveDelayMs: 5 });
    try {
      const a = await dirtySession(workspace("env_a"));
      a.detach();
      parkDirtySessions(workspace("env_a"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(a.transport.writes).toEqual([]);
      expect(a.session.getSnapshot().dirty).toBe(true);
    } finally {
      configureFileSessions({ autoSave: "off" });
    }
  });
});

/**
 * Write authority is the view's own capability, checked when the write
 * executes — never the parked flag and never a sibling view's opt-in. A
 * session whose views are all inspection views cannot write at all; the
 * session regains that only while a writable view is attached.
 */
describe("write authority", () => {
  it("a fresh inspection-only session cannot autosave a restored draft", async () => {
    const { configureFileSessions } = await import("@/lib/file-session");
    configureFileSessions({ autoSave: "afterDelay", autoSaveDelayMs: 5 });
    const drafts = memoryDraftStore();
    try {
      const source = workspace("env_a");
      // An earlier editing session left a draft; the disk file still matches
      // its base, so the load would apply it automatically.
      drafts.write(sessionKeyFor(source, "a.ts"), { content: "restored draft", baseSha256: "h1", savedAt: Date.now() });
      const transport = io();
      const session = acquireFileSession({ source, path: "a.ts", io: transport, drafts });
      session.attach("inspect", { writable: false });
      await vi.waitFor(() => expect(session.getSnapshot().load.kind).toBe("ready"));
      expect(session.getSnapshot().content).toBe("restored draft");
      expect(session.getSnapshot().dirty).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushDirtySessions();
      expect(transport.writes).toEqual([]);
    } finally {
      configureFileSessions({ autoSave: "off" });
    }
  });

  it("a read-only view cannot save after the last writable view detaches", async () => {
    const a = await dirtySession(workspace("env_a"));
    a.detach();
    const ro = a.session.attach("inspect", { writable: false });
    // No writable view is attached: neither an invoked save nor a lifecycle
    // flush nor an overwrite may write, and timers stay cancelled.
    await a.session.save("inspect");
    await a.session.save();
    await a.session.flush();
    await a.session.overwrite();
    await flushDirtySessions({ source: workspace("env_a") });
    expect(a.transport.writes).toEqual([]);
    expect(a.session.getSnapshot().content).toBe("unsaved work");
    ro();
  });

  it("a read-only view cannot borrow a sibling view's opt-in", async () => {
    const a = await dirtySession(workspace("env_a"));
    const ro = a.session.attach("inspect", { writable: false });
    // The writable editing view is still attached, yet the inspection view's
    // own mutations stay refused.
    a.session.setContent("inspect edit", "inspect");
    await a.session.save("inspect");
    await a.session.overwrite("inspect");
    await expect(
      a.session.mutateFile({ content: "unsaved work", sha256: "h1" }, async () => null, "inspect"),
    ).rejects.toThrow();
    const outcome = await a.session.reload("inspect");
    expect(outcome.ok).toBe(false);
    expect(a.transport.writes).toEqual([]);
    expect(a.session.getSnapshot().content).toBe("unsaved work");
    // The writable view keeps its own authority throughout.
    await a.session.save("view");
    expect(a.transport.writes).toEqual(["unsaved work"]);
    ro();
  });

  it("a save queued behind another operation is refused once its view's capability is revoked", async () => {
    let release: () => void = () => {};
    let gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const text = () => ({ kind: "text" as const, content: "original", sha256: "h1", absolutePath: "/w/a.ts", relativePath: "a.ts" });
    const transport = io();
    transport.read = vi.fn(async () => {
      await gate;
      return text();
    });
    const session = acquireFileSession({ source: workspace("env_a"), path: "a.ts", io: transport, drafts: memoryDraftStore() });
    const detach = session.attach("view");
    release();
    await vi.waitFor(() => expect(session.getSnapshot().load.kind).toBe("ready"));
    session.claimEditor("view");
    session.setContent("unsaved work", "view");
    // Park a slow read in the queue, then enqueue the save behind it. The
    // view's writable capability is revoked before the save step runs.
    gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const reading = session.readDisk();
    const saving = session.save("view");
    detach();
    release();
    await reading;
    expect(await saving).toBe(false);
    expect(transport.writes).toEqual([]);
    expect(session.getSnapshot().dirty).toBe(true);
  });

  it("edit opt-in resumes writes and opting back out revokes them", async () => {
    const source = workspace("env_a");
    const transport = io();
    const session = acquireFileSession({ source, path: "a.ts", io: transport, drafts: memoryDraftStore() });
    session.attach("inspect", { writable: false });
    await vi.waitFor(() => expect(session.getSnapshot().load.kind).toBe("ready"));
    await session.save("inspect");
    expect(transport.writes).toEqual([]);
    // Opt in: the writable view may dirty and save.
    const detachEditor = session.attach("editor", { writable: true });
    session.setContent("opted-in edit", "editor");
    await session.save("editor");
    expect(transport.writes).toEqual(["opted-in edit"]);
    // Opt back out: the view re-attaches read-only, and with only inspection
    // views left even lifecycle flushes stay out of the file.
    session.setContent("after opt-out", "editor");
    detachEditor();
    session.attach("editor", { writable: false });
    await session.save("editor");
    await session.flush();
    await flushDirtySessions({ source });
    expect(transport.writes).toEqual(["opted-in edit"]);
    expect(session.getSnapshot().content).toBe("after opt-out");
  });

  it("an inspection-only session disposes without a write; a formerly-writable session still flushes on close", async () => {
    const transportA = io();
    const inspected = acquireFileSession({ source: workspace("env_a"), path: "a.ts", io: transportA, drafts: memoryDraftStore() });
    inspected.attach("inspect", { writable: false });
    await vi.waitFor(() => expect(inspected.getSnapshot().load.kind).toBe("ready"));
    inspected.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transportA.writes).toEqual([]);

    // A workspace's own editor closing still saves — the session keeps a
    // lifecycle lease from its writable view.
    const b = await dirtySession(workspace("env_b"));
    b.detach();
    (b.session as { dispose(): void }).dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.transport.writes).toEqual(["unsaved work"]);
  });

  it("an inspection attachment permanently revokes the old lifecycle lease", async () => {
    const transport = io();
    const source = workspace("env_foreign");
    const session = acquireFileSession({ source, path: "a.ts", io: transport, drafts: memoryDraftStore() });
    const detachEditor = session.attach("editor", { writable: true });
    const detachInspector = session.attach("inspector", { writable: false });
    await vi.waitFor(() => expect(session.getSnapshot().load.kind).toBe("ready"));
    session.claimEditor("editor");
    session.setContent("foreign edit", "editor");

    detachEditor();
    await flushDirtySessions({ source });
    expect(transport.writes).toEqual([]);

    detachInspector();
    await flushDirtySessions({ source });
    // Closing the last reader must not revive the lease it only witnessed.
    expect(transport.writes).toEqual([]);
    expect(session.getSnapshot().content).toBe("foreign edit");
  });

  it("revoking the invoking view while reload awaits preserves dirty edits", async () => {
    let reads = 0;
    let releaseReload!: () => void;
    let markStarted!: () => void;
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const reloadStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const transport = io();
    transport.read = vi.fn(async () => {
      reads += 1;
      if (reads > 1) {
        markStarted();
        await reloadGate;
      }
      return {
        kind: "text" as const,
        content: reads === 1 ? "original" : "new disk text",
        sha256: reads === 1 ? "h1" : "h2",
        absolutePath: "/w/a.ts",
        relativePath: "a.ts",
      };
    });
    const source = workspace("env_a");
    const session = acquireFileSession({ source, path: "a.ts", io: transport, drafts: memoryDraftStore() });
    const detachEditor = session.attach("editor", { writable: true });
    session.attach("inspector", { writable: false });
    await vi.waitFor(() => expect(session.getSnapshot().load.kind).toBe("ready"));
    session.claimEditor("editor");
    session.setContent("dirty edit", "editor");

    const reloading = session.reload("editor");
    await reloadStarted;
    detachEditor();
    releaseReload();
    const outcome = await reloading;

    expect(outcome.ok).toBe(false);
    expect(session.getSnapshot().content).toBe("dirty edit");
    expect(session.getSnapshot().dirty).toBe(true);
  });
});
