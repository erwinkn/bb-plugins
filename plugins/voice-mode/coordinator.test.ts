import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { COORDINATOR_INSTRUCTIONS, COORDINATOR_TITLE_PREFIX } from "./coordinator/prompts.ts";
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
    sendOverride: null as null | ((args: Any) => Promise<Any>),
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
      models: async ({ providerId }: Any) => ({ modelLoadError: null, providers:[{id:providerId,serviceTiers:providerId === "codex" ? [{id:"default",label:"Default"},{id:"fast",label:"Fast"}] : []}], models: providerId === "codex" ? [{ id: "gpt-a", model: "gpt-a", displayName: "A", isDefault: false }, { id: "gpt-b", model: "gpt-b", displayName: "B", isDefault: true,defaultReasoningEffort:"high",supportedReasoningEfforts:[{reasoningEffort:"high",description:"High"},{reasoningEffort:"xhigh",description:"Extra high"}] }] : [{ id: "opus", model: "opus", displayName: "Opus", isDefault: true }] }),
    },
    threads: {
      spawn,
      get: async ({ threadId }: Any) => { const t = world.threads.get(threadId); if (!t) throw new Error(`no thread ${threadId}`); return t; },
      list: async (args: Any) => [...world.threads.values()].filter((t) => (!args?.originPluginId || t.originPluginId === args.originPluginId) && (args?.includeHidden || t.visibility !== "hidden")),
      send: async ({ threadId, mode, input }: Any) => {
        if (world.sendOverride) return world.sendOverride({ threadId, mode, input });
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
  assert.ok(message.indexOf("\"user\"") < message.indexOf("model_interpretation"));
  assert.match(message, /"I think we can archive it\. Nothing remains, right\?"/);
  assert.equal(JSON.parse(message.split("\n")[1]).model_interpretation,"archive the thread");
  assert.equal(JSON.parse(message.split("\n")[1]).heard.delivery,"interrupted");
  const partial = formatRequestMessage({ ...base, transcriptAvailable: false, originalText: "" }, {});
  assert.match(partial, /Incomplete transcript/);
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
  assert.deepEqual(fresh.tools.map((tool) => tool.name).sort(), ["voice_actions", "voice_ask", "voice_overview", "voice_reply", "voice_sequence", "voice_ui"]);
  assert.match(fresh.instructions ?? "", /Never turn a question/);
  assert.ok(COORDINATOR_INSTRUCTIONS.length <= 4096, "host instructions must retain the complete policy");
  assert.equal(fresh.instructions, COORDINATOR_INSTRUCTIONS, "the host must receive the entire policy");
  assert.match(fresh.instructions ?? "", /Queue normal follow-ups, not steering/);
  assert.match(fresh.instructions ?? "", /explicit stop uses stop_thread/);
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
  assert.match(result.error, /unavailable on Mac/);
  assert.equal(world.spawns, 0);
  const failure = replies().find((reply) => reply.kind === "failure");
  assert.match(failure.speech, /could not start that work/);
  assert.equal(failure.targetCallNonce, "call-1");
  await assert.rejects(rpc("runTool", { name: "archive_thread", args: {} }));
});

test("voice_reply is validated against the stored coordinator mapping and final replies commit before the turn settles", async (t) => {
  const { harness, world, rpc, claim, envelope, coordinatorId, idle, replies } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("call-1");
  await rpc("submitRequest", { envelope: envelope(conversationId, "call-1", "r_1", "Archive the old speech thread.") });
  const foreign = await harness.behavior.callAgentTool("voice_reply", { kind: "final", speech: "Done." }, { threadId: "thr_worker" }) as Any;
  assert.equal(foreign.isError, true);
  await idle(coordinatorId(), null); // bootstrap settles; r_1 was queued behind it
  await assert.rejects(harness.behavior.callAgentTool("voice_reply", { request_id: "r_1", kind: "progress", speech: "Checking." }, { threadId: coordinatorId() }));
  assert.equal(replies().filter(reply => reply.requestId === "r_1").length, 0, "only the bridge acknowledges a request");
  await harness.behavior.callAgentTool("voice_reply", {
    request_id: "r_1", kind: "final", speech: "Archived the old speech thread.", thread_ids: ["thr_speech"],
    receipts: [{ action: "archive", thread_id: "thr_speech", outcome: "done" }], state: { discussed_thread_id: "thr_speech", topic: "speech thread cleanup" },
  }, { threadId: coordinatorId() });
  assert.equal(replies().filter((reply) => reply.kind === "final").length, 1, "final publishes before idle");
  assert.equal((await rpc("getCoordinatorStatus", null)).requests[0].status, "settled");
  await idle(coordinatorId(), "Archived thr_speech.");
  const finals = replies().filter((reply) => reply.kind === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].source, "tool");
  assert.deepEqual(finals[0].receipts, [{ action: "archive", thread_id: "thr_speech", outcome: "done" }]);
  await harness.behavior.callAgentTool("voice_reply", {request_id:"r_1",kind:"final",speech:"Duplicate."}, {threadId:coordinatorId()});
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
  await harness.behavior.callAgentTool("voice_reply", { batch_id: reserved.batch.id, kind: "final", speech: "Docs failed on the build script; CI finished its second pass." }, { threadId: coordinatorId() });
  const update = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "voice-reply").map((signal) => signal.payload as Any).find((reply) => reply.kind === "update");
  assert.equal(update.batchId, reserved.batch.id);
  assert.equal("focusThreadId" in update, false, "speech replies cannot request navigation");
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
  assert.match(world.sends.at(-1)!.text, /"answer_to"/);
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

