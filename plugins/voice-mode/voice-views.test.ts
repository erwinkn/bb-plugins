import test from "node:test";
import assert from "node:assert/strict";
import { VoiceAgent, type Bindings } from "./voice-agent.ts";
import { ViewWorkspace } from "./view-workspace.ts";
import { clientDescriptor } from "./client-identity.ts";

type Call = { method: string; args: any };
function fixture(mobile = true) {
  clientDescriptor.mobile = mobile;
  const workspace = new ViewWorkspace();
  const agent = new VoiceAgent(workspace);
  const internal = agent as unknown as {
    nonce: string | null;
    state: string;
    handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>): Promise<void>;
    logQueue: Promise<unknown> | null;
  };
  const calls: Call[] = [];
  const sent: any[] = [];
  const dc = { readyState: "open", send: (text: string) => sent.push(JSON.parse(text)) } as unknown as RTCDataChannel;
  const rpc = { call: async (method: string, args: any) => {
    calls.push({ method, args });
    if (method === "resolveThreadViews") return {
      views: [...new Set(args.threadIds as string[])].map(threadId => ({ kind: "thread", id: `thread:${threadId}`, threadId, projectId: `project-${threadId}`, title: `Title ${threadId}` })),
      preference: "reuse",
    };
    if (method === "runTool") return { output: JSON.stringify(args), status: "success" };
    return { ok: true };
  } } as Bindings["rpc"];
  const base: Bindings = { rpc, context: { threadId: "original", projectId: "original-project", onNewThreadScreen: false }, openNewThread() {} };
  const unbind = agent.bind(base);
  internal.nonce = "call-session";
  internal.state = "live";
  let count = 0;
  const execute = async (name: string, args: Record<string, unknown>) => {
    await internal.handleToolCall(dc, { name, call_id: `tool-${++count}`, arguments: JSON.stringify(args) });
    while (internal.logQueue) await internal.logQueue;
    return calls.filter(call => call.method === "logEvent" && call.args?.kind === "tool.result").at(-1)?.args.payload;
  };
  return { workspace, agent, internal, calls, sent, dc, base, execute, unbind };
}

test("mobile openings use local drawers with correlated tool events", async () => {
  const f = fixture();
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  const result = await f.execute("focus_thread", { thread_id: "a" });
  assert.equal(result.status, "success");
  assert.equal(result.label, "Showed Title a");
  assert.equal(result.presentation, "panel");
  const events = f.calls.filter(call => call.method === "logEvent" && call.args.sessionId === "call-session");
  assert.deepEqual(events.map(event => event.args.kind), ["tool.call", "tool.result"]);
  assert.equal(events[0].args.payload.callId, result.callId);
  assert.deepEqual(events[0].args.payload._id, result._id);
  assert.equal(f.calls.some(call => call.method === "runTool" || call.method === "sendCompanion"), false);
});

test("desktop focus and batch inspection stay inside Voice and keep the call", async () => {
  const f = fixture(false);
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  for (const name of ["focus_thread", "focus_threads"]) {
    const result = await f.execute(name, { thread_id: "a", thread_ids: ["a", "b"] });
    assert.equal(result.status, "success");
    assert.equal(result.presentation, "panel");
  }
  assert.equal(f.workspace.get().views.length, 2);
  await f.execute("manage_views", { action: "clear" });
  assert.equal(f.workspace.get().views.length, 0);
  assert.equal(f.calls.some(call => call.method === "runTool"), false);
  assert.equal(f.internal.state, "live");
});

test("a host rejection, exception, or absent presenter returns an error to the model", async () => {
  for (const reveal of [null, () => false, () => { throw new Error("host crashed"); }]) {
    const f = fixture();
    if (reveal) f.workspace.registerPresenter({ available: () => true, reveal });
    const result = await f.execute("focus_thread", { thread_id: "a" });
    assert.equal(result.status, "error");
    assert.match(result.output, /^Tool error:/);
    assert.equal(f.workspace.get().views.length, 0);
    const response = f.sent.find(message => message.type === "conversation.item.create");
    assert.equal(response.item.output, result.output);
  }
});

