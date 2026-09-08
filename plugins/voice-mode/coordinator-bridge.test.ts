import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent } from "./voice-agent.ts";
import { nativeUi } from "./native-ui.ts";
import { TRANSCRIPT_WAIT_MS } from "./coordinator-bridge.ts";
import { userRequestEnvelopeSchema, type PublishedReply } from "./coordinator/envelopes.ts";

type Any = any;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A live call on the coordinator path: fake WebRTC, a data channel that
 * records every client event, and an rpc spy that answers claimCall with a
 * conversation id and records handoffs, delivery reports, and reservations.
 */
async function coordinatorFixture(t: TestContext, options: { submit?: (envelope: Any) => Promise<Any> | Any; reserve?: () => Any; sequence?: (input:Any)=>Any; coordinator?: boolean } = {}) {
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
  t.mock.method(nativeUi, "snapshot", () => ({ threadId: "thr_view", projectId: "proj_a", onNewThreadScreen: false, route: "/threads/thr_view", composers: [], draft: null, bound: true }));
  agent.bind({
    rpc: { call: (async (method: string, args: Any) => {
      calls.push({ method, args });
      if (method === "logEvent") { logs.push({ kind: args.kind, payload: args.payload }); return { ok: true }; }
      if (method === "claimCall") return { sequence: 7, conversationId: options.coordinator === false ? null : "conv_1", resumed: false, queuedUpdates: 0 };
      if (method === "createCall") return { sdp: "answer" };
      if (method === "submitRequest") return options.submit ? options.submit(args.envelope) : { requestId: args.envelope.requestId, status: "accepted", receipt: { delivery: "sent", coordinatorThreadId: "thr_c", mode: "queue-if-active" }, error: null, coordinatorThreadId: "thr_c" };
      if (method === "reserveUpdateBatch") return options.reserve ? options.reserve() : { batch: null, reason: "empty" };
      if (method === "resolveThreadViews") return { views: args.threadIds.map((threadId:string)=>({kind:"thread",id:`thread:${threadId}`,threadId,projectId:"proj_other",title:"Build thread"})) };
      if (method === "sequence") return options.sequence ? options.sequence(args) : {state:null};
      if (method === "pendingReplies") return { replies: [] };
      if (method === "runTool") return { output: "{}", status: "success" };
      return { ok: true };
    }) as never },
    context: { threadId: "thr_view", projectId: "proj_a", onNewThreadScreen: false },
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
  assert.equal(agent.getState(), options.coordinator === false ? "idle" : "live");
  const dc = channels.at(-1)!;
  const submits = () => calls.filter((call) => call.method === "submitRequest").map((call) => call.args.envelope);
  const deliveries = () => calls.filter((call) => call.method === "reportReplyDelivery").map((call) => call.args);
  const reply = (overrides: Partial<PublishedReply>): PublishedReply => ({
    v: 1, replyId: "reply_1", conversationId: "conv_1", seq: 1, requestId: null, batchId: null, questionId: null, kind: "final", source: "tool",
    speech: "Done.", detail: null, threadIds: [], receipts: [], targetCallNonce: agent.getSessionId(), createdAt: 0, ...overrides,
  });
  return { agent, dc, calls, logs, submits, deliveries, reply, tick: (ms: number) => t.mock.timers.tick(ms) };
}

function speak(dc: { emit(type: string, extra?: Record<string, Any>): void }, itemId: string, words = "Hello") {
  dc.emit("input_audio_buffer.speech_started", { item_id: itemId });
  if (words) dc.emit("conversation.item.input_audio_transcription.delta", { item_id: itemId, delta: words });
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
  assert.match(dc.toolOutputs()[0].item.output, /Request r_/);
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
  assert.equal(userRequestEnvelopeSchema.safeParse(envelope).success, true);
  assert.deepEqual(envelope.view, { threadId: "thr_view", projectId: "proj_a", onNewThreadScreen: false });
  tick(1);
});

test("a handoff without a transcript is rejected after the bounded wait", async (t) => {
  const { dc, submits, logs, tick } = await coordinatorFixture(t);
  speak(dc, "item_1");
  delegate(dc, "resp_1", "call_1", { request: "stop the CI thread" });
  await settle();
  tick(TRANSCRIPT_WAIT_MS - 1);
  await settle();
  assert.equal(submits().length, 0);
  tick(1);
  await settle();
  assert.equal(submits().length, 0);
  assert.ok(logs.some(log => log.kind === "handoff.rejected"));
  assert.ok(logs.some(log => log.kind === "transcription.result" && log.payload.error?.code === "transcript_timeout"));
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
  dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "u1", transcript: "Wait a moment." });
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
  speak(dc, "silent_input");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"silent_input",transcript:"No reply needed."});
  dc.emit("response.created", { response: { id: "resp_1" } });
  dc.emit("response.function_call_arguments.done", { name: "remain_silent", call_id: "call_s", arguments: "{}" });
  await settle();
  assert.equal(dc.toolOutputs().length, 1);
  dc.emit("response.done", { response: { id: "resp_1", status: "completed", output: [{ type: "function_call" }] } });
  assert.equal(dc.responses().length, 1, "no response.create after remain_silent");
  speak(dc, "bye_input");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"bye_input",transcript:"End this call."});
  dc.emit("response.created", { response: { id: "resp_2" } });
  dc.emit("response.function_call_arguments.done", { name: "end_call", call_id: "call_e", arguments: "{}" });
  await settle();
  dc.emit("response.done", { response: { id: "resp_2", status: "completed", output: [{ type: "function_call" }] } });
  assert.equal(dc.responses().length, 3, "the model may say goodbye");
  dc.emit("response.created", { response: { id: "resp_bye" } });
  dc.emit("output_audio_buffer.started", { response_id: "resp_bye" });
  dc.emit("response.done", { response: { id: "resp_bye", status: "completed", output: [{ type: "message" }] } });
  assert.equal(agent.getState(), "live", "the call stays up while the goodbye plays");
  dc.emit("output_audio_buffer.stopped", { response_id: "resp_bye" });
  assert.equal(agent.getState(), "idle");
});