test("logical sessions retain all calls, selection is read-only, and explicit continuation reuses its coordinator", async (t) => {
  const {harness,rpc,claim,envelope,coordinatorId,world} = await enabledHost();
  t.after(()=>harness.lifecycle.dispose());
  const first = await claim("history-call-1",{newConversation:true});
  await rpc("logEvent",{sessionId:"history-call-1",kind:"user",payload:{text:"First conversation"}});
  await rpc("submitRequest",{envelope:envelope(first.conversationId,"history-call-1","history_request","Check threads.")});
  const firstCoordinator = coordinatorId();
  await rpc("forceStop",{nonce:"history-call-1"});
  const second = await claim("history-call-2",{newConversation:true});
  await rpc("logEvent",{sessionId:"history-call-2",kind:"user",payload:{text:"Second conversation"}});
  const spawnsBefore = world.spawns;
  const selected = await rpc("getVoiceSession",{sessionId:first.conversationId});
  assert.deepEqual(selected.session.callIds,["history-call-1"]);
  assert.equal(world.spawns,spawnsBefore,"viewing a session starts no work");
  await assert.rejects(claim("blocked-call",{conversationId:first.conversationId}),/End the current call/);
  await rpc("forceStop",{nonce:"history-call-2"});
  const resumed = await claim("history-call-3",{conversationId:first.conversationId});
  assert.equal(resumed.conversationId,first.conversationId);
  await rpc("logEvent",{sessionId:"history-call-3",kind:"user",payload:{text:"Continue first"}});
  const history = await rpc("getVoiceSession",{sessionId:first.conversationId});
  assert.equal(history.session.coordinatorThreadId,firstCoordinator);
  assert.deepEqual(history.session.callIds,["history-call-1","history-call-3"]);
  assert.equal(history.events.filter((event:Any)=>event.kind === "user").length,2);
  assert.ok((await rpc("listVoiceSessions",null)).sessions.some((row:Any)=>row.id===second.conversationId));
  await rpc("forceStop",{nonce:"history-call-3"});
  await rpc("logEvent",{sessionId:"legacy-call",kind:"user",payload:{text:"Old call"}});
  const old = await rpc("getVoiceSession",{sessionId:"legacy-call"});
  assert.equal(old.session.legacy,true);
  const adopted = await claim("adopted-call",{conversationId:"legacy-call"});
  assert.notEqual(adopted.conversationId,"legacy-call");
  assert.equal((await rpc("getVoiceSession",{sessionId:adopted.conversationId})).events[0].callId,"legacy-call");
});

test("the overview tool is coordinator-only and returns a bounded fresh snapshot without reading timelines", async (t) => {
  const {harness,rpc,claim,envelope,coordinatorId,world} = await enabledHost();
  t.after(()=>harness.lifecycle.dispose());
  const {conversationId} = await claim("overview-call");
  await rpc("submitRequest",{envelope:envelope(conversationId,"overview-call","overview_request","What is active?")});
  for (let n=0;n<40;n++) world.threads.set(`work_${n}`,makeThreadResponse({id:`work_${n}`,title:`Work ${n}`,parentThreadId:n===0?null:"work_0",projectId:"proj_app",status:"active",updatedAt:Date.now(),runtime:{displayStatus:"active",hostReconnectGraceExpiresAt:null}}));
  const rejected = await harness.behavior.callAgentTool("voice_overview",{}, {threadId:"work_0"}) as Any;
  assert.equal(rejected.isError,true);
  const before = harness.inspection.sdk.callsTo("threads.timeline").length;
  const result = JSON.parse(String(await harness.behavior.callAgentTool("voice_overview",{}, {threadId:coordinatorId()})));
  assert.equal(result.threads.length,30); assert.equal(result.truncated,true);
  for (const thread of result.threads) assert.equal(thread.parentThreadId,thread.id === "work_0" ? null : "work_0");
  assert.ok(Math.abs(Date.now()-result.asOf)<1000);
  assert.equal(harness.inspection.sdk.callsTo("threads.timeline").length,before);
});

test("coordinator is mandatory and catalog-validated execution choices reach a new coordinator", async(t)=>{
  const {harness,rpc,claim,envelope,world,coordinatorId}=await enabledHost();t.after(()=>harness.lifecycle.dispose());
  const initial=await rpc("getConfig",null);
  assert.equal("enabled" in initial.coordinator,false);assert.equal("hostId" in initial.coordinator,false);
  await assert.rejects(rpc("setConfig",{coordinator:{enabled:false}}));
  await assert.rejects(rpc("setConfig",{coordinator:{hostId:"host_b"}}));
  const catalog=await rpc("listCoordinatorProviders",null);
  assert.equal(catalog.providers.find((p:Any)=>p.id === "codex").serviceTiers[1].id,"fast");
  assert.deepEqual(catalog.models.find((m:Any)=>m.model === "gpt-b").reasoningLevels.map((r:Any)=>r.id),["high","xhigh"]);
  await rpc("setConfig",{coordinator:{providerId:"codex",model:"gpt-b",reasoningLevel:"xhigh",serviceTier:"fast"}});
  await assert.rejects(rpc("setConfig",{coordinator:{reasoningLevel:"low"}}),/does not support/);
  await assert.rejects(rpc("setConfig",{coordinator:{providerId:"claude-code",model:"opus",reasoningLevel:null,serviceTier:"fast"}}),/does not support fast/);
  const {conversationId}=await claim("configured");
  await rpc("submitRequest",{envelope:envelope(conversationId,"configured","configured_request","Check the build.")});
  const spawn=world.threads.get(coordinatorId()).spawnArgs;
  assert.equal(spawn.reasoningLevel,"xhigh");assert.equal(spawn.serviceTier,"fast");
  assert.equal(spawn.environment.hostId,"host_a");
});

test("one assistant flow keeps assignment internal, suppresses repeated blockers and reports changed results once",async(t)=>{
  const {harness,rpc,claim,envelope,coordinatorId,idle,replies,world}=await enabledHost();t.after(()=>harness.lifecycle.dispose());
  const {conversationId}=await claim("flow");
  await rpc("submitRequest",{envelope:envelope(conversationId,"flow","flow_request","Fix the build and verify it.")});
  await idle(coordinatorId(),null);
  const reply=(params:Any)=>harness.behavior.callAgentTool("voice_reply",{request_id:"flow_request",...params},{threadId:coordinatorId()});
  await reply({kind:"assigned",speech:"Assigned internally.",receipts:[{action:"spawned",thread_id:"build_worker",outcome:"done"}]});
  await reply({kind:"assigned",speech:"Assigned again.",receipts:[{action:"spawned",thread_id:"build_worker",outcome:"done"}]});
  await idle(coordinatorId(),"Internal dispatch details.");
  assert.equal(replies().length,0,"assignment and idle fallback create no user-facing speech");
  await assert.rejects(reply({kind:"progress",speech:"Checking more things."}));
  await reply({kind:"blocked",speech:"The build needs access to the package registry."});
  await reply({kind:"blocked",speech:"The build needs access to the package registry."});
  assert.equal(replies().length,1);
  const noise=await reply({kind:"final",speech:"I delegated this to the coordinator thread."}) as Any;
  assert.equal(noise.isError,true);
  await reply({kind:"final",speech:"The build is fixed, and the checks pass.",receipts:[{action:"verify",thread_id:"build_worker",outcome:"done"}]});
  await idle(coordinatorId(),"Internal follow-up.");
  assert.equal(replies().filter((r:Any)=>r.kind === "final").length,1);
  await reply({kind:"final",speech:"Unrelated late result."});
  await idle(coordinatorId(),"Unrelated late output.");
  assert.equal(replies().length,2);
  assert.equal(world.sends.length,1,"reply bookkeeping never opens another coordinator turn");
});

