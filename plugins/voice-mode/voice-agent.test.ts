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
async function liveVoiceFixture(t: TestContext, runTool = async () => ({ output: "Tool complete", status: "success" }), overrides: Record<string, (args: any) => unknown> = {}, initialState = "live", engine: "realtime" | "live" = "realtime") {
  const rpcCalls: {method:string;args:any}[]=[];
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
    async setRemoteDescription() { this.dc.onopen?.(); this.dc.onmessage?.({data:JSON.stringify(engine === "live" ? {type:"session.started",session:{id:"live_sess_1"}} : {type:"session.updated",session:{audio:{input:{turn_detection:null,transcription:{model:"gpt-live-transcribe"}}}}})}); }
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
    rpc: { call: (async (method: string, args: any) => {
      rpcCalls.push({method,args});
      if (overrides[method]) return overrides[method](args);
      return (method === "claimCall" || method === "reconnectCall") ? { sequence: 1, conversationId: "conv_test" } : method === "createCall" ? { sdp: "answer" } : method === "runTool" ? runTool() : method === "callStartContext" ? {type:"call_start_context",tasks:[],recentTurns:[]} : { ok: true };
    }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
  });
  t.after(() => {
    agent.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  let greetings = 0;
  const start = async () => {
    agent.toggle();
    await settleVoice();
    assert.equal(agent.getState(), initialState);
    const dc = channels.at(-1)!;
    // Ada speaks first. Play that greeting to completion so each test starts after it,
    // as a real call does; the greeting itself is asserted by its own test.
    const greeting = dc.responses().at(-1);
    if (initialState === "live" && greeting?.response?.instructions?.includes("Speak first")) {
      greetings += 1; const id = `greeting-${greetings}`;
      dc.emit("response.created", { response: { id, metadata: greeting.response.metadata } });
      dc.emit("response.done", { response: { id, status: "completed", output: [] } });
      await settleVoice();
    }
    return dc;
  };
  const dc = await start();
  return { agent, dc, start, peers, track, rpcCalls, tick: (ms: number) => t.mock.timers.tick(ms) };
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


test("a brief disconnection recovers on the same peer without a greeting", async (t) => {
  const { agent, peers, dc, tick } = await liveVoiceFixture(t);
  agent.setMuted(true);
  const requests = dc.responses().length;
  peers[0].connectionState = "disconnected";
  peers[0].onconnectionstatechange?.();
  tick(5000);
  assert.equal(agent.getState(), "reconnecting");
  peers[0].connectionState = "connected";
  peers[0].onconnectionstatechange?.();
  tick(11000);
  assert.equal(agent.getState(), "muted");
  assert.equal(peers.length, 1);
  assert.equal(dc.responses().length, requests);
});

test("a prolonged disconnect replaces the peer, preserves mute and stays silent", async t => {
  const f = await liveVoiceFixture(t);
  f.agent.setMuted(true);
  f.peers[0].connectionState = "disconnected";
  f.peers[0].onconnectionstatechange?.();
  f.tick(10000); await settleVoice();
  assert.equal(f.peers.length, 2);
  assert.equal(f.agent.getState(), "muted");
  assert.equal(f.track.enabled, false);
  assert.equal(f.peers[1].dc.responses().length, 0);
  assert.equal(f.rpcCalls.filter(c => c.method === "reconnectCall").length, 1);
});

/**
 * Install a minimal `document` whose visibility is settable and whose listeners
 * fire on demand. Returns the doc plus a `restore`; call `restore` via `t.after`
 * AFTER the live fixture so it uninstalls document only once the fixture's own
 * teardown (which touches document) has run — `t.after` hooks run in order.
 */
function fakeDocument(): { doc: { visibilityState: string; fire: (type: string) => void }; restore: () => void } {
  const listeners: Record<string, Array<() => void>> = {};
  const doc = {
    visibilityState: "visible" as string,
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: () => void) => { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn); },
    fire: (type: string) => { for (const fn of listeners[type] ?? []) fn(); },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return { doc, restore: () => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); } };
}

test("a screen lock holds the call instead of ending it, and unlock revives the mic", async (t) => {
  const { doc, restore } = fakeDocument();
  const { agent, track } = await liveVoiceFixture(t);
  t.after(restore);
  // Phone screen locks: iOS mutes the mic track while the page is hidden.
  doc.visibilityState = "hidden";
  (track as { onmute?: () => void }).onmute?.();
  assert.equal(agent.getState(), "live", "a screen lock must not end the call");
  assert.equal(agent.getMicSuspended(), true, "the suspended mic is surfaced honestly");
  // Unlock: the OS resumes the same track and the uplink is back.
  doc.visibilityState = "visible";
  (track as { onunmute?: () => void }).onunmute?.();
  assert.equal(agent.getMicSuspended(), false);
  assert.equal(agent.getState(), "live");
});

