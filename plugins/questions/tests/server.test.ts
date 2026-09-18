import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { MIGRATIONS, QuestionsStore } from "../server/store";
import { QuestionsService } from "../server/service";
import { QuestionInteractions } from "../server/interactions";
import { LIMITS, actionableFailures, emptyAnswer, threadStateSchema, type Answer, type Question, type Submission } from "../lib/model";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const ids = new Map<string, string>();
function uuid(label: string): string {
  if (!ids.has(label)) ids.set(label, randomUUID());
  return ids.get(label)!;
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup(beforePlugin?: (host: ReturnType<typeof createFakePluginHost>) => void) {
  const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));
  /** Per-thread `questions` metadata namespace, as bb 0.43.1 stores it. */
  const metadata = new Map<string, Record<string, unknown>>();
  const host = createFakePluginHost({
    pluginId: "questions",
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: `proj_${threadId}`, environmentId: `env_${threadId}` }),
        send,
        getPluginMetadata: async ({ threadId }) => structuredClone(metadata.get(threadId) ?? {}),
        updatePluginMetadata: async ({ threadId, set, remove }) => {
          const next = { ...(metadata.get(threadId) ?? {}) };
          for (const key of remove ?? []) delete next[key];
          Object.assign(next, structuredClone(set ?? {}));
          if (Object.keys(next).length === 0) metadata.delete(threadId);
          else metadata.set(threadId, next);
          return structuredClone(next);
        },
      },
      environments: {
        get: async ({ environmentId }) => ({ id: environmentId, hostId: `host_${environmentId}` }),
        paths: async () => ({ paths: [{ path: "src/app.ts", name: "app.ts", kind: "file" }], truncated: false }),
      },
      files: { read: async () => ({ content: JSON.stringify({ questions: [{ title: "Remote JSON?" }] }), contentEncoding: "utf8" }) },
      projects: { attachments: {
        upload: async ({ filename, mimeType }) => ({ path: "uploads/test.png", name: filename, mimeType, sizeBytes: 3 }),
        read: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", sizeBytes: 3 }),
      } },
    },
  });
  hosts.push(host);
  host.harness.sdk.stub("threads.interactions.list", async () => host.harness.pendingInteractions.map((item) => ({
    ...item, status: "pending", origin: { kind: "plugin", pluginId: "questions", rendererId: item.rendererId },
    payload: { kind: "plugin", data: item.payload, title: item.title },
  })));
  beforePlugin?.(host);
  await plugin(host.bb);
  const rpc = host.harness.behavior.callRpc;
  const state = async (threadId = "t") => threadStateSchema.parse(await rpc("questions_state", { threadId }));
  const ask = async (questions: unknown[], threadId = "t", mode = "panel") => {
    const service = new QuestionsService(new QuestionsStore(host.bb.storage.database()), { sdk: host.bb.sdk, log: host.bb.log, publish: () => {} });
    return service.ask(threadId, `proj_${threadId}`, { mode, questions }).round;
  };
  const save = async (q: Question, draft: Answer, version = 0, threadId = "t") => rpc("questions_save_draft", { threadId, questionId: q.id, draft, expectedVersion: version });
  const submit = async (questionIds: string[], submissionId = "s1", version = 1) => rpc("questions_submit", {
    threadId: "t", submissionId: uuid(submissionId), items: questionIds.map((questionId) => ({ questionId, expectedVersion: version })),
  }) as Promise<{ outcome: string; submission: Submission }>;
  return { ...host, send, metadata, rpc, state, ask, save, submit };
}