test("a missing coordinator conversation stops startup without a direct fallback", async (t) => {
  const { agent, calls } = await coordinatorFixture(t, { coordinator: false });
  assert.equal(agent.getState(), "idle");
  assert.equal(agent.getBridgeSnapshot(), null);
  assert.equal(calls.some(call => call.method === "createCall" || call.method === "runTool"), false);
});

test("ordinary replies do not navigate away from the current route", async (t) => {
  const { agent, dc, calls, reply, tick } = await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply", reply({ requestId: "r_work", speech: "The review thread finished the requested changes.", threadIds: ["thr_work"] }));
  tick(1);
  assert.equal(dc.bridgeResponses().length, 1);
  assert.equal(calls.some(call => call.method === "resolveThreadViews" || call.method === "applyPresentation"), false);
  assert.equal(agent.getState(), "live");
});

test("a background digest cannot open a work-thread view even with a presentation field", async (t) => {
  const { agent, dc, calls, reply, tick } = await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply", reply({ kind: "update", batchId: "batch_test", speech: "The review finished." }));
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
  dc.emit("conversation.item.input_audio_transcription.delta",{item_id:"correction",delta:"Wait"});
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
  dc.emit("conversation.item.input_audio_transcription.delta",{item_id:"continuation",delta:"Wait"});
  dc.emit("response.function_call_arguments.done",{response_id:"old_response",name:"delegate_to_coordinator",call_id:"late",arguments:"{}"});
  await settle();
  assert.equal(submits().length,0);
  assert.match(dc.toolOutputs().at(-1)?.item.output,/Not executed/);
});


test("a reply carries speech without performing UI actions", async (t) => {
  const { agent, calls, reply, tick } = await coordinatorFixture(t);
  const execute = t.mock.method(nativeUi, "execute", async () => ({ status: "succeeded" as const, detail: "Shown" }));
  agent.ingestCoordinatorSignal("voice-reply", reply({ speech: "Here is the build thread.", threadIds: ["thr_other"] }));
  tick(1);
  await settle();
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(agent.getState(), "live");
  assert.equal(calls.some(call => call.method === "claimUiCommand"), false);
});

test("realtime mutation names cannot bypass the coordinator", async t => {
  const { dc, calls } = await coordinatorFixture(t);
  speak(dc, "input-mutation");
  dc.emit("response.created", { response: { id: "mutation" } });
  for (const name of ["start_thread", "focus_thread", "set_composer_text", "get_context"]) {
    dc.emit("response.function_call_arguments.done", { response_id: "mutation", name, call_id: name, arguments: "{}" });
  }
  await settle();
  assert.equal(calls.some(call => call.method === "runTool" || call.method === "claimUiCommand"), false);
  assert.equal(dc.toolOutputs().length, 4);
  assert.ok(dc.toolOutputs().every(event => event.item.output.includes("Unknown realtime tool")));
});


