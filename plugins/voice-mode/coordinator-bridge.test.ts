import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent } from "./voice-agent.ts";
import { TRANSCRIPT_WAIT_MS } from "./coordinator-bridge.ts";
import type { PublishedReply } from "./coordinator/envelopes.ts";

type Any = any;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A live call on the coordinator path: fake WebRTC, a data channel that
 * records every client event, and an rpc spy that answers claimCall with a
 * conversation id and records handoffs, delivery reports, and reservations.
 */
async function coordinatorFixture(t: TestContext, options: { submit?: (envelope: Any) => Promise<Any> | Any; reserve?: () => Any; coordinator?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const originals = ["navigator", "RTCPeerConnection", "Audio"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const channels: FakeDataChannel[] = [];
  class FakeDataChannel {
    readyState = "open";
    sent: Record<string, Any>[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    activeResponseId: string | undefined;
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = "closed"; }
    emit(type: string, extra: Record<string, Any> = {}) {
      if (type === "response.created") this.activeResponseId = extra.response?.id;
      this.onmessage?.({ data: JSON.stringify({ type, ...(type === "response.function_call_arguments.done" ? { response_id: this.activeResponseId } : {}), ...extra }) });
    }
    responses() { return this.sent.filter((event) => event.type === "response.create"); }
    bridgeResponses() { return this.responses().filter((event) => event.response?.metadata?.bb_voice_source === "coordinator_reply"); }
    contextItems() { return this.sent.filter((event) => event.type === "conversation.item.create" && event.item?.role === "system").map((event) => event.item.content[0].text as string); }
    toolOutputs() { return this.sent.filter((event) => event.type === "conversation.item.create" && event.item?.type === "function_call_output"); }
  }
  class FakePeerConnection {
    onconnectionstatechange: (() => void) | null = null;
    iceGatheringState = "complete";
    connectionState = "connected";
    localDescription: RTCSessionDescriptionInit | null = null;
    dc = new FakeDataChannel();
    addTrack() {}
    close() {}
    createDataChannel() { channels.push(this.dc); return this.dc; }
    async createOffer() { return { type: "offer", sdp: "offer" }; }
    async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
    async setRemoteDescription() { this.dc.onopen?.(); }
  }
  class FakeAudio { autoplay = false; srcObject = null; async play() {} remove() {} }
  const track = { kind: "audio", enabled: true, stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { enumerateDevices: async () => [{ deviceId: "mic", kind: "audioinput", label: "Test mic" }], getUserMedia: async () => stream } } });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
  const calls: { method: string; args: Any }[] = [];
  const logs: { kind: string; payload: Any }[] = [];
  const agent = new VoiceAgent();
  let voiceOpens = 0;
  agent.bind({
    openVoice: () => { voiceOpens += 1; },
    rpc: { call: (async (method: string, args: Any) => {
      calls.push({ method, args });
      if (method === "logEvent") { logs.push({ kind: args.kind, payload: args.payload }); return { ok: true }; }
      if (method === "claimCall") return { sequence: 7, conversationId: options.coordinator === false ? null : "conv_1", resumed: false, queuedUpdates: 0 };
      if (method === "createCall") return { sdp: "answer" };
      if (method === "submitRequest") return options.submit ? options.submit(args.envelope) : { requestId: args.envelope.requestId, status: "accepted", receipt: { delivery: "sent", coordinatorThreadId: "thr_c", mode: "queue-if-active" }, error: null, coordinatorThreadId: "thr_c" };
      if (method === "reserveUpdateBatch") return options.reserve ? options.reserve() : { batch: null, reason: "empty" };
      if (method === "pendingReplies") return { replies: [] };
      if (method === "runTool") return { output: "{}", status: "success" };
      return { ok: true };
    }) as never },
    context: { threadId: "thr_view", projectId: "proj_a", onNewThreadScreen: false },
    openNewThread() {},
  });
  t.after(() => {
    agent.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  agent.toggle();
  await settle();
  assert.equal(agent.getState(), "live");
  const dc = channels.at(-1)!;
  const submits = () => calls.filter((call) => call.method === "submitRequest").map((call) => call.args.envelope);
  const deliveries = () => calls.filter((call) => call.method === "reportReplyDelivery").map((call) => call.args);
  const reply = (overrides: Partial<PublishedReply>): PublishedReply => ({
    v: 1, replyId: "reply_1", conversationId: "conv_1", seq: 1, requestId: null, batchId: null, questionId: null, kind: "final", source: "tool",
    speech: "Done.", detail: null, threadIds: [], receipts: [], targetCallNonce: agent.getSessionId(), focusThreadId: null, createdAt: 0, ...overrides,
  });
  return { agent, dc, calls, logs, submits, deliveries, reply, voiceOpens, tick: (ms: number) => t.mock.timers.tick(ms) };
}

function speak(dc: { emit(type: string, extra?: Record<string, Any>): void }, itemId: string) {
  dc.emit("input_audio_buffer.speech_started", { item_id: itemId });
  dc.emit("input_audio_buffer.speech_stopped", { item_id: itemId });
  dc.emit("input_audio_buffer.committed", { item_id: itemId });
}

function delegate(dc: { emit(type: string, extra?: Record<string, Any>): void }, responseId: string, callId: string, args: Record<string, unknown>) {
  dc.emit("response.created", { response: { id: responseId } });
  dc.emit("response.function_call_arguments.done", { name: "delegate_to_coordinator", call_id: callId, arguments: JSON.stringify(args) });
}

test("a handoff waits for the settled transcript and carries the user's words, not the model's paraphrase", async (t) => {
  const { dc, submits, tick } = await coordinatorFixture(t);
  speak(dc, "item_1");
  delegate(dc, "resp_1", "call_1", { request: "archive the old speech thread", interpretation: "archive thread", urgency: "new" });
  await settle();
  assert.equal(dc.toolOutputs().length, 1, "the tool call is acknowledged at once");
  assert.match(dc.toolOutputs()[0].item.output, /Handoff r_/);
  assert.equal(submits().length, 0, "nothing is sent before the transcript settles");
  dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "item_1", transcript: "I think we can archive it. Nothing remains, right?" });
  await settle();
  assert.equal(submits().length, 1);
  const envelope = submits()[0];
  assert.equal(envelope.originalText, "I think we can archive it. Nothing remains, right?");
  assert.equal(envelope.interpretation, "archive thread");
  assert.equal(envelope.transcriptAvailable, true);
  assert.deepEqual(envelope.utteranceItemIds, ["item_1"]);
  assert.equal(envelope.callNonce, dc ? envelope.callNonce : "");
  assert.equal(envelope.callSequence, 7);
  assert.deepEqual(envelope.view, { threadId: "thr_view", projectId: "proj_a", onNewThreadScreen: false });
  tick(1);
});

