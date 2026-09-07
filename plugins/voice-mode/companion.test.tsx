import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { viewWorkspace, type ThreadView } from "./view-workspace.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, within } = await import("@testing-library/react");
installTestPluginRuntime();
const { CompanionTab } = await import("./companion.tsx");
const { voiceAgent } = await import("./voice-agent.ts");
const { LiveCallControls } = await import("./voice-chrome.tsx");
const { SessionsPanel } = await import("./sessions-panel.tsx");
const { VoiceController } = await import("./voice-realtime.ts");
after(() => dom.window.close());
const view = (id: string): ThreadView => ({ kind: "thread", id: `thread:${id}`, threadId: id, projectId: "project", title: `Thread ${id}` });

test("the mobile switcher changes the shown thread; closing only removes the requested view", () => {
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  const slot = renderSlot({ component: CompanionTab }, {});
  try {
    assert.match(slot.container.textContent ?? "", /all your running threads/);
    act(() => viewWorkspace.open([view("a"), view("b")]));
    assert.equal(slot.getAllByTestId("bb-thread-chat").length, 1);
    assert.equal(slot.getByRole("combobox", { name: "Shown thread" }).getAttribute("aria-label"), "Shown thread");
    fireEvent.change(slot.getByRole("combobox"), { target: { value: "thread:b" } });
    assert.equal(viewWorkspace.get().activeId, "thread:b");
    fireEvent.change(slot.getByRole("combobox"), { target: { value: "thread:a" } });
    assert.equal(viewWorkspace.get().activeId, "thread:a");
    const chat = slot.getByTestId("bb-thread-chat");
    assert.equal(chat.getAttribute("data-thread-id"), "a");
    fireEvent.click(slot.getAllByRole("button", { name: "Close Thread a" })[0]);
    assert.equal(viewWorkspace.get().activeId, "thread:b");
    assert.equal(slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"), "b");
    fireEvent.click(slot.getAllByRole("button", { name: "Close Thread b" })[0]);
    assert.equal(slot.queryByTestId("bb-thread-chat"), null);
    assert.equal(viewWorkspace.get().views.length, 0);
  } finally { slot.lifecycle.unmount(); unregister(); }
});

test("closing and remounting a host panel preserves the collection for the app session", () => {
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  viewWorkspace.open([view("a"), view("b")]);
  const first = renderSlot({ component: CompanionTab }, {});
  first.lifecycle.unmount();
  assert.equal(viewWorkspace.current(), null);
  const second = renderSlot({ component: CompanionTab }, {});
  try {
    assert.equal(second.getAllByRole("option").length, 2);
    assert.equal(second.getByTestId("bb-thread-chat").getAttribute("data-thread-id"), "a");
  } finally { second.lifecycle.unmount(); unregister(); viewWorkspace.clear(); }
});


test("drawer controls share call state, survive view changes, and only stop on explicit tap", (t) => {
  const call = voiceAgent as unknown as { state: "idle" | "connecting" | "live" | "muted"; emitChange(): void };
  const setState = (state: typeof call.state) => { call.state = state; call.emitChange(); };
  const mute = t.mock.method(voiceAgent, "toggleMuteFromSurface", () => setState(call.state === "muted" ? "live" : "muted"));
  const stop = t.mock.method(voiceAgent, "stopFromSurface", () => setState("idle"));
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  const drawer = renderSlot({ component: CompanionTab }, {});
  const pageControls = renderSlot({ component: LiveCallControls }, {});
  const drawerUi = within(drawer.container);
  const pageUi = within(pageControls.container);
  try {
    assert.equal(drawerUi.queryByRole("group", { name: "Aide call controls" }), null);
    act(() => setState("connecting"));
    assert.equal(drawerUi.getByRole("button", { name: "Mute Aide microphone" }).hasAttribute("disabled"), true);
    assert.ok(drawerUi.getByText("Connecting…"));
    act(() => setState("live"));
    act(() => viewWorkspace.open([view("a"), view("b")]));
    fireEvent.click(drawerUi.getByRole("button", { name: "Mute Aide microphone" }));
    assert.equal(mute.mock.callCount(), 1);
    assert.ok(pageUi.getByRole("button", { name: "Unmute Aide microphone" }));
    fireEvent.change(drawerUi.getByRole("combobox"), { target: { value: "thread:b" } });
    assert.ok(drawerUi.getByRole("button", { name: "Unmute Aide microphone" }));
    act(() => viewWorkspace.clear());
    assert.ok(drawerUi.getByRole("group", { name: "Aide call controls" }));
    assert.equal(stop.mock.callCount(), 0);
    fireEvent.click(pageUi.getByRole("button", { name: "Unmute Aide microphone" }));
    assert.ok(drawerUi.getByRole("button", { name: "Mute Aide microphone" }));
    fireEvent.click(drawerUi.getByRole("button", { name: "Stop Aide voice session" }));
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(drawerUi.queryByRole("group", { name: "Aide call controls" }), null);
  } finally {
    drawer.lifecycle.unmount(); pageControls.lifecycle.unmount(); unregister();
    setState("idle"); viewWorkspace.clear();
  }
  assert.equal(stop.mock.callCount(), 1);
});

const sessionRow = (id: string) => ({ id, title:`Session ${id}`,createdAt:1000,updatedAt:5000,coordinatorThreadId:null,callIds:[id],currentCallNonce:null,legacy:false });
const pageRpc = {
  listVoiceSessions: () => ({ sessions: [sessionRow("a"), sessionRow("b")], hasMore: false }),
  listPlugins: () => ({ plugins: [] }),
  requestPresence: () => ({ ok: true }),
  logEvent: () => ({ ok: true }),
  getVoiceSession: (input: unknown) => ({ session:sessionRow((input as {sessionId:string}).sessionId), events: [{ id: 1, ts: 1000, kind: "user", payload: JSON.stringify({ text: `Transcript ${(input as { sessionId: string }).sessionId}` }) }] }),
};

test("session creation is above history; call controls only show during a call", async (t) => {
  const call = voiceAgent as unknown as { state: "idle" | "connecting" | "live" | "muted"; emitChange(): void };
  const setState = (state: typeof call.state) => { call.state = state; call.emitChange(); };
  const start = t.mock.method(voiceAgent, "startConversation", () => setState("connecting"));
  const stop = t.mock.method(voiceAgent, "stopFromSurface", () => setState("idle"));
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: pageRpc });
  const ui = within(slot.container);
  try {
    const row = await ui.findByRole("button", { name: /Session a/ });
    const startButton = ui.getByRole("button", { name: "New session" });
    const header = ui.getByRole("heading", { name: "Voice sessions" }).parentElement;
    assert.equal(header?.contains(startButton), true);
    const settingsButton = ui.getByRole("button", { name: "Open Voice Mode settings" });
    assert.equal(header?.contains(settingsButton), true);
    assert.equal(settingsButton.textContent, "");
    assert.ok(settingsButton.compareDocumentPosition(startButton) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(startButton.compareDocumentPosition(row) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(ui.queryByRole("region", { name: "Current voice session" }), null);
    assert.equal(ui.queryByText("Talk to Aide"), null);
    fireEvent.click(startButton);
    assert.equal(start.mock.callCount(), 1);
    assert.equal(ui.getByRole("button", { name: "Connecting…" }).hasAttribute("disabled"), true);
    assert.ok(ui.getByRole("region", { name: "Current voice session" }));
    assert.equal(ui.getByRole("button", { name: "Mute Aide microphone" }).hasAttribute("disabled"), true);
    fireEvent.click(ui.getByRole("button", { name: "Stop Aide voice session" }));
    assert.equal(stop.mock.callCount(), 1);
    assert.ok(ui.getByRole("button", { name: "New session" }));
    assert.equal(ui.queryByRole("region", { name: "Current voice session" }), null);
    act(() => setState("muted"));
    assert.equal(ui.getByRole("button", { name: "Session in progress" }).hasAttribute("disabled"), true);
    assert.ok(ui.getByRole("button", { name: "Unmute Aide microphone" }));
  } finally { slot.lifecycle.unmount(); setState("idle"); }
});

test("session search has a label and filters can be cleared", async () => {
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: pageRpc });
  const ui = within(slot.container);
  try {
    await ui.findByRole("button", { name: /Session a/ });
    fireEvent.change(ui.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "missing" } });
    assert.ok(ui.getByText("No sessions match."));
    fireEvent.click(ui.getByRole("button", { name: "Clear filters" }));
    assert.ok(ui.getByRole("button", { name: /Session a/ }));
  } finally { slot.lifecycle.unmount(); }
});

