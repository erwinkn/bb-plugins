import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { COORDINATOR_MODE_SERVER_TOOLS } from "./server.ts";
import { COORDINATOR_TITLE_PREFIX } from "./coordinator/prompts.ts";
import { formatRequestMessage, userRequestEnvelopeSchema, type UserRequestEnvelope } from "./coordinator/envelopes.ts";

type Any = any;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A fake BB with one connected machine, a personal project, an available
 * provider, and recording thread stubs. `world` lets tests fail specific SDK
 * calls or inspect what the coordinator received.
 */
function fakeWorld(options: { providerAvailable?: boolean; spawnFails?: "before" | "after" | null } = {}) {
  const world = {
    threads: new Map<string, Any>(),
    sends: [] as { threadId: string; mode: string; text: string }[],
    stops: [] as string[],
    spawns: 0,
    queued: new Map<string, Any[]>(),
    timelineText: new Map<string, string>(),
    opened: [] as string[],
  };
  const spawn = async (args: Any) => {
    world.spawns += 1;
    if (options.spawnFails === "before") throw new Error("network down");
    const thread = makeThreadResponse({
      id: `thr_coord${world.spawns}`,
      title: args.title,
      projectId: args.projectId,
      visibility: args.visibility,
      environmentId: "env_personal",
      originPluginId: args.originPluginId,
      status: "active",
    });
    world.threads.set(thread.id, { ...thread, spawnArgs: args });
    if (options.spawnFails === "after") throw new Error("timeout after create");
    return thread;
  };
  const sdk: Any = {
    projects: { list: async () => [
      { id: "proj_personal", kind: "personal", name: "Personal", sources: [{ hostId: "host_a", isDefault: true }] },
      { id: "proj_app", kind: "standard", name: "App", sources: [{ hostId: "host_a", isDefault: true }] },
    ] },
    hosts: { list: async () => [{ id: "host_a", name: "Mac", status: "connected" }, { id: "host_b", name: "Studio", status: "disconnected" }] },
    providers: {
      list: async () => [{ id: "codex", displayName: "Codex", available: options.providerAvailable ?? true }, { id: "claude-code", displayName: "Claude Code", available: true }],
      models: async ({ providerId }: Any) => ({ modelLoadError: null, models: providerId === "codex" ? [{ id: "gpt-a", model: "gpt-a", displayName: "A", isDefault: false }, { id: "gpt-b", model: "gpt-b", displayName: "B", isDefault: true }] : [{ id: "opus", model: "opus", displayName: "Opus", isDefault: true }] }),
    },
    threads: {
      spawn,
      get: async ({ threadId }: Any) => { const t = world.threads.get(threadId); if (!t) throw new Error(`no thread ${threadId}`); return t; },
      list: async (args: Any) => [...world.threads.values()].filter((t) => (!args?.originPluginId || t.originPluginId === args.originPluginId) && (args?.includeHidden || t.visibility !== "hidden")),
      send: async ({ threadId, mode, input }: Any) => {
        world.sends.push({ threadId, mode, text: input[0].text });
        const thread = world.threads.get(threadId);
        if (thread && thread.status === "active") {
          const row = { id: `qm_${world.sends.length}`, content: input, threadId };
          world.queued.set(threadId, [...(world.queued.get(threadId) ?? []), row]);
          return { ok: true, delivery: "queued", queuedMessage: row };
        }
        return { ok: true, delivery: "sent" };
      },
      stop: async ({ threadId }: Any) => { world.stops.push(threadId); return { ok: true }; },
      open: async ({ threadId }: Any) => { world.opened.push(threadId); return { delivered: 1 }; },
      queuedMessages: { list: async ({ threadId }: Any) => world.queued.get(threadId) ?? [] },
      timeline: async ({ threadId }: Any) => ({ text: world.timelineText.get(threadId) ?? "" }),
      interactions: { list: async () => [], cancel: async () => ({}) },
      output: async () => ({ output: null }),
    },
    plugins: { list: async () => ({ plugins: [] }), getSettings: async () => ({ values: {} }) },
  };
  return { world, sdk };
}

