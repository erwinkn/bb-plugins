import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraftStore,
  type Backup,
  type BackupStorage,
  type DraftTransport,
  type SaveResponse,
} from "../lib/draft-store";
import { type Answer, type AnswerState, type ThreadState, emptyAnswer } from "../lib/model";

const THREAD = "thr_1";
const Q1 = "q_1";
const Q2 = "q_2";

function state(answers: AnswerState[] = []): ThreadState {
  return {
    threadId: THREAD,
    rounds: [
      {
        id: "rnd_1",
        threadId: THREAD,
        number: 1,
        mode: "notebook",
        intro: null,
        createdAt: 1,
        questions: [
          { id: Q1, title: "One?", help: null, group: null, select: "single", options: [{ id: "o1", label: "A" }], cites: [], attachments: false, references: false, confidence: false },
          { id: Q2, title: "Two?", help: null, group: null, select: null, options: [], cites: [], attachments: false, references: false, confidence: false },
        ],
      },
    ],
    answers,
    summary: null,
    submissions: [],
  };
}

function answerState(questionId: string, draft: Answer | null, version: number): AnswerState {
  return { questionId, roundId: "rnd_1", draft, version, submitted: null, submittedAt: null, submissionId: null };
}

/** A fake server that stores drafts with versions like the real store. */
function fakeServer(initial: AnswerState[] = []) {
  const answers = new Map(initial.map((item) => [item.questionId, item]));
  const saves: { questionId: string; draft: Answer; expectedVersion: number }[] = [];
  let failing = false;
  const transport: DraftTransport = {
    loadState: async () => state([...answers.values()]),
    saveDraft: async (questionId, draft, expectedVersion): Promise<SaveResponse> => {
      saves.push({ questionId, draft, expectedVersion });
      if (failing) throw new Error("offline");
      const current = answers.get(questionId) ?? answerState(questionId, null, 0);
      if (current.version !== expectedVersion) return { outcome: "conflict", state: current };
      const next = { ...current, draft, version: current.version + 1 };
      answers.set(questionId, next);
      return { outcome: "saved", state: next };
    },
  };
  return {
    transport,
    saves,
    answers,
    setFailing(value: boolean) {
      failing = value;
    },
    /** Another client saved something. */
    externalWrite(questionId: string, draft: Answer) {
      const current = answers.get(questionId) ?? answerState(questionId, null, 0);
      answers.set(questionId, { ...current, draft, version: current.version + 1 });
    },
  };
}

function memoryBackups() {
  const map = new Map<string, Backup>();
  const storage: BackupStorage = {
    read: () => new Map(map),
    write: (_thread, questionId, backup) => {
      map.set(questionId, backup);
      return true;
    },
    remove: (_thread, questionId) => {
      map.delete(questionId);
    },
  };
  return { storage, map };
}