test("switching transcripts rejects late results and shows retryable errors", async () => {
  let resolveA!: (result: ReturnType<typeof pageRpc.getVoiceSession>) => void;
  let failB = true;
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...pageRpc,
    getVoiceSession: (input: unknown) => {
      const { sessionId } = input as { sessionId: string };
      if (sessionId === "a") return new Promise(resolve => { resolveA = resolve; });
      if (failB) throw new Error("Transcript unavailable");
      return pageRpc.getVoiceSession({ sessionId });
    },
  } });
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button", { name: /Session a/ }));
    await ui.findByText("Loading session…");
    fireEvent.click(ui.getByRole("button", { name: /All sessions/ }));
    fireEvent.click(ui.getByRole("button", { name: /Session b/ }));
    await ui.findByRole("alert");
    await act(async () => resolveA(pageRpc.getVoiceSession({ sessionId: "a" })));
    assert.equal(ui.queryByText("Transcript a"), null);
    failB = false;
    fireEvent.click(ui.getByRole("button", { name: "Retry session" }));
    await ui.findByText("Transcript b");
    fireEvent.click(ui.getByRole("tab", { name: "Conversation" }));
    assert.equal(ui.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected"), "true");
  } finally { slot.lifecycle.unmount(); }
});

test("a failed session list shows a retry instead of endless loading", async () => {
  let fail = true;
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...pageRpc,
    listVoiceSessions: () => {
      if (fail) throw new Error("History unavailable");
      return { sessions: [], hasMore: false };
    },
  } });
  const ui = within(slot.container);
  try {
    await ui.findByRole("alert");
    assert.equal(ui.queryByText("Loading sessions…"), null);
    assert.equal(ui.queryByLabelText("Session history") === null, true);
    fail = false;
    fireEvent.click(ui.getByRole("button", { name: "Retry sessions" }));
    await ui.findByText("No voice sessions yet");
    assert.ok(ui.getByRole("button", { name: "New session" }));
    assert.ok(ui.getByLabelText("Session history"));
  } finally { slot.lifecycle.unmount(); }
});