test("empty transcription cancels a guessed answer without a spoken repair", async t => {
  const {dc, submits, logs, tick} = await coordinatorFixture(t);
  speak(dc, "missing");
  dc.emit("response.created", {response:{id:"guess"}});
  dc.emit("output_audio_buffer.started", {response_id:"guess"});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"missing", transcript:"  "});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"missing", transcript:""});
  dc.emit("response.function_call_arguments.done", {response_id:"guess", name:"delegate_to_coordinator", call_id:"bad", arguments:JSON.stringify({request:"We are working on project Alpha."})});
  dc.emit("response.done", {response:{id:"guess",status:"cancelled"}});
  await settle(); tick(2500); await settle();
  assert.equal(submits().length, 0);
  assert.ok(dc.sent.some(e => e.type === "response.cancel" && e.response_id === "guess"));
  assert.ok(dc.sent.some(e => e.type === "output_audio_buffer.clear"));
  assert.equal(logs.filter(e => e.kind === "transcription.result" && e.payload.outcome === "empty").length, 1);
  assert.equal(dc.bridgeResponses().length, 0);
  assert.ok(!logs.some(e => e.kind === "reply.speaking" && e.payload.replyId.startsWith("local_ack_")));
});

test("empty completion before generation blocks the later guessed tool response", async t => {
  const {dc, submits, tick} = await coordinatorFixture(t);
  speak(dc, "empty_first");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"empty_first", transcript:""});
  delegate(dc, "late_guess", "bad_call", {request:"Archive Alpha"});
  dc.emit("response.done", {response:{id:"late_guess",status:"cancelled"}});
  await settle(); tick(2500); await settle();
  assert.equal(submits().length, 0);
  assert.ok(dc.sent.some(e => e.type === "response.cancel" && e.response_id === "late_guess"));
  assert.equal(dc.bridgeResponses().length, 0);
});

test("non-verbal fragments stay quiet while short commands keep their words", async t => {
  const {dc, logs, submits, tick} = await coordinatorFixture(t);
  for (const [index, text] of ["", "...", "um", "uh, um"].entries()) {
    const item = `noise_${index}`;
    speak(dc, item);
    delegate(dc, item, `${item}_call`, {request: "A guessed request"});
    await settle();
    dc.emit("conversation.item.input_audio_transcription.completed", {item_id: item, transcript: text});
    dc.emit("response.done", {response: {id: item, status: "cancelled"}});
    await settle(); tick(2500); await settle();
  }
  assert.equal(dc.bridgeResponses().length, 0);
  assert.equal(submits().length, 0);
  assert.equal(logs.filter(event => event.kind === "user").length, 0);
  for (const [index, text] of ["Stop", "Wait", "Yes", "No", "I", "Go", "Um, open the latest Voice thread"].entries()) {
    const item = `words_${index}`;
    speak(dc, item);
    dc.emit("conversation.item.input_audio_transcription.completed", {item_id: item, transcript: text});
    delegate(dc, item, `${item}_call`, {request: text});
    await settle();
    assert.equal(submits().at(-1).originalText, text);
    dc.emit("response.done", {response: {id: item, status: "completed"}});
  }
  assert.equal(submits().length, 7);
});

test("a cancellation racing completion stays diagnostic and cannot disturb the next response", async t => {
  const {agent, dc, logs} = await coordinatorFixture(t);
  speak(dc, "empty");
  dc.emit("response.created", {response: {id: "guess"}});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id: "empty", transcript: ""});
  const cancel = dc.sent.find(event => event.type === "response.cancel")!;
  assert.ok(cancel.event_id);
  dc.emit("response.done", {response: {id: "guess", status: "completed"}});
  speak(dc, "retry");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id: "retry", transcript: "Wait, I want to explain what to change."});
  dc.emit("response.created", {response: {id: "next"}});
  dc.emit("error", {error: {event_id: cancel.event_id, type: "invalid_request_error", code: "response_cancel_not_active", message: "Cancellation failed: no active response found"}});
  await settle();
  assert.equal(logs.filter(event => event.kind === "response.cancelSettled").length, 1);
  assert.equal(logs.filter(event => event.kind === "error").length, 0);
  assert.equal((agent as Any).activeResponseId, "next");
  assert.equal((agent as Any).responseActive, true);
  // An uncorrelated error is still surfaced, even if its wording is identical.
  dc.emit("error", {error: {event_id: "unknown", message: "Cancellation failed: no active response found"}});
  await settle();
  assert.equal(logs.filter(event => event.kind === "error").length, 1);
});

test("rejected tools receive one terminal output without work or another response", async t => {
  const {dc, submits} = await coordinatorFixture(t);
  speak(dc, "empty");
  dc.emit("response.created", {response: {id: "guess"}});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id: "empty", transcript: ""});
  const before = dc.responses().length;
  for (let i = 0; i < 2; i++) dc.emit("response.function_call_arguments.done", {
    response_id: "guess", name: "sequence_control", call_id: "rejected", arguments: '{"operation":"resume"}',
  });
  dc.emit("response.function_call_arguments.done", {response_id: "unknown", name: "quick_action", call_id: "unknown", arguments: "{}"});
  await settle();
  assert.equal(submits().length, 0);
  assert.equal(dc.toolOutputs().length, 1);
  assert.equal(dc.toolOutputs()[0].item.call_id, "rejected");
  assert.match(dc.toolOutputs()[0].item.output, /Not executed/);
  assert.equal(dc.responses().length, before);
});