test("a call held through a lock ends only if the mic never returns", async (t) => {
  const { doc, restore } = fakeDocument();
  const { agent, track, tick } = await liveVoiceFixture(t);
  t.after(restore);
  doc.visibilityState = "hidden";
  (track as { onmute?: () => void }).onmute?.();
  tick(5 * 60_000); // well within the hold window
  assert.equal(agent.getState(), "live");
  tick(11 * 60_000); // now past the suspension deadline
  assert.equal(agent.getState(), "idle", "a mic that never comes back ends the call");
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
  test(`a closed event channel replaces the peer when close event arrives ${closeEventFirst ? "first" : "last"}`, async (t) => {
    const { agent, dc, peers, tick, start } = await liveVoiceFixture(t);
    const peer = peers.at(-1)!;
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    dc.readyState = "closed";
    if (closeEventFirst) dc.onclose?.();
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();
    assert.equal(agent.getState(), "reconnecting");
    await settleVoice();
    dc.onclose?.();
    tick(11000);
    assert.equal(agent.getState(), "live");
  });
}

test("event-channel closure reconnects an otherwise connected call", async (t) => {
  const { agent, dc } = await liveVoiceFixture(t);
  dc.readyState = "closed";
  dc.onclose?.();
  assert.equal(agent.getState(), "reconnecting");
  await settleVoice();
  assert.equal(agent.getState(), "live");
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

async function sequencerFixture(t: TestContext, read: (id: string) => unknown = id => ({ threadId: id, output: "Read complete", asOf: 123 }), submit?: () => unknown, options: {settleInput?:boolean; rpc?:Record<string,(args:any)=>unknown>} = {}) {
  const fixture = await liveVoiceFixture(t, undefined, options.rpc);
  const calls: string[] = [];
  const logs: { kind: string; payload: any }[] = [];
  fixture.agent.bind({
    rpc: { call: (async (method: string, args: any) => {
      fixture.rpcCalls.push({method,args});
      if (options.rpc?.[method]) return options.rpc[method](args);
      if (method === "logEvent") logs.push({ kind: args.kind, payload: args.payload });
      if (method === "runTool" && ["read_threads", "find_targets"].includes(args.tool)) {
        const id = args.args.thread_ids?.[0] ?? args.args.query;
        calls.push(id);
        return read(id);
      }
      if (method === "runTool" && args.tool === "message_thread") { calls.push("submit"); return submit?.(); }
      if (method === "runTool" && ["remain_silent", "end_call"].includes(args.tool)) return { action:args.tool, ...args.args };
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
    if (final) { fixture.dc.emit("conversation.item.input_audio_transcription.completed", { item_id: id, transcript: "Check this thread." }); if(options.settleInput!==false){fixture.tick(2000); input.sample(0);} }
  };
  words("request");
  const outputs = () => fixture.dc.sent.filter(event => event.item?.type === "function_call_output").map(event => event.item);
  const speech = { id: "speech", type: "message", content: [{ type: "audio", transcript: "I will check." }] };
  const tool = (id: string) => ({ id, type: "function_call", name: "read_threads", call_id: id });
  const addItem = (responseId: string, outputIndex: number, item: Record<string, unknown>, done = false) =>
    fixture.dc.emit(`response.output_item.${done ? "done" : "added"}`, { response_id: responseId, output_index: outputIndex, item });
  const call = (responseId: string, id: string, outputIndex: number, name = "read_threads", args = (name === "find_targets" ? { query:id } : { thread_ids:[id], what:"output" }) as Record<string, unknown>) =>
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
  return { ...fixture, tick:(ms:number)=>{fixture.tick(ms);input.sample(0);}, calls, logs, words, outputs, speech, tool, addItem, call, done, startResponse: start };
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
    (f.agent as any).responseBinding={origin:"background",utterance:null};
    f.dc.emit("response.created", { response: { id, metadata: { bb_voice_origin: "background" } } });
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

for (const name of ["read_threads", "find_targets"]) {
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
    f.call("failure", "first", 0, outcome === "unknown-tool" ? "missing_tool" : "read_threads");
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
  test(`${outcome} operation receipt cancels the remaining calls and returns a failure continuation`, async t => {
    const f = await sequencerFixture(t, undefined, () => {
      if (outcome === "unknown") return { status:"unknown", error:"Submission response could not be confirmed" };
      return { status: "failed", error: "Action failed", receipt: null };
    });
    f.startResponse("failure", false);
    f.call("failure", "first", 0, "message_thread", { thread_id:"first", body:"Check this", mode:"normal" });
    f.call("failure", "second", 1);
    const before = f.dc.responses().length;
    f.done("failure", [f.tool("first"), f.tool("second")]); await settleVoice();
    assert.deepEqual(f.calls, ["submit"]);
    assert.equal(f.outputs().length, 2);
    assert.match(f.outputs()[0].output, outcome === "failed" ? /Action failed/ : /could not be confirmed/);
    assert.equal(f.outputs()[1].output, "Not executed: an earlier action failed.");
    assert.equal(f.dc.responses().length, before + 1);
  });
}

test("a successful read of a failed thread returns data and does not cancel the next read", async t => {
  const f = await sequencerFixture(t, id => ({ threads:[{ threadId: id, status: "failed", output: "Thread error", asOf: 123 }] }));
  f.startResponse("reads", false); f.call("reads", "first", 0); f.call("reads", "second", 1);
  f.done("reads", [f.tool("first"), f.tool("second")]); await settleVoice();
  assert.deepEqual(f.calls, ["first", "second"]);
  assert.equal(f.outputs().length, 2);
  assert.ok(f.outputs().every(item => JSON.parse(item.output).threads[0].status === "failed"));
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
  (f.agent as any).responseBinding={origin:"background",utterance:null};
  f.dc.emit("response.created", { response: { id: "second", metadata: { bb_voice_origin: "background" } } });
  f.dc.emit("output_audio_buffer.started", { response_id: "second" }); f.done("second", [f.speech]);
  const before = f.dc.responses().length;
  f.words("new"); await settleVoice();
  assert.equal(f.dc.responses().length, before + 1);
});

test("call-start context is injected once before the microphone and first response are enabled", async t => {
  // Duplicate session events must not fetch context again.
  const f = await liveVoiceFixture(t);
  const context = f.dc.sent.filter(event=>event.item?.role==="system");
  assert.equal(context.length,1);
  assert.equal(JSON.parse(context[0].item.content[0].text).type,"call_start_context");
  for(let i=0;i<2;i++) f.dc.emit("session.updated",{session:{audio:{input:{turn_detection:null,transcription:{model:"gpt-live-transcribe"}}}}});
  await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="callStartContext").length,1);
  const device = f.rpcCalls.find(call => call.method === "callStartContext")!.args.device;
  assert.deepEqual(Object.keys(device).sort(), ["browser", "mobile", "platform", "runtime"]);
  assert.equal(typeof device.mobile, "boolean");
  assert.equal(f.dc.sent.filter(event=>event.item?.role==="system").length,1);
});

test("an effect waits two seconds and carries the frozen utterance and occurrence", async t => {
  const f = await sequencerFixture(t,undefined,undefined,{settleInput:false,rpc:{runTool:()=>({status:"succeeded"})}});
  f.startResponse("effect",false);
  f.call("effect","send",0,"message_thread",{thread_id:"build",body:"Inspect it",mode:"normal"});
  f.done("effect",[f.tool("send")]);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="runTool").length,0);
  f.tick(1999);await settleVoice();assert.equal(f.rpcCalls.filter(call=>call.method==="runTool").length,0);
  f.tick(1);await settleVoice();
  const sent=f.rpcCalls.find(call=>call.method==="runTool")!.args;
  assert.equal(sent.tool,"message_thread");assert.equal(sent.responseOrigin,"user");assert.equal(sent.occurrence,0);
  assert.deepEqual(sent.utterance,{id:(f.agent as any).input.snapshot().id,version:1,text:"Check this thread.",startedAt:sent.utterance.startedAt});
  assert.equal(typeof sent.utterance.startedAt,"number");
  assert.equal(sent.conversationId,"conv_test");assert.equal(sent.nonce,f.agent.getSessionId());
});

test("a version change cancels an effect held in the correction window without a continuation",async t=>{
  const f=await sequencerFixture(t,undefined,undefined,{settleInput:false,rpc:{runTool:()=>({status:"succeeded"})}});
  f.startResponse("effect",false);f.call("effect","send",0,"message_thread",{thread_id:"build",body:"Inspect it",mode:"normal"});
  f.done("effect",[f.tool("send")]);await settleVoice();const before=f.dc.responses().length;
  f.words("qualifier",false);await settleVoice();f.tick(2000);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="runTool").length,0);
  assert.equal(f.outputs()[0].output,"Not executed: the user continued speaking.");
  assert.equal(f.dc.responses().length,before);
});

async function offeredFixture(t:TestContext, rpc:Record<string,(args:any)=>unknown>={}) {
  let available=true;
  const f=await sequencerFixture(t,undefined,undefined,{rpc:{
    nextUpdateBatch:()=>{if(!available)return null;available=false;return {offerId:"offer",items:[{summary:"Build finished"}],asOf:123};},
    ...rpc,
  }});
  f.startResponse("user-response",false);f.done("user-response",[{type:"message",content:[{type:"output_text",text:"Okay"}]}]);
  await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="nextUpdateBatch").length,0);
  f.tick(1999);await settleVoice();assert.equal(f.rpcCalls.filter(call=>call.method==="nextUpdateBatch").length,0);
  f.tick(1);await settleVoice();
  const updates=f.dc.sent.filter(event=>event.item?.role==="system").map(event=>JSON.parse(event.item.content[0].text)).filter(item=>item.type==="background_updates");
  assert.equal(updates.length,1);assert.equal(updates[0].offerId,"offer");
  assert.equal(f.dc.responses().at(-1)!.response.metadata.bb_voice_origin,"background");
  f.dc.emit("response.created",{response:{id:"background",metadata:f.dc.responses().at(-1)!.response.metadata}});
  return f;
}