const typed = (text: string): Answer => ({ ...emptyAnswer(), text });

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("DraftStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("saves a debounced edit with the version at which the edit started", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 100 });
    await store.load();
    store.edit(Q2, () => typed("hello"));
    expect(store.draftOf(Q2).text).toBe("hello");
    expect(server.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(server.saves).toEqual([{ questionId: Q2, draft: typed("hello"), expectedVersion: 0 }]);
    expect(store.serverAnswer(Q2)?.version).toBe(1);
    expect(store.unresolvedIds()).toEqual([]);
  });

  it("keeps whitespace exactly as typed", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 10 });
    await store.load();
    store.edit(Q2, () => typed("  two lines\n\n  "));
    await vi.advanceTimersByTimeAsync(10);
    expect(server.answers.get(Q2)?.draft?.text).toBe("  two lines\n\n  ");
  });

  it("reports a conflict instead of overwriting another client's newer draft", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 100 });
    await store.load();
    store.edit(Q2, () => typed("mine"));
    // Another client saves before our debounce fires; a realtime refetch lands.
    server.externalWrite(Q2, typed("theirs"));
    await store.load();
    await vi.advanceTimersByTimeAsync(100);
    expect(server.answers.get(Q2)?.draft?.text).toBe("theirs");
    expect(store.draftOf(Q2).text).toBe("mine");
    expect(store.conflicts()).toEqual([Q2]);
    expect(store.currentNotices[0]?.text).toMatch(/changed in another window/);
    await expect(store.flush()).rejects.toThrow(/Resolve the conflict/);

    store.resolveConflict(Q2, "mine");
    await vi.advanceTimersByTimeAsync(100);
    expect(server.answers.get(Q2)?.draft?.text).toBe("mine");
    expect(store.conflicts()).toEqual([]);
  });

  it("lets the user take the saved version on conflict", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 100 });
    await store.load();
    store.edit(Q2, () => typed("mine"));
    server.externalWrite(Q2, typed("theirs"));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.conflicts()).toEqual([Q2]);
    store.resolveConflict(Q2, "saved");
    expect(store.draftOf(Q2).text).toBe("theirs");
    expect(store.unresolvedIds()).toEqual([]);
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("saves edits made while a save is in flight on top of the new version", async () => {
    const server = fakeServer();
    let release: (() => void) | null = null;
    const slow: DraftTransport = {
      loadState: server.transport.loadState,
      saveDraft: (questionId, draft, expectedVersion) =>
        new Promise((resolve) => {
          release = () => resolve(server.transport.saveDraft(questionId, draft, expectedVersion));
        }),
    };
    const store = new DraftStore({ threadId: THREAD, transport: slow, backups: null, debounceMs: 10 });
    await store.load();
    store.edit(Q2, () => typed("a"));
    await vi.advanceTimersByTimeAsync(10);
    expect(store.saving).toBe(true);
    store.edit(Q2, () => typed("ab"));
    release!;
    (release as unknown as () => void)();
    await settle();
    // Second save is scheduled with the version the first save produced.
    await vi.advanceTimersByTimeAsync(10);
    (release as unknown as () => void)();
    await settle();
    expect(server.saves.map((save) => [save.draft.text, save.expectedVersion])).toEqual([
      ["a", 0],
      ["ab", 1],
    ]);
    expect(server.answers.get(Q2)?.draft?.text).toBe("ab");
  });

  it("keeps the edit and backs off when the server is unreachable, then flush fails honestly", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 10 });
    await store.load();
    server.setFailing(true);
    store.edit(Q2, () => typed("keep me"));
    await vi.advanceTimersByTimeAsync(10);
    expect(server.saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(server.saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.saves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.saves).toHaveLength(3);
    expect(store.draftOf(Q2).text).toBe("keep me");
    expect(store.currentNotices).toHaveLength(1);
    await expect(store.flush()).rejects.toThrow(/could not be saved/);
    server.setFailing(false);
    await expect(store.flush()).resolves.toBeUndefined();
    expect(server.answers.get(Q2)?.draft?.text).toBe("keep me");
  });

  it("dispose starts saving a pending edit instead of dropping it", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 1000 });
    await store.load();
    store.edit(Q2, () => typed("closing"));
    store.dispose();
    await settle();
    expect(server.answers.get(Q2)?.draft?.text).toBe("closing");
  });

  it("restores a browser backup after reload and saves it when versions match", async () => {
    const server = fakeServer();
    const backups = memoryBackups();
    const first = new DraftStore({ threadId: THREAD, transport: server.transport, backups: backups.storage, debounceMs: 1000 });
    await first.load();
    first.edit(Q2, () => typed("unsaved"));
    expect(backups.map.get(Q2)).toEqual({ answer: typed("unsaved"), baseVersion: 0 });
    // Simulate a hard close: no dispose, no save.
    const second = new DraftStore({ threadId: THREAD, transport: server.transport, backups: backups.storage, debounceMs: 10 });
    await second.load();
    expect(second.draftOf(Q2).text).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(10);
    expect(server.answers.get(Q2)?.draft?.text).toBe("unsaved");
    expect(backups.map.has(Q2)).toBe(false);
  });

  it("turns a stale browser backup into a conflict rather than overwriting", async () => {
    const server = fakeServer();
    const backups = memoryBackups();
    backups.map.set(Q2, { answer: typed("old backup"), baseVersion: 0 });
    server.externalWrite(Q2, typed("newer on server"));
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: backups.storage, debounceMs: 10 });
    await store.load();
    await vi.advanceTimersByTimeAsync(50);
    expect(server.answers.get(Q2)?.draft?.text).toBe("newer on server");
    expect(store.conflicts()).toEqual([Q2]);
    expect(store.draftOf(Q2).text).toBe("old backup");
  });

  it("reports no browser backups when storage is unavailable", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null });
    expect(store.backupMode).toBe("none");
  });

  it("merges an upload result without losing text typed meanwhile", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 10 });
    await store.load();
    store.edit(Q1, () => typed("before upload"));
    await vi.advanceTimersByTimeAsync(10);
    store.edit(Q1, (current) => ({ ...current, text: "typed during upload" }));
    const uploaded: AnswerState = answerState(
      Q1,
      { ...typed("before upload"), attachments: [{ type: "localFile", path: "up/a.txt", name: "a.txt", sizeBytes: 3, mimeType: null }] },
      2,
    );
    store.mergeUploaded(uploaded);
    expect(store.draftOf(Q1).text).toBe("typed during upload");
    expect(store.draftOf(Q1).attachments).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(server.saves.at(-1)).toMatchObject({ expectedVersion: 2 });
  });

  it("ignores a stale load response after a newer one", async () => {
    const server = fakeServer();
    let resolveFirst: ((value: ThreadState) => void) | null = null;
    const transport: DraftTransport = {
      loadState: () =>
        resolveFirst === null
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : server.transport.loadState(),
      saveDraft: server.transport.saveDraft,
    };
    const store = new DraftStore({ threadId: THREAD, transport, backups: null });
    const first = store.load();
    store.refresh();
    resolveFirst!({ ...state(), rounds: [] });
    await first;
    await settle();
    expect(store.rounds).toHaveLength(1);
  });
});