test("compact requests preserve every input item once and unchanged context is omitted",async(t)=>{
  const {harness,rpc,claim,envelope,world}=await enabledHost();t.after(()=>harness.lifecycle.dispose());
  const {conversationId}=await claim("compact");
  const first=envelope(conversationId,"compact","compact_1","Only if the checks pass.",{utteranceItemIds:["last"],transcriptDelta:[{itemId:"first",text:"Fix the build, preserve the existing changes, and do not publish."},{itemId:"last",text:"Only if the checks pass."}],interpretation:"Fix build conditionally"});
  await rpc("submitRequest",{envelope:first});
  const data=JSON.parse(world.sends[0].text.split("\n")[1]);
  assert.deepEqual(data.user.items.map((item:Any)=>item.text),first.transcriptDelta.map(item=>item.text));
  assert.equal(data.user.text,undefined,"last item is not repeated");
  assert.deepEqual(data.source, {call_id:"compact",conversation_id:conversationId});
  await rpc("submitRequest",{envelope:envelope(conversationId,"compact","compact_2","Also check the tests.")});
  assert.equal(JSON.parse(world.sends[1].text.split("\n")[1]).context,"unchanged");
});

test("silent assignment allows completion digests; repeated and late events never open extra reply turns", async (t) => {
  const { harness, rpc, claim, envelope, coordinatorId, idle, replies, world } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("quiet");
  await rpc("submitRequest", { envelope: envelope(conversationId, "quiet", "quiet_request", "Fix the build and test it.") });
  await idle(coordinatorId(), null);
  await harness.behavior.callAgentTool("voice_reply", { request_id: "quiet_request", kind: "assigned", speech: "", receipts: [{ action: "send", thread_id: "worker", outcome: "pending" }] }, { threadId: coordinatorId() });
  await idle(coordinatorId(), null);
  const event = (updatedAt: number) => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "worker", title: "Build", updatedAt }), lastAssistantText: "Build fixed. Tests pass." });
  await event(1);
  await event(2);
  assert.equal((await rpc("getCoordinatorStatus", null)).queuedUpdates, 1);
  const reserved = await rpc("reserveUpdateBatch", { conversationId, nonce: "quiet", msSinceCallLive: 20000 });
  assert.ok(reserved.batch, "silent assignment must not block its later completion report");
  const sendCount = world.sends.length;
  const report = { batch_id: reserved.batch.id, kind: "final", speech: "The build is fixed, and the tests pass." };
  await harness.behavior.callAgentTool("voice_reply", report, { threadId: coordinatorId() });
  await harness.behavior.callAgentTool("voice_reply", report, { threadId: coordinatorId() });
  const update = replies().find((reply: Any) => reply.kind === "update");
  assert.equal(replies().length, 1);
  await rpc("reportReplyDelivery", { replyId: update.replyId, nonce: "quiet", state: "delivered" });
  await idle(coordinatorId(), null);
  await event(3);
  assert.equal((await rpc("getCoordinatorStatus", null)).queuedUpdates, 0);
  assert.equal((await rpc("reserveUpdateBatch", { conversationId, nonce: "quiet", msSinceCallLive: 20000 })).reason, "empty");
  await harness.behavior.callAgentTool("voice_reply", { request_id: "quiet_request", kind: "final", speech: "Late result from the same work." }, { threadId: coordinatorId() });
  await rpc("submitRequest", { envelope: envelope(conversationId, "quiet", "new_request", "What is the next task?") });
  await harness.behavior.callAgentTool("voice_reply", { request_id: "missing_old_request", kind: "final", speech: "An old result." }, { threadId: coordinatorId() });
  await harness.behavior.callAgentTool("voice_reply", { kind: "final", speech: "Unscoped old output." }, { threadId: coordinatorId() });
  assert.equal(replies().length, 1);
  assert.equal(world.sends.length, sendCount + 1, "only the new user request sends another message");
});


test("routine handoffs queue behind active work and only interrupting requests steer", async (t) => {
  const { harness, rpc, claim, envelope, world } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  const { conversationId } = await claim("queue-policy");
  const requests = [
    { id: "feature", text: "Also add settings search.", urgency: "new" as const, mode: "queue-if-active" },
    { id: "followup", text: "After that, check mobile layout.", urgency: "after_current" as const, mode: "queue-if-active" },
    { id: "comment", text: "One comment: explain the shortcut.", urgency: "after_current" as const, mode: "queue-if-active" },
    { id: "interrupt", text: "Stop that change now; that is the wrong thread.", urgency: "steer" as const, mode: "steer-if-active" },
  ];
  for (const request of requests) {
    await rpc("submitRequest", { envelope: envelope(conversationId, "queue-policy", request.id, request.text, { urgency: request.urgency }) });
    assert.equal(world.sends.at(-1)?.mode, request.mode);
    assert.ok(world.sends.at(-1)?.text.includes(request.text), "routing retains the original request");
  }
});