for(const outcome of ["stopped","cleared"] as const)test(`a background offer closes after ${outcome} with the correct drain evidence`,async t=>{
  const f=await offeredFixture(t);
  f.addItem("background",0,f.speech);f.dc.emit("output_audio_buffer.started",{response_id:"background"});
  f.done("background",[f.speech]);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,0);
  f.dc.emit(`output_audio_buffer.${outcome}`,{response_id:"background"});await settleVoice();
  const close=f.rpcCalls.filter(call=>call.method==="closeOffer");
  assert.equal(close.length,1);assert.equal(close[0].args.outcome,outcome==="stopped"?"delivered":"not_delivered");
  assert.equal(close[0].args.responseId,"background");
  const drains=f.rpcCalls.filter(call=>call.method==="reportDrain");
  assert.equal(drains.length,outcome==="stopped"?1:0);
  if(outcome==="stopped")assert.ok(f.rpcCalls.indexOf(drains[0])<f.rpcCalls.indexOf(close[0]));
  f.dc.emit("output_audio_buffer.stopped",{response_id:"background"});await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,1);
  assert.equal(f.rpcCalls.filter(call=>call.method==="reportDrain").length,outcome==="stopped"?1:0);
});

for(const updates of ["dismiss","defer"] as const)test(`remain_silent closes an offer as ${updates} without a continuation`,async t=>{
  const f=await offeredFixture(t);const before=f.dc.responses().length;
  f.call("background","quiet",0,"remain_silent",{updates});f.done("background",[f.tool("quiet")]);await settleVoice();
  assert.equal(f.rpcCalls.find(call=>call.method==="closeOffer")?.args.outcome,updates==="dismiss"?"dismissed":"deferred");
  assert.equal(f.dc.responses().length,before);
});