test("Escape returns to history from a transcript and preserves input and handled events", async (t) => {
  const back = t.mock.method(dom.window.history, "back", () => undefined);
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: pageRpc });
  const ui = within(slot.container);
  try {
    const row = await ui.findByRole("button", { name: /Session a/ });
    fireEvent.keyDown(ui.getByRole("searchbox", { name: "Search sessions" }), { key: "Escape" });
    assert.equal(back.mock.callCount(), 0);
    act(() => row.focus());
    fireEvent.click(row);
    await ui.findByText("Transcript a");
    assert.equal(document.activeElement === ui.getByRole("button", { name: /All sessions/ }), true);
    const handled = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(ui.getByRole("tab", { name: "Conversation" }), handled);
    assert.ok(ui.getByText("Transcript a"));
    assert.equal(back.mock.callCount(), 0);
    fireEvent.keyDown(ui.getByRole("button", { name: /All sessions/ }), { key: "Escape" });
    assert.ok(ui.getByRole("button", { name: /Session a/ }));
    assert.equal(document.activeElement === ui.getByRole("button", { name: /Session a/ }), true);
    assert.equal(ui.queryByText("Transcript a"), null);
    assert.equal(back.mock.callCount(), 0);
    fireEvent.click(ui.getByRole("button", { name: /Session a/ }));
    await ui.findByText("Transcript a");
    fireEvent.click(ui.getByRole("button", { name: /All sessions/ }));
    assert.equal(document.activeElement === ui.getByRole("button", { name: /Session a/ }), true);
    fireEvent.keyDown(ui.getByRole("button", { name: "New session" }), { key: "Escape" });
    assert.equal(back.mock.callCount(), 1);
  } finally { slot.lifecycle.unmount(); }
});