async function enabledHost(options: Parameters<typeof fakeWorld>[0] = {}) {
  const { world, sdk } = fakeWorld(options);
  const { bb, harness } = createFakePluginHost({ pluginId: "voice-mode", sdk, settings: { openaiApiKey: "sk-test" } });
  await bb.storage.kv.set("config", { coordinator: { enabled: true, providerId: "codex", model: null, reasoningLevel: null, hostId: null } });
  await plugin(bb);
  const rpc = (method: string, input?: unknown) => harness.behavior.callRpc(method, input) as Promise<Any>;
  const claim = async (nonce: string, extra: Record<string, unknown> = {}) => rpc("claimCall", { nonce, threadId: "thr_view", projectId: "proj_app", ...extra });
  const envelope = (conversationId: string, nonce: string, requestId: string, text: string, extra: Partial<UserRequestEnvelope> = {}): UserRequestEnvelope => ({
    v: 1, conversationId, callNonce: nonce, callSequence: 1, requestId, utteranceItemIds: ["item_1"], transcriptRevision: 1, transcriptAvailable: true,
    originalText: text, transcriptDelta: [{ itemId: "item_1", text }], interpretation: null, urgency: "new", answersQuestionId: null,
    view: { threadId: "thr_view", projectId: "proj_app", onNewThreadScreen: false }, ...extra,
  });
  const coordinatorId = () => [...world.threads.keys()].find((id) => id.startsWith("thr_coord"))!;
  /**
   * The coordinator's turn ends. Like BB, the idle event still counts rows
   * queued behind the turn; they dispatch right after, so the thread goes
   * active again when any were waiting.
   */
  const idle = async (threadId: string, text: string | null = "Done.") => {
    const thread = world.threads.get(threadId);
    const queuedMessageCount = world.queued.get(threadId)?.length ?? 0;
    thread.status = "idle";
    thread.queuedMessageCount = 0;
    world.queued.delete(threadId);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ ...thread, status: "idle", queuedMessageCount }), lastAssistantText: text });
    await settle();
    if (queuedMessageCount > 0) thread.status = "active";
  };
  const replies = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "voice-reply").map((signal) => signal.payload as Any);
  return { bb, harness, world, rpc, claim, envelope, coordinatorId, idle, replies };
}

test("envelope validation rejects unknown fields and formats original words before the interpretation", () => {
  const base: UserRequestEnvelope = {
    v: 1, conversationId: "c", callNonce: "n", callSequence: 1, requestId: "r1", utteranceItemIds: ["a"], transcriptRevision: 2, transcriptAvailable: true,
    originalText: "I think we can archive it. Nothing remains, right?", transcriptDelta: [{ itemId: "a", text: "I think we can archive it. Nothing remains, right?" }],
    interpretation: "archive the thread", urgency: "new", answersQuestionId: null, view: { threadId: null, projectId: null, onNewThreadScreen: false },
  };
  assert.equal(userRequestEnvelopeSchema.safeParse(base).success, true);
  assert.equal(userRequestEnvelopeSchema.safeParse({ ...base, extra: 1 }).success, false);
  assert.equal(userRequestEnvelopeSchema.safeParse({ ...base, v: 2 }).success, false);
  const message = formatRequestMessage(base, { latestAnnouncement: { threadIds: ["thr_x"], text: "Speech thread finished.", delivery: "interrupted" } });
  assert.ok(message.indexOf("User said:") < message.indexOf("Voice model's reading"));
  assert.match(message, /"I think we can archive it\. Nothing remains, right\?"/);
  assert.match(message, /not the user's words/);
  assert.match(message, /Latest announcement to the user \(interrupted\)/);
  const partial = formatRequestMessage({ ...base, transcriptAvailable: false, originalText: "" }, {});
  assert.match(partial, /transcript unavailable/);
  assert.match(partial, /ask before any destructive/);
});

test("a hidden coordinator starts once in the personal environment with plugin attribution and its own provider", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const first = await claim("call-1");
  assert.ok(first.conversationId);
  assert.equal(first.resumed, false);
  await rpc("submitRequest", { envelope: envelope(first.conversationId, "call-1", "r_1", "What is running right now?") });
  await rpc("submitRequest", { envelope: envelope(first.conversationId, "call-1", "r_2", "Ask the activity thread to fix that review comment and push.") });
  assert.equal(world.spawns, 1);
  const spawned = world.threads.get(coordinatorId()).spawnArgs;
  assert.equal(spawned.visibility, "hidden");
  assert.equal(spawned.projectId, "proj_personal");
  assert.deepEqual(spawned.environment, { type: "host", hostId: "host_a", workspace: { type: "personal" } });
  assert.equal(spawned.providerId, "codex");
  assert.equal(spawned.model, "gpt-b");
  assert.equal(spawned.originPluginId, "voice-mode");
  assert.equal(spawned.parentThreadId, undefined);
  assert.match(spawned.title, new RegExp(`^${COORDINATOR_TITLE_PREFIX}`));
  // Both requests reached the coordinator with the user's exact words and no rewriting.
  assert.equal(world.sends.length, 2);
  assert.match(world.sends[1].text, /"Ask the activity thread to fix that review comment and push\."/);
  assert.equal(world.sends[1].mode, "queue-if-active");
  // Initial tool selection works before the mapping exists, through origin + title.
  const fresh = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_unknown", title: `${COORDINATOR_TITLE_PREFIX}conv_x` }, origin: { kind: null, pluginId: "voice-mode" } }));
  assert.deepEqual(fresh.tools.map((tool) => tool.name).sort(), ["voice_ask", "voice_reply"]);
  assert.match(fresh.instructions ?? "", /Never turn a question/);
  const worker = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "thr_worker", title: "Fix CI" }, origin: { kind: null, pluginId: null } }));
  assert.deepEqual(worker.tools, []);
  const status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.conversation.coordinatorThreadId, coordinatorId());
  assert.equal(status.requests.length, 2);
});

