import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { MIGRATIONS, QuestionsStore } from "../server/store";
import { QuestionsService } from "../server/service";
import { emptyAnswer, threadStateSchema, type Answer, type Question, type Submission } from "../lib/model";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const ids = new Map<string, string>();
function uuid(label: string): string {
  if (!ids.has(label)) ids.set(label, randomUUID());
  return ids.get(label)!;
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup(beforePlugin?: (host: ReturnType<typeof createFakePluginHost>) => void) {
  const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));
  const host = createFakePluginHost({
    pluginId: "questions",
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: `proj_${threadId}`, environmentId: `env_${threadId}` }),
        send,
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
  host.harness.sdk.stub("threads.interactions.respond", async ({ interactionId, value }: { interactionId: string; value: any }) => {
    host.harness.submitInteraction(interactionId, value);
    return { status: "resolved" };
  });
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
  return { ...host, send, rpc, state, ask, save, submit };
}

describe("Questions backend", () => {
  it.each([true, false])("settles a response crossing hourly expiry before renewing, accepted=%s", async (accepted) => {
    const h = await setup();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const respond = vi.fn(async () => {
      await gate;
      if (!accepted) throw new Error("Response rejected after expiry");
      return { status: "resolved" };
    });
    h.harness.sdk.stub("threads.interactions.respond", respond);
    vi.useFakeTimers();
    try {
      const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "At expiry?" }] }, { threadId: "t", projectId: "proj_t" });
      await vi.advanceTimersByTimeAsync(0);
      const q = (await h.state()).rounds[0]!.questions[0]!;
      await h.save(q, { ...emptyAnswer(), text: "Kept" });
      const submission = h.submit([q.id]);
      await vi.advanceTimersByTimeAsync(0);
      expect(respond).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(h.harness.pendingInteractions).toHaveLength(0);
      finish();
      await submission;
      await vi.advanceTimersByTimeAsync(0);
      if (accepted) {
        expect(JSON.parse(await call as string).answers[0].answer.text).toBe("Kept");
        expect(h.harness.pendingInteractions).toHaveLength(0);
        expect((await h.state()).answers[0]!.submitted!.text).toBe("Kept");
      } else {
        expect(h.harness.pendingInteractions).toHaveLength(1);
        expect((await h.state()).answers[0]!.submitted).toBeNull();
        h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
        await call;
      }
      expect(h.send).not.toHaveBeenCalled();
    } finally { finish(); vi.useRealTimers(); }
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
  it("uses native waiting for CLI asks", async () => {
    const h = await setup();
    const call = h.harness.behavior.runCli(["ask", "CLI question?"], { threadId: "t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "CLI answer" });
    await h.submit([q.id]);
    expect(await call).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("CLI answer") });
    expect(h.send).not.toHaveBeenCalled();
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

  it("never falls back to a message after an uncertain native response", async () => {
    const h = await setup();
    const call = h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Submit?" }] }, { threadId: "t", projectId: "proj_t" });
    await vi.waitFor(() => expect(h.harness.pendingInteractions).toHaveLength(1));
    const q = (await h.state()).rounds[0]!.questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Answer" });
    h.harness.sdk.stub("threads.interactions.respond", async () => { throw new Error("Lost response"); });
    expect((await h.submit([q.id])).submission.state).toBe("uncertain");
    expect(h.send).not.toHaveBeenCalled();
    expect((await h.state()).answers[0]!.submitted).toBeNull();
    h.harness.cancelInteraction(h.harness.pendingInteractions[0]!.id);
    await call;
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
      bb.storage.migrate(db, MIGRATIONS.slice(0, -1));
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

  it("uses only public SDK imports", async () => {
    const result = experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, { allow: [
      /^react(?:-dom)?(?:\/.*)?$/, /^@radix-ui\//, /^@hugeicons\//,
      /^@\/(?:components|lib|hooks)\/[\w/-]+$/, /^@testing-library\/react$/,
      /^(?:class-variance-authority|clsx|tailwind-merge|better-sqlite3|sonner|vaul)$/,
      /^vitest(?:\/.*)?$/,
    ] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
