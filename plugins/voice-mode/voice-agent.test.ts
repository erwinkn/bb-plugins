import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent } from "./voice-agent.ts";
import { writeAudioDevicePreferences } from "./audio-devices.ts";

/** A VoiceAgent bound to a spy rpc that records every relayed call. */
function agentWithRpcSpy() {
  const calls: { method: string; args: unknown }[] = [];
  const agent = new VoiceAgent(async () => () => {});
  agent.bind({
    rpc: {
      call: (async (method: string, args: unknown) => {
        calls.push({ method, args });
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  });
  // bind() emits a one-time client.hello diagnostic; drop it so tests start clean.
  calls.length = 0;
  return { agent, calls };
}

test("mirrors a call owned by another realm from voice-presence", () => {
  const agent = new VoiceAgent(async () => () => {});
  assert.equal(agent.getState(), "idle");

  agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 1000 });
  assert.equal(agent.getState(), "live");
  assert.equal(agent.getSessionId(), "call-A");
  assert.equal(agent.getLiveStartedAt(), 1000);

  agent.ingestPresence({ nonce: "call-A", phase: "muted", startedAt: 1000 });
  assert.equal(agent.getState(), "muted");

  // The owner announcing idle clears the mirror on every other surface.
  agent.ingestPresence({ nonce: "call-A", phase: "idle", startedAt: null });
  assert.equal(agent.getState(), "idle");
  assert.equal(agent.getSessionId(), null);
});

test("ignores malformed or nonce-less presence", () => {
  const agent = new VoiceAgent(async () => () => {});
  agent.ingestPresence(null);
  agent.ingestPresence({ phase: "live" });
  agent.ingestPresence({ nonce: "x", phase: "bogus" });
  assert.equal(agent.getState(), "idle");
});

test("a mirrored call expires once its heartbeats lapse (no ghost live)", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  try {
    const agent = new VoiceAgent(async () => () => {});
    agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 0 });
    assert.equal(agent.getState(), "live");

    mock.timers.tick(10_000); // still within the fresh window
    assert.equal(agent.getState(), "live");

    mock.timers.tick(20_000); // now past PRESENCE_STALE_MS (25s)
    assert.equal(agent.getState(), "idle");
  } finally {
    mock.timers.reset();
  }
});

test("stop/mute from a surface that doesn't own the call is relayed to the owner", () => {
  const { agent, calls } = agentWithRpcSpy();
  agent.ingestPresence({ nonce: "call-A", phase: "live", startedAt: 1000 });

  // Commands also carry client/realm identity (observability); assert the parts
  // that matter for routing.
  const lastArgs = () => calls.at(-1)?.args as { nonce: string; action?: string };

  agent.toggleMuteFromSurface(); // live → mute (relayed to the owner)
  assert.equal(calls.at(-1)?.method, "sendVoiceCommand");
  assert.equal(lastArgs().nonce, "call-A");
  assert.equal(lastArgs().action, "mute");

  agent.ingestPresence({ nonce: "call-A", phase: "muted", startedAt: 1000 });
  agent.toggleMuteFromSurface(); // muted → unmute
  assert.equal(lastArgs().action, "unmute");

  // Stop of a mirrored call is server-authoritative (forceStop) so it works even
  // against a frozen owner, and clears the mirror immediately.
  agent.stopFromSurface();
  assert.equal(calls.at(-1)?.method, "forceStop");
  assert.equal(lastArgs().nonce, "call-A");
  assert.equal(agent.getState(), "idle");

  agent.ingestPresence({ nonce: "call-A", phase: "idle", startedAt: null });
});

test("presence catch-up: a surface requests, a non-owner never answers", () => {
  const { agent, calls } = agentWithRpcSpy();
  agent.requestPresence();
  assert.deepEqual(calls.at(-1), { method: "requestPresence", args: null });

  // We own no call, so a peer's query must NOT make us publish presence.
  calls.length = 0;
  agent.answerPresenceQuery();
  assert.equal(calls.length, 0);
});

test("a relayed command is ignored by a realm that doesn't own that call", () => {
  const { agent, calls } = agentWithRpcSpy();
  // Idle here: we own nothing, so an incoming command must be a no-op.
  agent.applyVoiceCommand({ nonce: "call-A", action: "stop" });
  assert.equal(agent.getState(), "idle");
  assert.equal(calls.length, 0);
});