test("a no-audio offer is not delivered and no drain is reported",async t=>{
  const f=await offeredFixture(t);f.done("background",[]);await settleVoice();
  assert.equal(f.rpcCalls.find(call=>call.method==="closeOffer")?.args.outcome,"not_delivered");
  assert.equal(f.rpcCalls.filter(call=>call.method==="reportDrain").length,0);
});

test("finishUserExchange is sent once at the final drain and never by the quiet timer",async t=>{
  const f=await sequencerFixture(t);
  f.startResponse("spoken");f.done("spoken",[f.speech]);await settleVoice();f.tick(5000);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,0);
  f.dc.emit("output_audio_buffer.stopped",{response_id:"spoken"});await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,1);
  f.tick(10000);await settleVoice();f.dc.emit("output_audio_buffer.stopped",{response_id:"spoken"});await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,1);

});

test("control_ui from a background response never runs on the client",async t=>{
  const {nativeUi}=await import("./native-ui.ts");
  const execute=t.mock.method(nativeUi,"execute",async()=>({status:"succeeded" as const,detail:"Opened"}));
  const f=await offeredFixture(t,{beginClientEffect:()=>({execute:true,operationId:"op",receipt:{},action:{kind:"show_voice"}})});
  f.call("background","ui",0,"control_ui",{action:"show_voice"});f.done("background",[f.tool("ui")]);await settleVoice();
  assert.equal(f.rpcCalls.find(call=>call.method==="beginClientEffect")?.args.responseOrigin,"background");
  assert.equal(execute.mock.callCount(),0);
  assert.equal(f.rpcCalls.find(call=>call.method==="finishClientEffect")?.args.status,"cancelled");
});

test("end_call returns its output then ends after the current response drains",async t=>{
  const f=await sequencerFixture(t);f.startResponse("goodbye");f.call("goodbye","end",1,"end_call",{});
  f.done("goodbye",[f.speech,f.tool("end")]);await settleVoice();assert.equal(f.agent.getState(),"live");
  const before=f.dc.responses().length;f.dc.emit("output_audio_buffer.stopped",{response_id:"goodbye"});await settleVoice();
  assert.equal(f.outputs().length,1);assert.equal(f.agent.getState(),"idle");assert.equal(f.dc.responses().length,before);
});

test("the quiet timer cannot finish an exchange before any user input",async t=>{
  const f=await liveVoiceFixture(t);f.tick(5000);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,0);
});

