// Logical-session UI: New session and Continue semantics, legacy call links,
// scoped live refresh, and the Diagnostics view over raw events.
import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ConversationWork } from "./conversation-work.ts";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, within } = await import("@testing-library/react");
installTestPluginRuntime();
const { voiceAgent } = await import("./voice-agent.ts");
const { nativeUi } = await import("./native-ui.ts");
const { SessionsPanel } = await import("./sessions-panel.tsx");
after(() => dom.window.close());

type Any = any;
const sessionRow = (id: string, extra: Partial<Any> = {}) => ({ id, title: `Session ${id}`, createdAt: 1000, updatedAt: 5000, coordinatorThreadId: `coord_${id}`, callIds: [`call_${id}_1`, `call_${id}_2`], currentCallNonce: null, legacy: false, ...extra });
const userEvent = (id: number, callId: string, text: string) => ({ id, ts: id * 1000, kind: "user", payload: JSON.stringify({ text }), callId });

function baseRpc(sessions: Any[] = [sessionRow("a"), sessionRow("b"), sessionRow("old", { callIds: ["old"], coordinatorThreadId: null, legacy: true })]) {
  const detailCalls: string[] = [];
  const rpc = {
    listVoiceSessions: () => ({ sessions, hasMore: false }),
    listPlugins: () => ({ plugins: [] }),
    requestPresence: () => ({ ok: true }),
    logEvent: () => ({ ok: true }),
    getVoiceSession: (input: unknown) => {
      const { sessionId } = input as { sessionId: string };
      detailCalls.push(sessionId);
      const session = sessions.find((row) => row.id === sessionId || row.callIds.includes(sessionId));
      if (!session) throw new Error("Voice session not found.");
      return { session, events: session.callIds.flatMap((callId: string, index: number) => [userEvent(index * 10 + 1, callId, `Words in ${callId}`)]) };
    },
    getCoordinatorStatus: () => ({ conversation: null, requests: [], questions: [], pendingInteractions: [], watch: [], queuedUpdates: 0, recentReplies: [], conversations: [] }),
  };
  return { rpc, detailCalls };
}

function callControl(t: TestContext) {
  const call = voiceAgent as unknown as { state: "idle" | "connecting" | "live" | "muted"; logicalConversationId: string | null; emitChange(): void };
  const setState = (state: typeof call.state, conversationId: string | null = call.logicalConversationId) => { call.state = state; call.logicalConversationId = conversationId; call.emitChange(); };
  t.after(() => setState("idle", null));
  return { call, setState };
}

test("New session starts a fresh logical session and selects it once the call reports its id", async (t) => {
  const { setState } = callControl(t);
  const start = t.mock.method(voiceAgent, "startConversation", (id?: string) => { assert.equal(id, undefined); setState("connecting"); });
  t.mock.method(voiceAgent, "getSessionId", () => "call_new_1");
  const { rpc } = baseRpc([sessionRow("a")]);
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...rpc,
    getVoiceSession: (input: unknown) => ({ session: sessionRow("fresh", { callIds: ["call_new_1"] }), events: [userEvent(1, "call_new_1", `Hello from ${(input as { sessionId: string }).sessionId}`)] }),
  } });
  const ui = within(slot.container);
  try {
    await ui.findByRole("button", { name: /Session a/ });
    fireEvent.click(ui.getByRole("button", { name: "New session" }));
    assert.equal(start.mock.callCount(), 1);
    // Selecting a row never starts anything; the call itself announces the session.
    assert.ok(ui.getByRole("heading", { name: "Voice sessions" }));
    act(() => setState("live", "fresh"));
    await ui.findByText("Hello from fresh");
    assert.ok(ui.getByText("Live now", { exact: false }));
    assert.equal(ui.queryByRole("button", { name: "Continue this session" }), null, "a live session offers no Continue");
    assert.equal(ui.queryByRole("button", { name: "See full transcript" }), null, "the live session is already on screen");
  } finally { slot.lifecycle.unmount(); }
});