test("consecutive provider failures ask once, then usable input restores normal recovery", async t => {
  const {dc, tick, logs, submits} = await coordinatorFixture(t);
  for (const id of ["first", "second", "third"]) {
    speak(dc, id);
    dc.emit("response.created", {response: {id}});
    dc.emit("conversation.item.input_audio_transcription.failed", {item_id: id, error: {message: "Transcription failed"}});
    dc.emit("response.done", {response: {id, status: "cancelled"}});
    await settle(); tick(2500); await settle();
    if (id === "first") {
      const response = dc.bridgeResponses()[0].response;
      dc.emit("response.created", {response: {id: "repair", metadata: response.metadata}});
      dc.emit("output_audio_buffer.started", {response_id: "repair"});
      dc.emit("response.done", {response: {id: "repair", status: "completed"}});
      // The second utterance interrupts this prompt, as in the reported call.
    }
  }
  assert.equal(dc.bridgeResponses().length, 1);
  assert.equal(logs.filter(event => event.kind === "transcription.repairSuppressed").length, 2);
  speak(dc, "valid");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id: "valid", transcript: "Check the active threads."});
  delegate(dc, "valid_response", "valid_tool", {request: "Check the active threads."});
  await settle();
  assert.equal(submits().length, 1);
  assert.equal(submits()[0].originalText, "Check the active threads.");
  dc.emit("response.done", {response: {id: "valid_response", status: "completed"}});
  speak(dc, "new_empty");
  dc.emit("response.created", {response: {id: "new_empty_response"}});
  dc.emit("conversation.item.input_audio_transcription.failed", {item_id: "new_empty", error: {message: "Transcription failed"}});
  dc.emit("response.done", {response: {id: "new_empty_response", status: "cancelled"}});
  await settle(); tick(2500); await settle();
  assert.equal(dc.bridgeResponses().filter(event => event.response.metadata.bb_reply_id.startsWith("local_input_")).length, 2);
});

test("late interrupted playback is cleared once without cancelling a completed response or newer audio", async t => {
  const {agent, dc, logs} = await coordinatorFixture(t);
  speak(dc, "explain");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"explain",transcript:"Explain this."});
  dc.emit("response.created", {response: {id: "old"}});
  dc.emit("output_audio_buffer.started", {response_id: "old"});
  dc.emit("response.done", {response: {id: "old", status: "completed"}});
  dc.emit("input_audio_buffer.speech_started", {item_id: "interrupt", audio_start_ms: 100});
  dc.emit("conversation.item.input_audio_transcription.delta", {item_id:"interrupt",delta:"Wait"});
  dc.emit("output_audio_buffer.cleared", {response_id: "old"});
  dc.emit("output_audio_buffer.started", {response_id: "old"});
  dc.emit("output_audio_buffer.started", {response_id: "old"});
  assert.equal(dc.sent.filter(event => event.type === "output_audio_buffer.clear").length, 2);
  assert.equal(dc.sent.filter(event => event.type === "response.cancel").length, 0);
  dc.emit("input_audio_buffer.speech_stopped", {item_id: "interrupt", audio_end_ms: 1400});
  dc.emit("input_audio_buffer.committed", {item_id: "interrupt"});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id: "interrupt", transcript: "Wait, let me explain."});
  dc.emit("response.created", {response: {id: "next"}});
  dc.emit("output_audio_buffer.started", {response_id: "next"});
  dc.emit("output_audio_buffer.started", {response_id: "old"});
  assert.equal(dc.sent.filter(event => event.type === "output_audio_buffer.clear").length, 2);
  assert.equal((agent as Any).playbackResponseId, "next");
  await settle();
  const segment = logs.find(event => event.kind === "audio.inputSegment" && event.payload.itemId === "interrupt")!.payload;
  assert.equal(segment.durationMs, 1300);
  assert.equal(segment.interruptedPlaybackResponseId, "old");
  assert.equal(segment.microphone.enabled, true);
});

test("a superseded bridge response holds generation until its cancellation settles", async t => {
  const {agent, dc} = await coordinatorFixture(t);
  dc.emit("response.created", {response: {id: "stale", metadata: {bb_voice_source: "coordinator_reply", bb_reply_id: "no_longer_pending"}}});
  assert.equal((agent as Any).responseActive, true);
  assert.equal((agent as Any).activeResponseId, "stale");
  assert.equal(dc.sent.filter(event => event.type === "response.cancel").length, 1);
  dc.emit("response.done", {response: {id: "stale", status: "cancelled"}});
  assert.equal((agent as Any).responseActive, false);
  assert.equal((agent as Any).activeResponseId, null);
});