test("pending call-start context keeps microphone input disabled until injection",async t=>{
  let complete!:(value:unknown)=>void;
  const f=await liveVoiceFixture(t,undefined,{callStartContext:()=>new Promise(resolve=>{complete=resolve;})},"connecting");
  assert.equal(f.track.enabled,false);assert.equal(f.dc.sent.filter(event=>event.item?.role==="system").length,0);
  f.dc.emit("conversation.item.input_audio_transcription.delta",{item_id:"early",delta:"Send it"});
  assert.equal(f.dc.responses().length,0);
  complete({type:"call_start_context",tasks:[],recentTurns:[]});await settleVoice();
  assert.equal(f.agent.getState(),"live");assert.equal(f.track.enabled,true);
  assert.equal(f.dc.sent.filter(event=>event.item?.role==="system").length,1);
});

test("a silent user exchange finishes once with no model continuation",async t=>{
  const f=await sequencerFixture(t);const before=f.dc.responses().length;
  f.startResponse("silent",false);f.call("silent","quiet",0,"remain_silent",{});f.done("silent",[f.tool("quiet")]);await settleVoice();
  assert.equal(f.dc.responses().length,before);
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,1);
});

test("hangup closes an open offer before releasing call ownership",async t=>{
  const f=await offeredFixture(t);
  f.agent.stop();await settleVoice();
  const close=f.rpcCalls.findIndex(call=>call.method==="closeOffer");
  const release=f.rpcCalls.findIndex(call=>call.method==="publishPresence" && call.args.phase==="idle");
  assert.ok(close>=0);assert.ok(release>close,"closeOffer needs the call nonce to remain current");
  assert.equal(f.rpcCalls[close].args.outcome,"not_delivered");
});

test("an input-repair response completes its failed user exchange after drain",async t=>{
  const f=await sequencerFixture(t);f.startResponse("old",false);
  f.words("failed",false);f.dc.emit("response.done",{response:{id:"old",status:"cancelled",output:[]}});
  f.dc.emit("conversation.item.input_audio_transcription.failed",{item_id:"failed",error:{message:"Unavailable"}});
  f.dc.emit("response.created",{response:{id:"repair"}});
  f.dc.emit("output_audio_buffer.started",{response_id:"repair"});f.done("repair",[f.speech]);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,0);
  f.dc.emit("output_audio_buffer.stopped",{response_id:"repair"});await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="finishUserExchange").length,1);
});

for(const outcome of ["stopped","cleared"] as const)test(`a background tool continuation keeps its offer until ${outcome}`,async t=>{
  const f=await offeredFixture(t);const before=f.dc.responses().length;
  f.call("background","read",0,"read_threads",{thread_ids:["build"],what:"status"});
  f.done("background",[f.tool("read")]);await settleVoice();
  assert.equal(f.dc.responses().length,before+1);
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,0);
  f.dc.emit("response.created",{response:{id:"continuation",metadata:f.dc.responses().at(-1)!.response.metadata}});
  f.dc.emit("output_audio_buffer.started",{response_id:"continuation"});f.done("continuation",[f.speech]);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,0);
  f.dc.emit(`output_audio_buffer.${outcome}`,{response_id:"continuation"});await settleVoice();
  const closed=f.rpcCalls.filter(call=>call.method==="closeOffer");assert.equal(closed.length,1);
  assert.equal(closed[0].args.responseId,"continuation");assert.equal(closed[0].args.outcome,outcome==="stopped"?"delivered":"not_delivered");
});

test("an offer stays open while a background continuation waits for another drain",async t=>{
  const f=await offeredFixture(t);
  const agent=f.agent as any;
  agent.outputSequencer.created("other-audio");agent.outputSequencer.started("other-audio");agent.outputSequencer.done("other-audio",[f.speech]);
  f.call("background","read",0);f.done("background",[f.tool("read")]);await settleVoice();
  assert.equal(agent.responsePending,true);
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,0);
  f.dc.emit("output_audio_buffer.stopped",{response_id:"other-audio"});await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,0);
  f.dc.emit("response.created",{response:{id:"continuation"}});
  f.done("continuation",[]);await settleVoice();
  assert.equal(f.rpcCalls.filter(call=>call.method==="closeOffer").length,1);
});

test("Ada speaks first: a new call requests a greeting turn bound to no utterance", async (t) => {
  const { dc } = await liveVoiceFixture(t);
  const greeting = dc.responses()[0];
  assert.match(greeting.response.instructions, /call just started/);
  assert.match(greeting.response.instructions, /Do not call effect tools/);
  assert.equal(greeting.response.metadata.bb_voice_origin, "user");
  assert.equal(dc.sent.filter(e => e.type === "conversation.item.create").length, 1, "the greeting follows the call-start context item");
});