test("Continue is refused while another call is active and never selects or replays work by itself", async (t) => {
  const { setState } = callControl(t);
  const start = t.mock.method(voiceAgent, "startConversation", () => {});
  const { rpc, detailCalls } = baseRpc();
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc });
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button", { name: /Session b/ }));
    await ui.findByText("Words in call_b_1");
    assert.deepEqual(detailCalls, ["b"]);
    assert.equal(start.mock.callCount(), 0, "selecting a session starts nothing");
    act(() => setState("live", "a"));
    fireEvent.click(ui.getByRole("button", { name: "Continue this session" }));
    assert.equal(start.mock.callCount(), 0, "no session switch while a call is active");
    act(() => setState("idle", null));
    fireEvent.click(ui.getByRole("button", { name: "Continue this session" }));
    assert.deepEqual(start.mock.calls[0].arguments, ["b"]);
    assert.equal(detailCalls.length, 1, "Continue does not refetch or replay the session");
  } finally { slot.lifecycle.unmount(); }
});

test("older physical call ids still open their session, and a legacy call has no coordinator", async (t) => {
  const { setState } = callControl(t);
  t.mock.method(voiceAgent, "getSessionId", () => "call_a_2");
  const { rpc, detailCalls } = baseRpc();
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc });
  const ui = within(slot.container);
  try {
    await ui.findByRole("button", { name: /Session a/ });
    // A live call on an older client reports only its physical id; it resolves to session a.
    act(() => setState("live", null));
    fireEvent.click(ui.getByRole("button", { name: "See full transcript" }));
    await ui.findByText("Words in call_a_1");
    assert.equal(detailCalls.at(-1), "a");
    assert.ok(ui.getByText("2 calls", { exact: false }));
    fireEvent.click(ui.getByRole("button", { name: /All sessions/ }));
    act(() => setState("idle", null));
    fireEvent.click(await ui.findByRole("button", { name: /Session old/ }));
    await ui.findByText("Words in old");
    assert.ok(ui.getByText("single call", { exact: false }));
    assert.equal(ui.queryByRole("option",{name:"Coordinator history"}),null);
    assert.equal(ui.queryByRole("button",{name:"Coordinator history"}),null);
    assert.equal(ui.queryByTestId("bb-thread-chat"), null);
  } finally { slot.lifecycle.unmount(); }
});

test("Diagnostics shows raw events with call boundaries; live log signals refresh only the selected session", async () => {
  const { rpc, detailCalls } = baseRpc();
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...rpc,
    getVoiceSession: (input: unknown) => {
      const base = rpc.getVoiceSession(input);
      return { ...base, events: [...base.events,
        { id: 98, ts: 98_000, kind: "tool.call", payload: JSON.stringify({ name: "delegate_to_coordinator", args: { request: "internal words" }, callId: "t1" }), callId: "call_a_2" },
        { id: 99, ts: 99_000, kind: "tool.result", payload: JSON.stringify({ name: "delegate_to_coordinator", output: "Handoff r_1 recorded", status: "success", callId: "t1" }), callId: "call_a_2" },
      ] };
    },
  } });
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button", { name: /Session a/ }));
    await ui.findByText("Words in call_a_1");
    assert.equal(ui.queryByText(/internal words/), null, "the conversation hides handoffs");
    const nav = within(ui.getByRole("navigation", { name: "Session navigation" }));
    assert.ok(nav.getByRole("button", { name: "All sessions" }).querySelector("svg"));
    assert.deepEqual(nav.getAllByRole("option").map(option => option.textContent), ["Conversation", "Tasks", "Coordinator history", "Diagnostics"]);
    assert.equal(nav.queryByRole("tablist"), null);
    const controls = within(ui.getByRole("region", { name: "Voice session controls" }));
    fireEvent.click(controls.getByRole("button", { name: "Diagnostics" }));
    assert.ok(ui.getByRole("separator", { name: "Call 1" }));
    assert.ok(ui.getByRole("separator", { name: "Call 2" }));
    assert.ok(ui.getByText("Handed off to the coordinator"));
    assert.match(ui.getByRole("region", { name: "Session content" }).textContent ?? "", /internal words/, "Diagnostics keeps the raw record");
    assert.ok(ui.getByRole("group", { name: "Transcript filters" }));
    const before = detailCalls.length;
    await slot.behavior.emitRealtime("aide-log", { sessionId: "call_zzz" });
    assert.equal(detailCalls.length, before, "another session's call does not refetch this one");
    await slot.behavior.emitRealtime("aide-log", { sessionId: "call_a_2" });
    assert.equal(detailCalls.length, before + 1);
    assert.equal((ui.getByRole("combobox", { name: "Session view" }) as HTMLSelectElement).value, "diagnostics", "a refresh keeps the current view");
    fireEvent.click(controls.getByRole("button", { name: "Conversation" }));
    assert.equal(controls.getByRole("button", { name: "Conversation" }).getAttribute("aria-current"), "page");
    assert.equal(ui.queryByText(/internal words/), null, "the picker returns to the conversation");
  } finally { slot.lifecycle.unmount(); }
});