test("a handoff without a transcript dispatches after the bounded wait, marked unavailable", async (t) => {
  const { dc, submits, logs, tick } = await coordinatorFixture(t);
  speak(dc, "item_1");
  delegate(dc, "resp_1", "call_1", { request: "stop the CI thread" });
  await settle();
  tick(TRANSCRIPT_WAIT_MS - 1);
  await settle();
  assert.equal(submits().length, 0);
  tick(1);
  await settle();
  assert.equal(submits().length, 1);
  assert.equal(submits()[0].transcriptAvailable, false);
  assert.equal(submits()[0].originalText, "");
  assert.equal(submits()[0].interpretation, "stop the CI thread");
  assert.ok(logs.some((log) => log.kind === "handoff.transcriptTimeout"));
});

test("speaking again holds an unsent handoff, and the next delegation carries both utterances", async (t) => {
  const { dc, submits, logs } = await coordinatorFixture(t);
  speak(dc, "item_1");
  delegate(dc, "resp_1", "call_1", { request: "tell the activity thread to remove it" });
  await settle();
  speak(dc, "item_2"); // "...wait, only if it's already built in"
  await settle();
  assert.ok(logs.some((log) => log.kind === "handoff.superseded"));
  assert.match(dc.contextItems().at(-1) ?? "", /held and not sent/);
  dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "item_1", transcript: "Tell the activity thread to remove it" });
  dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "item_2", transcript: "wait, only if this is already built in, we do not need our copy" });
  await settle();
  assert.equal(submits().length, 0, "a held handoff never dispatches on its own");
  delegate(dc, "resp_2", "call_2", { request: "tell the activity thread to remove it, only if it's already built in" });
  await settle();
  assert.equal(submits().length, 1);
  const envelope = submits()[0];
  assert.equal(envelope.originalText, "wait, only if this is already built in, we do not need our copy");
  assert.deepEqual(envelope.transcriptDelta.map((item: Any) => item.text), ["Tell the activity thread to remove it", "wait, only if this is already built in, we do not need our copy"]);
});