describe("Questions backend", () => {
  it.each(["panel", "inline"])("holds the native %s prompt for Cursor after the tool returns", async (mode) => {
    const h = await setup(({ harness }) => {
      harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, providerId: "acp-cursor", projectId: "proj_t" }));
    });
    const controller = new AbortController();
    const call = await h.harness.behavior.callAgentTool("questions_ask", { mode, questions: [{ title: "Cursor answer?" }] }, { threadId: "t", projectId: "proj_t", signal: controller.signal });
    expect(JSON.parse(call as string)).toMatchObject({ status: "waiting", instruction: expect.stringContaining("End your turn") });
    controller.abort(); // The returned tool no longer owns the prompt.
    expect(h.harness.pendingInteractions).toHaveLength(1);
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Cursor receives this" });
    h.send.mockImplementationOnce(async () => {
      expect(h.harness.pendingInteractions).toHaveLength(0);
      return { ok: true, delivery: "sent" };
    });
    expect((await h.submit([q.id], `cursor-${mode}`)).submission.state).toBe("sent");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ threadId: "t", mode: "queue-if-active", input: [{ type: "text", text: expect.stringContaining("Cursor receives this") }] });
    await h.submit([q.id], `cursor-${mode}`);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.harness.inspection.sdk.callsTo("threads.interactions.respond")).toHaveLength(0);
  });

  it("uses the configured delivery policy for native tools", async () => {
    const h = await setup();
    const provider = (await h.bb.sdk.threads.get({ threadId: "t" })).providerId;
    await h.harness.behavior.setSettings({ nonBlockingProviders: ` acp-cursor, ${provider} ` });
    const result = await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Configured hold?" }] }, { threadId: "t", projectId: "proj_t" });
    expect(JSON.parse(result as string)).toMatchObject({ status: "waiting" });
    expect(h.harness.pendingInteractions).toHaveLength(1);
    const duplicate = await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Duplicate?" }] }, { threadId: "t", projectId: "proj_t" });
    expect(duplicate).toMatchObject({ isError: true });
    expect((await h.state()).rounds).toHaveLength(1);
    h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(0));
    await h.harness.behavior.setSettings({ nonBlockingProviders: "" });
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Wait again?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const q = (await h.state()).rounds[1]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Direct result" });
    await h.submit([q.id], "configured");
    expect(JSON.parse(await call as string).answers[0].answer.text).toBe("Direct result");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reports the open prompt in state and signals its close on cancel", async () => {
    const h = await setup();
    const publish = vi.spyOn(h.bb.realtime, "publish");
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Cancel me?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const roundId = (await h.state()).rounds[0]!.id;
    expect((await h.state()).openRoundId).toBe(roundId);
    expect(publish).toHaveBeenCalledWith("questions-changed", { threadId: "t", kind: "prompt-opened", roundId });
    h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
    expect(await call).toMatchObject({ isError: true });
    // The question is still unanswered, yet nothing waits on the user any more.
    expect((await h.state()).openRoundId).toBeNull();
    expect(publish).toHaveBeenCalledWith("questions-changed", { threadId: "t", kind: "prompt-closed", roundId });
  });

  it("clears the open prompt from state when the round is submitted", async () => {
    const h = await setup();
    const publish = vi.spyOn(h.bb.realtime, "publish");
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Submit me?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const round = (await h.state()).rounds[0]!;
    expect((await h.state()).openRoundId).toBe(round.id);
    const q = round.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Done" });
    await h.submit([q.id]);
    expect(JSON.parse(await call as string).answers[0].answer.text).toBe("Done");
    expect((await h.state()).openRoundId).toBeNull();
    expect(publish).toHaveBeenCalledWith("questions-changed", { threadId: "t", kind: "prompt-closed", roundId: round.id });
    expect(h.harness.pendingInteractions).toHaveLength(0);
  });

  it("renews a detached prompt hourly and stops after user dismissal", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    vi.useFakeTimers();
    try {
      await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Much later?" }] }, { threadId: "t", projectId: "proj_t" });
      const first = h.harness.pendingInteractions[0]!.id;
      const q = (await h.state()).rounds[0]!.questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: "Late answer" });
      await vi.advanceTimersByTimeAsync(7_200_000);
      expect(h.harness.pendingInteractions).toHaveLength(1);
      expect(h.harness.pendingInteractions[0]!.id).not.toBe(first);
      h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
      await vi.advanceTimersByTimeAsync(7_200_000);
      expect(h.harness.pendingInteractions).toHaveLength(0);
      expect(h.send).not.toHaveBeenCalled();
      expect((await h.state()).answers[0]!.draft!.text).toBe("Late answer");
      await h.submit([q.id], "late-held");
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("retries an unavailable detached prompt and releases the retry before sending", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    const request = vi.spyOn(h.bb.ui, "requestInput").mockRejectedValueOnce(new Error("Another interaction is pending"));
    vi.useFakeTimers();
    try {
      await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "After another prompt?" }] }, { threadId: "t", projectId: "proj_t" });
      expect(h.harness.pendingInteractions).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.harness.pendingInteractions).toHaveLength(1);
      request.mockRejectedValue(new Error("Renewal unavailable"));
      await vi.advanceTimersByTimeAsync(3_600_000);
      const attempts = request.mock.calls.length;
      expect(h.harness.pendingInteractions).toHaveLength(0);
      const q = (await h.state()).rounds[0]!.questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: "Submit while retrying" });
      await h.submit([q.id], "retrying-prompt");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(attempts);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not restore a held prompt after reload; drafts and late message delivery survive", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Reload?" }] }, { threadId: "t", projectId: "proj_t" });
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Survives reload" });
    const replacement = await h.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    expect(replacement.harness.pendingInteractions).toHaveLength(0);
    const state = threadStateSchema.parse(await replacement.harness.behavior.callRpc("questions_state", { threadId: "t" }));
    expect(state.answers[0]!.draft!.text).toBe("Survives reload");
    await replacement.harness.behavior.callRpc("questions_submit", { threadId: "t", submissionId: uuid("after-reload"), items: [{ questionId: q.id, expectedVersion: 1 }] });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("releases a detached prompt when its thread is deleted", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Delete?" }] }, { threadId: "t", projectId: "proj_t" });
    await h.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "t" }) });
    expect(h.harness.pendingInteractions).toHaveLength(0);
    expect((await h.state()).rounds).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("ignores raw native form values without a validated submission", async () => {
    const h = await setup();
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Validate?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    h.harness.submitInteraction(h.harness.pendingInteractions[0]!.id, { submissionId: "forged" });
    expect(await call).toMatchObject({ isError: true });
    expect((await h.state()).submissions).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("renews without yielding to a late submission when no delivery is in flight", async () => {
    const h = await setup();
    const round = await h.ask([{ title: "After expiry?" }]);
    const q = round.questions[0]!;
    const requestInput = h.bb.ui.requestInput;
    let expire!: (result: Awaited<ReturnType<typeof requestInput>>) => void;
    let requests = 0;
    h.bb.ui.requestInput = (request, options) => ++requests === 1
      ? new Promise((resolve) => { expire = resolve; })
      : requestInput(request, options);
    const coordinator = new QuestionInteractions(h.bb);
    const call = coordinator.wait(round);
    const submission: Submission = {
      id: uuid("expiry-gap"), threadId: "t", state: "pending", questionIds: [q.id],
      snapshot: { [q.id]: { ...emptyAnswer(), text: "Late answer" } },
      error: null, createdAt: 1, settledAt: null, queuedMessageId: null,
    };
    expire({ outcome: "cancelled", reason: "timeout" });
    const confirmed = vi.fn();
    // This job runs immediately after the timeout continuation, before any
    // continuation created by an unnecessary await of undefined.
    const delivery = Promise.resolve().then(() => {
      expect(requests).toBe(2);
      expect(h.harness.pendingInteractions).toHaveLength(1);
      return coordinator.deliverToWaiter(submission, confirmed);
    });
    expect(await delivery).toBe(true);
    expect(await call).toBe(submission);
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
    expect(h.harness.pendingInteractions).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });
  it("submits through the renewed native interaction without a fallback message", async () => {
    const h = await setup();
    vi.useFakeTimers();
    try {
      const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Ready later?" }] }, { threadId: "t", projectId: "proj_t" });
      await vi.advanceTimersByTimeAsync(0);
      const q = (await h.state()).rounds[0]!.questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: "Ready" });
      await vi.advanceTimersByTimeAsync(3_600_000);
      await h.submit([q.id]);
      expect(JSON.parse(await call as string).answers[0].answer.text).toBe("Ready");
      expect(h.harness.pendingInteractions).toHaveLength(0);
      expect(h.send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("keeps message submission available if hourly renewal fails", async () => {
    const h = await setup();
    const requestInput = h.bb.ui.requestInput;
    let calls = 0;
    h.bb.ui.requestInput = (request, options) => ++calls === 1 ? requestInput(request, options) : Promise.reject(new Error("Renewal unavailable"));
    vi.useFakeTimers();
    try {
      const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Later?" }] }, { threadId: "t", projectId: "proj_t" });
      await vi.advanceTimersByTimeAsync(0);
      const q = (await h.state()).rounds[0]!.questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: "Kept" });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(await call).toMatchObject({ isError: true });
      expect(calls).toBe(2);
      await h.submit([q.id]);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not renew an interaction when the waiting call is aborted", async () => {
    const h = await setup();
    const controller = new AbortController();
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Cancel?" }] }, { threadId: "t", projectId: "proj_t", signal: controller.signal });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    controller.abort();
    expect(await call).toMatchObject({ isError: true });
    expect(h.harness.pendingInteractions).toHaveLength(0);
    expect((await h.state()).rounds).toHaveLength(1);
  });
  it("returns from CLI asks before answers on every provider, without a polling process", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: "" });
    const controller = new AbortController();
    const result = await h.harness.behavior.runCli(["ask", "CLI question?"], { threadId: "t", signal: controller.signal });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({ status: "waiting", instruction: expect.stringContaining("Do not poll") });
    controller.abort();
    expect(h.harness.pendingInteractions).toHaveLength(1);
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "CLI answer" });
    await h.submit([q.id]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.harness.pendingInteractions).toHaveLength(0);
    expect(h.harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ threadId: "t", input: [{ type: "text", text: expect.stringContaining("CLI answer") }] });
  });
  it("lets an all-optional round close with no answers", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Anything else?", optional: true }])).questions[0]!;
    await h.submit([q.id], "skip", 0);
    const state = (await h.state()).answers[0]!;
    expect(state.submitted).toEqual(emptyAnswer());
    expect(state.draft).toEqual(emptyAnswer());
    expect(await h.submit([q.id], "skip-again", 0)).toMatchObject({ outcome: "nothing" });
  });

  it("reads submitted images but never draft-only images", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Screenshot?", attachments: true }])).questions[0]!;
    await h.rpc("questions_upload_attachment", { threadId: "t", questionId: q.id, expectedVersion: 0, name: "test.png", mimeType: "image/png", dataBase64: "AQID" });
    const read = () => h.harness.behavior.callAgentTool("questions_image", { question: "Q1", path: "uploads/test.png" }, { threadId: "t", projectId: "proj_t" });
    expect(await read()).toMatchObject({ isError: true });
    await h.submit([q.id]);
    expect(await read()).toMatchObject({ content: [{ type: "image", mimeType: "image/png", data: "AQID" }] });
    expect(await h.harness.behavior.callAgentTool("questions_image", { question: "Q1", path: "uploads/test.png" }, { threadId: "other", projectId: "proj_other" })).toMatchObject({ isError: true });
  });

  it("renews hourly without returning to the agent, and cancellation stops renewal", async () => {
    const h = await setup();
    vi.useFakeTimers();
    try {
      const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Later?" }] }, { threadId: "t", projectId: "proj_t" });
      await vi.advanceTimersByTimeAsync(0);
      const q = (await h.state()).rounds[0]!.questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: "Kept" });
      const firstId = h.harness.pendingInteractions[0]!.id;
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(h.harness.pendingInteractions).toHaveLength(1);
      expect(h.harness.pendingInteractions[0]!.id).not.toBe(firstId);
      expect((await h.state()).rounds).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(h.harness.pendingInteractions).toHaveLength(1);
      h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
      expect(await call).toMatchObject({ isError: true });
      expect(h.harness.pendingInteractions).toHaveLength(0);
      expect((await h.state()).answers[0]!.draft!.text).toBe("Kept");
      expect(h.send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("delivers saved answers without using the native response API", async () => {
    const h = await setup();
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Submit?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Answer" });
    const result = call.then(async (text) => {
      expect((await h.state()).answers[0]!.submitted!.text).toBe("Answer");
      expect(h.harness.pendingInteractions).toHaveLength(0);
      return JSON.parse(text as string);
    });
    expect((await h.submit([q.id])).submission.state).toBe("sent");
    expect((await result).answers[0].answer.text).toBe("Answer");
    expect(h.harness.inspection.sdk.callsTo("threads.interactions.respond")).toHaveLength(0);
    // Only the ask preflight checks for an unrelated pending interaction.
    expect(h.harness.inspection.sdk.callsTo("threads.interactions.list")).toHaveLength(1);
    expect(h.send).not.toHaveBeenCalled();
  });
  it("waits in a one-hour native interaction and returns a whole round without sending a message", async () => {
    const h = await setup();
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Required?" }, { title: "Optional?", optional: true }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const pending = h.harness.pendingInteractions[0]!;
    expect(pending.timeoutMs).toBe(3_600_000);
    const round = (await h.state()).rounds[0]!;
    expect(round.questions.map((q) => q.optional)).toEqual([false, true]);
    await expect(h.rpc("questions_submit", { threadId: "t", submissionId: uuid("missing"), items: round.questions.map((q) => ({ questionId: q.id, expectedVersion: 0 })) })).rejects.toThrow("required question");
    await h.save(round.questions[0]!, { ...emptyAnswer(), text: "Ready" });
    const result = await h.rpc("questions_submit", { threadId: "t", submissionId: uuid("native"), items: round.questions.map((q, i) => ({ questionId: q.id, expectedVersion: i === 0 ? 1 : 0 })) });
    expect(result).toMatchObject({ outcome: "submitted", submission: { state: "sent" } });
    const returned = JSON.parse(await call as string);
    expect(returned.answers[0].answer.text).toBe("Ready");
    expect(returned.answers[1].answer).toEqual(emptyAnswer());
    expect((await h.state()).answers).toHaveLength(2);
    expect((await h.state()).answers.every((a) => a.submitted !== null)).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.harness.pendingInteractions).toHaveLength(0);
  });

  it("keeps drafts after cancellation and delivers a later complete round as a message", async () => {
    const h = await setup();
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Later?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Saved draft" });
    h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
    expect(await call).toMatchObject({ isError: true });
    expect((await h.state()).answers[0]!.draft!.text).toBe("Saved draft");
    await h.submit([q.id]);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("does not create another round when native asks start concurrently", async () => {
    const h = await setup();
    const first = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "First?" }] }, { threadId: "t", projectId: "proj_t" });
    const second = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Second?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    expect(await second).toMatchObject({ isError: true });
    expect((await h.state()).rounds).toHaveLength(1);
    h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
    await first;
  });
  it("passes a lowercase query to BB's fuzzy path search", async () => {
    const h = await setup();
    await h.rpc("questions_search_paths", { threadId: "t", query: "  Agents  " });
    expect(h.harness.inspection.sdk.callsTo("environments.paths").at(-1)?.[0]).toMatchObject({ query: "agents", limit: "20" });
  });
  it("rejects the retired partial retry API", async () => {
    const h = await setup();
    await expect(h.rpc("questions_submit", { threadId: "t", submissionId: uuid("retired"), items: [], retryOf: "old" })).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("keeps an empty Other selection as a draft without submitting an empty answer", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Choose?", options: ["A"] }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), other: true });
    expect((await h.state()).answers[0]!.draft?.other).toBe(true);
    await expect(h.submit([q.id])).rejects.toThrow("required question");
    await expect(h.save(q, { ...emptyAnswer(), other: true, selected: ["o1"] }, 1)).rejects.toThrow("Other cannot be combined");
  });

  it("does not send blank file searches to the host", async () => {
    const h = await setup();
    expect(await h.rpc("questions_search_paths", { threadId: "t", query: "  " })).toMatchObject({ hits: [], unavailable: null });
    expect(h.harness.inspection.sdk.callsTo("environments.paths")).toHaveLength(0);
  });

  it("migrates the old display mode without changing rounds or answers", async () => {
    const draft = { ...emptyAnswer(), text: "Unsent edit " };
    const submitted = { ...emptyAnswer(), text: "Original answer" };
    const h = await setup(({ bb }) => {
      const db = bb.storage.database();
      bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("mode = 'panel'"))));
      db.prepare("INSERT INTO rounds VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy", "t", "proj_t", 1, "notebook", "Keep this", "[]", 123);
      db.prepare("INSERT INTO answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy-q", "t", "legacy", JSON.stringify(draft), 7, JSON.stringify(submitted), 456, "legacy-s", 789);
    });
    const migrated = await h.state();
    expect(migrated.rounds[0]).toMatchObject({ id: "legacy", mode: "panel", number: 1, intro: "Keep this", createdAt: 123 });
    expect(migrated.answers[0]).toMatchObject({ questionId: "legacy-q", draft, submitted, version: 7, submittedAt: 456, submissionId: "legacy-s" });
    expect((await h.ask([{ title: "New panel round?" }])).mode).toBe("panel");
    await expect(h.harness.behavior.callAgentTool("questions_ask", { mode: "notebook", questions: [{ title: "Old mode?" }] }, { threadId: "t" })).rejects.toThrow("Invalid option");
    const beforeReload = await h.state();
    const replacement = await h.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    expect(threadStateSchema.parse(await replacement.harness.behavior.callRpc("questions_state", { threadId: "t" }))).toEqual(beforeReload);
  });

  it("accepts more than 200 panel questions but refuses six inline questions", async () => {
    const h = await setup();
    expect((await h.ask(Array.from({ length: 201 }, (_, i) => ({ title: `Question ${i}?` })))).questions).toHaveLength(201);
    const result = await h.harness.behavior.callAgentTool("questions_ask", { mode: "inline", questions: Array.from({ length: 6 }, () => ({ title: "Quick?" })) }, { threadId: "t", projectId: "proj_t" });
    expect(result).toMatchObject({ isError: true });
    expect((await h.state()).rounds).toHaveLength(1);
    const advanced = await h.harness.behavior.callAgentTool("questions_ask", { mode: "inline", questions: [{ title: "Quick?", help: "Extra context" }] }, { threadId: "t", projectId: "proj_t" });
    expect(advanced).toMatchObject({ isError: true });
    expect((await h.state()).rounds).toHaveLength(1);
  });

  it("scopes rounds, references and writes to the owning thread", async () => {
    const h = await setup();
    const first = await h.ask([{ title: "First?" }]);
    const other = await h.ask([{ title: "Other?" }], "other");
    expect(first.questions[0]!.id).not.toBe(other.questions[0]!.id);
    await expect(h.save(first.questions[0]!, { ...emptyAnswer(), text: "wrong thread" }, 0, "other")).rejects.toThrow("Unknown question");
    const result = await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Cross thread?", cites: [first.questions[0]!.id] }] }, { threadId: "other", projectId: "proj_other" });
    expect(result).toMatchObject({ isError: true });
    expect((await h.state("other")).rounds).toHaveLength(1);
  });

  it("preserves whitespace and rejects stale saves without discarding either draft", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Draft?", options: ["A", "B"] }])).questions[0]!;
    const draft = { ...emptyAnswer(), selected: ["o1"], text: "Hello \n", details: { o1: "Because \n" } };
    expect(await h.save(q, draft)).toMatchObject({ outcome: "saved", state: { version: 1, draft } });
    expect(await h.save(q, { ...emptyAnswer(), text: "Other device" })).toMatchObject({ outcome: "conflict", state: { draft } });
    expect((await h.state()).answers[0]!.draft).toEqual(draft);
    const read = await h.harness.behavior.callAgentTool("questions_read", {}, { threadId: "t" });
    expect(String(read)).not.toContain("Hello");
    expect(await h.harness.behavior.runCli(["state"], { threadId: "t" })).toMatchObject({ exitCode: 1 });
  });

  it("submits a complete round once, freezes its snapshot, and ignores unchanged resubmissions", async () => {
    const h = await setup();
    const [a, b] = (await h.ask([{ title: "A?" }, { title: "B?" }])).questions;
    await h.save(a!, { ...emptyAnswer(), text: "A" });
    await h.save(b!, { ...emptyAnswer(), text: "B" });
    await expect(h.submit([a!.id])).rejects.toThrow("complete round");
    const result = await h.submit([a!.id, a!.id, b!.id]);
    expect(result.submission.state).toBe("sent");
    expect(result.submission.questionIds).toEqual([a!.id, b!.id]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.harness.inspection.sdk.callsTo("threads.send")[0]![0]).toMatchObject({ threadId: "t", mode: "queue-if-active", input: [{ type: "text", text: expect.stringContaining(`submission ${uuid("s1")}`) }] });
    await h.submit([a!.id]);
    expect(await h.submit([a!.id, b!.id], "s2")).toMatchObject({ outcome: "nothing" });
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.save(a!, { ...emptyAnswer(), text: "Unsent change" }, 1);
    const state = await h.state();
    expect(state.answers.find((item) => item.questionId === a!.id)!.submitted!.text).toBe("A");
    expect(state.answers.find((item) => item.questionId === b!.id)!.submitted!.text).toBe("B");
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("blocks overlapping sends while keeping edits made during delivery", async () => {
    const h = await setup();
    let finish!: (value: { ok: boolean; delivery: string }) => void;
    h.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "First" });
    const first = h.submit([q.id]);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await h.save(q, { ...emptyAnswer(), text: "New draft" }, 1);
    expect(await h.submit([q.id], "s2", 2)).toMatchObject({ outcome: "in-flight" });
    finish({ ok: true, delivery: "sent" });
    await first;
    expect((await h.state()).answers[0]).toMatchObject({ version: 2, draft: { text: "New draft" }, submitted: { text: "First" } });
  });

  it("records uncertain delivery and resubmits only after a new complete-round request", async () => {
    const h = await setup();
    h.send.mockRejectedValueOnce(new Error("response lost"));
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Original" });
    expect((await h.submit([q.id])).submission.state).toBe("uncertain");
    await h.submit([q.id]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((await h.state()).answers[0]!.submitted).toBeNull();
    await h.save(q, { ...emptyAnswer(), text: "Newer edit" }, 1);
    const retry = await h.submit([q.id], "s_retry", 2);
    expect(retry.submission.snapshot[q.id]!.text).toBe("Newer edit");
    expect((await h.state()).answers[0]!.draft!.text).toBe("Newer edit");
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("keeps drafts and changes interrupted pending delivery to uncertain on reload", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Saved" });
    await h.submit([q.id]);
    h.bb.storage.database().prepare("UPDATE submissions SET state = 'pending' WHERE id = ?").run(uuid("s1"));
    const replacement = await h.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    const state = threadStateSchema.parse(await replacement.harness.behavior.callRpc("questions_state", { threadId: "t" }));
    expect(state.submissions[0]!.state).toBe("uncertain");
    expect(state.answers[0]!.draft!.text).toBe("Saved");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("uploads real bytes, sends image inputs and denies forged attachment paths", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Evidence?", attachments: true }])).questions[0]!;
    await h.rpc("questions_upload_attachment", { threadId: "t", questionId: q.id, expectedVersion: 0, name: "image.png", mimeType: "image/png", dataBase64: "AQID" });
    expect(h.harness.inspection.sdk.callsTo("projects.attachments.upload")[0]![0]).toMatchObject({ projectId: "proj_t", filename: "image.png", clientFile: new Uint8Array([1, 2, 3]) });
    await h.submit([q.id]);
    expect(h.harness.inspection.sdk.callsTo("threads.send")[0]![0]).toMatchObject({ input: [expect.anything(), { type: "localImage", path: "uploads/test.png" }] });
    const draft = (await h.state()).answers[0]!.draft!;
    await expect(h.save(q, { ...draft, attachments: [{ ...draft.attachments[0]!, path: "/secrets" }] }, 1)).rejects.toThrow("Unknown attachment");
    await expect(h.rpc("questions_attachment_preview", { threadId: "t", questionId: q.id, path: "/secrets" })).rejects.toThrow("Unknown attachment");
  });

  it("validates optional controls, reference workspace and URL schemes", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "References?", references: true, confidence: true }])).questions[0]!;
    const reference = { kind: "workspace" as const, environmentId: "env_t", hostId: "host_env_t", path: "src/app.ts", entryKind: "file" as const };
    await h.save(q, { ...emptyAnswer(), text: "Reference answer", references: [reference], confidence: "high" });
    await h.submit([q.id]);
    const read = String(await h.harness.behavior.callAgentTool("questions_read", {}, { threadId: "t" }));
    expect(read).toContain("src/app.ts");
    expect(read).toContain('"confidence":"high"');
    await expect(h.save(q, { ...emptyAnswer(), references: [{ ...reference, environmentId: "other" }] }, 1)).rejects.toThrow("does not belong");
    await expect(h.save(q, { ...emptyAnswer(), references: [{ kind: "url", url: "javascript:alert(1)" }] }, 1)).rejects.toThrow();
    const plain = (await h.ask([{ title: "Plain?" }])).questions[0]!;
    await expect(h.save(plain, { ...emptyAnswer(), confidence: "high" })).rejects.toThrow("does not offer");
  });

  it("reads JSON on the invoking machine even when the target thread differs", async () => {
    const h = await setup();
    const call = h.harness.behavior.runCli(["ask", "--thread", "other", "--file", "questions.json", "--json"], { threadId: "caller", cwd: "/workspace" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const q = (await h.state("other")).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Remote answer" }, 0, "other");
    await h.rpc("questions_submit", { threadId: "other", submissionId: uuid("remote"), items: [{ questionId: q.id, expectedVersion: 1 }] });
    const result = await call;
    expect(result.exitCode).toBe(0);
    expect(h.harness.inspection.sdk.callsTo("files.read")[0]![0]).toMatchObject({ hostId: "host_env_caller", path: "/workspace/questions.json" });
    expect((await h.state("other")).rounds[0]!.questions[0]!.title).toBe("Remote JSON?");
    const missing = await h.harness.behavior.runCli(["ask", "--thread", "other", "--file", "/questions.json"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--host");
  });

  it("does not hide corrupt persisted answers", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Saved" });
    h.bb.storage.database().prepare("UPDATE answers SET draft_json = '{}' WHERE question_id = ?").run(q.id);
    await expect(h.state()).rejects.toThrow("not readable");
  });

  it("removes only the deleted thread's question data", async () => {
    const h = await setup();
    await h.ask([{ title: "Delete this?" }]);
    await h.ask([{ title: "Keep this?" }], "other");
    await h.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "t" }) });
    expect((await h.state()).rounds).toEqual([]);
    expect((await h.state("other")).rounds).toHaveLength(1);
  });

  it("paginates complete submitted answers without exposing drafts", async () => {
    const h = await setup();
    const round = await h.ask(Array.from({ length: 30 }, (_, i) => ({ title: `Large ${i}?` })));
    for (const q of round.questions) await h.save(q, { ...emptyAnswer(), text: q.id + "x".repeat(19_900) });
    await h.submit(round.questions.map((q) => q.id));
    const read = String(await h.harness.behavior.callAgentTool("questions_read", {}, { threadId: "t" }));
    const after = read.match(/after="([^"]+)"/)?.[1];
    expect(after).toBeTruthy();
    const next = String(await h.harness.behavior.callAgentTool("questions_read", { after }, { threadId: "t" }));
    expect(next).toContain(round.questions.at(-1)!.id);
    const records = [...read.split("\n"), ...next.split("\n")].filter((line) => line.startsWith("{"));
    expect(records).toHaveLength(30);
    for (const line of records) expect(JSON.parse(line).submitted.text.length).toBeGreaterThan(19_900);
  });

  it("keeps unresolved delivery visible after more than 20 unrelated submissions", async () => {
    const h = await setup();
    h.send.mockRejectedValueOnce(new Error("lost response"));
    for (let i = 0; i < 23; i++) {
      const q = (await h.ask([{ title: `Answer ${i}?` }])).questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: `Answer ${i}` });
      await h.submit([q.id], `history_${i}`);
    }
    const state = await h.state();
    expect(state.submissions).toHaveLength(21);
    expect(state.submissions.find((s) => s.id === uuid("history_0"))!.state).toBe("uncertain");
  });

  it("reads a stored summary until the next write moves it into thread metadata", async () => {
    const h = await setup();
    const store = new QuestionsStore(h.bb.storage.database());
    store.setLegacySummary("t", "Stored before metadata existed", 5);
    expect((await h.state()).summary).toEqual({ markdown: "Stored before metadata existed", updatedAt: 5 });
    expect(h.metadata.has("t")).toBe(false);

    expect(await h.harness.behavior.callAgentTool("questions_summary", { summary: "# Goal\nShip it" }, { threadId: "t", projectId: "proj_t" })).toBe("Summary updated.");
    expect(h.metadata.get("t")).toEqual({ summary: { markdown: "# Goal\nShip it", updatedAt: expect.any(Number), version: 1 } });
    expect(store.getLegacySummary("t")).toBeNull();
    expect((await h.state()).summary?.markdown).toBe("# Goal\nShip it");
    expect(await h.harness.behavior.runCli(["summary", "show"], { threadId: "t" })).toMatchObject({ exitCode: 0, stdout: "# Goal\nShip it" });

    // Metadata wins over a lingering legacy row, and clearing removes only our key.
    store.setLegacySummary("t", "Stale copy", 1);
    h.metadata.set("t", { ...h.metadata.get("t"), other: { plugin: "data" } });
    expect((await h.state()).summary?.markdown).toBe("# Goal\nShip it");
    expect(await h.harness.behavior.callAgentTool("questions_summary", { summary: null }, { threadId: "t", projectId: "proj_t" })).toBe("Summary cleared.");
    expect(h.metadata.get("t")).toEqual({ other: { plugin: "data" } });
    expect(store.getLegacySummary("t")).toBeNull();
    expect((await h.state()).summary).toBeNull();
    expect(h.harness.inspection.sdk.callsTo("threads.updatePluginMetadata").at(-1)?.[0]).toMatchObject({ threadId: "t", remove: ["summary"] });
  });

  it("treats a malformed or oversized metadata summary as absent", async () => {
    const h = await setup();
    h.metadata.set("t", { summary: { markdown: 42, updatedAt: 1, version: 1 } });
    expect((await h.state()).summary).toBeNull();
    h.metadata.set("t", { summary: { markdown: "x".repeat(LIMITS.summaryChars + 1), updatedAt: 1, version: 1 } });
    expect((await h.state()).summary).toBeNull();
    h.metadata.set("t", { summary: { markdown: "future", updatedAt: 1, version: 2 } });
    expect((await h.state()).summary).toBeNull();
    expect(await h.harness.behavior.callAgentTool("questions_summary", { summary: "x".repeat(LIMITS.summaryChars + 1) }, { threadId: "t", projectId: "proj_t" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("8000") }] });
    expect(await h.harness.behavior.runCli(["summary", "set", "y".repeat(LIMITS.summaryChars + 1)], { threadId: "t" })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("8000") });
  });

  it("backfills stored summaries into thread metadata once", async () => {
    const h = await setup();
    const store = new QuestionsStore(h.bb.storage.database());
    store.setLegacySummary("a", "Summary A", 10);
    store.setLegacySummary("b", "Summary B", 20);
    store.setLegacySummary("gone", "Summary for a deleted thread", 30);
    h.metadata.set("b", { summary: { markdown: "Newer B", updatedAt: 25, version: 1 } });
    h.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => {
      if (threadId === "gone") throw new Error("Thread not found");
      return structuredClone(h.metadata.get(threadId) ?? {});
    });

    const dry = await h.harness.behavior.runCli(["summary", "backfill", "--dry-run", "--json"]);
    expect(JSON.parse(dry.stdout ?? "")).toEqual({ dryRun: true, total: 3, migrated: ["a"], kept: ["b"], failed: [{ threadId: "gone", error: "Thread not found" }] });
    expect(h.metadata.has("a")).toBe(false);
    expect(store.listLegacySummaries()).toHaveLength(3);

    const run = await h.harness.behavior.runCli(["summary", "backfill"]);
    expect(run).toMatchObject({ exitCode: 1 });
    expect(run.stdout).toContain("moved 1 into thread metadata, 1 already there, 1 failed.");
    expect(run.stdout).toContain("gone: Thread not found");
    expect(h.metadata.get("a")).toEqual({ summary: { markdown: "Summary A", updatedAt: 10, version: 1 } });
    expect(h.metadata.get("b")).toEqual({ summary: { markdown: "Newer B", updatedAt: 25, version: 1 } });
    expect(store.listLegacySummaries().map((row) => row.threadId)).toEqual(["gone"]);

    const again = await h.harness.behavior.runCli(["summary", "backfill"]);
    expect(again).toMatchObject({ exitCode: 1, stdout: expect.stringContaining("1 stored summary: moved 0") });
  });

  it("reads the summary through the tool when no summary argument is given", async () => {
    const h = await setup();
    expect(await h.harness.behavior.callAgentTool("questions_summary", {}, { threadId: "t", projectId: "proj_t" })).toBe("No summary recorded for this thread.");

    await h.harness.behavior.callAgentTool("questions_summary", { summary: "Earlier note" }, { threadId: "t", projectId: "proj_t" });
    expect(await h.harness.behavior.callAgentTool("questions_summary", {}, { threadId: "t", projectId: "proj_t" })).toBe("Earlier note");
    expect(await h.harness.behavior.callAgentTool("questions_summary", {}, { threadId: "other", projectId: "proj_other" })).toBe("No summary recorded for this thread.");

    await h.harness.behavior.callAgentTool("questions_summary", { summary: null }, { threadId: "t", projectId: "proj_t" });
    expect(await h.harness.behavior.callAgentTool("questions_summary", {}, { threadId: "t", projectId: "proj_t" })).toBe("No summary recorded for this thread.");
  });

  it("cancels a queued submission when its message is removed and lets the user resubmit", async () => {
    const h = await setup();
    const round = await h.ask([{ title: "Queued?" }]);
    const q = round.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Queued answer" });
    h.send.mockImplementationOnce(async () => ({ ok: true, delivery: "queued", queuedMessage: makeQueueEntry({ id: "qm_1", threadId: "t" }) }) as { ok: boolean; delivery: string });
    const first = await h.submit([q.id], "queued");
    expect(first.submission).toMatchObject({ state: "queued", queuedMessageId: "qm_1" });
    expect((await h.state()).answers[0]!.submitted?.text).toBe("Queued answer");

    await h.harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "qm_other", threadId: "t" }) });
    await h.harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "qm_1", threadId: "other" }) });
    expect((await h.state()).submissions[0]!.state).toBe("queued");

    await h.harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "qm_1", threadId: "t" }) });
    let state = await h.state();
    expect(state.submissions[0]).toMatchObject({ state: "cancelled", error: expect.stringContaining("removed before the agent"), snapshot: { [q.id]: { text: "Queued answer" } } });
    expect(state.answers[0]).toMatchObject({ submitted: null, submissionId: null, submittedAt: null, draft: { text: "Queued answer" } });
    expect(actionableFailures(state.submissions).map((item) => item.state)).toEqual(["cancelled"]);
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "qm_1", threadId: "t" }) });
    expect((await h.state()).submissions).toHaveLength(1);

    const again = await h.submit([q.id], "resent");
    expect(again.submission.state).toBe("sent");
    expect(h.send).toHaveBeenCalledTimes(2);
    state = await h.state();
    expect(actionableFailures(state.submissions)).toEqual([]);
    expect(state.answers[0]!.submissionId).toBe(uuid("resent"));
  });

  it("reopens only the held round's prompt when its thread is unarchived", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    const requestInput = h.bb.ui.requestInput;
    let settle!: (result: Awaited<ReturnType<typeof requestInput>>) => void;
    let calls = 0;
    h.bb.ui.requestInput = (request, options) => ++calls === 1
      ? new Promise((resolve) => { settle = resolve; })
      : requestInput(request, options);
    await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Held?" }] }, { threadId: "t", projectId: "proj_t" });
    const held = (await h.state()).rounds[0]!;
    // A later round that never held a prompt must stay quiet on unarchive.
    await h.ask([{ title: "Never held?" }]);

    // Archiving an active thread interrupts the open prompt like a stop does.
    settle({ outcome: "cancelled", reason: "thread-stopped" });
    const store = new QuestionsStore(h.bb.storage.database());
    expect(store.getOpenHoldRound("t")).toBe(held.id);

    // Emit until the hold teardown finishes and the unarchive reopens it.
    await vi.waitFor(async () => {
      await h.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "t" }) });
      expect(h.harness.pendingInteractions).toHaveLength(1);
    });
    expect(h.harness.pendingInteractions[0]!.payload).toEqual({ roundId: held.id });

    // Unarchiving again while the hold is alive does not duplicate it.
    await h.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "t" }) });
    expect(h.harness.pendingInteractions).toHaveLength(1);

    // A user dismissal ends the hold; later unarchives reopen nothing.
    h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
    await vi.waitFor(() => expect(store.getOpenHoldRound("t")).toBeNull());
    await h.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "t" }) });
    expect(h.harness.pendingInteractions).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not reopen the prompt once the held round was submitted", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    const requestInput = h.bb.ui.requestInput;
    let settle!: (result: Awaited<ReturnType<typeof requestInput>>) => void;
    let calls = 0;
    h.bb.ui.requestInput = (request, options) => ++calls === 1
      ? new Promise((resolve) => { settle = resolve; })
      : requestInput(request, options);
    await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Held?" }] }, { threadId: "t", projectId: "proj_t" });
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Answered while archived" });

    settle({ outcome: "cancelled", reason: "thread-stopped" });
    await h.submit([q.id], "archived-answer");
    expect(h.send).toHaveBeenCalledTimes(1);
    const store = new QuestionsStore(h.bb.storage.database());
    expect(store.getOpenHoldRound("t")).toBeNull();

    await h.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "t" }) });
    expect(h.harness.pendingInteractions).toHaveLength(0);
  });

  it("keeps the open-hold marker across a reload so unarchive can still reopen it", async () => {
    const h = await setup();
    await h.harness.behavior.setSettings({ nonBlockingProviders: (await h.bb.sdk.threads.get({ threadId: "t" })).providerId });
    const requestInput = h.bb.ui.requestInput;
    let settle!: (result: Awaited<ReturnType<typeof requestInput>>) => void;
    let calls = 0;
    h.bb.ui.requestInput = (request, options) => ++calls === 1
      ? new Promise((resolve) => { settle = resolve; })
      : requestInput(request, options);
    await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Held?" }] }, { threadId: "t", projectId: "proj_t" });
    const held = (await h.state()).rounds[0]!;

    settle({ outcome: "cancelled", reason: "thread-stopped" });
    const store = new QuestionsStore(h.bb.storage.database());
    expect(store.getOpenHoldRound("t")).toBe(held.id);
    const replacement = await h.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    expect(replacement.harness.pendingInteractions).toHaveLength(0);

    await replacement.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "t" }) });
    expect(replacement.harness.pendingInteractions).toHaveLength(1);
    expect(replacement.harness.pendingInteractions[0]!.payload).toEqual({ roundId: held.id });
  });

  it("uses only public SDK imports", async () => {
    const result = experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, { allow: [
      /^react(?:-dom)?(?:\/.*)?$/, /^@radix-ui\//,
      /^@\/(?:components|lib|hooks)\/[\w/-]+$/, /^@testing-library\/react$/,
      /^(?:class-variance-authority|clsx|tailwind-merge|better-sqlite3|sonner|vaul)$/,
      /^vitest(?:\/.*)?$/,
    ] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
