import { afterEach, expect, it, vi } from "vitest";
import { questionSession } from "../lib/question-session";
import { type DraftTransport, type SaveResponse } from "../lib/draft-store";
import { type ThreadState, emptyAnswer } from "../lib/model";

function backend(threadId: string) {
  const state: ThreadState = {
    threadId, summary: null, submissions: [], answers: [],
    rounds: [{ id: "r", threadId, number: 1, mode: "inline", intro: null, createdAt: 1,
      questions: [{ id: "q", title: "Question?", help: null, select: null, options: [], cites: [], attachments: false, references: false, confidence: false }] }],
  };
  const save = vi.fn<DraftTransport["saveDraft"]>(async (questionId, draft, version) => {
    const next = { questionId, roundId: "r", draft, version: version + 1, submitted: null, submittedAt: null, submissionId: null };
    state.answers = [next];
    return { outcome: "saved", state: next };
  });
  const transport: DraftTransport = { loadState: async () => structuredClone(state), saveDraft: save };
  return { state, transport, save };
}

afterEach(() => vi.useRealTimers());

it("joins an in-flight final save on close and immediate reopen", async () => {
  const server = backend("reopen");
  const session = questionSession("reopen", server.transport);
  const release = session.retain(server.transport);
  await session.store.load();
  let finish!: (value: SaveResponse) => void;
  const original = server.save.getMockImplementation()!;
  server.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  session.store.edit("q", () => ({ ...emptyAnswer(), text: "before close" }));
  release();
  expect(server.save).toHaveBeenCalledTimes(1);
  const reopened = questionSession("reopen", { ...server.transport });
  expect(reopened).toBe(session);
  const releaseAgain = reopened.retain(server.transport);
  reopened.store.edit("q", () => ({ ...emptyAnswer(), text: "after reopen" }));
  finish(await original("q", { ...emptyAnswer(), text: "before close" }, 0));
  await reopened.store.flush();
  expect(server.state.answers[0]!.draft!.text).toBe("after reopen");
  expect(reopened.store.conflicts()).toEqual([]);
  releaseAgain();
});

it("does not dispose a store while another view owns it", async () => {
  const server = backend("owners");
  const session = questionSession("owners", server.transport);
  const one = session.retain(server.transport);
  const two = session.retain({ ...server.transport });
  await session.store.load();
  const dispose = vi.spyOn(session.store, "dispose");
  one();
  one();
  expect(dispose).not.toHaveBeenCalled();
  session.store.edit("q", () => ({ ...emptyAnswer(), text: "second view" }));
  two();
  await session.store.flush();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(server.state.answers[0]!.draft!.text).toBe("second view");
});

it("survives the StrictMode setup-cleanup-setup lifecycle", async () => {
  const server = backend("strict");
  const session = questionSession("strict", server.transport);
  session.retain(server.transport)();
  const release = session.retain(server.transport);
  await session.store.load();
  expect(questionSession("strict", server.transport)).toBe(session);
  session.store.edit("q", () => ({ ...emptyAnswer(), text: "kept" }));
  await session.store.flush();
  expect(server.state.answers[0]!.draft!.text).toBe("kept");
  release();
});

it("isolates threads and keeps uncertain request ids through a remount", async () => {
  const a = backend("a");
  const b = backend("b");
  const first = questionSession("a", a.transport);
  const second = questionSession("b", b.transport);
  const releaseA = first.retain(a.transport);
  const releaseB = second.retain(b.transport);
  await Promise.all([first.store.load(), second.store.load()]);
  first.pendingSubmit = { id: "request", key: "q@1" };
  first.store.edit("q", () => ({ ...emptyAnswer(), text: "only a" }));
  await first.store.flush();
  expect(second.store.draftOf("q").text).toBe("");
  releaseA();
  await Promise.resolve();
  const reopened = questionSession("a", a.transport);
  expect(reopened.pendingSubmit).toEqual({ id: "request", key: "q@1" });
  const release = reopened.retain(a.transport);
  reopened.pendingSubmit = null;
  release();
  releaseB();
});