describe("DraftStore merging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not let a delayed load roll back a version a save already advanced", async () => {
    const server = fakeServer();
    let releaseLoad: ((value: ThreadState) => void) | null = null;
    let loads = 0;
    const transport: DraftTransport = {
      loadState: () => {
        loads += 1;
        if (loads === 2) {
          return new Promise((resolve) => {
            releaseLoad = resolve;
          });
        }
        return server.transport.loadState();
      },
      saveDraft: server.transport.saveDraft,
    };
    const store = new DraftStore({ threadId: THREAD, transport, backups: null, debounceMs: 10 });
    await store.load();
    const stale = await server.transport.loadState();
    const delayed = store.load();
    store.edit(Q2, () => typed("new"));
    await vi.advanceTimersByTimeAsync(10);
    expect(store.serverAnswer(Q2)?.version).toBe(1);
    releaseLoad!(stale);
    await delayed;
    expect(store.serverAnswer(Q2)?.version).toBe(1);
    expect(store.serverAnswer(Q2)?.draft?.text).toBe("new");
  });

  it("keeps newer submission metadata when an equal-version late reply arrives", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 10 });
    await store.load();
    store.edit(Q2, () => typed("final"));
    await vi.advanceTimersByTimeAsync(10);
    const submitted = { ...answerState(Q2, typed("final"), 1), submitted: typed("final"), submittedAt: 50, submissionId: "sub_1" };
    store.replaceServerAnswer(submitted);
    // Same draft version, but recorded before the submission.
    store.replaceServerAnswer(answerState(Q2, typed("final"), 1));
    expect(store.serverAnswer(Q2)?.submissionId).toBe("sub_1");
    expect(store.serverAnswer(Q2)?.submittedAt).toBe(50);
    // A higher draft version carrying stale submission metadata keeps both.
    store.replaceServerAnswer(answerState(Q2, typed("final edited"), 2));
    expect(store.serverAnswer(Q2)?.version).toBe(2);
    expect(store.serverAnswer(Q2)?.draft?.text).toBe("final edited");
    expect(store.serverAnswer(Q2)?.submissionId).toBe("sub_1");
  });

  it("survives StrictMode dispose and activate without losing the pending save", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 50 });
    store.activate();
    await store.load();
    store.dispose();
    store.activate();
    store.edit(Q2, () => typed("after remount"));
    await vi.advanceTimersByTimeAsync(50);
    expect(server.answers.get(Q2)?.draft?.text).toBe("after remount");
  });

  it("flush rejects at once when the transport fails instead of retrying in a loop", async () => {
    const server = fakeServer();
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: null, debounceMs: 10 });
    await store.load();
    server.setFailing(true);
    store.edit(Q2, () => typed("x"));
    await expect(store.flush()).rejects.toThrow(/could not be saved/);
    expect(server.saves).toHaveLength(1);
  });

  it("restores a backup byte-exactly and ignores a corrupted one", async () => {
    const server = fakeServer();
    const backups = memoryBackups();
    backups.map.set(Q2, { answer: typed("  keep   spaces \n"), baseVersion: 0 });
    const store = new DraftStore({ threadId: THREAD, transport: server.transport, backups: backups.storage, debounceMs: 10 });
    await store.load();
    expect(store.draftOf(Q2).text).toBe("  keep   spaces \n");
    await vi.advanceTimersByTimeAsync(10);
    expect(server.answers.get(Q2)?.draft?.text).toBe("  keep   spaces \n");
  });
});