test("replies are spoken under their gate, tracked to what was heard, and added to context; stale calls are ignored", async (t) => {
  const { agent, dc, reply, deliveries, tick } = await coordinatorFixture(t);
  // A clarification may be spoken while the coordinator waits, but not over the user.
  dc.emit("input_audio_buffer.speech_started", { item_id: "u1" });
  agent.ingestCoordinatorSignal("voice-reply", reply({ replyId: "reply_q", kind: "clarification", questionId: "q_1", speech: "Which thread: speech or CI?" }));
  await settle();
  assert.equal(dc.bridgeResponses().length, 0);
  dc.emit("input_audio_buffer.speech_stopped", { item_id: "u1" });
  dc.emit("input_audio_buffer.committed", { item_id: "u1" });
  // The user's own turn still has no response, so the question waits for it.
  assert.equal(dc.bridgeResponses().length, 0);
  dc.emit("response.created", { response: { id: "resp_user" } });
  dc.emit("response.done", { response: { id: "resp_user", status: "completed", output: [{ type: "message" }] } });
  tick(1);
  assert.equal(dc.bridgeResponses().length, 1);
  assert.equal(dc.bridgeResponses()[0].response.metadata.bb_reply_id, "reply_q");
  assert.equal(dc.bridgeResponses()[0].response.tool_choice, "none");
  dc.emit("response.created", { response: { id: "resp_q", metadata: { bb_voice_source: "coordinator_reply", bb_reply_id: "reply_q" } } });
  dc.emit("output_audio_buffer.started", { response_id: "resp_q" });
  dc.emit("response.done", { response: { id: "resp_q", status: "completed" } });
  dc.emit("output_audio_buffer.stopped", { response_id: "resp_q" });
  await settle();
  assert.deepEqual(deliveries().map((entry) => entry.state), ["playing", "delivered"]);
  assert.equal(JSON.parse(dc.contextItems().at(-1)!).voice_reply.question_id,"q_1");
  assert.equal(agent.getBridgeSnapshot()?.openQuestion?.id, "q_1");
  // A reply for another call never speaks here.
  agent.ingestCoordinatorSignal("voice-reply", reply({ replyId: "reply_old", targetCallNonce: "old-call", speech: "Stale." }));
  tick(5000);
  assert.equal(dc.bridgeResponses().length, 1);
  // An interrupted reply is recorded as partly heard, and the same id is never spoken twice.
  agent.ingestCoordinatorSignal("voice-reply", reply({ replyId: "reply_f", kind: "final", requestId: "r_1", speech: "Archived the speech thread.", threadIds: ["thr_speech"] }));
  tick(1);
  assert.equal(dc.bridgeResponses().length, 2);
  dc.emit("response.created", { response: { id: "resp_f", metadata: { bb_voice_source: "coordinator_reply", bb_reply_id: "reply_f" } } });
  dc.emit("output_audio_buffer.started", { response_id: "resp_f" });
  dc.emit("input_audio_buffer.speech_started", { item_id: "u2" });
  dc.emit("output_audio_buffer.cleared", { response_id: "resp_f" });
  await settle();
  assert.equal(deliveries().at(-1)?.state, "interrupted");
  assert.deepEqual(JSON.parse(dc.contextItems().at(-1)!).voice_reply.threads,["thr_speech"]);
  agent.ingestCoordinatorSignal("voice-reply", reply({ replyId: "reply_f", kind: "final", requestId: "r_1", speech: "Archived the speech thread." }));
  dc.emit("input_audio_buffer.speech_stopped", { item_id: "u2" });
  tick(5000);
  assert.equal(dc.bridgeResponses().length, 2);
});