test("a timed-out create is reconciled instead of spawning a duplicate coordinator", async (t) => {
  const { harness, world, rpc, claim, envelope } = await enabledHost({ spawnFails: "after" });
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  const failed = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "list my threads") });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /timeout after create/);
  assert.equal(world.spawns, 1);
  const retried = await rpc("retryRequest", { requestId: "r_1" });
  assert.equal(retried.status, "accepted");
  assert.equal(world.spawns, 1, "the existing hidden coordinator was adopted");
  assert.equal(world.sends[0].threadId, "thr_coord1");
});

test("an unavailable coordinator provider is a recoverable failure and never falls back to direct voice mutations", async (t) => {
  const { harness, world, rpc, claim, envelope, replies } = await enabledHost({ providerAvailable: false });
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  const result = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "archive the old speech thread") });
  assert.equal(result.status, "failed");
  assert.match(result.error, /not available on Mac/);
  assert.equal(world.spawns, 0);
  const failure = replies().find((reply) => reply.kind === "failure");
  assert.match(failure.speech, /coordinator is unavailable/);
  assert.equal(failure.targetCallNonce, "call-1");
  const direct = await rpc("runTool", { name: "archive_thread", args: { thread_id: "thr_old" }, threadId: null, projectId: null });
  assert.equal(direct.status, "error");
  assert.match(direct.output, /Delegate to the coordinator/);
  assert.equal(COORDINATOR_MODE_SERVER_TOOLS.has("send_to_thread"), false);
});

test("voice_reply is validated against the stored coordinator mapping and final replies wait for the turn to settle", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "Archive the old speech thread.") });
  const foreign = await harness.behavior.callAgentTool("voice_reply", { kind: "final", speech: "Done." }, { threadId: "thr_worker" }) as Any;
  assert.equal(foreign.isError, true);
  await idle(coordinatorId(), null); // bootstrap settles; r_1 was queued behind it
  const progress = await harness.behavior.callAgentTool("voice_reply", { request_id: "r_1", kind: "progress", speech: "Checking the speech thread." }, { threadId: coordinatorId() });
  assert.match(String(progress), /Recorded progress/);
  assert.equal(replies().filter((reply) => reply.requestId === "r_1").length, 1, "progress is published at once");
  await harness.behavior.callAgentTool("voice_reply", {
    request_id: "r_1", kind: "final", speech: "Archived the old speech thread.", thread_ids: ["thr_speech"],
    receipts: [{ action: "archive", thread_id: "thr_speech", outcome: "done" }], state: { discussed_thread_id: "thr_speech", topic: "speech thread cleanup" },
  }, { threadId: coordinatorId() });
  assert.equal(replies().filter((reply) => reply.kind === "final").length, 0, "final waits for idle");
  await idle(coordinatorId(), "Archived thr_speech.");
  const finals = replies().filter((reply) => reply.kind === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].source, "tool");
  assert.deepEqual(finals[0].receipts, [{ action: "archive", thread_id: "thr_speech", outcome: "done" }]);
  // No fallback is spoken beside the structured reply, and a second idle does not repeat it.
  await idle(coordinatorId(), "Archived thr_speech.");
  assert.equal(replies().filter((reply) => reply.requestId === "r_1" && reply.kind === "final").length, 1);
  const status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.conversation.discussedThreadId, "thr_speech");
  assert.deepEqual(status.watch.map((row: Any) => row.threadId), ["thr_speech"]);
  assert.equal(status.requests[0].status, "settled");
  assert.equal(world.stops.length, 0, "the runtime is kept while the call is live");
});