test("saved voice instructions reach the actual call and coordinator without repeated context", async (t) => {
  const { harness, rpc, claim, envelope, world } = await enabledHost();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.setSettings({openaiApiKey:"test-key"});
  let sentSession: Any;
  t.mock.method(globalThis,"fetch",async (_url: unknown, options: RequestInit) => {
    sentSession = JSON.parse(String((options.body as FormData).get("session")));
    return new Response("test-answer", {status:200});
  });
  const preferences = "Answer in French. Use short sentences.";
  await rpc("setPrompt",{content:preferences,source:"user",note:null});
  const {conversationId} = await claim("preferences");
  await rpc("createCall",{nonce:"preferences",sdp:"test-offer",threadId:null,projectId:null});
  assert.ok(sentSession.instructions.includes(preferences));
  assert.ok(sentSession.instructions.includes("delegate_to_coordinator"));
  assert.ok(!sentSession.tools.some((tool:Any)=>tool.name === "archive_thread"));
  await rpc("submitRequest",{envelope:envelope(conversationId,"preferences","pref1","Check CI.")});
  assert.equal(JSON.parse(world.sends.at(-1)!.text.split("\n")[1]).user_preferences,preferences);
  await rpc("submitRequest",{envelope:envelope(conversationId,"preferences","pref2","Then check docs.")});
  assert.equal(JSON.parse(world.sends.at(-1)!.text.split("\n")[1]).user_preferences,undefined);
  await rpc("setPrompt",{content:"Answer in English.",source:"user",note:null});
  await rpc("submitRequest",{envelope:envelope(conversationId,"preferences","pref3","Now check the build.")});
  assert.equal(JSON.parse(world.sends.at(-1)!.text.split("\n")[1]).user_preferences,"Answer in English.");
});

test("voice_ui requires the mapped coordinator and an active user request, and waits for the owner receipt", async t => {
  const h = await enabledHost(); t.after(() => h.harness.lifecycle.dispose());
  const { conversationId } = await h.claim("ui-call");
  await h.rpc("submitRequest", { envelope: h.envelope(conversationId, "ui-call", "ui-request", "Open the App project") });
  const execute = (request_id: string, threadId = h.coordinatorId(), action: Any = { kind: "open_project", projectId: "proj_app" }) => h.harness.behavior.callAgentTool("voice_ui", { request_id, action }, { threadId });
  for (const request of ["bootstrap", "missing"]) {
    assert.equal((await execute(request) as Any).isError, true);
  }
  assert.equal((await execute("ui-request", "thr_other") as Any).isError, true);
  const failed = JSON.parse(await execute("ui-request", h.coordinatorId(), { kind: "open_thread", threadId: "does-not-exist" }) as string);
  assert.equal(failed.status, "failed");
  const waiting = execute("ui-request");
  await settle();
  const { commands } = await h.rpc("pendingUiCommands", { conversationId, callNonce: "ui-call" });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].action, { kind: "open_project", projectId: "proj_app" });
  const claim = { conversationId, callNonce: "ui-call", commandId: commands[0].id };
  assert.equal((await h.rpc("claimUiCommand", { ...claim, callNonce: "other" })).claimed, false);
  assert.equal((await h.rpc("claimUiCommand", claim)).claimed, true);
  assert.equal((await h.rpc("claimUiCommand", claim)).claimed, false);
  const result = { status: "succeeded", detail: "Project opened." };
  assert.equal((await h.rpc("reportUiCommandResult", { ...claim, result })).accepted, true);
  assert.deepEqual(JSON.parse(await waiting as string), result);
  assert.equal(h.replies().length, 0, "UI receipts do not create speech replies");
  assert.equal(h.world.opened.length, 0, "server never broadcasts threads.open");
  await h.idle(h.coordinatorId());
  await h.idle(h.coordinatorId());
  assert.equal((await execute("ui-request") as Any).isError, true, "settled request cannot navigate");
});

test("hangup cancels pending UI tools and rejects late results without ending accepted work", async t => {
  const h = await enabledHost(); t.after(() => h.harness.lifecycle.dispose());
  const { conversationId } = await h.claim("ui-hangup");
  await h.rpc("submitRequest", { envelope: h.envelope(conversationId, "ui-hangup", "ui-request", "Show Voice") });
  const waiting = h.harness.behavior.callAgentTool("voice_ui", { request_id: "ui-request", action: { kind: "show_voice" } }, { threadId: h.coordinatorId() });
  await settle();
  const { commands } = await h.rpc("pendingUiCommands", { conversationId, callNonce: "ui-hangup" });
  assert.equal(commands.length, 1);
  const identity = { conversationId, callNonce: "ui-hangup", commandId: commands[0].id };
  await h.rpc("forceStop", { nonce: "ui-hangup" });
  assert.equal(JSON.parse(await waiting as string).status, "cancelled");
  assert.equal((await h.rpc("claimUiCommand", identity)).claimed, false);
  assert.equal((await h.rpc("reportUiCommandResult", { ...identity, result: { status: "succeeded", detail: "Late" } })).accepted, false);
  assert.equal(h.world.stops.length, 0, "hangup does not stop accepted coordinator work");
});

test("request settlement immediately revokes started UI work before its timeout", async t => {
  const h = await enabledHost(); t.after(() => h.harness.lifecycle.dispose());
  const { conversationId } = await h.claim("ui-settled");
  await h.rpc("submitRequest", { envelope: h.envelope(conversationId, "ui-settled", "ui-request", "Prepare a draft") });
  const waiting = h.harness.behavior.callAgentTool("voice_ui", { request_id: "ui-request", action: { kind: "prepare_draft", target: { kind: "new" }, text: "Draft" } }, { threadId: h.coordinatorId() });
  await settle();
  const { commands } = await h.rpc("pendingUiCommands", { conversationId, callNonce: "ui-settled" });
  const identity = { conversationId, callNonce: "ui-settled", commandId: commands[0].id };
  assert.equal((await h.rpc("claimUiCommand", identity)).claimed, true);
  await h.harness.behavior.callAgentTool("voice_reply", { request_id: "ui-request", kind: "silent" }, { threadId: h.coordinatorId() });
  assert.equal(JSON.parse(await waiting as string).status, "unknown");
  const revocation = h.harness.inspection.realtimeSignals.find(signal => signal.channel === "voice-ui-cancelled");
  assert.deepEqual(revocation?.payload, identity);
  const recovered = await h.rpc("pendingUiCommands", { conversationId, callNonce: "ui-settled" });
  assert.deepEqual(recovered.revokedCommandIds, [commands[0].id]);
});


