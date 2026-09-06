import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, formatThreadNotices } from "./voice-agent.ts";
import { writeAudioDevicePreferences } from "./audio-devices.ts";

/** A VoiceAgent bound to a spy rpc that records every relayed call. */
function agentWithRpcSpy() {
  const calls: { method: string; args: unknown }[] = [];
  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      call: (async (method: string, args: unknown) => {
        calls.push({ method, args });
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
  });
  // bind() emits a one-time client.hello diagnostic; drop it so tests start clean.
  calls.length = 0;
  return { agent, calls };
}

test("mirrors a call owned by another realm from voice-presence", () => {
  const agent = new VoiceAgent();
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
  const agent = new VoiceAgent();
  agent.ingestPresence(null);
  agent.ingestPresence({ phase: "live" });
  agent.ingestPresence({ nonce: "x", phase: "bogus" });
  assert.equal(agent.getState(), "idle");
});

test("a mirrored call expires once its heartbeats lapse (no ghost live)", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  try {
    const agent = new VoiceAgent();
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
    const agent = new VoiceAgent();
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

test("grounds a thread notification in the latest completed result", () => {
  const { logText, instruction } = formatThreadNotices([
    {
      kind: "idle",
      threadId: "thr_settings",
      title: "Install BB Voice Mode version",
      detail: "Updated the notification prompt and reloaded Voice Mode.",
    },
  ]);

  assert.match(logText, /Updated the notification prompt/);
  assert.match(instruction, /latest_result: "Updated the notification prompt/);
  assert.match(instruction, /Ground the summary only in latest_result/);
  assert.match(instruction, /Never guess from earlier conversation/);
  assert.match(instruction, /every announcement must name its thread: start with the title/);
});

test("names every thread in a multi-thread digest so 'it finished' is never ambiguous", () => {
  const { logText, instruction } = formatThreadNotices([
    {
      kind: "idle",
      threadId: "thr_review",
      title: "Review recent GitHub pull requests",
      detail: "Both pull requests landed on main.",
    },
    {
      kind: "failed",
      threadId: "thr_vsix",
      title: "Enable one-click plugin distribution",
      detail: "Build script exited with status 1.",
    },
  ]);

  assert.match(logText, /finished: Review recent GitHub pull requests/);
  assert.match(logText, /failed: Enable one-click plugin distribution/);
  assert.match(instruction, /title: "Review recent GitHub pull requests"/);
  assert.match(instruction, /title: "Enable one-click plugin distribution"/);
  assert.match(instruction, /every announcement must name its thread: start with the title/);
  assert.match(instruction, /"<title> finished: <summary>" or "<title> failed: <summary>"/);
  assert.match(instruction, /Never say just "it finished"/);
  assert.match(instruction, /one short sentence per update/);
});

test("both individual and batched announcements give the user priority", () => {
  for (const count of [1, 6]) {
    const { instruction } = formatThreadNotices(Array.from({ length: count }, (_, i) => ({ kind: "idle", threadId: `t-${i}`, title: `Task ${i}`, detail: "Finished" })));
    assert.match(instruction, /background updates, not a new user request/);
    assert.match(instruction, /Finish responding to the user before announcing/);
  }
});

test("requires reading the thread when a completion has no result", () => {
  const { instruction } = formatThreadNotices([
    {
      kind: "idle",
      threadId: "thr_missing",
      title: "Background task",
      detail: null,
    },
  ]);

  assert.match(instruction, /latest_result: unavailable/);
  assert.match(instruction, /call read_thread with that thread_id before speaking/);
});

const settleVoice = () => new Promise<void>(resolve => setImmediate(resolve));
const threadNotice = (threadId = "thread-a", detail = "Tests passed.") => ({ kind: "idle", threadId, title: `Task ${threadId}`, detail });

async function liveVoiceFixture(t: TestContext, runTool = async () => ({ output: "Tool complete", status: "success" })) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const originals = ["navigator", "RTCPeerConnection", "Audio"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const channels: FakeDataChannel[] = [];
  class FakeDataChannel {
    readyState = "open";
    sent: Record<string, any>[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = "closed"; }
    emit(type: string, extra: Record<string, unknown> = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...extra }) }); }
    notices() { return this.sent.filter(event => event.type === "conversation.item.create" && event.item?.role === "system"); }
    responses() { return this.sent.filter(event => event.type === "response.create"); }
  }
  class FakePeerConnection {
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
  const agent = new VoiceAgent();
  agent.bind({
    rpc: { call: (async (method: string) => method === "claimCall" ? { sequence: 1 } : method === "createCall" ? { sdp: "answer" } : method === "runTool" ? runTool() : { ok: true }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread() {},
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
  return { agent, dc, start, tick: (ms: number) => t.mock.timers.tick(ms) };
}

function userTurn(dc: { emit(type: string, event?: Record<string, unknown>): void }, id: string) {
  dc.emit("input_audio_buffer.speech_started", { item_id: id });
  dc.emit("input_audio_buffer.speech_stopped", { item_id: id });
  dc.emit("input_audio_buffer.committed", { item_id: id });
}

function responseDone(dc: { emit(type: string, event?: Record<string, unknown>): void }, id: string, output: unknown[] = [], status = "completed") {
  dc.emit("response.done", { response: { id, status, output } });
}

test("thread updates wait through speech, the automatic-response gap, and playback", async (t) => {
  const { agent, dc, tick } = await liveVoiceFixture(t);
  dc.emit("input_audio_buffer.speech_started", { item_id: "user-1" });
  agent.enqueueThreadEvent(threadNotice());
  tick(5000);
  assert.equal(dc.notices().length, 0);
  dc.emit("input_audio_buffer.speech_stopped", { item_id: "user-1" });
  dc.emit("input_audio_buffer.committed", { item_id: "user-1" });
  tick(5000);
  assert.equal(dc.notices().length, 0);
  dc.emit("response.created", { response: { id: "reply-1" } });
  dc.emit("output_audio_buffer.started", { response_id: "reply-1" });
  responseDone(dc, "reply-1", [{ type: "message" }]);
  tick(5000);
  assert.equal(dc.notices().length, 0);
  dc.emit("output_audio_buffer.stopped", { response_id: "reply-1" });
  tick(1999);
  assert.equal(dc.notices().length, 0);
  tick(1);
  assert.equal(dc.notices().length, 1);
  assert.equal(dc.responses().length, 1);
});

test("generation done is not playback done even without a user turn", async (t) => {
  const { agent, dc, tick } = await liveVoiceFixture(t);
  dc.emit("response.created", { response: { id: "reply-1" } });
  dc.emit("output_audio_buffer.started", { response_id: "reply-1" });
  agent.enqueueThreadEvent(threadNotice());
  responseDone(dc, "reply-1");
  tick(5000);
  assert.equal(dc.notices().length, 0);
  dc.emit("output_audio_buffer.stopped", { response_id: "reply-1" });
  tick(2000);
  assert.equal(dc.notices().length, 1);
});

test("a cancelled old response cannot release a newer user turn", async (t) => {
  const { agent, dc, tick } = await liveVoiceFixture(t);
  dc.emit("response.created", { response: { id: "old-reply" } });
  userTurn(dc, "user-2");
  agent.enqueueThreadEvent(threadNotice());
  responseDone(dc, "old-reply", [], "cancelled");
  tick(5000);
  assert.equal(dc.notices().length, 0);
  dc.emit("response.created", { response: { id: "new-reply" } });
  responseDone(dc, "new-reply", [{ type: "message" }]);
  tick(2000);
  assert.equal(dc.notices().length, 1);
});

test("updates wait for asynchronous tools and their spoken answer", async (t) => {
  let finishTool!: (result: { output: string; status: string }) => void;
  const { agent, dc, tick } = await liveVoiceFixture(t, () => new Promise(resolve => { finishTool = resolve; }));
  userTurn(dc, "user-1");
  dc.emit("response.created", { response: { id: "tool-reply" } });
  dc.emit("response.function_call_arguments.done", { name: "read_thread", call_id: "call-1", arguments: "{}" });
  responseDone(dc, "tool-reply", [{ type: "function_call", call_id: "call-1" }]);
  await settleVoice();
  agent.enqueueThreadEvent(threadNotice());
  tick(5000);
  assert.equal(dc.notices().length, 0);
  finishTool({ output: "Task result", status: "success" });
  await settleVoice();
  assert.equal(dc.responses().length, 1);
  dc.emit("response.created", { response: { id: "spoken-reply" } });
  dc.emit("output_audio_buffer.started", { response_id: "spoken-reply" });
  responseDone(dc, "spoken-reply", [{ type: "message" }]);
  tick(5000);
  assert.equal(dc.notices().length, 0);
  dc.emit("output_audio_buffer.stopped", { response_id: "spoken-reply" });
  tick(2000);
  assert.equal(dc.notices().length, 1);
});

for (const status of ["failed", "incomplete"]) {
  test(`thread updates resume after a ${status} reply without requiring another user turn`, async (t) => {
    const { agent, dc, tick } = await liveVoiceFixture(t);
    userTurn(dc, "user-1");
    dc.emit("response.created", { response: { id: "reply-1" } });
    agent.enqueueThreadEvent(threadNotice());
    responseDone(dc, "reply-1", status === "incomplete" ? [{ type: "function_call" }] : [], status);
    tick(1999);
    assert.equal(dc.notices().length, 0);
    tick(1);
    assert.equal(dc.notices().length, 1);
  });
}

test("new speech takes priority during the quiet window and stale response events are ignored", async (t) => {
  const { agent, dc, tick } = await liveVoiceFixture(t);
  agent.enqueueThreadEvent(threadNotice());
  tick(1900);
  userTurn(dc, "user-1");
  dc.emit("response.created", { response: { id: "current" } });
  responseDone(dc, "stale", [], "cancelled");
  tick(5000);
  assert.equal(dc.notices().length, 0);
  responseDone(dc, "current", [{ type: "message" }]);
  tick(2000);
  assert.equal(dc.notices().length, 1);
});

test("a background response cannot stand in for the answer to a new user turn", async (t) => {
  const { agent, dc, tick } = await liveVoiceFixture(t);
  agent.enqueueThreadEvent(threadNotice());
  tick(2000);
  assert.equal(dc.responses()[0].response.metadata.bb_voice_source, "thread_update");
  userTurn(dc, "user-1");
  dc.emit("response.created", { response: { id: "notice-reply", metadata: { bb_voice_source: "thread_update" } } });
  responseDone(dc, "notice-reply", [{ type: "message" }]);
  agent.enqueueThreadEvent(threadNotice("second"));
  tick(5000);
  assert.equal(dc.notices().length, 1);
  dc.emit("response.created", { response: { id: "user-reply" } });
  responseDone(dc, "user-reply", [{ type: "message" }]);
  tick(2000);
  assert.equal(dc.notices().length, 2);
});

test("late tool results do not request speech while the user is speaking", async (t) => {
  let finishTool!: (result: { output: string; status: string }) => void;
  const { agent, dc, tick } = await liveVoiceFixture(t, () => new Promise(resolve => { finishTool = resolve; }));
  userTurn(dc, "user-1");
  dc.emit("response.created", { response: { id: "tool-reply" } });
  dc.emit("response.function_call_arguments.done", { name: "read_thread", call_id: "call-1", arguments: "{}" });
  responseDone(dc, "tool-reply", [{ type: "function_call", call_id: "call-1" }]);
  await settleVoice();
  dc.emit("input_audio_buffer.speech_started", { item_id: "user-2" });
  finishTool({ output: "Task result", status: "success" });
  await settleVoice();
  agent.enqueueThreadEvent(threadNotice());
  tick(5000);
  assert.equal(dc.responses().length, 0);
  assert.equal(dc.notices().length, 0);
  dc.emit("input_audio_buffer.speech_stopped", { item_id: "user-2" });
  dc.emit("input_audio_buffer.committed", { item_id: "user-2" });
  tick(5000);
  assert.equal(dc.responses().length, 0);
});

test("a notice tool result waits behind a new user turn and continues without a notice tag", async (t) => {
  let finishTool!: (result: { output: string; status: string }) => void;
  const { agent, dc, tick } = await liveVoiceFixture(t, () => new Promise(resolve => { finishTool = resolve; }));
  agent.enqueueThreadEvent({ ...threadNotice(), detail: null });
  tick(2000);
  dc.emit("response.created", { response: { id: "notice", metadata: { bb_voice_source: "thread_update" } } });
  dc.emit("response.function_call_arguments.done", { name: "read_thread", call_id: "call-1", arguments: "{}" });
  responseDone(dc, "notice", [{ type: "function_call", call_id: "call-1" }]);
  await settleVoice();
  dc.emit("input_audio_buffer.speech_started", { item_id: "user-1" });
  finishTool({ output: "Task result", status: "success" });
  await settleVoice();
  assert.equal(dc.responses().length, 1);
  dc.emit("input_audio_buffer.speech_stopped", { item_id: "user-1" });
  dc.emit("input_audio_buffer.committed", { item_id: "user-1" });
  tick(3000);
  assert.equal(dc.responses().length, 1);
  dc.emit("response.created", { response: { id: "user-reply" } });
  responseDone(dc, "user-reply", [{ type: "message" }]);
  assert.equal(dc.responses().length, 2);
  assert.equal(dc.responses()[1].response?.metadata?.bb_voice_source, undefined);
});

test("an old tool settling after restart cannot change the new call's pending work", async (t) => {
  const finishTools: ((result: { output: string; status: string }) => void)[] = [];
  const { agent, dc, tick, start } = await liveVoiceFixture(t, () => new Promise(resolve => { finishTools.push(resolve); }));
  userTurn(dc, "old-user");
  dc.emit("response.created", { response: { id: "old-reply" } });
  dc.emit("response.function_call_arguments.done", { name: "read_thread", call_id: "old-call", arguments: "{}" });
  responseDone(dc, "old-reply", [{ type: "function_call" }]);
  await settleVoice();
  agent.stop();
  const next = await start();
  userTurn(next, "new-user");
  next.emit("response.created", { response: { id: "new-reply" } });
  next.emit("response.function_call_arguments.done", { name: "read_thread", call_id: "new-call", arguments: "{}" });
  responseDone(next, "new-reply", [{ type: "function_call" }]);
  await settleVoice();
  agent.enqueueThreadEvent(threadNotice());
  finishTools[0]({ output: "Old result", status: "success" });
  await settleVoice();
  tick(3000);
  assert.equal(next.responses().length, 0);
  assert.equal(next.notices().length, 0);
  finishTools[1]({ output: "New result", status: "success" });
  await settleVoice();
  next.emit("response.created", { response: { id: "final-reply" } });
  responseDone(next, "final-reply", [{ type: "message" }]);
  tick(2000);
  assert.equal(next.notices().length, 1);
  assert.equal(dc.responses().length, 0);
});

test("thread updates coalesce while waiting and stop discards them", async (t) => {
  const { agent, dc, tick, start } = await liveVoiceFixture(t);
  userTurn(dc, "user-1");
  agent.enqueueThreadEvent(threadNotice("a", "Old result"));
  agent.enqueueThreadEvent(threadNotice("a", "Latest result"));
  agent.enqueueThreadEvent(threadNotice("b", "Other result"));
  dc.emit("response.created", { response: { id: "reply-1" } });
  responseDone(dc, "reply-1", [{ type: "message" }]);
  tick(2000);
  assert.equal(dc.notices().length, 1);
  const text = dc.notices()[0].item.content[0].text;
  assert.match(text, /Latest result/);
  assert.match(text, /Other result/);
  assert.doesNotMatch(text, /Old result/);
  agent.enqueueThreadEvent(threadNotice("c"));
  agent.stop();
  const next = await start();
  dc.emit("input_audio_buffer.speech_started", { item_id: "stale" });
  assert.equal(agent.getActivity(), "idle");
  tick(5000);
  assert.equal(next.notices().length, 0);
  agent.enqueueThreadEvent(threadNotice("fresh"));
  tick(2000);
  assert.equal(next.notices().length, 1);
});

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

  const agent = new VoiceAgent();
  agent.bind({
    rpc: {
      // Pause startup at the SDP exchange so the test can stop mid-flight.
      call: (async (method: string) => {
        if (method === "claimCall") return { sequence: 1 };
        if (method === "createCall") {
          announceCallStarted();
          await callPending;
          return { sdp: "answer" };
        }
        return { ok: true };
      }) as never,
    },
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    composer: { setText() {}, updateText() {} },
    openNewThread() {},
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
  const agent = new VoiceAgent();
  let requests = 0;
  const unbind = agent.bind({
    rpc: { call: (async (method: string) => { if (method === "requestPresence") requests++; return { ok: true }; }) as never },
    context: { threadId: null, projectId: null, onNewThreadScreen: false }, openNewThread() {},
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