test("the Voice page shows only a read-only coordinator history with no work controls", async () => {
  const { rpc } = baseRpc();
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...rpc,
    getCoordinatorStatus: () => ({ conversation: { id: "a", status: "active", coordinatorThreadId: "coord_a", providerId: "p", model: "m", hostId: null, currentCallNonce: null, topic: null, discussedThreadId: null }, requests: [], questions: [], pendingInteractions: [{ id: "i1", threadId: "thr_work", title: "Needs approval", kind: "permission" }], watch: [{ threadId: "thr_watched", reason: "started by voice", addedAt: 1 }], queuedUpdates: 0, recentReplies: [], conversations: [] }),
  } });
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button", { name: /Session a/ }));
    await ui.findByText("Words in call_a_1");
    assert.equal(ui.queryByRole("group", { name: "Voice area" }), null, "no Session/Threads switcher");
    fireEvent.change(ui.getByRole("combobox", { name: "Session view" }), { target: { value: "coordinator" } });
    const coordinator = within(await ui.findByRole("region", { name: "Coordinator history" }));
    assert.equal(coordinator.queryAllByRole("button").length,0);
    assert.deepEqual(slot.inspection.sidebarActionCalls,[]);
    assert.equal(slot.inspection.rpcCalls.some(call=>call.method==="getCoordinatorStatus"),false);
    assert.equal(slot.inspection.rpcCalls.some(call => call.method === "resolveThreadViews"), false);
    assert.deepEqual(ui.queryAllByTestId("bb-thread-chat").map(node => node.getAttribute("data-thread-id")), ["coord_a"], "only coordinator debugging is embedded");
  } finally { slot.lifecycle.unmount(); }
});

test("show_voice selects the current call's conversation through the panel binding, also from a debug view", async (t) => {
  const connected = nativeUi.transportConnected();
  nativeUi.setTransportConnected(true);
  t.after(() => nativeUi.setTransportConnected(connected));
  t.after(nativeUi.bind({
    kind: "app",
    context: () => ({ threadId: null, projectId: null }),
    route: () => "/plugins/voice-mode/sessions",
    navigate: { toProject: () => assert.fail("unexpected project navigation"), toPluginPanel: () => assert.fail("mounted panel needs no navigation") },
    threads: { open: () => assert.fail("unexpected thread navigation"), openNewThread: () => assert.fail("unexpected composer navigation") },
  }));
  const showVoice = async () => {
    let result!: Awaited<ReturnType<typeof nativeUi.execute>>;
    await act(async () => { result = await nativeUi.execute({ kind: "show_voice" }, () => true); });
    return result;
  };
  const { setState } = callControl(t);
  t.mock.method(voiceAgent, "getSessionId", () => "call_a_2");
  const { rpc } = baseRpc();
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc });
  const ui = within(slot.container);
  try {
    await ui.findByRole("button", { name: /Session a/ });
    // No current call: the panel reports it cannot show a conversation.
    let result = await showVoice();
    assert.equal(result.status, "failed");
    assert.match(result.detail, /no current conversation/);
    assert.ok(ui.getByRole("heading", { name: "Voice sessions" }), "the list stays");
    act(() => setState("live", "a"));
    result = await showVoice();
    assert.equal(result.status, "succeeded");
    await ui.findByText("Words in call_a_1");
    assert.equal((ui.getByRole("combobox", { name: "Session view" }) as HTMLSelectElement).value, "conversation");
    // From the Diagnostics view, show_voice returns to the conversation.
    fireEvent.change(ui.getByRole("combobox", { name: "Session view" }), { target: { value: "diagnostics" } });
    result = await showVoice();
    assert.equal(result.status, "succeeded");
    assert.equal((ui.getByRole("combobox", { name: "Session view" }) as HTMLSelectElement).value, "conversation");
    assert.equal(slot.inspection.navigateCalls.length, 0, "a mounted panel needs no navigation");
  } finally { slot.lifecycle.unmount(); }
});

