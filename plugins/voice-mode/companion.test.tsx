import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent, within } from "@testing-library/react";
import { viewWorkspace, type ThreadView } from "./view-workspace.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
installTestPluginRuntime();
const { CompanionTab } = await import("./companion.tsx");
const { voiceAgent } = await import("./voice-agent.ts");
const { LiveCallControls } = await import("./voice-chrome.tsx");
const { SessionsPanel } = await import("./sessions-panel.tsx");
after(() => dom.window.close());
const view = (id: string): ThreadView => ({ kind: "thread", id: `thread:${id}`, threadId: id, projectId: "project", title: `Thread ${id}` });

test("the mobile switcher changes the shown thread; closing only removes the requested view", () => {
  viewWorkspace.clear();
  const unregister = viewWorkspace.registerPresenter({ available: () => true, reveal: () => true });
  const slot = renderSlot({ component: CompanionTab }, {});
  try {
    assert.match(slot.container.textContent ?? "", /all your running threads/);
    act(() => viewWorkspace.open([view("a"), view("b")], "new", "reuse"));
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
  viewWorkspace.open([view("a"), view("b")], "new", "reuse");
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
    act(() => viewWorkspace.open([view("a"), view("b")], "new", "reuse"));
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

const sessionRow = (id: string) => ({ id, startedAt: 1000, lastEventAt: 5000, events: 2, ended: true, costUsd: 0, preview: `Session ${id}`, hasError: false, device: null });
const pageRpc = {
  listSessions: () => ({ sessions: [sessionRow("a"), sessionRow("b")], hasMore: false }),
  listPlugins: () => ({ plugins: [] }),
  requestPresence: () => ({ ok: true }),
  logEvent: () => ({ ok: true }),
  getSessionEvents: (input: unknown) => ({ events: [{ id: 1, ts: 1000, kind: "user", payload: JSON.stringify({ text: `Transcript ${(input as { sessionId: string }).sessionId}` }) }] }),
};

test("session creation is above history; call controls only show during a call", async (t) => {
  const call = voiceAgent as unknown as { state: "idle" | "connecting" | "live" | "muted"; emitChange(): void };
  const setState = (state: typeof call.state) => { call.state = state; call.emitChange(); };
  const start = t.mock.method(voiceAgent, "toggleFromSurface", () => setState("connecting"));
  const stop = t.mock.method(voiceAgent, "stopFromSurface", () => setState("idle"));
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: pageRpc });
  const ui = within(slot.container);
  try {
    const row = await ui.findByRole("button", { name: /Session a/ });
    const startButton = ui.getByRole("button", { name: "New session" });
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
    fireEvent.click(ui.getByRole("button", { name: "Errors" }));
    assert.equal(ui.getByRole("button", { name: "Errors" }).getAttribute("aria-pressed"), "true");
    assert.ok(ui.getByText("No sessions match."));
    fireEvent.click(ui.getByRole("button", { name: "Clear filters" }));
    assert.equal(ui.getByRole("button", { name: "Errors" }).getAttribute("aria-pressed"), "false");
    assert.ok(ui.getByRole("button", { name: /Session a/ }));
  } finally { slot.lifecycle.unmount(); }
});

test("switching transcripts rejects late results and shows retryable errors", async () => {
  let resolveA!: (result: ReturnType<typeof pageRpc.getSessionEvents>) => void;
  let failB = true;
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...pageRpc,
    getSessionEvents: (input: unknown) => {
      const { sessionId } = input as { sessionId: string };
      if (sessionId === "a") return new Promise(resolve => { resolveA = resolve; });
      if (failB) throw new Error("Transcript unavailable");
      return pageRpc.getSessionEvents({ sessionId });
    },
  } });
  const ui = within(slot.container);
  try {
    fireEvent.click(await ui.findByRole("button", { name: /Session a/ }));
    await ui.findByText("Loading transcript…");
    fireEvent.click(ui.getByRole("button", { name: /All sessions/ }));
    fireEvent.click(ui.getByRole("button", { name: /Session b/ }));
    await ui.findByRole("alert");
    await act(async () => resolveA(pageRpc.getSessionEvents({ sessionId: "a" })));
    assert.equal(ui.queryByText("Transcript a"), null);
    failB = false;
    fireEvent.click(ui.getByRole("button", { name: "Retry transcript" }));
    await ui.findByText("Transcript b");
    fireEvent.click(ui.getByRole("button", { name: "Conversation" }));
    assert.equal(ui.getByRole("button", { name: "Conversation" }).getAttribute("aria-pressed"), "true");
  } finally { slot.lifecycle.unmount(); }
});

test("a failed session list shows a retry instead of endless loading", async () => {
  let fail = true;
  const slot = renderSlot({ component: SessionsPanel }, {}, { rpc: { ...pageRpc,
    listSessions: () => {
      if (fail) throw new Error("History unavailable");
      return { sessions: [], hasMore: false };
    },
  } });
  const ui = within(slot.container);
  try {
    await ui.findByRole("alert");
    assert.equal(ui.queryByText("Loading sessions…"), null);
    fail = false;
    fireEvent.click(ui.getByRole("button", { name: "Retry sessions" }));
    await ui.findByText("No voice sessions yet");
    assert.ok(ui.getByRole("button", { name: "New session" }));
  } finally { slot.lifecycle.unmount(); }
});