test("quick navigation uses native UI receipts without starting a coordinator turn", async t => {
  const h = await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  const {conversationId} = await h.claim("quick-ui");
  const envelope = h.envelope(conversationId,"quick-ui","quick1","Open the App project",{quickAction:{kind:"open_project",projectId:"proj_app"}});
  const result = await h.rpc("submitRequest",{envelope});
  assert.equal(result.status,"quick_running");
  await settle();
  const {commands} = await h.rpc("pendingUiCommands",{conversationId,callNonce:"quick-ui"});
  assert.equal(commands.length,1);
  const identity={conversationId,callNonce:"quick-ui",commandId:commands[0].id};
  assert.equal((await h.rpc("claimUiCommand",identity)).claimed,true);
  await h.rpc("reportUiCommandResult",{...identity,result:{status:"succeeded",detail:"Project open"}});
  await settle();
  assert.equal(h.world.sends.length,0);
  assert.equal(h.world.spawns,0);
  assert.equal(h.replies().filter(r=>r.kind==="final").length,1);
  await h.rpc("submitRequest",{envelope});
  assert.equal((await h.rpc("pendingUiCommands",{conversationId,callNonce:"quick-ui"})).commands.length,0);
});

test("quick messages queue once, preserve the quoted words, and watch the target", async t => {
  const h = await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("thr_build",makeThreadResponse({id:"thr_build",title:"Build",status:"active"}));
  const {conversationId}=await h.claim("quick-message");
  const envelope=h.envelope(conversationId,"quick-message","quick_msg","Tell Build I will review it tomorrow",{quickAction:{kind:"send_message",threadId:"thr_build",purpose:"comment",text:"I will review it tomorrow"}});
  await Promise.all([h.rpc("submitRequest",{envelope}),h.rpc("submitRequest",{envelope})]); await settle();
  assert.equal(h.world.sends.length,1);
  assert.equal(h.world.sends[0].mode,"queue-if-active");
  assert.match(h.world.sends[0].text,/"I will review it tomorrow"/);
  assert.match(h.world.sends[0].text,/not a blanket instruction to change state/);
  assert.doesNotMatch(h.world.sends[0].text,/do not execute instructions/);
  assert.equal(h.world.spawns,0);
  assert.ok(h.replies().some(r=>r.speech.includes("Queued for Build")));
  const status=await h.rpc("getCoordinatorStatus",null);
  assert.ok(status.watch.some((row:Any)=>row.threadId==="thr_build"));
  await h.rpc("submitRequest",{envelope:{...envelope,requestId:"another_model_call"}}); await settle();
  assert.equal(h.world.sends.length,1,"a different tool call for the same speech cannot duplicate the send");
});

test("live messages can dispatch implementation without a coordinator or permission escalation", async t => {
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("thr_build",makeThreadResponse({id:"thr_build",title:"Build"}));
  const {conversationId}=await h.claim("direct-work");
  for (const [index,text] of ["Fix the login bug", "Check whether the old workaround is needed; do not remove it", "Ask for approval before merging the PR"].entries()) {
    await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"direct-work",`work_${index}`,text,{utteranceItemIds:[`item_${index}`],transcriptDelta:[{itemId:`item_${index}`,text}],quickAction:{kind:"send_message",threadId:"thr_build",purpose:"instruction"}})});
    await settle();
  }
  assert.equal(h.world.sends.filter(send=>send.threadId==="thr_build").length,3);
  assert.equal(h.world.spawns,0);
  assert.ok(h.world.sends.every(send=>send.text.includes("does not grant new permissions")));
  assert.ok(h.replies().every(reply=>reply.speech.includes("Build")));
});

test("cancellation before quick submission and during target resolution prevents effects", async t => {
  const h=await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  const {conversationId}=await h.claim("quick-cancel");
  await h.rpc("cancelQuickRequest",{conversationId,callNonce:"quick-cancel",requestId:"before"});
  const before=h.envelope(conversationId,"quick-cancel","before","Show Voice",{quickAction:{kind:"show_voice"}});
  assert.equal((await h.rpc("submitRequest",{envelope:before})).status,"quick_cancelled");
  let resolve!: (thread:Any)=>void;
  h.harness.sdk.stub("threads.get",()=>new Promise(r=>{resolve=r;}));
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"quick-cancel","during","Ask Build for status",{utteranceItemIds:["u2"],transcriptDelta:[{itemId:"u2",text:"Ask Build for status"}],quickAction:{kind:"send_message",threadId:"thr_build",purpose:"status",text:"status"}})});
  await settle();
  await h.rpc("cancelQuickRequest",{conversationId,callNonce:"quick-cancel",requestId:"during"});
  resolve(makeThreadResponse({id:"thr_build",title:"Build"})); await settle();
  assert.equal(h.world.sends.length,0);
  assert.equal(h.world.spawns,0);
});

test("an uncertain direct send is retained and is never retried", async t => {
  const h=await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("thr_build",makeThreadResponse({id:"thr_build",title:"Build"}));
  let attempts=0; h.harness.sdk.stub("threads.send",async()=>{attempts++;throw new Error("connection lost after acceptance");});
  const {conversationId}=await h.claim("quick-unknown");
  const envelope=h.envelope(conversationId,"quick-unknown","uncertain","Ask Build for status",{quickAction:{kind:"send_message",threadId:"thr_build",purpose:"status",text:"status"}});
  await h.rpc("submitRequest",{envelope}); await settle();
  const result=await h.rpc("retryRequest",{requestId:"uncertain"});
  assert.equal(result.status,"quick_unknown");
  await h.rpc("submitRequest",{envelope});
  assert.equal(attempts,1);
  assert.ok(h.replies().some(r=>r.speech.includes("could not confirm")));
});


test("quick input validation rejects incomplete source text and stale calls", async t => {
  const h=await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  const {conversationId}=await h.claim("quick-source");
  const envelope=h.envelope(conversationId,"quick-source","bad-source","Show Voice",{transcriptDelta:[],quickAction:{kind:"show_voice"}});
  assert.equal((await h.rpc("submitRequest",{envelope})).status,"failed");
  await assert.rejects(h.rpc("lookupVoiceTargets",{nonce:"stale",query:""}));
  assert.equal(h.world.spawns,0);
});