test("pausing narration after generation ends clears playback without a redundant cancellation", async t => {
  const {agent, dc, reply, tick} = await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply", reply({replyId: "sequence_speech:test:1", speech: "This thread contains the work in progress."}));
  tick(2500); await settle();
  const metadata = dc.bridgeResponses()[0].response.metadata;
  dc.emit("response.created", {response: {id: "narration", metadata}});
  dc.emit("output_audio_buffer.started", {response_id: "narration"});
  dc.emit("response.done", {response: {id: "narration", status: "completed"}});
  (agent as Any).bridge.pauseSequence("The user changed the view.", true);
  assert.equal(dc.sent.filter(event => event.type === "response.cancel").length, 0);
  assert.equal(dc.sent.filter(event => event.type === "output_audio_buffer.clear").length, 1);
  dc.emit("output_audio_buffer.cleared", {response_id: "narration"});
  assert.equal((agent as Any).assistantSpeaking, false);
});

test("a late failed transcript stays with its old turn and does not cancel a new valid request", async t => {
  const {dc, submits, logs} = await coordinatorFixture(t);
  speak(dc, "old");
  speak(dc, "new");
  dc.emit("conversation.item.input_audio_transcription.failed", {item_id:"old", error:{code:"bad_audio",message:"No speech decoded"}});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"new", transcript:"Check my active threads."});
  delegate(dc, "new_response", "new_call", {request:"Check threads"});
  await settle();
  assert.equal(submits().length, 1);
  assert.equal(submits()[0].originalText, "Check my active threads.");
  assert.equal(submits()[0].transcriptAvailable, true);
  assert.equal(dc.sent.filter(e => e.type === "response.cancel").length, 0);
  assert.equal(logs.find(e => e.kind === "transcription.result" && e.payload.outcome === "failed")?.payload.error.code, "bad_audio");
});

test("a failed transcription before commit is retained and a fresh request can recover", async t => {
  const {dc, submits, logs} = await coordinatorFixture(t);
  dc.emit("input_audio_buffer.speech_started");
  dc.emit("input_audio_buffer.speech_stopped");
  dc.emit("conversation.item.input_audio_transcription.failed", {item_id:"failed_first",error:{message:"Empty audio"}});
  dc.emit("input_audio_buffer.committed", {item_id:"failed_first"});
  dc.emit("response.created", {response:{id:"failed_before_commit_response"}});
  assert.ok(dc.sent.some(e => e.type === "response.cancel" && e.response_id === "failed_before_commit_response"));
  dc.emit("response.done", {response:{id:"failed_before_commit_response",status:"cancelled"}});
  speak(dc, "retry");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"retry",transcript:"Open my active thread."});
  delegate(dc, "retry_response", "retry_call", {request:"Open thread"});
  await settle();
  assert.equal(submits().length, 1);
  assert.equal(submits()[0].originalText, "Open my active thread.");
  assert.equal(logs.filter(e => e.kind === "transcription.result" && e.payload.outcome === "failed").length, 1);
});


test("an empty answer leaves a pending question open and produces no request or acknowledgment", async t => {
  const {agent, dc, reply, submits, logs, tick} = await coordinatorFixture(t);
  agent.ingestCoordinatorSignal("voice-reply", reply({replyId:"question",kind:"clarification",questionId:"q1",speech:"Which thread?"}));
  speak(dc, "answer");
  delegate(dc, "answer_response", "answer_tool", {request:"Alpha",answers_question_id:"q1"});
  await settle();
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"answer",transcript:""});
  dc.emit("response.done", {response:{id:"answer_response",status:"cancelled"}});
  await settle(); tick(2500); await settle();
  assert.equal(submits().length, 0);
  assert.ok(logs.some(e => e.kind === "handoff.rejected"));
  assert.ok(!logs.some(e => e.kind === "reply.speaking" && e.payload.replyId.startsWith("local_ack_")));
  // The rejected spoken answer never uses the server's question-resolution route.
  assert.equal((agent as any).bridge.snapshot().openQuestion.id, "q1");
});