test("a resumed conversation gets a status turn instead of an introduction", async (t) => {
  const { dc } = await liveVoiceFixture(t, undefined, { callStartContext: () => ({ type: "call_start_context", tasks: [], recentTurns: [{ who: "you", text: "earlier" }] }) });
  assert.match(dc.responses()[0].response.instructions, /resumed an earlier conversation/);
});

test("a live call logs an input health heartbeat with meter and connection state", async (t) => {
  const { agent, rpcCalls, tick } = await liveVoiceFixture(t);
  const health = () => rpcCalls.filter(c => c.method === "logEvent" && c.args?.kind === "input.health").map(c => c.args.payload);
  assert.equal(health().length, 0);
  tick(30_000); await settleVoice();
  assert.equal(health().length, 1);
  assert.equal(health()[0].connection, "connected");
  assert.equal(health()[0].suspended, false);
  assert.equal(typeof health()[0].deltas, "number");
  agent.stop();
  tick(60_000); await settleVoice();
  assert.equal(health().length, 1, "no heartbeat after hangup");
});

test("device transfer stays silent and preserves a muted microphone", async t => {
  const f = await liveVoiceFixture(t, undefined, {callStartContext: () => ({recentTurns:[{role:"user",text:"Earlier request"}]})});
  f.agent.stop();
  f.agent.ingestPresence({nonce:"desktop",phase:"muted",startedAt:1000,client:"desktop-client"});
  f.agent.switchToThisDevice(); await settleVoice();
  assert.equal(f.agent.getState(), "muted");
  assert.equal(f.track.enabled, false);
  assert.equal(f.peers.at(-1)!.dc.responses().length, 0);
});

test("recovery retries a lost claim reply with the same nonce and keeps the mic", async t => {
  let attempts = 0;
  const f = await liveVoiceFixture(t, undefined, {reconnectCall: () => {
    if (++attempts === 1) throw new Error("Network unavailable");
    return {sequence:2,conversationId:"conv_test"};
  }});
  const capture = t.mock.method(navigator.mediaDevices, "getUserMedia");
  f.peers[0].connectionState = "failed"; f.peers[0].onconnectionstatechange?.();
  await settleVoice(); assert.equal(f.agent.getState(), "reconnecting");
  f.tick(1000); await settleVoice();
  assert.equal(f.agent.getState(), "live");
  const claims = f.rpcCalls.filter(c => c.method === "reconnectCall");
  assert.equal(claims.length, 2); assert.deepEqual(claims[0].args, claims[1].args);
  assert.equal(capture.mock.callCount(), 0);
  assert.equal(f.peers.at(-1)!.dc.responses().length, 0);
});

test("a stop during a pending recovery claim cannot restart the call", async t => {
  let grant!: (value: unknown) => void;
  const f = await liveVoiceFixture(t, undefined, {reconnectCall: () => new Promise(resolve => {grant = resolve;})});
  f.peers[0].connectionState = "failed"; f.peers[0].onconnectionstatechange?.();
  await settleVoice(); f.agent.stop();
  grant({sequence:2,conversationId:"conv_test"}); await settleVoice();
  f.tick(61000); await settleVoice();
  assert.equal(f.agent.getState(), "idle");
  assert.equal(f.peers.length, 1);
  assert.ok(f.rpcCalls.some(c => c.method === "forceStop"));
});

test("recovery stops if another device owns the call", async t => {
  const f = await liveVoiceFixture(t, undefined, {reconnectCall: () => null});
  f.peers[0].connectionState = "failed"; f.peers[0].onconnectionstatechange?.();
  await settleVoice(); f.tick(61000);
  assert.equal(f.agent.getState(), "idle");
  assert.equal(f.rpcCalls.filter(c => c.method === "reconnectCall").length, 1);
});

test("offline recovery has a deadline and releases the microphone", async t => {
  const f = await liveVoiceFixture(t);
  const stopped = t.mock.method(f.track, "stop");
  Object.defineProperty(navigator, "onLine", {configurable:true,value:false});
  f.peers[0].connectionState = "failed"; f.peers[0].onconnectionstatechange?.();
  assert.equal(f.agent.getState(), "reconnecting");
  f.tick(60000); await settleVoice();
  assert.equal(f.agent.getState(), "idle");
  assert.ok(stopped.mock.callCount() > 0);
  assert.equal(f.rpcCalls.filter(c => c.method === "reconnectCall").length, 0);
});