test("quick target lookup stays read-only, hides hidden threads, and reports truncation", async t => {
  const h=await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  await h.claim("lookup");
  h.harness.sdk.stub("threads.search",async()=>({active:{total:30,results:[{thread:makeThreadResponse({id:"visible",title:"Build",visibility:"visible",createdAt:1000,updatedAt:2000,archivedAt:null}),matches:[]},{thread:makeThreadResponse({id:"hidden",title:"Coordinator",visibility:"hidden"}),matches:[]}]},archived:{total:0,results:[]}}));
  const result=await h.rpc("lookupVoiceTargets",{nonce:"lookup",query:"Build"});
  assert.deepEqual(result.threads.map((thread:Any)=>thread.id),["visible"]);
  assert.equal(result.threads[0].createdAt,1000);
  assert.equal(result.threads[0].updatedAt,2000);
  assert.equal(result.threads[0].archived,false);
  assert.equal(result.truncated,true);
  assert.equal(h.world.sends.length,0);
});

test("quick cancellation tombstones survive a plugin reload", async t => {
  const h=await enabledHost();
  const {conversationId}=await h.claim("before-reload");
  await h.rpc("cancelQuickRequest",{conversationId,callNonce:"before-reload",requestId:"delayed"});
  const reloaded=await h.harness.lifecycle.reload(plugin); t.after(()=>reloaded.harness.lifecycle.dispose());
  const result=await reloaded.harness.behavior.callRpc("submitRequest",{envelope:h.envelope(conversationId,"before-reload","delayed","Show Voice",{quickAction:{kind:"show_voice"}})}) as Any;
  assert.equal(result.status,"quick_cancelled");
  assert.equal(h.world.sends.length,0);
});

test("hangup during a direct send preserves uncertainty and never replays delivery", async t => {
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("thr_build",makeThreadResponse({id:"thr_build",title:"Build"}));
  let complete!: (value:Any)=>void;
  h.harness.sdk.stub("threads.send",()=>new Promise(resolve=>{complete=resolve;}));
  const {conversationId}=await h.claim("hangup-send");
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"hangup-send","pending-send","Ask Build for status",{quickAction:{kind:"send_message",threadId:"thr_build",purpose:"status",text:"status"}})}); await settle();
  await h.rpc("forceStop",{nonce:"hangup-send"}); await settle();
  assert.equal((await h.rpc("retryRequest",{requestId:"pending-send"})).status,"quick_unknown");
  complete({ok:true,delivery:"sent"});await settle();
  const result=await h.rpc("retryRequest",{requestId:"pending-send"});
  assert.equal(result.status,"settled","the late receipt supersedes uncertainty without resending");
});


test("device transfer keeps the active conversation and rejects an outdated takeover", async t => {
  const h=await enabledHost(); t.after(()=>h.harness.lifecycle.dispose());
  const desktop=await h.claim("desktop");
  await h.rpc("submitRequest",{envelope:h.envelope(desktop.conversationId,"desktop","warmup","Check status")});
  await h.idle(h.coordinatorId());
  const mobile=await h.rpc("claimCall",{nonce:"mobile",transferFromNonce:"desktop"});
  assert.equal(mobile.conversationId,desktop.conversationId);
  assert.equal(mobile.sequence,desktop.sequence+1);
  await settle();
  assert.equal(h.world.stops.length,0,"transferring must not release the coordinator runtime");
  const status=await h.rpc("getCoordinatorStatus",null);
  assert.equal(status.conversation.currentCallNonce,"mobile");
  await assert.rejects(h.rpc("claimCall",{nonce:"stale-mobile",transferFromNonce:"desktop"}),/call changed/);
  assert.equal((await h.rpc("getCoordinatorStatus",null)).conversation.currentCallNonce,"mobile");
});

test("live creates a configured worker without a coordinator and worker reports use the quiet direct route",async t=>{
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  const settings=await h.rpc("getWorkerSettings",null);
  settings.profiles.investigate.model="gpt-a";
  await h.rpc("setWorkerSettings",settings);
  const {conversationId}=await h.claim("direct-worker");
  const text="Start a thread to investigate transcription errors; don't edit files.";
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"direct-worker","spawn-work",text,{quickAction:{kind:"start_thread",projectId:"proj_app",role:"investigate",title:"Transcription investigation"}})});
  await settle();
  assert.equal(h.world.spawns,1);
  const worker=[...h.world.threads.values()][0];
  assert.equal(worker.spawnArgs.model,"gpt-a");assert.equal(worker.spawnArgs.visibility,"visible");assert.equal(worker.spawnArgs.parentThreadId,undefined);
  assert.equal((await h.rpc("getCoordinatorStatus",null)).conversation.coordinatorThreadId,null);
  assert.equal(h.world.sends.length,0);
  const selected=await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({thread:{id:worker.id,title:worker.title},origin:{kind:null,pluginId:"voice-mode"}}));
  assert.deepEqual(selected.tools.map(tool=>tool.name),["voice_worker_report"]);
  const report={outcome:"complete",speech:"The retry path loses empty transcripts. No files were changed."};
  assert.equal((await h.harness.behavior.callAgentTool("voice_worker_report",report,{threadId:"unrelated"}) as Any).isError,true);
  await h.harness.behavior.callAgentTool("voice_worker_report",report,{threadId:worker.id});
  assert.equal(h.replies().filter(reply=>reply.kind==="update").length,0,"reports wait for worker idle");
  await h.idle(worker.id,"Long investigation output");
  const receipt=h.replies().find(reply=>reply.kind === "final");
  await h.rpc("reportReplyDelivery",{replyId:receipt.replyId,nonce:"direct-worker",state:"delivered"});
  const reserved=await h.rpc("reserveUpdateBatch",{conversationId,nonce:"direct-worker",msSinceCallLive:60000});
  assert.ok(reserved.batch);assert.equal(h.world.spawns,1);assert.equal(h.world.sends.length,0,"the report must not wake a coordinator");
  const update=h.replies().find(reply=>reply.kind==="update");assert.match(update.speech,/Transcription investigation/);assert.match(update.speech,/No files were changed/);
  await h.rpc("reportReplyDelivery",{replyId:update.replyId,nonce:"direct-worker",state:"interrupted"});
  assert.equal((await h.rpc("getCoordinatorStatus",null)).queuedUpdates,1,"interrupted updates remain available");
});