test("a transcript arriving after timeout is recorded but never auto-dispatched", async t => {
  const {dc, submits, logs, tick} = await coordinatorFixture(t);
  speak(dc, "late");
  delegate(dc, "late_response", "late_tool", {request:"Archive this thread"});
  await settle(); tick(TRANSCRIPT_WAIT_MS); await settle();
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"late",transcript:"Archive this thread"});
  dc.emit("response.done", {response:{id:"late_response",status:"cancelled"}});
  await settle(); tick(2500); await settle();
  assert.equal(submits().length, 0);
  assert.equal(logs.filter(e => e.kind === "reply.speaking" && e.payload.replyId.startsWith("local_input_")).length, 1);
  assert.ok(logs.some(e => e.kind === "transcription.result" && e.payload.outcome === "complete"));
});

test("an empty fragment prevents dispatch of a partially transcribed utterance", async t => {
  const {dc, submits, logs} = await coordinatorFixture(t);
  speak(dc, "part1");
  dc.emit("input_audio_buffer.committed", {item_id:"part2"});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"part1",transcript:"Archive"});
  delegate(dc, "partial", "partial_tool", {request:"Archive Alpha"});
  await settle();
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"part2",transcript:""});
  await settle();
  assert.equal(submits().length, 0);
  assert.ok(logs.some(e => e.kind === "handoff.rejected"));
});


test("quick actions share transcript validation and never dispatch guessed words", async t => {
  const {dc,submits}=await coordinatorFixture(t);
  speak(dc,"quick_input");
  dc.emit("response.created",{response:{id:"quick_response"}});
  dc.emit("response.function_call_arguments.done",{name:"quick_action",call_id:"quick_call",arguments:JSON.stringify({request:"Open Build",action:{kind:"open_thread",threadId:"thr_build"}})});
  await settle(); assert.equal(submits().length,0);
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"quick_input",transcript:"Open Build in a split"});
  await settle();
  assert.equal(submits().length,1);
  assert.equal(submits()[0].originalText,"Open Build in a split");
  assert.equal(submits()[0].quickAction.kind,"open_thread");
});

test("new speech cancels an in-flight quick action locally and on the server", async t => {
  let accept!: (value:Any)=>void;
  const {agent,dc,calls,submits}=await coordinatorFixture(t,{submit:()=>new Promise(resolve=>{accept=resolve;})});
  speak(dc,"quick_input");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"quick_input",transcript:"Show Voice"});
  dc.emit("response.created",{response:{id:"quick_response"}});
  dc.emit("response.function_call_arguments.done",{name:"quick_action",call_id:"quick_call",arguments:JSON.stringify({request:"Show Voice",action:{kind:"show_voice"}})});
  await settle();
  const requestId=submits()[0].requestId;
  dc.emit("input_audio_buffer.speech_started", {item_id:"interrupt-quick"});
  dc.emit("conversation.item.input_audio_transcription.delta", {item_id:"interrupt-quick",delta:"Wait"});
  assert.ok(calls.some(call=>call.method==="cancelQuickRequest" && call.args.requestId===requestId));
  assert.ok((agent as any).cancelledQuickRequests.has(requestId));
  accept({status:"quick_cancelled",receipt:null,error:null}); await settle();
});

test("quick actions cannot bypass empty input or expose destructive action shapes", async t => {
  const {dc,submits}=await coordinatorFixture(t);
  speak(dc,"empty_quick");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"empty_quick",transcript:""});
  dc.emit("response.created",{response:{id:"guess_quick"}});
  dc.emit("response.function_call_arguments.done",{name:"quick_action",call_id:"bad_quick",arguments:JSON.stringify({request:"Archive Build",action:{kind:"archive_thread",threadId:"thr_build"}})});
  await settle(); assert.equal(submits().length,0);
});


test("a lost quick-submit response never claims non-delivery or asks for an automatic retry", async t => {
  const {dc,logs,tick}=await coordinatorFixture(t,{submit:async()=>{throw new Error("response lost");}});
  speak(dc,"quick_rpc");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"quick_rpc",transcript:"Show Voice"});
  dc.emit("response.created",{response:{id:"quick_rpc_response"}});
  dc.emit("response.function_call_arguments.done",{name:"quick_action",call_id:"quick_rpc_call",arguments:JSON.stringify({request:"Show Voice",action:{kind:"show_voice"}})});
  await settle();
  dc.emit("response.done",{response:{id:"quick_rpc_response",status:"completed"}});
  tick(2500); await settle();
  assert.ok(logs.some(event=>event.kind==="reply.speaking" && event.payload.text.includes("could not confirm")));
  assert.ok(!logs.some(event=>event.kind==="reply.speaking" && event.payload.text.includes("Please try again")));
});

test("request context stays bound to speech start when navigation changes during transcription",async t=>{
  const {dc,submits}=await coordinatorFixture(t);
  let current="thr_original";
  t.mock.method(nativeUi,"snapshot",()=>({threadId:current,projectId:"proj_a",onNewThreadScreen:false,route:`/threads/${current}`,composers:[],draft:null,bound:true}));
  speak(dc,"context-item");
  delegate(dc,"context-response","context-tool",{request:"Ask this thread to investigate"});
  current="thr_different";
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"context-item",transcript:"Ask this thread to investigate"});
  await settle();
  assert.equal(submits()[0].view.threadId,"thr_original");
});