test("late SDP failure cannot stop the microphone of a successful retry", async t => {
  let calls = 0, rejectOld!: (error: Error) => void;
  const f = await liveVoiceFixture(t, undefined, {createCall: () => {
    if (++calls === 2) return new Promise((_, reject) => {rejectOld = reject;});
    return {sdp:"answer"};
  }});
  const stopped = t.mock.method(f.track, "stop");
  f.peers[0].connectionState = "failed"; f.peers[0].onconnectionstatechange?.();
  await settleVoice(); f.tick(15000); await settleVoice();
  f.tick(1000); await settleVoice();
  assert.equal(f.agent.getState(), "live");
  rejectOld(new Error("Old request timed out")); await settleVoice();
  assert.equal(f.agent.getState(), "live");
  assert.equal(stopped.mock.callCount(), 0);
  assert.equal(f.peers.at(-1)!.dc.responses().length, 0);
});

test("recovery never replays a tool whose result arrives after the connection failed", async t => {
  let resolve!: (result: unknown) => void, requests = 0;
  const f = await sequencerFixture(t, () => {requests++; return new Promise(r => {resolve = r;});}, undefined, {rpc:{
    reconnectCall: () => ({sequence:2,conversationId:"conv_test"}),
    createCall: () => ({sdp:"answer"}), callStartContext: () => ({recentTurns:[]}),
  }});
  f.startResponse("before-loss",false); f.addItem("before-loss",0,f.tool("one")); f.call("before-loss","one",0);
  f.done("before-loss",[f.tool("one")]); await settleVoice();
  assert.equal(requests,1);
  f.peers[0].connectionState = "failed"; f.peers[0].onconnectionstatechange?.(); await settleVoice();
  resolve({threads:[]}); await settleVoice();
  assert.equal(requests,1);
  assert.equal(f.agent.getState(),"live");
  assert.equal(f.peers.at(-1)!.dc.responses().length,0);
});

test("a retained microphone that the OS muted stays marked paused after recovery", async t => {
  const f = await liveVoiceFixture(t);
  Object.defineProperty(f.track,"muted",{value:true,configurable:true});
  f.peers[0].connectionState="failed"; f.peers[0].onconnectionstatechange?.();
  await settleVoice();
  assert.equal(f.agent.getState(),"live");
  assert.equal(f.agent.getMicSuspended(),true);
  assert.equal(f.peers.at(-1)!.dc.responses().length,0);
});

test("gpt-live-1: transcripts commit locally and delegated function calls round-trip", async t => {
  const f = await liveVoiceFixture(t, async () => ({ output: "Done", status: "succeeded" }),
    { createCall: () => ({ sdp: "answer", engine: "live", sessionId: "sess_live" }) }, "live", "live");
  const dc = f.dc;
  // Live sessions are configured by the creation POST: no session.update, the
  // call-start context lands as thinking appends, and the greeting is an
  // instructions append rather than response.create.
  assert.ok(!dc.sent.some(event => event.type === "session.update"));
  assert.ok(!dc.sent.some(event => event.type === "conversation.item.create"));
  assert.ok(dc.sent.some(event => event.type === "session.thinking.append"));
  assert.ok(dc.sent.some(event => event.type === "session.instructions.append" && event.content.includes("Speak first")));

  const input = (f.agent as unknown as { input: import("./input-controller.ts").InputController }).input;
  input.sample(0.04); f.tick(150); input.sample(0.04);
  dc.emit("session.input_transcript.delta", { event_id: "t1", delta: "Check ", start_ms: 0, end_ms: 100 });
  dc.emit("session.input_transcript.delta", { event_id: "t2", delta: "this thread", start_ms: 100, end_ms: 300 });
  f.tick(300); input.sample(0); f.tick(800); input.sample(0);
  // The local commit intercept settles the item; no server commit exists.
  assert.ok(!dc.sent.some(event => event.type === "input_audio_buffer.commit"));
  f.tick(2000); input.sample(0); await settleVoice();
  assert.ok(f.rpcCalls.some(call => call.method === "logEvent" && call.args?.kind === "user"));

  // The voice model delegates; the backend emits a function call; we execute
  // it through the same runTool path and return output + response.create.
  dc.emit("session.delegation.created", { delegation: { id: "del_1", target: "responses" }, response_id: "resp_1" });
  dc.emit("response.event", { delegation_id: "del_1", event: { type: "response.output_item.done", response_id: "resp_1",
    item: { type: "function_call", call_id: "call_1", name: "read_threads", arguments: JSON.stringify({ thread_ids: ["build"], what: "output" }) } } });
  await settleVoice();
  assert.ok(f.rpcCalls.some(call => call.method === "runTool" && call.args?.tool === "read_threads"));
  const itemOut = dc.sent.filter(event => event.type === "response.item.create").at(-1);
  assert.equal(itemOut?.item?.type, "function_call_output");
  assert.equal(itemOut?.item?.call_id, "call_1");
  assert.ok(dc.sent.some(event => event.type === "response.create" && String(event.event_id).startsWith("continue_")));
});