test("coordinator actions use the same dispatch service but require an accepted owning request",async t=>{
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("build",makeThreadResponse({id:"build",title:"Build",status:"idle"}));
  const {conversationId}=await h.claim("coord-actions");
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"coord-actions","coordinate","Ask Build to add tests")});
  const action={kind:"send_message",threadId:"build",purpose:"instruction"};
  const call=(request_id:string,threadId=h.coordinatorId())=>h.harness.behavior.callAgentTool("voice_actions",{request_id,action},{threadId});
  await assert.rejects(()=>call("missing"),/accepted request/);
  await assert.rejects(()=>call("coordinate","build"),/accepted request/);
  const [first,second]=await Promise.all([call("coordinate"),call("coordinate")]);
  assert.deepEqual(first,second);assert.equal(h.world.sends.filter(send=>send.threadId==="build").length,1);
  assert.match(String(first),/Sent to Build/);
  assert.equal(h.replies().length,0,"coordinator owns its one final spoken receipt");
});

test("live read RPC is bounded, read-only and rejects hidden or stale-call targets",async t=>{
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("build",makeThreadResponse({id:"build",title:"Build"}));
  await h.claim("read-call");
  const read=await h.rpc("readVoiceThread",{nonce:"read-call",threadId:"build"});
  assert.equal(read.title,"Build");assert.equal(read.output,null);assert.equal(h.world.sends.length,0);assert.equal(h.world.spawns,0);
  h.world.threads.get("build").visibility="hidden";
  await assert.rejects(()=>h.rpc("readVoiceThread",{nonce:"read-call",threadId:"build"}),/accessible|unavailable|hidden/i);
  await assert.rejects(()=>h.rpc("readVoiceThread",{nonce:"old",threadId:"build"}),/stopped or replaced/);
});

test("worker profiles stay separate from coordinator settings and catalogs use actual machine identity",async t=>{
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  const before=await h.rpc("getConfig",null);
  const profiles=await h.rpc("getWorkerSettings",null);profiles.profiles.review.model="gpt-a";profiles.maxActiveWorkers=3;
  await h.rpc("setWorkerSettings",profiles);
  assert.deepEqual((await h.rpc("getConfig",null)).coordinator,before.coordinator);
  assert.deepEqual(await h.rpc("getWorkerSettings",null),profiles);
  await assert.rejects(()=>h.rpc("setWorkerSettings",{...profiles,maxActiveWorkers:0}));
  const catalog=await h.rpc("listWorkerProviders",{hostId:"host_a"});assert.equal(catalog.hostId,"host_a");assert.ok(catalog.models.some((model:Any)=>model.model==="gpt-b"));
  await assert.rejects(()=>h.rpc("listWorkerProviders",{hostId:"host_b"}),/no longer connected/);
  await h.claim("lookup");const targets=await h.rpc("lookupVoiceTargets",{nonce:"lookup",query:""});
  assert.ok(targets.projects.find((project:Any)=>project.id==="proj_app").hostIds.includes("host_a"));
  assert.equal(targets.hosts.find((host:Any)=>host.id==="host_a").name,"Mac");
});

test("voice_sequence validates targets, publishes before idle, and runs only the current step on the call owner",async t=>{
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  const {conversationId}=await h.claim("sequence-call");
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"sequence-call","sequence-request","Show App, explain it, then show Voice.")});
  const params={request_id:"sequence-request",title:"Workspace review",steps:[
    {kind:"action",action:{kind:"open_project",projectId:"proj_app"}},
    {kind:"speech",text:"This is the App project."},
    {kind:"action",action:{kind:"show_voice"}},
    {kind:"speech",text:"We are back in Voice."},
  ]};
  assert.equal((await h.harness.behavior.callAgentTool("voice_sequence",params,{threadId:"other"}) as Any).isError,true);
  await h.harness.behavior.callAgentTool("voice_sequence",params,{threadId:h.coordinatorId()});
  assert.equal(h.replies().length,1,"the final plan publishes before coordinator idle");
  assert.equal((await h.rpc("pendingUiCommands",{conversationId,callNonce:"sequence-call"})).commands.length,0,"planning does not navigate");
  const forbidden=await h.harness.behavior.callAgentTool("voice_ui",{request_id:"sequence-request",action:{kind:"show_voice"}},{threadId:h.coordinatorId()}) as Any;
  assert.equal(forbidden.isError,true,"the coordinator cannot also execute the planned actions");
  await h.idle(h.coordinatorId());await h.idle(h.coordinatorId());
  const reply=h.replies().find(r=>r.sequence);assert.ok(reply);assert.equal(reply.speech,"");
  let state=(await h.rpc("sequence",{conversationId,callNonce:"sequence-call",replyId:reply.replyId,operation:"sync"})).state;
  const run=(operation:string,overrides:Any={})=>h.rpc("sequence",{conversationId,callNonce:"sequence-call",replyId:reply.replyId,operation,index:state.index,revision:state.revision,...overrides});
  await assert.rejects(run("next",{callNonce:"another-device"}),/does not own/);
  const navigation=run("next");await settle();
  const {commands}=await h.rpc("pendingUiCommands",{conversationId,callNonce:"sequence-call"});assert.equal(commands.length,1);
  const command={conversationId,callNonce:"sequence-call",commandId:commands[0].id};
  assert.equal((await h.rpc("claimUiCommand",command)).claimed,true);
  await h.rpc("reportUiCommandResult",{...command,result:{status:"succeeded",detail:"Project selected."}});
  state=(await navigation).state;assert.equal(state.index,1);
  state=(await run("next")).state;assert.equal(state.phase,"speech");
  const stale={index:state.index,revision:state.revision};
  assert.equal((await run("next")).state.index,1,"generation or a repeated next cannot skip playback");
  assert.equal((await h.rpc("reserveUpdateBatch",{conversationId,nonce:"sequence-call",msSinceCallLive:5000})).reason,"sequence-active");
  state=(await run("delivered")).state;assert.equal(state.index,2);
  assert.equal((await run("delivered",stale)).state.index,2,"duplicate playback receipt is inert");
  state=(await run("stop")).state;assert.equal(state.phase,"cancelled");
});