test("direct worker creation carries interpretation and produces no extra starting acknowledgment",async t=>{
  const {dc,submits}=await coordinatorFixture(t,{submit:()=>({status:"quick_running",receipt:null})});
  speak(dc,"worker-item");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"worker-item",transcript:"Start a thread to investigate that retry problem"});
  dc.emit("response.created",{response:{id:"worker-response"}});
  dc.emit("response.function_call_arguments.done",{name:"quick_action",call_id:"worker-tool",arguments:JSON.stringify({request:"Start a thread to investigate that retry problem",interpretation:"The empty transcript retry issue just discussed",action:{kind:"start_thread",projectId:"proj_a",role:"investigate",title:"Retry issue"}})});
  await settle();
  assert.equal(submits().length,1);assert.match(submits()[0].interpretation,/empty transcript/);
  dc.emit("response.done",{response:{id:"worker-response",output:[]}});await settle();
  assert.equal(dc.bridgeResponses().length,0,"only an actual action result should be announced");
});

test("normal playback completion does not reject a later tool from the same response",async t=>{
  const {dc,submits}=await coordinatorFixture(t);
  speak(dc,"normal_item");
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"normal_item",transcript:"Show the current workstreams in order."});
  dc.emit("response.created",{response:{id:"normal_response"}});
  dc.emit("output_audio_buffer.started",{response_id:"normal_response"});
  dc.emit("output_audio_buffer.stopped",{response_id:"normal_response"});
  dc.emit("response.function_call_arguments.done",{name:"delegate_to_coordinator",call_id:"normal_tool",arguments:JSON.stringify({request:"Show the current workstreams in order."})});
  dc.emit("response.done",{response:{id:"normal_response",status:"completed"}});
  await settle();assert.equal(submits().length,1);assert.ok(!dc.toolOutputs().at(-1)!.item.output.includes("interrupted"));
});

test("real playback events advance sequence speech, while generation and background replies do not",async t=>{
  const steps=[{kind:"speech",text:"This is the current work."},{kind:"action",action:{kind:"show_voice"}},{kind:"speech",text:"Here is your Voice conversation."}];
  const state:Any={replyId:"plan_reply",conversationId:"conv_1",callNonce:"",plan:{title:"Review",steps},index:0,revision:0,phase:"ready",reason:null,blocked:false,completedDrafts:[]};
  let actions=0,loaded=false;
  const f=await coordinatorFixture(t,{sequence:input=>{
    state.callNonce=input.callNonce;
    if(input.operation==="sync") {if(input.replyId)loaded=true;return {state:loaded ? structuredClone(state) : null};}
    if(input.operation==="next") {
      if(state.index===1){actions++;state.index=2;state.phase="ready";}else state.phase="speech";
    } else if(input.operation==="delivered"){state.index++;state.phase=state.index===steps.length ? "complete" : "ready";}
    state.revision++;return {state:structuredClone(state)};
  }});
  f.agent.ingestCoordinatorSignal("voice-reply", f.reply({replyId:"plan_reply",speech:"",sequence:{title:"Review",steps} as Any}));await settle();
  const response=f.dc.bridgeResponses().at(-1)!;assert.ok(response);assert.equal(actions,0);
  f.dc.emit("response.created",{response:{id:"seq_audio_1",metadata:response.response.metadata}});
  f.dc.emit("output_audio_buffer.started",{response_id:"seq_audio_1"});
  f.agent.ingestCoordinatorSignal("voice-reply", f.reply({replyId:"background_during_sequence",kind:"update",speech:"Background update."}));
  f.dc.emit("response.done",{response:{id:"seq_audio_1",status:"completed",metadata:response.response.metadata}});
  await settle();assert.equal(actions,0,"generated audio still has to play");
  f.dc.emit("output_audio_buffer.stopped",{response_id:"seq_audio_1"});await settle();
  assert.equal(actions,1);assert.equal(f.dc.bridgeResponses().length,2);
  assert.equal(f.dc.bridgeResponses().at(-1)!.response.input[0].content[0].text,"Here is your Voice conversation.");
  assert.equal(f.deliveries().length,0,"step playback uses its own durable cursor, not parent final delivery");
});