test("background digests need the full idle gate, and interrupting one preserves the batch", async (t) => {
  let reservations = 0;
  const { agent, dc, reply, deliveries, calls, tick } = await coordinatorFixture(t, { reserve: () => { reservations += 1; return { batch: { id: "batch_1", count: 2, remaining: 0 }, reason: null }; } });
  agent.ingestCoordinatorSignal("voice-inbox", { conversationId: "conv_1", callNonce: agent.getSessionId(), queued: 3 });
  tick(1999);
  assert.equal(reservations, 0, "not quiet for two seconds yet");
  tick(1);
  await settle();
  assert.equal(reservations, 1);
  assert.equal(calls.find((call) => call.method === "reserveUpdateBatch")?.args.conversationId, "conv_1");
  // A pending handoff blocks unrelated background speech.
  speak(dc, "item_9");
  delegate(dc, "resp_9", "call_9", { request: "what's running" });
  dc.emit("response.output_audio_transcript.done", {response_id:"resp_9",transcript:"On it."});
  await settle();
  agent.ingestCoordinatorSignal("voice-reply", reply({ replyId: "reply_u", kind: "update", batchId: "batch_1", speech: "Docs failed on the build script." }));
  tick(2500);
  assert.equal(dc.bridgeResponses().length, 0, "a handoff waiting for its transcript blocks the digest");
  dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "item_9", transcript: "what's running" });
  await settle();
  dc.emit("response.done", { response: { id: "resp_9", status: "completed", output: [{ type: "function_call" }] } });
  dc.emit("response.created", { response: { id: "resp_ack" } });
  dc.emit("response.done", { response: { id: "resp_ack", status: "completed", output: [{ type: "message" }] } });
  tick(1999);
  assert.equal(dc.bridgeResponses().length, 0, "background speech waits for the quiet window");
  tick(1);
  assert.equal(dc.bridgeResponses().length, 1);
  dc.emit("response.created", { response: { id: "resp_u", metadata: { bb_voice_source: "coordinator_reply", bb_reply_id: "reply_u" } } });
  dc.emit("output_audio_buffer.started", { response_id: "resp_u" });
  dc.emit("input_audio_buffer.speech_started", { item_id: "u3" });
  dc.emit("output_audio_buffer.cleared", { response_id: "resp_u" });
  await settle();
  assert.equal(deliveries().at(-1)?.state, "interrupted", "the server re-queues the batch's updates");
  assert.equal(JSON.parse(dc.contextItems().at(-1)!).voice_reply.delivery,"interrupted");
});

test("hangup cancels a handoff still waiting for its transcript but lets a settled one reach the server", async (t) => {
  const { agent, dc, submits, logs } = await coordinatorFixture(t);
  speak(dc, "item_1");
  dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "item_1", transcript: "tell the three review threads to rebase" });
  delegate(dc, "resp_1", "call_1", { request: "tell the three review threads to rebase" });
  await settle();
  speak(dc, "item_2");
  delegate(dc, "resp_2", "call_2", { request: "and then" });
  await settle();
  agent.stop();
  await settle();
  assert.equal(submits().length, 1, "the settled request was dispatched; the partial one was not");
  assert.equal(submits()[0].originalText, "tell the three review threads to rebase");
  assert.ok(logs.some((log) => log.kind === "handoff.cancelled"));
  assert.equal(agent.getBridgeSnapshot(), null);
});

test("remain_silent returns no speech and end_call stops once the goodbye has played", async (t) => {
  const { agent, dc } = await coordinatorFixture(t);
  dc.emit("response.created", { response: { id: "resp_1" } });
  dc.emit("response.function_call_arguments.done", { name: "remain_silent", call_id: "call_s", arguments: "{}" });
  await settle();
  assert.equal(dc.toolOutputs().length, 1);
  dc.emit("response.done", { response: { id: "resp_1", status: "completed", output: [{ type: "function_call" }] } });
  assert.equal(dc.responses().length, 0, "no response.create after remain_silent");
  dc.emit("response.created", { response: { id: "resp_2" } });
  dc.emit("response.function_call_arguments.done", { name: "end_call", call_id: "call_e", arguments: "{}" });
  await settle();
  dc.emit("response.done", { response: { id: "resp_2", status: "completed", output: [{ type: "function_call" }] } });
  assert.equal(dc.responses().length, 1, "the model may say goodbye");
  dc.emit("response.created", { response: { id: "resp_bye" } });
  dc.emit("output_audio_buffer.started", { response_id: "resp_bye" });
  dc.emit("response.done", { response: { id: "resp_bye", status: "completed", output: [{ type: "message" }] } });
  assert.equal(agent.getState(), "live", "the call stays up while the goodbye plays");
  dc.emit("output_audio_buffer.stopped", { response_id: "resp_bye" });
  assert.equal(agent.getState(), "idle");
});