test("a turn that ends without a structured reply speaks bounded final text exactly once", async (t) => {
  const { harness, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "what did the agent say") });
  await idle(coordinatorId(), null);
  await idle(coordinatorId(), `The agent reported ${"a very long sentence ".repeat(40)}. Then more.`);
  const fallbacks = replies().filter((reply) => reply.source === "fallback");
  assert.equal(fallbacks.length, 1);
  assert.ok(fallbacks[0].speech.length <= 401);
  await idle(coordinatorId(), "again");
  assert.equal(replies().filter((reply) => reply.source === "fallback").length, 1);
});

test("hangup keeps accepted work running, defers late results, and releases the runtime once settled", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "Tell the three review threads to rebase and push.") });
  await idle(coordinatorId(), null); // bootstrap done, r_1 now running
  world.threads.get(coordinatorId()).status = "active";
  await rpc("publishPresence", { nonce: "call-1", phase: "idle", startedAt: null });
  await settle();
  assert.equal(world.stops.length, 0, "an active coordinator is not stopped at hangup");
  const status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.requests[0].status, "accepted");
  // The coordinator finishes the remaining sends after hangup and replies.
  await harness.behavior.callAgentTool("voice_reply", { request_id: "r_1", kind: "final", speech: "Told all three threads.", receipts: [{ action: "send", thread_id: "thr_a", outcome: "done" }] }, { threadId: coordinatorId() });
  assert.equal(replies().filter((reply) => reply.kind === "final").length, 0, "no speech into a stopped call");
  await idle(coordinatorId(), "Told all three threads.");
  assert.equal(replies().filter((reply) => reply.kind === "final").length, 0);
  assert.deepEqual(world.stops, [coordinatorId()], "runtime released after accepted work settled");
  // Resuming brings the result back as a queued update, not as stale speech.
  const resumed = await claim("call-2");
  assert.equal(resumed.conversationId, conversationId);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.queuedUpdates, 1);
  const late = await rpc("reportReplyDelivery", { replyId: "reply_nope", nonce: "call-2", state: "delivered" });
  assert.deepEqual(late, { ok: true });
});