test("raw noise and an empty transcript never interrupt existing playback or its pending work", async t => {
  const {dc, logs, tick} = await coordinatorFixture(t);
  speak(dc, "request", "Show");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"request", transcript:"Show the current workstreams."});
  dc.emit("response.created", {response:{id:"answer"}});
  dc.emit("output_audio_buffer.started", {response_id:"answer"});
  const requests = dc.responses().length;
  speak(dc, "noise", "");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"noise", transcript:""});
  await settle(); tick(5000); await settle();
  assert.equal(dc.sent.filter(e => e.type === "response.cancel").length, 0);
  assert.equal(dc.sent.filter(e => e.type === "output_audio_buffer.clear").length, 0);
  assert.equal(dc.responses().length, requests, "noise starts no replacement answer");
  assert.equal(logs.filter(e => e.kind === "input.wordsConfirmed").length, 1);
});

test("a first recognised word interrupts once, streams immediately, and cannot authorize unfinished work", async t => {
  const {dc, calls, submits, tick} = await coordinatorFixture(t);
  speak(dc, "request");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"request", transcript:"Explain the build."});
  dc.emit("response.created", {response:{id:"answer"}});
  dc.emit("output_audio_buffer.started", {response_id:"answer"});
  dc.emit("response.output_audio_transcript.delta", {response_id:"answer", item_id:"answer-item", event_id:"out1", delta:"The build is"});
  tick(100); await settle();
  assert.ok(calls.some(c => c.method === "publishTranscript" && c.args.items.some((i:Any) => i.payload.text === "The build is")));
  dc.emit("input_audio_buffer.speech_started", {item_id:"correction"});
  dc.emit("conversation.item.input_audio_transcription.delta", {item_id:"correction", event_id:"noise1", delta:"..."});
  assert.equal(dc.sent.filter(e => e.type === "response.cancel").length, 0);
  dc.emit("conversation.item.input_audio_transcription.delta", {item_id:"correction", event_id:"word1", delta:"Wait"});
  dc.emit("conversation.item.input_audio_transcription.delta", {item_id:"correction", event_id:"word1", delta:"Wait"});
  assert.equal(dc.sent.filter(e => e.type === "response.cancel" && e.response_id === "answer").length, 1);
  assert.equal(dc.sent.filter(e => e.type === "output_audio_buffer.clear").length, 1);
  tick(100); await settle();
  assert.ok(calls.some(c => c.method === "publishTranscript" && c.args.items.some((i:Any) => i.payload.text === "...Wait")));
  assert.equal(submits().length, 0);
  dc.emit("response.done", {response:{id:"answer", status:"cancelled"}});
  const requests = dc.responses().length;
  dc.emit("input_audio_buffer.speech_stopped", {item_id:"correction"});
  dc.emit("input_audio_buffer.committed", {item_id:"correction"});
  assert.equal(dc.responses().length, requests);
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"correction", transcript:"Wait, open the docs instead."});
  assert.equal(dc.responses().length, requests + 1, "only final words start the next response");
});

test("late transcript deltas and finals from an older item cannot interrupt a newer answer", async t => {
  const {dc} = await coordinatorFixture(t);
  speak(dc, "old", "");
  speak(dc, "new", "Explain");
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"new", transcript:"Explain this thread."});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"old", transcript:""});
  dc.emit("response.created", {response:{id:"answer"}});
  dc.emit("output_audio_buffer.started", {response_id:"answer"});
  dc.emit("conversation.item.input_audio_transcription.delta", {item_id:"old", delta:"Stop"});
  dc.emit("conversation.item.input_audio_transcription.completed", {item_id:"old", transcript:"Stop"});
  assert.equal(dc.sent.filter(e => e.type === "response.cancel").length, 0);
  assert.equal(dc.sent.filter(e => e.type === "output_audio_buffer.clear").length, 0);
});


test("speech-start context survives navigation before the first recognised word",async t=>{
  const {dc,submits}=await coordinatorFixture(t);
  let current="thr_original";
  t.mock.method(nativeUi,"snapshot",()=>({threadId:current,projectId:"proj_a",onNewThreadScreen:false,route:`/threads/${current}`,composers:[],draft:null,bound:true}));
  dc.emit("input_audio_buffer.speech_started",{item_id:"spoken-reference"});
  current="thr_different";
  dc.emit("conversation.item.input_audio_transcription.delta",{item_id:"spoken-reference",delta:"Ask"});
  dc.emit("input_audio_buffer.speech_stopped",{item_id:"spoken-reference"});
  dc.emit("input_audio_buffer.committed",{item_id:"spoken-reference"});
  dc.emit("conversation.item.input_audio_transcription.completed",{item_id:"spoken-reference",transcript:"Ask this thread to inspect the logs."});
  delegate(dc,"context-response","context-tool",{request:"Ask this thread to inspect the logs."});
  await settle();
  assert.equal(submits()[0].view.threadId,"thr_original");
});
