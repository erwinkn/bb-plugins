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