test("returning from a session absent from history focuses the history heading", async (t) => {
  t.mock.method(voiceAgent, "getState", () => "live");
  t.mock.method(voiceAgent, "getSessionId", () => "unlisted");
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...pageRpc,
    listVoiceSessions: () => ({ sessions: [], hasMore: false }),
  } });
  const ui = within(slot.container);
  try {
    await ui.findByText("No voice sessions yet");
    fireEvent.click(ui.getByRole("button", { name: "See full transcript" }));
    await ui.findByText("Transcript unlisted");
    assert.equal(document.activeElement === ui.getByRole("button", { name: /All sessions/ }), true);
    fireEvent.keyDown(ui.getByRole("button", { name: /All sessions/ }), { key: "Escape" });
    assert.equal(document.activeElement === ui.getByRole("heading", { name: "Voice sessions" }), true);
  } finally { slot.lifecycle.unmount(); }
});

test("transcript navigation remains outside the scrolling content", async () => {
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: pageRpc });
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button", { name: /Session a/ }));
    await ui.findByText("Transcript a");
    const navigation = ui.getByRole("navigation", { name: "Session navigation" });
    const content = ui.getByRole("region", { name: "Session content" });
    assert.ok(within(navigation).getByRole("button", { name: /All sessions/ }));
    assert.ok(within(navigation).getByRole("tablist", { name: "Session views" }));
    assert.equal(content.contains(navigation), false);
    assert.ok(content.contains(ui.getByText("Transcript a")));
    assert.ok(navigation.compareDocumentPosition(content) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  } finally { slot.lifecycle.unmount(); }
});

test("logical session rows announce live status", async () => {
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...pageRpc,
    listVoiceSessions: () => ({ sessions: [
      { ...sessionRow("live"), currentCallNonce:"live-call" },
      { ...sessionRow("error"), hasError: true },
      sessionRow("ended"),
    ], hasMore: false }),
  } });
  const ui = within(slot.container);
  try {
    assert.ok(await ui.findByRole("button", { name: /Session live.*Live session/ }));
    assert.ok(ui.getByRole("button", { name: /Session error/ }));
    assert.doesNotMatch(ui.getByRole("button", { name: /Session ended/ }).textContent ?? "", /Live session|Session has errors/);
  } finally { slot.lifecycle.unmount(); }
});


test("app-wide controller receives stop, mute, and thread events without a Voice page", async (t) => {
  const started = t.mock.method(voiceAgent, "onCallStarted", () => {});
  const muted = t.mock.method(voiceAgent, "setMuted", () => {});
  const notice = t.mock.method(voiceAgent, "enqueueThreadEvent", () => {});
  const slot = renderSlot({ component: VoiceController }, {}, { rpc: pageRpc });
  try {
    await slot.behavior.emitRealtime("voice-call", { nonce: "new-call" });
    await slot.behavior.emitRealtime("voice-mute", { muted: true });
    await slot.behavior.emitRealtime("voice-mute", { muted: false });
    await slot.behavior.emitRealtime("aide-thread-event", { kind: "idle", threadId: "worker", title: "Done" });
    assert.equal(started.mock.calls[0].arguments[0], "new-call");
    assert.deepEqual(muted.mock.calls.map(call => call.arguments[0]), [true, false]);
    assert.equal(notice.mock.callCount(), 1);
  } finally { slot.lifecycle.unmount(); }
});