test("only watched threads feed the inbox, batches wait for the opening answer, coalesce, keep failures, and cap at two", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "watch the CI thread") });
  await idle(coordinatorId(), null);
  await harness.behavior.callAgentTool("voice_reply", { request_id: "r_1", kind: "final", speech: "Watching CI.", state: { watch_add: ["thr_ci", "thr_docs", "thr_build"] } }, { threadId: coordinatorId() });
  await idle(coordinatorId(), "ok");
  const event = (id: string, title: string, kind: "thread.idle" | "thread.failed", detail: string, updatedAt: number) =>
    kind === "thread.idle"
      ? harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id, title, updatedAt }), lastAssistantText: detail })
      : harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id, title, updatedAt }), error: detail });
  await event("thr_unwatched", "Random", "thread.idle", "noise", 1);
  await event("thr_ci", "CI", "thread.idle", "First pass", 2);
  await event("thr_ci", "CI", "thread.idle", "First pass", 2); // duplicate event
  await event("thr_ci", "CI", "thread.idle", "Second pass", 3);
  await event("thr_docs", "Docs", "thread.failed", "Build script exited 1", 4);
  await event("thr_docs", "Docs", "thread.idle", "recovered?", 5); // must not hide the failure
  await event("thr_build", "Build", "thread.idle", "Built", 6);
  let status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.queuedUpdates, 5);
  const inbox = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "voice-inbox");
  assert.ok(inbox.length >= 1);
  // Opening request already answered above via delivery report? Not yet: the reply was never spoken.
  let reserved = await rpc("reserveUpdateBatch", { conversationId, nonce: "call-1", msSinceCallLive: 1000 });
  assert.equal(reserved.batch, null);
  assert.equal(reserved.reason, "awaiting-opening-answer");
  const final = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "voice-reply").map((signal) => signal.payload as Any).find((reply) => reply.kind === "final");
  await rpc("reportReplyDelivery", { replyId: final.replyId, nonce: "call-1", state: "delivered" });
  reserved = await rpc("reserveUpdateBatch", { conversationId, nonce: "call-1", msSinceCallLive: 1000 });
  assert.ok(reserved.batch);
  assert.equal(reserved.batch.count, 2);
  const digest = world.sends.at(-1)!;
  assert.match(digest.text, /background updates batch/);
  assert.match(digest.text, /Docs.*failed.*Build script exited 1/s);
  assert.match(digest.text, /Second pass/);
  assert.doesNotMatch(digest.text, /First pass/);
  assert.doesNotMatch(digest.text, /Random/);
  assert.doesNotMatch(digest.text, /Built/, "third thread waits for the next batch");
  const again = await rpc("reserveUpdateBatch", { conversationId, nonce: "call-1", msSinceCallLive: 1000 });
  assert.equal(again.reason, "batch-in-flight");
  await harness.behavior.callAgentTool("voice_reply", { batch_id: reserved.batch.id, kind: "progress", speech: "Docs failed on the build script; CI finished its second pass.", present: { focus_thread_id: "thr_docs" } }, { threadId: coordinatorId() });
  const update = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "voice-reply").map((signal) => signal.payload as Any).find((reply) => reply.kind === "update");
  assert.equal(update.batchId, reserved.batch.id);
  assert.equal(update.focusThreadId, null, "a background digest cannot request visual inspection");
  await rpc("reportReplyDelivery", { replyId: update.replyId, nonce: "call-1", state: "delivered" });
  status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.queuedUpdates, 1);
  assert.match((await rpc("getCoordinatorStatus", null)).conversation.topic ?? "", /.*/);
  const stale = await rpc("reserveUpdateBatch", { conversationId, nonce: "call-old", msSinceCallLive: 1000 });
  assert.equal(stale.reason, "call-mismatch");
  await rpc("setWatch", { conversationId, threadId: "thr_build", watched: false });
  await event("thr_build", "Build", "thread.idle", "Built again", 7);
  assert.equal((await rpc("getCoordinatorStatus", null)).queuedUpdates, 1);
});

test("questions stay alive until answered, map spoken answers only to the open question, and survive hangup and reload", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "archive it") });
  await idle(coordinatorId(), null);
  world.threads.get(coordinatorId()).status = "active";
  // 1. Spoken answer resolves the live invocation; an unrelated "yes" does not.
  const ask = harness.behavior.callAgentTool("voice_ask", { request_id: "r_1", question: "Which thread: the speech thread or the CI thread?", options: ["speech thread", "CI thread"] }, { threadId: coordinatorId() });
  await settle();
  const asked = replies().find((reply) => reply.kind === "clarification");
  assert.ok(asked.questionId);
  assert.equal(harness.inspection.pendingInteractions.length, 1, "a native pending interaction keeps the question visible");
  const unrelated = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_2", "yes", { answersQuestionId: "q_other" }) });
  assert.equal(unrelated.status, "accepted", "an answer to a different question is an ordinary request");
  const answer = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_3", "the CI thread", { answersQuestionId: asked.questionId }) });
  assert.equal(answer.status, "settled");
  assert.match(String(await ask), /by voice.*CI thread/);
  assert.equal(world.sends.filter((send) => send.text.includes("[voice request r_3]")).length, 0, "the answer did not start a new coordinator turn");

  // 2. Hangup while a question is open preserves it and re-asks on resume.
  const ask2 = harness.behavior.callAgentTool("voice_ask", { question: "Merge now?", options: ["yes", "no"] }, { threadId: coordinatorId() });
  await settle();
  await rpc("forceStop", { nonce: "call-1" });
  await settle();
  assert.match(String(await ask2), /Do not guess\. End your turn/);
  let status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.questions[0].status, "unresolved");
  const resumed = await claim("call-2");
  const reasked = replies().filter((reply) => reply.kind === "clarification" && reply.targetCallNonce === "call-2");
  assert.equal(reasked.length, 1);
  assert.match(reasked[0].speech, /Merge now\?/);
  const late = await rpc("submitRequest", { envelope: envelope(resumed.conversationId, "call-2", "r_4", "yes, merge", { answersQuestionId: status.questions[0].id }) });
  assert.equal(late.status, "accepted");
  assert.match(world.sends.at(-1)!.text, /This answers your question/);
  status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.questions.length, 0);

  // 3. UI submission after the invocation was torn down is kept and redelivered, not lost.
  const controller = new AbortController();
  const ask3 = harness.behavior.callAgentTool("voice_ask", { question: "Delete the branch too?", options: ["yes", "no"] }, { threadId: coordinatorId(), signal: controller.signal });
  await settle();
  controller.abort();
  await settle();
  const pending = harness.inspection.pendingInteractions.at(-1)!;
  harness.behavior.submitInteraction(pending.id, "no");
  await settle();
  assert.match(String(await ask3), /No answer/, "the torn-down invocation reports no answer instead of inventing one");
  await settle();
  const redelivered = world.sends.some((send) => send.text.includes("[voice answer") && send.text.includes("Delete the branch too?") && send.text.includes("\"no\""));
  assert.ok(redelivered, "the late UI submission is delivered as a message, not lost");
  status = await rpc("getCoordinatorStatus", null);
  assert.equal(status.questions.some((question: Any) => question.question === "Delete the branch too?"), false);
  await claim("call-3");
  assert.equal(replies().filter((reply) => reply.targetCallNonce === "call-3" && /Delete the branch too\?/.test(reply.speech)).length, 0, "an answered question is not asked again");
});