test("batch opens, selection, and closing feed the displayed thread into get_context", async () => {
  const f = fixture();
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  const unmount = f.workspace.registerVisiblePanel(() => true);
  await f.execute("focus_threads", { thread_ids: ["a", "b"] });
  await f.execute("manage_views", { action: "select", view_id: "thread:b" });
  let result = await f.execute("get_context", {});
  assert.equal(JSON.parse(result.output).threadId, "b");
  assert.equal(JSON.parse(result.output).projectId, "project-b");
  await f.execute("manage_views", { action: "close", view_id: "thread:b" });
  result = await f.execute("get_context", {});
  assert.equal(JSON.parse(result.output).threadId, "a");
  unmount();
  result = await f.execute("get_context", {});
  assert.equal(JSON.parse(result.output).threadId, "original");
  assert.equal(f.internal.state, "live");
});

test("composer bindings clean up without clobbering a newer binding", async () => {
  const f = fixture();
  const disposeA = f.agent.bind({ ...f.base, context: { ...f.base.context, threadId: "a" } });
  const disposeB = f.agent.bind({ ...f.base, context: { ...f.base.context, threadId: "b" } });
  disposeA();
  assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "b");
  disposeB();
  assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "original");
});

test("voice cannot write into an unrelated composer while another thread is shown", async () => {
  const f = fixture();
  let wrote = false;
  f.agent.bind({ ...f.base, composer: { setText() { wrote = true; }, updateText() { wrote = true; } } });
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  f.workspace.registerVisiblePanel(() => true);
  await f.execute("focus_thread", { thread_id: "a" });
  const result = await f.execute("set_composer_text", { text: "wrong thread" });
  assert.equal(result.status, "error");
  assert.equal(wrote, false);
});

test("stopping during metadata resolution prevents a late open and logs to the original session", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.base.rpc.call = (async (method: string, args: any) => {
    f.calls.push({ method, args });
    if (method === "resolveThreadViews") return new Promise<unknown>(done => { resolve = done; });
    return { ok: true };
  }) as Bindings["rpc"]["call"];
  f.workspace.registerPresenter({ available: () => true, reveal: () => true });
  const pending = f.execute("focus_thread", { thread_id: "a" });
  f.internal.nonce = "new-session";
  resolve({ views: [{ kind: "thread", id: "thread:a", threadId: "a", projectId: null, title: "A" }], preference: "auto" });
  const result = await pending;
  assert.equal(result.status, "error");
  assert.equal(f.workspace.get().views.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls.filter(call => call.args?.kind === "tool.result").at(-1)?.args.sessionId, "call-session");
});


test("page and composer bindings take priority over app-wide fallback through navigation", async () => {
  const f = fixture();
  const page = f.agent.bindFallback({ ...f.base, context: { ...f.base.context, threadId: "page" } });
  const global = f.agent.bindGlobal({ ...f.base, context: { threadId: null, projectId: null, onNewThreadScreen: false } });
  try {
    assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "original");
    f.unbind();
    assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, "page");
    page();
    assert.equal(JSON.parse((await f.execute("get_context", {})).output).threadId, null);
    assert.equal((await f.execute("read_thread", { thread_id: "target" })).status, "success");
  } finally { global(); }
});


test("new work stays in Voice on both clients, with missing prompts asked aloud", async () => {
  for (const mobile of [false, true]) for (const state of ["live", "muted"]) {
    const f = fixture(mobile);
    f.internal.state = state;
    let opened = false;
    f.agent.bind({ ...f.base, openNewThread() { opened = true; } });
    const result = await f.execute("start_thread", { project_id: "p" });
    assert.equal(result.status, "error");
    assert.match(result.output, /Ask the user to dictate/);
    assert.equal(opened, false);
    assert.equal(f.calls.some(call => call.method === "runTool"), false);
    const prompted = await f.execute("start_thread", { project_id: "p", prompt: "Build the page" });
    assert.equal(prompted.status, "success");
    assert.equal(f.calls.find(call => call.method === "runTool")?.args.args.focus, false);
    assert.equal(f.internal.state, state);
  }
});