test("legacy message receipts recover persisted receipts after an interrupted invocation without repeating BB effects", async t => {
  const h = await enabledHost(); t.after(() => h.harness.lifecycle.dispose());
  const { conversationId } = await h.claim("recover-send");
  for (const [id, status] of [["saved-send", "sent"], ["saved-inflight", "sending"]]) {
    await h.rpc("submitRequest", { envelope: h.envelope(conversationId, "recover-send", id, "Send this comment.") });
    h.bb.storage.database().prepare("INSERT INTO voice_message_sends (request_id, payload_json) VALUES (?, ?)").run(id, JSON.stringify({ threadId: "worker", title: "Build", text: "Send this comment.", mode: "queue", status, ...(status === "sent" ? { receipt: { action: "send_message", thread_id: "worker", outcome: "done", note: "Sent" } } : {}) }));
  }
  await h.idle(h.coordinatorId()); await h.idle(h.coordinatorId());
  assert.equal(h.world.sends.filter(s => s.threadId === "worker").length, 0);
  assert.equal(h.replies().length, 2);
  assert.equal(h.replies().find(r => r.requestId === "saved-send").receipts[0].outcome, "done");
  assert.equal(h.replies().find(r => r.requestId === "saved-inflight").receipts[0].outcome, "unknown");
});

test("an investigation forwarded from Voice remains a real request and carries the exact session identity", async t => {
  const h = await enabledHost(); t.after(() => h.harness.lifecycle.dispose());
  const {conversationId} = await h.claim("investigation-call");
  h.world.threads.set("worker", makeThreadResponse({id:"worker", title:"Make voice mode more reliable", status:"active"}));
  const words = "Could you send a message to the voice reliability thread to inspect the transcript for this session? I barely moved and it dropped your message.";
  await h.rpc("submitRequest", {envelope:h.envelope(conversationId,"investigation-call","investigate",words,{quickAction:{kind:"send_message",threadId:"worker",purpose:"instruction",text:"inspect the transcript for this session"}})});
  await settle();
  const sent = h.world.sends.filter(s => s.threadId === "worker");
  assert.equal(sent.length, 1); assert.equal(sent[0].mode, "queue-if-active");
  const body = JSON.parse(sent[0].text.split("\n").at(-1)!);
  assert.equal(body.user.text, words);
  assert.equal(body.provenance.call_nonce, "investigation-call");
  assert.equal(body.provenance.conversation_id, conversationId);
  assert.deepEqual(body.provenance.utterance_item_ids, ["item_1"]);
  assert.doesNotMatch(sent[0].text, /information only|do not execute/i);
  assert.equal(h.world.spawns, 0, "a resolved read-only request does not need coordinator latency");
});

test("shared coordinator actions wait for receipts and recover the destination result without a second send", async t => {
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("build",makeThreadResponse({id:"build",title:"Build",status:"active"}));
  const {conversationId}=await h.claim("shared-receipt");
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"shared-receipt","shared-send","Ask Build to inspect the logs. Do not edit files.")});
  let resolve!: (result:Any)=>void;
  let attempts=0;
  h.world.sendOverride=()=>{attempts++;return new Promise(done=>{resolve=done;});};
  const params={request_id:"shared-send",action:{kind:"send_message",threadId:"build",purpose:"instruction"}};
  const send=()=>h.harness.behavior.callAgentTool("voice_actions",params,{threadId:h.coordinatorId()});
  const first=send(),second=send();await settle();
  await h.harness.behavior.callAgentTool("voice_reply",{request_id:"shared-send",kind:"final",speech:"Sent prematurely."},{threadId:h.coordinatorId()});
  await h.idle(h.coordinatorId(),"No result yet.");
  assert.equal(h.replies().length,0,"an in-flight send is not a final answer or fallback");
  resolve({ok:true,delivery:"sent"});await Promise.all([first,second]);
  await h.idle(h.coordinatorId(),"I could not do that.");await h.idle(h.coordinatorId());
  assert.equal(attempts,1);
  assert.equal(h.replies().length,1);
  assert.match(h.replies()[0].speech,/Sent to Build/);
  assert.match(h.replies()[0].speech,/Do not edit files/);
  assert.equal(h.replies()[0].receipts[0].outcome,"done");
});

test("unknown shared action delivery stays unknown across coordinator retries and idle", async t => {
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("build",makeThreadResponse({id:"build",title:"Build"}));
  const {conversationId}=await h.claim("shared-unknown");
  await h.rpc("submitRequest",{envelope:h.envelope(conversationId,"shared-unknown","uncertain","Ask Build to inspect logs.")});
  await h.idle(h.coordinatorId(),null); // Finish bootstrap; the queued request now owns the turn.
  let attempts=0;h.world.sendOverride=async()=>{attempts++;throw new Error("Connection lost after dispatch");};
  const send=()=>h.harness.behavior.callAgentTool("voice_actions",{request_id:"uncertain",action:{kind:"send_message",threadId:"build",purpose:"instruction"}},{threadId:h.coordinatorId()});
  await send();await send();await h.idle(h.coordinatorId(),"I failed.");
  assert.equal(attempts,1);assert.equal(h.replies().length,1);
  assert.equal(h.replies()[0].receipts[0].outcome,"unknown");
});

test("historical request-labelled messages remain readable after the operator schema change",async t=>{
  const h=await enabledHost();t.after(()=>h.harness.lifecycle.dispose());
  h.world.threads.set("worker",makeThreadResponse({id:"worker",title:"Build"}));
  const {conversationId}=await h.claim("legacy-label");
  const envelope=h.envelope(conversationId,"legacy-label","legacy-message","Inspect this transcript.",{quickAction:{kind:"send_message",threadId:"worker",purpose:"instruction"}});
  await h.rpc("submitRequest",{envelope});await settle();
  const historical={...envelope,quickAction:{kind:"send_message",threadId:"worker",purpose:"request",text:"Inspect this transcript."}};
  h.bb.storage.database().prepare("UPDATE voice_requests SET envelope_json=? WHERE id=?").run(JSON.stringify(historical),envelope.requestId);
  const status=await h.rpc("getCoordinatorStatus",null);
  assert.equal(status.requests.find((r:Any)=>r.id==="legacy-message")?.text,"Inspect this transcript.");
  await assert.rejects(h.rpc("submitRequest",{envelope:{...historical,requestId:"new-invalid"}}),/validation/);
});