test("arriving on the conversation sub-path shows the live conversation without a click", async (t) => {
  const { setState } = callControl(t);
  t.mock.method(voiceAgent, "getSessionId", () => "call_b_1");
  setState("live", "b");
  const { rpc } = baseRpc();
  const slot = renderSlot({ component: SessionsPanel }, { subPath: "conversation" }, { rpc });
  const ui = within(slot.container);
  try {
    await ui.findByText("Words in call_b_1");
    assert.ok(ui.getByText("Live now", { exact: false }));
  } finally { slot.lifecycle.unmount(); }
});

test("live transcript text grows in place and a durable final replaces it without a duplicate", async () => {
  const row = sessionRow("stream", {callIds:["stream-call"],currentCallNonce:"stream-call"});
  const {rpc} = baseRpc([row]);
  let events: Any[] = [];
  const slot = renderSlot({component:SessionsPanel}, {}, {rpc:{...rpc,
    getLiveTranscript:()=>({callNonce:null,revision:0,items:[]}),
    getVoiceSession:()=>({session:row,events}),
  }});
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button",{name:/Session stream/}));
    await ui.findByText("Your conversation will appear here as you speak.");
    const snapshot = (revision:number,text:string)=>({callNonce:"stream-call",revision,items:[{key:"user:u",kind:"user",ts:100,payload:{itemId:"u",text,partial:true}}]});
    await slot.behavior.emitRealtime("voice-transcript",snapshot(1,"Inspect"));
    const first = (await ui.findByText("Inspect")).closest("[data-message-id]");
    await slot.behavior.emitRealtime("voice-transcript",snapshot(2,"Inspect this session"));
    assert.equal((await ui.findByText("Inspect this session")).closest("[data-message-id]"),first);
    await slot.behavior.emitRealtime("voice-transcript",snapshot(1,"Old text"));
    assert.equal(ui.queryByText("Old text"),null);
    await slot.behavior.emitRealtime("voice-transcript",{callNonce:"stream-call",revision:3,items:[]});
    assert.ok(ui.getByText("Inspect this session"),"final delivery gap keeps the draft visible");
    events=[{id:1,ts:100,kind:"user",callId:"stream-call",payload:JSON.stringify({itemId:"u",text:"Inspect the transcript for this session."})}];
    await slot.behavior.emitRealtime("aide-log",{sessionId:"stream-call"});
    assert.equal((await ui.findByText("Inspect the transcript for this session.")).closest("[data-message-id]"),first);
    assert.equal(slot.container.querySelectorAll("[data-message-id]").length,1);
    assert.equal(slot.container.querySelectorAll('[aria-label="Streaming"]').length,0);
  } finally {slot.lifecycle.unmount();}
});