test("a spoken clarification is delivered while the coordinator waits, and UI-cancelled questions report no answer", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "stop that") });
  await idle(coordinatorId(), null);
  world.threads.get(coordinatorId()).status = "active";
  const ask = harness.behavior.callAgentTool("voice_ask", { question: "Stop which thread?" }, { threadId: coordinatorId() });
  await settle();
  const question = replies().find((reply) => reply.kind === "clarification");
  assert.equal(question.targetCallNonce, "call-1");
  // The digest gate refuses while the question blocks, so it cannot deadlock the exchange.
  const reserved = await rpc("reserveUpdateBatch", { conversationId, nonce: "call-1", msSinceCallLive: 60_000 });
  assert.equal(reserved.reason, "blocking-interaction");
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
  assert.match(String(await ask), /dismissed the question/);
  await rpc("answerQuestion", { questionId: question.questionId, value: "CI" }).then(() => assert.fail("cancelled question accepts no answer"), (error: Error) => assert.match(error.message, /cancelled/));
  assert.equal(world.sends.filter((send) => send.text.includes("[voice answer")).length, 0);
});

test("new conversation separates coordinators; the old one gets no speech in the new call", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const first = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(first.conversationId, "call-1", "r_1", "start the docs job") });
  await idle(coordinatorId(), null);
  world.threads.get(coordinatorId()).status = "active";
  const oldCoordinator = coordinatorId();
  const second = await claim("call-2", { newConversation: true });
  assert.notEqual(second.conversationId, first.conversationId);
  await rpc("submitRequest", { envelope: envelope(second.conversationId, "call-2", "r_2", "hello there") });
  assert.equal(world.spawns, 2);
  await harness.behavior.callAgentTool("voice_reply", { request_id: "r_1", kind: "final", speech: "Docs job started." }, { threadId: oldCoordinator });
  world.threads.get(oldCoordinator).status = "idle";
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ ...world.threads.get(oldCoordinator), status: "idle", queuedMessageCount: 0 }), lastAssistantText: "Docs job started." });
  await settle();
  assert.equal(replies().filter((reply) => reply.kind === "final" && reply.targetCallNonce === "call-2").length, 0);
  assert.equal(replies().filter((reply) => reply.kind === "final" && reply.conversationId === first.conversationId && reply.targetCallNonce === null).length, 0, "deferred replies are inbox rows, not published speech");
  const oldStatus = await rpc("getCoordinatorStatus", { conversationId: first.conversationId });
  assert.equal(oldStatus.queuedUpdates, 1);
  const stale = await rpc("submitRequest", { envelope: envelope(first.conversationId, "call-1", "r_9", "late words") }).catch((error: Error) => error.message);
  assert.match(String(stale), /stopped or replaced/);
});