test("the direct path stays unchanged when the server reports no conversation", async (t) => {
  const { agent, dc, calls } = await coordinatorFixture(t, { coordinator: false });
  assert.equal(agent.getBridgeSnapshot(), null);
  dc.emit("response.created", { response: { id: "resp_1" } });
  dc.emit("response.function_call_arguments.done", { name: "delegate_to_coordinator", call_id: "call_d", arguments: JSON.stringify({ request: "x" }) });
  await settle();
  // Without a bridge the call goes to the server like any other tool, where an unknown name is refused.
  assert.ok(calls.some((call) => call.method === "runTool" && call.args.name === "delegate_to_coordinator"));
  assert.equal(calls.some((call) => call.method === "submitRequest"), false);
  agent.ingestCoordinatorSignal("voice-reply", { v: 1 });
  assert.equal(dc.responses().filter((event) => event.response?.metadata?.bb_voice_source === "coordinator_reply").length, 0);
});


test("starting a call opens Voice once and ordinary replies need no work-thread view", async (t) => {
  const { agent, dc, calls, reply, voiceOpens, tick } = await coordinatorFixture(t);
  assert.equal(voiceOpens, 1);
  agent.ingestCoordinatorSignal("voice-reply", reply({ requestId: "r_work", speech: "The review thread finished the requested changes.", threadIds: ["thr_work"] }));
  tick(1);
  assert.equal(dc.bridgeResponses().length, 1);
  assert.equal(calls.some(call => call.method === "resolveThreadViews" || call.method === "applyPresentation"), false);
  assert.equal(agent.getState(), "live");
});

test("a background digest cannot open a work-thread view even with a presentation field", async (t) => {
  const { agent, dc, calls, reply, tick } = await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply", reply({ kind: "update", batchId: "batch_test", speech: "The review finished.", focusThreadId: "thr_work" }));
  tick(3000);
  assert.equal(dc.bridgeResponses().length, 1);
  assert.equal(calls.some(call => call.method === "resolveThreadViews" || call.method === "applyPresentation"), false);
  assert.equal(agent.getState(), "live");
});

test("delegation emits one bridge acknowledgment with no model tool follow-up, then one final answer", async (t) => {
  const {agent,dc,submits,reply,deliveries,logs,tick} = await coordinatorFixture(t);
  speak(dc,"ack_input");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"ack_input",transcript:"Check the current threads."});
  const before = dc.responses().length;
  delegate(dc,"ack_tool","ack_call",{request:"Check the current threads.",acknowledgment:"I’ll check what is active."});
  await settle();
  assert.equal(dc.responses().length,before,"tool output cannot ask the model for another acknowledgment");
  dc.emit("response.done",{response:{id:"ack_tool",status:"completed",output:[{type:"function_call"}]}});
  await settle(); tick(1);
  const ack = dc.bridgeResponses().at(-1)!;
  assert.match(ack.response.metadata.bb_reply_id,/^local_ack_/);
  assert.equal(ack.response.input[0].content[0].text,"I’ll check what is active.");
  dc.emit("response.created",{response:{id:"ack_audio",metadata:ack.response.metadata}});
  dc.emit("output_audio_buffer.started",{response_id:"ack_audio"});
  dc.emit("response.output_audio_transcript.done",{response_id:"ack_audio",item_id:"ack_output",transcript:"I’ll check what is active."});
  dc.emit("response.done",{response:{id:"ack_audio",status:"completed",output:[{type:"message"}]}});
  const requestId = submits()[0].requestId;
  agent.ingestCoordinatorSignal("voice-reply",reply({requestId,replyId:"answer"}));
  assert.equal(dc.bridgeResponses().length,1,"the answer waits for acknowledgment playback");
  dc.emit("output_audio_buffer.stopped",{response_id:"ack_audio"}); tick(1);
  assert.equal(dc.bridgeResponses().length,2);
  assert.equal(dc.bridgeResponses()[1].response.metadata.bb_reply_id,"answer");
  assert.equal(deliveries().length,0,"a local acknowledgment is not a stored coordinator reply");
  await settle();
  assert.ok(logs.some(row => row.kind === "assistant" && row.payload.source === "acknowledgment" && row.payload.requestId === requestId));
});