test("gpt-live-1: assistant speech does not settle an utterance the user is still speaking", async t => {
  const f = await liveVoiceFixture(t, undefined, { createCall: () => ({ sdp: "answer", engine: "live", sessionId: "sess_live" }) }, "live", "live");
  const dc = f.dc;
  const input = (f.agent as unknown as { input: import("./input-controller.ts").InputController }).input;
  const finishes = () => f.rpcCalls.filter(call => call.method === "finishUserExchange");
  // The user starts a new sentence while a fragment of Ada's previous answer is
  // still arriving: the exchange must stay open with the input unresolved.
  input.sample(0.04); f.tick(150); input.sample(0.04);
  dc.emit("session.input_transcript.delta", { event_id: "t1", delta: "Check ", start_ms: 0, end_ms: 100 });
  dc.emit("session.input_transcript.delta", { event_id: "t2", delta: "this thread", start_ms: 100, end_ms: 300 });
  assert.ok(input.unresolved);
  const utteranceId = input.currentUtterance()?.id;
  assert.ok(utteranceId);
  dc.emit("session.output_transcript.delta", { event_id: "o1", delta: "…and that was the build." });
  await settleVoice();
  assert.equal(finishes().length, 0, "a late prior-turn fragment must not finish the new utterance");
  assert.ok(input.pending, "the open utterance was not closed as answered");
  // Once the input settles, the next assistant fragment covers the utterance.
  f.tick(300); input.sample(0); f.tick(800); input.sample(0); f.tick(2000); input.sample(0); await settleVoice();
  assert.ok(!input.unresolved);
  assert.equal(finishes().length, 0, "settling alone does not report an answer");
  dc.emit("session.output_transcript.delta", { event_id: "o2", delta: "Sure, opening it." });
  await settleVoice();
  assert.deepEqual(finishes().map(call => call.args.utteranceId), [utteranceId]);
  dc.emit("session.output_transcript.delta", { event_id: "o3", delta: " Done." });
  await settleVoice();
  assert.equal(finishes().length, 1, "an exchange finishes once");
});

async function liveOfferFixture(t: TestContext, summary = "Build finished. " + "x".repeat(2000), expectedChunks = 2) {
  const f = await liveVoiceFixture(t, undefined, {
    createCall: () => ({ sdp: "answer", engine: "live", sessionId: "sess_live" }),
    nextUpdateBatch: (() => { let offered = false; return () => { if (offered) return null; offered = true; return { offerId: "offer", items: [{ summary }], asOf: 123 }; }; })(),
  }, "live", "live");
  f.tick(2000); await settleVoice(); f.tick(2000); await settleVoice();
  const chunks = f.dc.sent.filter(event => event.type === "session.commentary.append" && String(event.event_id).startsWith("live_offer_offer_"));
  assert.equal(chunks.length, expectedChunks, "the update is appended in chunks, all tagged with the offer");
  assert.equal(JSON.parse(chunks.map(chunk => chunk.content).join("")).offerId, "offer");
  const closes = () => f.rpcCalls.filter(call => call.method === "closeOffer");
  assert.equal(closes().length, 0);
  return { ...f, chunks, closes };
}

test("gpt-live-1: a multi-chunk update is delivered only once every chunk is acknowledged", async t => {
  const f = await liveOfferFixture(t);
  f.dc.emit("session.commentary.appended", { client_event_id: f.chunks[1].event_id }); await settleVoice();
  assert.equal(f.closes().length, 0, "the last chunk's ack alone does not deliver the offer");
  f.dc.emit("session.commentary.appended", { client_event_id: f.chunks[0].event_id }); await settleVoice();
  assert.deepEqual(f.closes().map(call => call.args.outcome), ["delivered"]);
});

test("gpt-live-1: a failed chunk closes the update as not delivered even after a later ack", async t => {
  const f = await liveOfferFixture(t);
  f.dc.emit("error", { error: { message: "append rejected", client_event_id: f.chunks[0].event_id } }); await settleVoice();
  assert.deepEqual(f.closes().map(call => call.args.outcome), ["not_delivered"]);
  f.dc.emit("session.commentary.appended", { client_event_id: f.chunks[1].event_id }); await settleVoice();
  assert.equal(f.closes().length, 1, "the surviving chunk's ack cannot resurrect the offer as delivered");
});

test("gpt-live-1: an update larger than the append ledger still closes once every chunk is acknowledged", async t => {
  // More than 300 chunks overflows the liveAppends bound; the offer's own ids must not be evicted.
  const f = await liveOfferFixture(t, "x".repeat(430_000), 308);
  assert.ok(f.chunks.length > 300);
  for (const chunk of f.chunks) f.dc.emit("session.commentary.appended", { client_event_id: chunk.event_id });
  await settleVoice();
  assert.deepEqual(f.closes().map(call => call.args.outcome), ["delivered"]);
});