test("Voice inspection is optional, stays in the area, and preserves the conversation on return", async (t) => {
  viewWorkspace.clear();
  const stopped = t.mock.method(voiceAgent, "stopFromSurface", () => {});
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: pageRpc });
  const ui = within(slot.container);
  try {
    await ui.findByRole("heading", { name: "Voice sessions" });
    assert.equal(ui.queryByTestId("bb-thread-chat"), null);
    assert.equal(ui.queryByRole("group", { name: "Voice area" }), null);
    fireEvent.click(await ui.findByRole("button", { name: /Session a/ }));
    await ui.findByText("Transcript a");
    act(() => viewWorkspace.open([view("a")]));
    assert.equal(ui.getByTestId("bb-thread-chat").getAttribute("data-thread-id"), "a");
    fireEvent.click(ui.getByRole("button", { name: "Session" }));
    assert.equal(ui.queryByTestId("bb-thread-chat"), null);
    assert.ok(ui.getByText("Transcript a"));
    fireEvent.click(ui.getByRole("button", { name: "Threads (1)" }));
    assert.ok(ui.getByTestId("bb-thread-chat"));
    fireEvent.click(ui.getByRole("button", { name: "Close Thread a" }));
    assert.equal(ui.queryByTestId("bb-thread-chat"), null);
    assert.ok(ui.getByText("Transcript a"));
    assert.equal(stopped.mock.callCount(), 0);
    assert.equal(slot.inspection.navigateCalls.length, 0);
  } finally { slot.lifecycle.unmount(); viewWorkspace.clear(); }
});

test("session selection shows one conversation; coordinator inspection and continuation stay scoped", async(t)=>{
  const start=t.mock.method(voiceAgent,"startConversation",()=>{});
  const stopped=t.mock.method(voiceAgent,"stopFromSurface",()=>{});
  const requested:string[]=[];
  const slot=renderSlot({component:SessionsPanel},{},{rpc:{...pageRpc,
    getVoiceSession:(input:unknown)=>({...pageRpc.getVoiceSession(input),events:[
      {id:1,ts:1000,kind:"user",payload:JSON.stringify({text:"Check work"}),callId:"a"},
      {id:2,ts:1001,kind:"tool.result",payload:JSON.stringify({name:"delegate_to_coordinator",output:"internal handoff text"}),callId:"a"},
      {id:3,ts:1002,kind:"assistant",payload:JSON.stringify({responseId:"answer",text:"Two threads are active."}),callId:"a"},
    ]}),
    getCoordinatorStatus:(input:unknown)=>{requested.push((input as {conversationId:string}).conversationId);return {enabled:true,conversation:{id:"a",coordinatorThreadId:"coord_a",providerId:"codex",model:null,hostId:null,currentCallNonce:null,topic:null,status:"released"},requests:[],questions:[],pendingInteractions:[],watch:[],queuedUpdates:0,recentReplies:[],conversations:[]};},
  }});
  const ui=within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button",{name:/Session a/}));
    await ui.findByText("Two threads are active.");
    assert.equal(start.mock.callCount(),0);
    assert.equal(ui.queryByText("internal handoff text"),null);
    assert.equal(ui.getByRole("tab",{name:"Conversation"}).getAttribute("aria-selected"),"true");
    assert.equal(ui.queryByTestId("bb-thread-chat"),null);
    fireEvent.click(ui.getByRole("tab",{name:"Coordinator"}));
    assert.equal((await ui.findByTestId("bb-thread-chat")).getAttribute("data-thread-id"),"coord_a");
    assert.deepEqual(requested,["a"]);
    fireEvent.click(ui.getByRole("tab",{name:"Conversation"}));
    fireEvent.click(ui.getByRole("button",{name:"Continue this session"}));
    assert.deepEqual(start.mock.calls[0].arguments,["a"]);
    assert.equal(stopped.mock.callCount(),0);
    assert.equal(slot.inspection.navigateCalls.length,0);
  } finally {slot.lifecycle.unmount();}
});