test("a spoken preamble consumes the single acknowledgment and stale audio cannot finish a later reply", async (t) => {
  const {agent,dc,reply,deliveries,tick} = await coordinatorFixture(t);
  speak(dc,"u_ack");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"u_ack",transcript:"Check."});
  delegate(dc,"preamble","preamble_call",{request:"Check."});
  dc.emit("response.output_audio_transcript.done",{response_id:"preamble",transcript:"Checking."});
  await settle();
  dc.emit("response.done",{response:{id:"preamble",status:"completed",output:[{type:"function_call"},{type:"message"}]}});
  await settle(); tick(1);
  assert.equal(dc.bridgeResponses().length,0);
  agent.ingestCoordinatorSignal("voice-reply",reply({replyId:"first"})); tick(1);
  dc.emit("response.created",{response:{id:"first_audio",metadata:dc.bridgeResponses()[0].response.metadata}});
  dc.emit("output_audio_buffer.started",{response_id:"first_audio"});
  dc.emit("response.done",{response:{id:"first_audio",status:"completed"}});
  dc.emit("output_audio_buffer.stopped",{response_id:"first_audio"});
  agent.ingestCoordinatorSignal("voice-reply",reply({replyId:"second"})); tick(1);
  dc.emit("response.created",{response:{id:"second_audio",metadata:dc.bridgeResponses()[1].response.metadata}});
  dc.emit("output_audio_buffer.started",{response_id:"second_audio"});
  dc.emit("output_audio_buffer.cleared",{response_id:"first_audio"});
  dc.emit("response.done",{response:{id:"first_audio",status:"cancelled"}});
  await settle();
  assert.equal(deliveries().filter(row => row.replyId === "second" && row.state !== "playing").length,0);
  dc.emit("response.done",{response:{id:"second_audio",status:"completed"}});
  dc.emit("output_audio_buffer.stopped",{response_id:"second_audio"});
  await settle();
  assert.equal(deliveries().at(-1)?.state,"delivered");
  assert.equal(deliveries().at(-1)?.replyId,"second");
});

test("interruption before response.created cancels the late bridge response instead of adopting it", async (t) => {
  const {agent,dc,reply,deliveries,tick} = await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply",reply({replyId:"before_audio"})); tick(1);
  const metadata = dc.bridgeResponses()[0].response.metadata;
  dc.emit("input_audio_buffer.speech_started",{item_id:"correction"});
  dc.emit("response.created",{response:{id:"late_audio",metadata}});
  dc.emit("output_audio_buffer.started",{response_id:"late_audio"});
  dc.emit("response.done",{response:{id:"late_audio",status:"cancelled"}});
  await settle();
  assert.ok(dc.sent.some(event=>event.type === "response.cancel" && event.response_id === "late_audio"));
  assert.equal(deliveries().filter(row=>row.replyId === "before_audio" && row.state === "playing").length,0);
  assert.equal(deliveries().at(-1)?.state,"interrupted");
});

test("a mismatched spoken answer is never recorded as the intended answer or replayed", async(t)=>{
  const {agent,dc,reply,deliveries,logs,tick}=await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply",reply({replyId:"mismatch",speech:"The checks pass."}));tick(1);
  const expected=dc.bridgeResponses()[0];
  assert.match(expected.response.instructions,/<speech>The checks pass.<\/speech>/);
  dc.emit("response.created",{response:{id:"mismatch_audio",metadata:expected.response.metadata}});
  dc.emit("output_audio_buffer.started",{response_id:"mismatch_audio"});
  dc.emit("response.output_audio_transcript.done",{response_id:"mismatch_audio",transcript:"I don’t have the coordinator’s reply text to repeat."});
  dc.emit("response.done",{response:{id:"mismatch_audio",status:"completed"}});
  dc.emit("output_audio_buffer.stopped",{response_id:"mismatch_audio"});
  await settle();
  assert.equal(deliveries().at(-1)?.state,"mismatch");
  assert.equal(deliveries().some(row=>row.state === "delivered"),false);
  assert.equal(JSON.parse(dc.contextItems().at(-1)!).voice_output.intended_reply_not_delivered,true);
  assert.ok(logs.some(row=>row.kind === "reply.mismatch"));
  tick(5000);assert.equal(dc.bridgeResponses().length,1);
});

test("a late tool from an interrupted response cannot dispatch while the user continues", async(t)=>{
  const {dc,submits}=await coordinatorFixture(t);
  speak(dc,"old_input");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"old_input",transcript:"Change the setting"});
  dc.emit("response.created",{response:{id:"old_response"}});
  dc.emit("input_audio_buffer.speech_started",{item_id:"continuation"});
  dc.emit("response.function_call_arguments.done",{response_id:"old_response",name:"delegate_to_coordinator",call_id:"late",arguments:"{}"});
  await settle();
  assert.equal(submits().length,0);
  assert.match(dc.toolOutputs().at(-1)?.item.output,/Held/);
});