test("reloads audio preferences saved by another browser window", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    const agent = new VoiceAgent(async () => () => {});
    writeAudioDevicePreferences(storage, {
      inputDeviceId: "mic-from-window-a",
      inputLabel: "Window A Mic",
    });

    agent.refreshAudioPreferences();

    assert.deepEqual(agent.getAudioPreferences(), {
      inputDeviceId: "mic-from-window-a",
      inputLabel: "Window A Mic",
    });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

const settleVoice = () => new Promise<void>(resolve => setImmediate(resolve));
async function liveVoiceFixture(t: TestContext, runTool = async () => ({ output: "Tool complete", status: "success" })) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const originals = ["navigator", "RTCPeerConnection", "Audio"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const channels: FakeDataChannel[] = [];
  const peers: FakePeerConnection[] = [];
  class FakeDataChannel {
    readyState = "open";
    sent: Record<string, any>[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = "closed"; }
    activeResponseId: string | undefined;
    emit(type: string, extra: Record<string, any> = {}) {
      if (type === "response.created") this.activeResponseId = extra.response?.id;
      this.onmessage?.({ data: JSON.stringify({ type, ...(type === "response.function_call_arguments.done" ? { response_id: this.activeResponseId } : {}), ...extra }) });
    }
    responses() { return this.sent.filter(event => event.type === "response.create"); }
  }
  class FakePeerConnection {
    constructor() { peers.push(this); }
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
    async setRemoteDescription() { this.dc.onopen?.(); this.dc.onmessage?.({data:JSON.stringify({type:"session.updated",session:{audio:{input:{turn_detection:null,transcription:{model:"gpt-realtime-whisper"}}}}})}); }
  }
  class FakeAudio {
    autoplay = false;
    srcObject = null;
    async play() {}
    remove() {}
  }
  const track = { kind: "audio", enabled: true, stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => [{ deviceId: "mic", kind: "audioinput", label: "Test mic" }],
    getUserMedia: async () => stream,
  } } });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: FakeAudio });
  const agent = new VoiceAgent(async () => () => {});
  agent.bind({
    rpc: { call: (async (method: string) => method === "claimCall" ? { sequence: 1, conversationId: "conv_test" } : method === "createCall" ? { sdp: "answer" } : method === "runTool" ? runTool() : { ok: true }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  });
  t.after(() => {
    agent.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const start = async () => {
    agent.toggle();
    await settleVoice();
    assert.equal(agent.getState(), "live");
    return channels.at(-1)!;
  };
  const dc = await start();
  return { agent, dc, start, peers, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("stopping during the SDP exchange closes the mic and cancels startup", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let resolveCall!: () => void;
  let announceCallStarted!: () => void;
  const callStarted = new Promise<void>((resolve) => {
    announceCallStarted = resolve;
  });
  const callPending = new Promise<void>((resolve) => {
    resolveCall = resolve;
  });
  let peer: FakePeerConnection | null = null;

  class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    closed = false;
    setRemoteCalls = 0;
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;

    constructor() {
      peer = this;
    }

    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true;
    }
    createDataChannel() {
      return { readyState: "connecting", close() {}, send() {}, onopen: null, onclose: null, onmessage: null };
    }
    async createOffer() {
      return { type: "offer" as const, sdp: "offer" };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) {
      this.localDescription = description;
    }
    async setRemoteDescription() {
      this.setRemoteCalls += 1;
    }
  }

  class FakeAudio {
    autoplay = false;
    srcObject: MediaStream | null = null;
    async play() {}
    remove() {}
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [
          { deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" },
        ],
      },
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
  });
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudio,
  });

  const agent = new VoiceAgent(async () => () => {});
  agent.bind({
    rpc: {
      // Pause startup at the SDP exchange so the test can stop mid-flight.
      call: (async (method: string) => {
        if (method === "claimCall") return { sequence: 1, conversationId: "conv_test" };
        if (method === "createCall") {
          announceCallStarted();
          await callPending;
          return { sdp: "answer" };
        }
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  });
  agent.setAudioPreferences({ inputDeviceId: "", inputLabel: "" });

  try {
    agent.toggle();
    await callStarted;
    agent.stop();

    assert.equal(track.stopped, true);
    assert.equal((peer as FakePeerConnection | null)?.closed, true);

    resolveCall();
    await new Promise((resolve) => setImmediate(resolve));
    // Stopped mid-exchange: the answer must never be applied.
    assert.equal((peer as FakePeerConnection | null)?.setRemoteCalls, 0);
    assert.equal(agent.getState(), "idle");
  } finally {
    resolveCall();
    agent.stop();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalPeerConnection) Object.defineProperty(globalThis, "RTCPeerConnection", originalPeerConnection);
    else delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
    else delete (globalThis as { Audio?: unknown }).Audio;
  }
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`stale microphone acquisition ${outcome} cannot replace or stop a new call`, async (t) => {
    const { agent, start } = await liveVoiceFixture(t);
    agent.stop();
    const acquire = navigator.mediaDevices.getUserMedia;
    let resolve!: (stream: MediaStream) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<MediaStream>((yes, no) => { resolve = yes; reject = no; });
    navigator.mediaDevices.getUserMedia = () => pending;
    agent.toggle();
    await settleVoice();
    assert.equal(agent.getState(), "connecting");
    agent.stop();
    navigator.mediaDevices.getUserMedia = acquire;
    const fresh = await start();
    const id = agent.getSessionId();
    let stopped = false;
    if (outcome === "resolve") resolve({ getTracks: () => [{ stop() { stopped = true; } }] } as unknown as MediaStream);
    else reject(new Error("Old acquisition failed"));
    await settleVoice();
    assert.equal(agent.getState(), "live");
    assert.equal(agent.getSessionId(), id);
    assert.equal(fresh.readyState, "open");
    assert.equal(stopped, outcome === "resolve");
  });
}

test("binding requests presence only after an RPC binding is installed", () => {
  const agent = new VoiceAgent(async () => () => {});
  let requests = 0;
  const unbind = agent.bind({
    rpc: { call: (async (method: string) => { if (method === "requestPresence") requests++; return { ok: true }; }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  });
  assert.equal(requests, 1);
  unbind();
});

test("older call announcements do not stop a newer owner", async (t) => {
  const { agent } = await liveVoiceFixture(t);
  const nonce = agent.getSessionId();
  agent.onCallStarted("older-call", 0);
  assert.equal(agent.getState(), "live");
  assert.equal(agent.getSessionId(), nonce);
  agent.onCallStarted("newer-call", 2);
  assert.equal(agent.getState(), "idle");
});


test("presence queries and rebinds cannot announce a call before its claim completes", async (t) => {
  const { agent } = await liveVoiceFixture(t);
  agent.stop();
  let grant!: (value: { sequence: number; conversationId: string }) => void;
  const claim = new Promise<{ sequence: number; conversationId: string }>(resolve => { grant = resolve; });
  const phases: string[] = [];
  const binding = {
    rpc: { call: (async (method: string, args: any) => {
      if (method === "claimCall") return claim;
      if (method === "requestPresence") agent.answerPresenceQuery();
      if (method === "publishPresence") phases.push(args.phase);
      if (method === "createCall") return { sdp: "answer" };
      return { ok: true };
    }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  };
  agent.bind(binding);
  agent.toggle();
  await settleVoice();
  agent.answerPresenceQuery();
  agent.bind(binding);
  assert.equal(agent.getState(), "connecting");
  assert.deepEqual(phases, []);
  grant({ sequence: 2, conversationId: "conv_test" });
  await settleVoice();
  assert.equal(agent.getState(), "live");
  assert.deepEqual(phases, ["connecting", "live"]);
});


test("transient disconnection recovers, but a prolonged disconnect or failure ends the call", async (t) => {
  const { agent, peers, tick, start } = await liveVoiceFixture(t);
  const change = (state: string) => { const peer = peers.at(-1)!; peer.connectionState = state; peer.onconnectionstatechange?.(); };
  change("disconnected");
  tick(5000);
  assert.equal(agent.getState(), "live");
  change("connected");
  tick(11000);
  assert.equal(agent.getState(), "live");
  change("disconnected");
  tick(11000);
  assert.equal(agent.getState(), "idle");
  await start();
  change("failed");
  assert.equal(agent.getState(), "idle");
});

test("a stopped call's disconnect timer cannot stop a replacement call", async (t) => {
  const { agent, peers, tick, start } = await liveVoiceFixture(t);
  const old = peers.at(-1)!;
  old.connectionState = "disconnected";
  old.onconnectionstatechange?.();
  agent.stop();
  await start();
  old.onconnectionstatechange?.();
  tick(11000);
  assert.equal(agent.getState(), "live");
});


for (const closeEventFirst of [true, false]) {
  test(`a closed event channel ends recovery when close event arrives ${closeEventFirst ? "first" : "last"}`, async (t) => {
    const { agent, dc, peers, tick, start } = await liveVoiceFixture(t);
    const peer = peers.at(-1)!;
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    dc.readyState = "closed";
    if (closeEventFirst) dc.onclose?.();
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();
    assert.equal(agent.getState(), "idle");
    await start();
    dc.onclose?.();
    tick(11000);
    assert.equal(agent.getState(), "live");
  });
}

test("event-channel closure ends an otherwise connected call", async (t) => {
  const { agent, dc } = await liveVoiceFixture(t);
  dc.readyState = "closed";
  dc.onclose?.();
  assert.equal(agent.getState(), "idle");
});


test("device switch acquires the microphone before claiming the existing call", async t => {
  const {agent}=await liveVoiceFixture(t); agent.stop();
  const calls:{method:string;args:any}[]=[];
  agent.bind({rpc:{call:(async(method:string,args:any)=>{calls.push({method,args});return method==="claimCall" ? {sequence:2,conversationId:"same_conversation"} : method==="createCall" ? {sdp:"answer"} : {ok:true};}) as never},context:{threadId:null,projectId:null,onNewThreadScreen:false}});
  agent.ingestPresence({nonce:"desktop",phase:"live",startedAt:1000,client:"desktop-client"});
  const stream=await navigator.mediaDevices.getUserMedia({audio:true});
  let grant!:(stream:MediaStream)=>void;
  navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{grant=resolve;});
  agent.switchToThisDevice(); agent.switchToThisDevice();
  await settleVoice();
  assert.equal(calls.filter(call=>call.method==="claimCall").length,0);
  grant(stream); await settleVoice();
  assert.equal(calls.filter(call=>call.method==="claimCall").length,1);
  assert.equal(calls.find(call=>call.method==="claimCall")?.args.transferFromNonce,"desktop");
  assert.equal(agent.getState(),"live");
  assert.equal(agent.getRemoteCallLabel(),null);
  agent.stop(); assert.equal(agent.getState(),"idle","the old desktop mirror must not reappear");
});

test("denied microphone access leaves the other device's call running", async t => {
  const {agent}=await liveVoiceFixture(t);agent.stop();
  const calls:{method:string;args:any}[]=[];
  agent.bind({rpc:{call:(async(method:string,args:any)=>{calls.push({method,args});return {ok:true};}) as never},context:{threadId:null,projectId:null,onNewThreadScreen:false}});
  agent.ingestPresence({nonce:"desktop",phase:"live",startedAt:1000,client:"desktop-client"});
  navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("Denied","NotAllowedError");};
  agent.switchToThisDevice();await settleVoice();
  assert.equal(calls.some(call=>call.method==="claimCall" || call.method==="forceStop"),false);
  assert.equal(agent.getSessionId(),"desktop");
  assert.equal(agent.getRemoteCallLabel(),"Call on another device");
  agent.ingestPresence({nonce:"desktop",phase:"idle"});
});

async function sequencerFixture(t: TestContext, read: (id: string) => unknown = id => ({ threadId: id, output: "Read complete", asOf: 123 }), submit?: () => unknown) {
  const fixture = await liveVoiceFixture(t);
  const calls: string[] = [];
  const logs: { kind: string; payload: any }[] = [];
  fixture.agent.bind({
    rpc: { call: (async (method: string, args: any) => {
      if (method === "logEvent") logs.push({ kind: args.kind, payload: args.payload });
      if (method === "readVoiceThread" || method === "lookupVoiceTargets") {
        const id = args.threadId ?? args.query;
        calls.push(id);
        return read(id);
      }
      if (method === "submitRequest") { calls.push("submit"); return submit?.(); }
      if (method === "pendingReplies") return { replies: [] };
      if (method === "reserveUpdateBatch") return { batch: null, reason: "empty" };
      return { ok: true };
    }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  });
  const input = (fixture.agent as unknown as { input: import("./input-controller.ts").InputController }).input;
  const words = (id: string, final = true) => {
    input.sample(0.04); fixture.tick(150); input.sample(0.04);
    fixture.dc.emit("conversation.item.input_audio_transcription.delta", { item_id: id, delta: "Check this thread" });
    fixture.tick(300); input.sample(0); fixture.tick(800); input.sample(0);
    fixture.dc.emit("input_audio_buffer.committed", { item_id: id });
    if (final) fixture.dc.emit("conversation.item.input_audio_transcription.completed", { item_id: id, transcript: "Check this thread." });
  };
  words("request");
  const outputs = () => fixture.dc.sent.filter(event => event.item?.type === "function_call_output").map(event => event.item);
  const speech = { id: "speech", type: "message", content: [{ type: "audio", transcript: "I will check." }] };
  const tool = (id: string) => ({ id, type: "function_call", name: "read_thread", call_id: id });
  const addItem = (responseId: string, outputIndex: number, item: Record<string, unknown>, done = false) =>
    fixture.dc.emit(`response.output_item.${done ? "done" : "added"}`, { response_id: responseId, output_index: outputIndex, item });
  const call = (responseId: string, id: string, outputIndex: number, name = "read_thread", args = { threadId: id, query: id } as Record<string, unknown>) =>
    fixture.dc.emit("response.function_call_arguments.done", { response_id: responseId, item_id: id, output_index: outputIndex, call_id: id, name, arguments: JSON.stringify(args) });
  const done = (id: string, output: Record<string, unknown>[]) =>
    fixture.dc.emit("response.done", { response: { id, status: "completed", output } });
  const start = (id: string, audio = true) => {
    fixture.dc.emit("response.created", { response: { id } });
    if (audio) {
      addItem(id, 0, speech);
      fixture.dc.emit("output_audio_buffer.started", { response_id: id });
    }
  };
  return { ...fixture, calls, logs, words, outputs, speech, tool, addItem, call, done, startResponse: start };
}

test("speech then tool waits for natural drain and sends one continuation after its output", async t => {
  let finish!: (value: unknown) => void;
  const f = await sequencerFixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.startResponse("speech-tool");
  f.addItem("speech-tool", 1, f.tool("read"));
  f.call("speech-tool", "read", 1);
  f.addItem("speech-tool", 1, f.tool("read"), true);
  f.done("speech-tool", [f.speech, f.tool("read")]);
  await settleVoice();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.outputs(), []);
  const before = f.dc.responses().length;
  f.dc.emit("output_audio_buffer.stopped", { response_id: "speech-tool" });
  await settleVoice();
  assert.deepEqual(f.calls, ["read"]);
  assert.equal(f.dc.responses().length, before);
  finish({ output: "Result", asOf: 123 }); await settleVoice();
  assert.equal(f.outputs().length, 1);
  assert.equal(f.dc.responses().length, before + 1);
  assert.equal(f.dc.sent.at(-1)?.type, "response.create");
});

test("speech then two tools runs by output_index and continues once after both outputs", async t => {
  const f = await sequencerFixture(t);
  f.startResponse("two-tools");
  f.addItem("two-tools", 1, f.tool("first")); f.addItem("two-tools", 2, f.tool("second"));
  f.call("two-tools", "second", 2); f.call("two-tools", "first", 1);
  f.done("two-tools", [f.speech, f.tool("first"), f.tool("second")]);
  await settleVoice(); assert.deepEqual(f.calls, []);
  const before = f.dc.responses().length;
  f.dc.emit("output_audio_buffer.stopped", { response_id: "two-tools" }); await settleVoice();
  assert.deepEqual(f.calls, ["first", "second"]);
  assert.deepEqual(f.outputs().map(item => item.call_id), ["first", "second"]);
  assert.equal(f.dc.responses().length, before + 1);
});

test("tool-only output runs at response.done without a playback event", async t => {
  const f = await sequencerFixture(t);
  f.startResponse("tool-only", false); f.addItem("tool-only", 0, f.tool("read")); f.call("tool-only", "read", 0);
  await settleVoice(); assert.deepEqual(f.calls, []);
  const before = f.dc.responses().length;
  f.done("tool-only", [f.tool("read")]); await settleVoice();
  assert.deepEqual(f.calls, ["read"]);
  assert.equal(f.dc.responses().length, before + 1);
});

test("a tool-only continuation waits for every other response to drain", async t => {
  const f = await sequencerFixture(t);
  f.startResponse("tools", false); f.call("tools", "read", 0);
  // Simulate previously overlapping responses to test the complete ledger gate.
  for (const id of ["audio-a", "audio-b"]) {
    f.dc.emit("response.created", { response: { id, metadata: { bb_voice_source: "background" } } });
    f.addItem(id, 0, f.speech); f.dc.emit("output_audio_buffer.started", { response_id: id });
    f.done(id, [f.speech]);
  }
  const before = f.dc.responses().length;
  f.done("tools", [f.tool("read")]); await settleVoice();
  assert.equal(f.outputs().length, 1);
  assert.equal(f.dc.responses().length, before);
  f.dc.emit("output_audio_buffer.stopped", { response_id: "audio-b" }); await settleVoice();
  assert.equal(f.dc.responses().length, before, "a null playback pointer does not prove all audio drained");
  f.dc.emit("output_audio_buffer.stopped", { response_id: "audio-a" }); await settleVoice();
  assert.equal(f.dc.responses().length, before + 1);
});

for (const interruption of ["cleared", "words"] as const) {
  test(`${interruption} cancels held tools without continuation and stray stopped runs nothing`, async t => {
    const f = await sequencerFixture(t);
    f.startResponse("interrupted"); f.call("interrupted", "first", 1); f.call("interrupted", "second", 2);
    f.done("interrupted", [f.speech, f.tool("first"), f.tool("second")]); await settleVoice();
    const before = f.dc.responses().length;
    if (interruption === "cleared") f.dc.emit("output_audio_buffer.cleared", { response_id: "interrupted" });
    else f.words("new", false);
    await settleVoice();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.outputs().map(item => item.output), ["Not executed: interrupted.", "Not executed: interrupted."]);
    assert.equal(f.dc.responses().length, before);
    f.dc.emit("output_audio_buffer.stopped", { response_id: "interrupted" }); await settleVoice();
    f.call("interrupted", "first", 1); f.call("interrupted", "second", 2);
    assert.deepEqual(f.calls, []);
    assert.equal(f.outputs().length, 2);
    assert.equal(f.dc.responses().length, before);
    if (interruption === "cleared") f.words("new");
    else f.dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "new", transcript: "Check this thread." });
    await settleVoice(); assert.equal(f.dc.responses().length, before + 1, "the next user turn proceeds");
  });
}

test("message after a function call logs ordering.violation and keeps the tool held", async t => {
  const f = await sequencerFixture(t);
  f.startResponse("violation", false);
  f.addItem("violation", 0, f.tool("read")); f.call("violation", "read", 0);
  f.addItem("violation", 1, f.speech); f.addItem("violation", 1, f.speech, true);
  f.dc.emit("output_audio_buffer.started", { response_id: "violation" });
  f.done("violation", [f.tool("read"), f.speech]); await settleVoice();
  assert.equal(f.logs.filter(event => event.kind === "ordering.violation").length, 1);
  assert.deepEqual(f.calls, []);
  f.dc.emit("output_audio_buffer.stopped", { response_id: "violation" }); await settleVoice();
  assert.deepEqual(f.calls, ["read"]);
});

for (const name of ["read_thread", "lookup_targets"]) {
  test(`completed ${name} returns its data after a new word without reviving the old turn`, async t => {
    let finish!: (value: unknown) => void;
    const f = await sequencerFixture(t, () => new Promise(resolve => { finish = resolve; }));
    f.startResponse("read", false); f.call("read", "data", 0, name); f.done("read", [f.tool("data")]);
    await settleVoice(); assert.deepEqual(f.calls, ["data"]);
    const before = f.dc.responses().length;
    f.words("new", false);
    const result = { output: "Completed data", asOf: 123 };
    finish(result); await settleVoice();
    assert.deepEqual(JSON.parse(f.outputs()[0].output), result);
    assert.equal(f.dc.responses().length, before);
    f.dc.emit("conversation.item.input_audio_transcription.completed", { item_id: "new", transcript: "Check this thread." });
    await settleVoice(); assert.equal(f.dc.responses().length, before + 1);
  });
}

for (const outcome of ["throw", "unknown-tool"] as const) {
  test(`${outcome} cancels the remaining response calls and returns one failure continuation`, async t => {
    const f = await sequencerFixture(t, () => {
      if (outcome === "throw") throw new Error("Read failed");
      return { status: outcome, output: "Read result" };
    });
    f.startResponse("failure", false);
    f.call("failure", "first", 0, outcome === "unknown-tool" ? "missing_tool" : "read_thread");
    f.call("failure", "second", 1);
    const before = f.dc.responses().length;
    f.done("failure", [f.tool("first"), f.tool("second")]); await settleVoice();
    assert.deepEqual(f.calls, outcome === "unknown-tool" ? [] : ["first"]);
    assert.equal(f.outputs().length, 2);
    assert.match(f.outputs()[0].output, /Read|Unknown realtime tool/);
    assert.equal(f.outputs()[1].output, "Not executed: an earlier action failed.");
    assert.equal(f.dc.responses().length, before + 1);
  });
}

for (const outcome of ["failed", "unknown"] as const) {
  test(`${outcome} bridge receipt cancels the remaining calls and returns a failure continuation`, async t => {
    const f = await sequencerFixture(t, undefined, () => {
      if (outcome === "unknown") throw new Error("Submission response lost");
      return { status: "failed", error: "Action failed", receipt: null };
    });
    f.startResponse("failure", false);
    f.call("failure", "first", 0, "quick_action", { request: "Show Voice", action: { kind: "show_voice" } });
    f.call("failure", "second", 1);
    const before = f.dc.responses().length;
    f.done("failure", [f.tool("first"), f.tool("second")]); await settleVoice();
    assert.deepEqual(f.calls, ["submit"]);
    assert.equal(f.outputs().length, 2);
    assert.match(f.outputs()[0].output, outcome === "failed" ? /was not executed/ : /could not be confirmed/);
    assert.equal(f.outputs()[1].output, "Not executed: an earlier action failed.");
    assert.equal(f.dc.responses().length, before + 1);
  });
}

test("a successful read of a failed thread returns data and does not cancel the next read", async t => {
  const f = await sequencerFixture(t, id => ({ threadId: id, status: "failed", output: "Thread error", asOf: 123 }));
  f.startResponse("reads", false); f.call("reads", "first", 0); f.call("reads", "second", 1);
  f.done("reads", [f.tool("first"), f.tool("second")]); await settleVoice();
  assert.deepEqual(f.calls, ["first", "second"]);
  assert.equal(f.outputs().length, 2);
  assert.ok(f.outputs().every(item => JSON.parse(item.output).status === "failed"));
  assert.ok(f.logs.filter(event => event.kind === "tool.result").every(event => event.payload.status === "success"));
});

test("an audio item holds tools even when response.done precedes audio started", async t => {
  const f = await sequencerFixture(t);
  f.startResponse("late-audio", false); f.addItem("late-audio", 0, f.speech); f.call("late-audio", "read", 1);
  f.done("late-audio", [f.speech, f.tool("read")]); await settleVoice();
  assert.deepEqual(f.calls, []);
  f.dc.emit("output_audio_buffer.started", { response_id: "late-audio" }); await settleVoice();
  assert.deepEqual(f.calls, []);
  f.dc.emit("output_audio_buffer.stopped", { response_id: "late-audio" }); await settleVoice();
  assert.deepEqual(f.calls, ["read"]);
});

test("interruption cancels a queued call after drain while a running read returns data", async t => {
  let finish!: (value: unknown) => void;
  const f = await sequencerFixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.startResponse("batch"); f.call("batch", "first", 1); f.call("batch", "second", 2);
  f.done("batch", [f.speech, f.tool("first"), f.tool("second")]);
  f.dc.emit("output_audio_buffer.stopped", { response_id: "batch" }); await settleVoice();
  assert.deepEqual(f.calls, ["first"]);
  const before = f.dc.responses().length;
  f.words("new", false); finish({ output: "First data" }); await settleVoice();
  assert.deepEqual(f.calls, ["first"]);
  assert.equal(f.outputs().find(item => item.call_id === "second")?.output, "Not executed: interrupted.");
  assert.deepEqual(JSON.parse(f.outputs().find(item => item.call_id === "first")!.output), { output: "First data" });
  assert.equal(f.dc.responses().length, before);
});

test("word interruption closes all tracked playback gates even when the playback pointer changed", async t => {
  const f = await sequencerFixture(t);
  f.startResponse("first"); f.done("first", [f.speech]);
  f.dc.emit("response.created", { response: { id: "second", metadata: { bb_voice_source: "background" } } });
  f.dc.emit("output_audio_buffer.started", { response_id: "second" }); f.done("second", [f.speech]);
  const before = f.dc.responses().length;
  f.words("new"); await settleVoice();
  assert.equal(f.dc.responses().length, before + 1);
});