test("ambiguous send failures reconcile against coordinator history before any retry", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_0", "warm up") });
  await idle(coordinatorId(), null);
  const realSend = harness.inspection.sdk.callsTo("threads.send");
  assert.equal(realSend.length, 1);
  harness.inspection.sdk.stub("threads.send", async (args: Any) => {
    world.sends.push({ threadId: args.threadId, mode: args.mode, text: args.input[0].text });
    world.timelineText.set(args.threadId, args.input[0].text); // it did arrive
    throw new Error("socket hang up");
  });
  const result = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "rename it to CI fix") });
  assert.equal(result.status, "accepted");
  assert.equal(result.receipt.mode, "reconciled");
  harness.inspection.sdk.stub("threads.send", async () => { throw new Error("socket hang up"); });
  const lost = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_2", "and push") });
  assert.equal(lost.status, "dispatch_unknown", "a missing history marker cannot prove non-delivery");
  const sendsBefore = world.sends.length;
  const retryAfterAccepted = await rpc("retryRequest", { requestId: "r_1" });
  assert.equal(retryAfterAccepted.status, "accepted");
  assert.equal(world.sends.length, sendsBefore, "an accepted request is never re-sent");
});

test("the plugin reloads with its coordinator state intact", async (t) => {
  const { harness, rpc, claim, envelope, coordinatorId, idle } = await enabledHost();
  t.after(async () => { await reloaded.harness.lifecycle.dispose().catch(() => undefined); });
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "list threads") });
  await idle(coordinatorId(), null);
  const reloaded = await harness.lifecycle.reload(plugin);
  const status = await reloaded.harness.behavior.callRpc("getCoordinatorStatus", null) as Any;
  assert.equal(status.conversation.id, conversationId);
  assert.equal(status.conversation.coordinatorThreadId, coordinatorId());
  assert.equal(status.requests[0].id, "r_1");
});

for (const lookupFails of [true, false]) {
  test(`unknown delivery is never resent when history ${lookupFails ? "fails" : "has no marker"}`, async (t) => {
    const { harness, world, rpc, claim, envelope, coordinatorId } = await enabledHost();
    t.after(() => harness.lifecycle.dispose());
    const { conversationId } = await claim("call-1");
    let sends = 0;
    harness.sdk.stub("threads.send", async () => { sends += 1; throw new Error("timeout after acceptance"); });
    harness.sdk.stub("threads.timeline", async () => {
      if (lookupFails) throw new Error("history unavailable");
      return { text: "" };
    });
    const first = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_unknown", "Tell the review thread to continue.") });
    assert.equal(first.status, "dispatch_unknown");
    assert.equal((await rpc("retryRequest", { requestId: "r_unknown" })).status, "dispatch_unknown");
    assert.equal(sends, 1);
    assert.equal(world.spawns, 1);
    harness.sdk.stub("threads.timeline", async () => ({ text: "[voice request r_unknown]" }));
    assert.equal((await rpc("retryRequest", { requestId: "r_unknown" })).status, "accepted");
    assert.equal(sends, 1, "later evidence reconciles without resending");
    assert.ok(coordinatorId());
  });
}

for (const lookupFails of [true, false]) {
  test(`unknown create is never repeated when lookup ${lookupFails ? "fails" : "has no result"}`, async (t) => {
    const { harness, world, rpc, claim, envelope } = await enabledHost({ spawnFails: "after" });
    t.after(() => harness.lifecycle.dispose());
    const { conversationId } = await claim("call-1");
    await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_create", "What is running?") });
    harness.sdk.stub("threads.list", async () => {
      if (lookupFails) throw new Error("lookup unavailable");
      return [];
    });
    assert.equal((await rpc("retryRequest", { requestId: "r_create" })).status, "failed");
    assert.equal(world.spawns, 1);
    harness.sdk.stub("threads.list", async () => [...world.threads.values()]);
    assert.equal((await rpc("retryRequest", { requestId: "r_create" })).status, "accepted");
    assert.equal(world.spawns, 1);
  });
}

test("an unreachable existing coordinator retains its identity", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_first", "What is running?") });
  const id = coordinatorId();
  harness.sdk.stub("threads.get", async () => { throw new Error("BB unavailable"); });
  const second = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_second", "Show the review thread.") });
  assert.equal(second.status, "failed");
  assert.equal(second.coordinatorThreadId, id);
  assert.equal(world.spawns, 1);
});

test("missing transcription cannot execute the voice model's interpretation, even on retry", async (t) => {
  const { harness, world, rpc, claim, envelope } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  const result = await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_partial", "", { transcriptAvailable: false, interpretation: "Tell the activity thread to remove it" }) });
  assert.equal(result.status, "failed");
  assert.match(result.error, /repeat the request/);
  assert.equal((await rpc("retryRequest", { requestId: "r_partial" })).status, "failed");
  assert.equal(world.sends.length, 0);
  assert.equal(world.spawns, 0);
});