const taskWork = (): ConversationWork => ({tasks:[
  {op_id:"op-review",thread_id:"work-review",title:"Review mobile layout",kind:"worker",profile:"review",status:"turn_ended",last_text:"Checked the narrow layout.",updated_at:2000,truncated:false},
  {op_id:"op-spawn",thread_id:null,title:"Prepare release notes",kind:"thread",profile:null,status:"spawning",last_text:null,updated_at:3000},
],subscriptions:[{thread_id:"work-review",root_thread_id:"work-review",state:"disabled",updated_at:2000},{thread_id:"other-watch",root_thread_id:"other-watch",state:"active",updated_at:2000}],asOf:4000});

test("Tasks view renders live RPC rows, opens a thread, and refreshes only while mounted",async t=>{
  const {setState}=callControl(t);t.mock.method(voiceAgent,"getSessionId",()=>"live-call");
  const open=t.mock.method(nativeUi,"execute",async()=>({status:"succeeded" as const,detail:"Opened"}));
  let work=taskWork(),reads=0;const {rpc}=baseRpc([sessionRow("live",{callIds:["live-call"],currentCallNonce:"live-call",coordinatorThreadId:null})]);
  setState("live","live");
  const slot=renderSlot({component:SessionsPanel},{},{rpc:{...rpc,
    listLiveTasks:(input:unknown)=>{assert.deepEqual(input,{nonce:"live-call",conversationId:"live"});reads++;return {items:work.tasks,asOf:work.asOf};},
    listLiveSubscriptions:()=>({items:work.subscriptions,asOf:work.asOf}),
  }});const ui=within(slot.container);
  try{
    await ui.findByText("Words in live-call");fireEvent.change(ui.getByRole("combobox",{name:"Session view"}),{target:{value:"tasks"}});
    await ui.findByRole("button",{name:"Open Review mobile layout"});assert.ok(ui.getByText("Turn ended"));assert.ok(ui.getByText("Muted"));assert.ok(ui.getByText("Active"));
    assert.equal((ui.getByRole("button",{name:"Open Prepare release notes"}) as HTMLButtonElement).disabled,true);
    fireEvent.click(ui.getByRole("button",{name:"Open Review mobile layout"}));await act(async()=>{await Promise.resolve();});
    assert.deepEqual(open.mock.calls[0].arguments[0],{kind:"open_thread",threadId:"work-review",split:false});
    work={...work,tasks:work.tasks.map(task=>({...task,last_text:"Fresh result"}))};
    await slot.behavior.emitRealtime("aide-log",{sessionId:"live-call"});await ui.findAllByText("Fresh result");assert.ok(reads>=2);
    fireEvent.change(ui.getByRole("combobox",{name:"Session view"}),{target:{value:"diagnostics"}});
    const before=reads;await slot.behavior.emitRealtime("aide-log",{sessionId:"live-call"});assert.equal(reads,before);
    assert.equal(ui.queryByRole("option",{name:"Coordinator history"}),null);
  }finally{slot.lifecycle.unmount();}
});

test("ended sessions show saved tasks without using a call nonce or starting a call",async t=>{
  const start=t.mock.method(voiceAgent,"startConversation",()=>{});const {rpc}=baseRpc([sessionRow("ended",{coordinatorThreadId:null})]);
  const slot=renderSlot({component:SessionsPanel},{},{rpc:{...rpc,getVoiceSession:(input:unknown)=>({...rpc.getVoiceSession(input),work:taskWork()})}});const ui=within(slot.container);
  try{fireEvent.click(await ui.findByRole("button",{name:/Session ended/}));await ui.findByText("Words in call_ended_1");fireEvent.click(ui.getByRole("button",{name:"Tasks"}));
    await ui.findByText("Checked the narrow layout.");assert.equal(start.mock.callCount(),0);assert.equal(slot.inspection.rpcCalls.some(call=>call.method==="listLiveTasks"),false);
  }finally{slot.lifecycle.unmount();}
});

for(const width of [390,1200])test(`Tasks layout constrains long content at ${width}px`,async()=>{
  const {rpc}=baseRpc([sessionRow("narrow",{coordinatorThreadId:null})]);const work=taskWork();work.tasks[0].title="Long".repeat(120);work.tasks[0].last_text="unbroken".repeat(1000);
  const slot=renderSlot({component:SessionsPanel},{},{rpc:{...rpc,getVoiceSession:(input:unknown)=>({...rpc.getVoiceSession(input),work})}});slot.container.style.width=`${width}px`;const ui=within(slot.container);
  try{fireEvent.click(await ui.findByRole("button",{name:/Session narrow/}));await ui.findByText("Words in call_narrow_1");fireEvent.click(ui.getByRole("button",{name:"Tasks"}));
    const tasks=await ui.findByRole("region",{name:"Conversation tasks"});assert.ok(tasks.classList.contains("min-w-0"));
    const title=ui.getByRole("button",{name:`Open ${work.tasks[0].title}`});assert.ok(title.classList.contains("[overflow-wrap:anywhere]"));
    const output=tasks.querySelector("pre")!;assert.ok(output.classList.contains("whitespace-pre-wrap"));assert.ok(output.textContent!.length<=6000);
    assert.ok(ui.getByRole("navigation",{name:"Session views"}).classList.contains("grid-cols-2"));assert.ok(ui.getByRole("navigation",{name:"Session views"}).classList.contains("@lg:flex"));
  }finally{slot.lifecycle.unmount();}
});

test("Tasks polling runs every ten seconds only while the view and document are visible",async t=>{
  const {TasksView}=await import("./tasks-view.tsx");t.mock.timers.enable({apis:["setInterval"]});
  let reads=0;const work=taskWork();const slot=renderSlot({component:TasksView},{conversationId:"poll",nonce:"call"},{rpc:{
    listLiveTasks:()=>{reads++;return {items:work.tasks,asOf:work.asOf};},listLiveSubscriptions:()=>({items:work.subscriptions,asOf:work.asOf}),
  }});const ui=within(slot.container);
  try{
    await ui.findByText("Checked the narrow layout.");assert.equal(reads,1);
    await act(async()=>{t.mock.timers.tick(10000);await Promise.resolve();});assert.equal(reads,2);
    Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});
    await act(async()=>{t.mock.timers.tick(10000);await Promise.resolve();});assert.equal(reads,2);
    Object.defineProperty(document,"visibilityState",{value:"visible",configurable:true});
    await act(async()=>{document.dispatchEvent(new dom.window.Event("visibilitychange"));await Promise.resolve();});assert.equal(reads,3);
  }finally{slot.lifecycle.unmount();delete (document as any).visibilityState;}
  await act(async()=>{t.mock.timers.tick(10000);await Promise.resolve();});assert.equal(reads,3);
});

test("call-end presence switches Tasks from live RPCs to saved session state",async t=>{
  const {setState}=callControl(t);let nonce:string|null="closing-call";t.mock.method(voiceAgent,"getSessionId",()=>nonce);
  const session=sessionRow("closing",{callIds:["closing-call"],currentCallNonce:nonce,coordinatorThreadId:null});const {rpc}=baseRpc([session]);let reads=0;const work=taskWork();setState("live","closing");
  const slot=renderSlot({component:SessionsPanel},{},{rpc:{...rpc,getVoiceSession:(input:unknown)=>({...rpc.getVoiceSession(input),work}),
    listLiveTasks:()=>{reads++;return {items:work.tasks,asOf:work.asOf};},listLiveSubscriptions:()=>({items:work.subscriptions,asOf:work.asOf}),
  }});const ui=within(slot.container);
  try{await ui.findByText("Words in closing-call");fireEvent.click(ui.getByRole("button",{name:"Tasks"}));await ui.findByText("Checked the narrow layout.");
    const before=reads;session.currentCallNonce=null;nonce=null;act(()=>setState("idle",null));await slot.behavior.emitRealtime("voice-presence",{nonce:"closing-call",phase:"idle"});
    await ui.findByText(/Saved state checked/);assert.equal(reads,before);assert.equal(ui.queryByRole("alert"),null);
  }finally{slot.lifecycle.unmount();}
});
