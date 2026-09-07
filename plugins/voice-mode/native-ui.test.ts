// The native UI controller: it drives bb only through the bound SDK surfaces,
// re-checks call ownership at every step, reports what it could observe and
// nothing more, and never sends a draft.
import test from "node:test";
import assert from "node:assert/strict";
import { NativeUi, type NativeUiAppBinding, type NativeUiComposerBinding } from "./native-ui.ts";
import type { PluginComposerScope } from "@get-bb/plugin-sdk/app";
import type { UiAction } from "./ui-actions.ts";

/** A fake bb window: route state plus recorders for every SDK call. */
function fakeApp(initial: { threadId?: string | null; projectId?: string | null; route?: string } = {}) {
  const state = { threadId: initial.threadId ?? null, projectId: initial.projectId ?? null, route: initial.route ?? "/" };
  const calls: unknown[] = [];
  const binding: NativeUiAppBinding = {
    kind: "app",
    context: () => ({ threadId: state.threadId, projectId: state.projectId }),
    route: () => state.route,
    navigate: {
      toProject: (projectId) => { calls.push({ method: "toProject", projectId }); },
      toPluginPanel: (path, options) => { calls.push({ method: "toPluginPanel", path, options }); },
    },
    threads: {
      open: (threadId, options) => { calls.push({ method: "open", threadId, options }); },
      openNewThread: (options) => { calls.push({ method: "openNewThread", options }); },
    },
  };
  return { binding, state, calls };
}

function fakeComposer(initialScope: PluginComposerScope, text = "", run = { isRunning: false, isSubmitting: false }) {
  const draft = { text, attachmentCount: 0, get isEmpty() { return draft.text.length === 0; } };
  let scope = initialScope;
  const previews: unknown[] = [];
  let previewAccepted = true;
  const binding: NativeUiComposerBinding = {
    kind: "composer",
    view: () => ({ scope, draft, run }),
    composer: {
      setText: (next) => { draft.text = next; },
      updateText: (updater) => { draft.text = updater(draft.text); },
    },
    openFilePreview: (options) => { previews.push(options); return previewAccepted; },
  };
  return { binding, draft, previews, setScope: (next: PluginComposerScope) => { scope = next; }, setPreviewAccepted: (value: boolean) => { previewAccepted = value; } };
}

const voicePanel = (showConversation: (id: string | null) => boolean, openFilePreview: (options: unknown) => boolean = () => false) =>
  ({ kind: "voice-panel", showConversation, openFilePreview } as const);

const fast = () => new NativeUi({ readyTimeoutMs: 120, pollMs: 5 });
const current = () => true;

test("snapshot reports the route selection, the mounted composers and the matching draft", () => {
  const ui = fast();
  assert.deepEqual(ui.snapshot(), { threadId: null, projectId: null, onNewThreadScreen: false, route: "", composers: [], draft: null, bound: false });
  const app = fakeApp({ threadId: "thr_a", projectId: "proj_1", route: "/threads/thr_a" });
  ui.bind(app.binding);
  const a = fakeComposer({ kind: "thread", threadId: "thr_a" }, "hello");
  const b = fakeComposer({ kind: "thread", threadId: "thr_b" });
  const disposeA = ui.bind(a.binding);
  ui.bind(b.binding);
  let snapshot = ui.snapshot();
  assert.equal(snapshot.bound, true);
  assert.equal(snapshot.threadId, "thr_a");
  assert.equal(snapshot.projectId, "proj_1");
  assert.equal(snapshot.composers.length, 2);
  assert.deepEqual(snapshot.draft, { scope: { kind: "thread", threadId: "thr_a" }, text: "hello", isRunning: false });
  disposeA();
  assert.equal(ui.snapshot().draft, null);
  // The New thread screen: no route thread, a new-thread composer with its project.
  app.state.threadId = null; app.state.projectId = null;
  ui.bind(fakeComposer({ kind: "new-thread", projectId: "proj_2" }).binding);
  snapshot = ui.snapshot();
  assert.equal(snapshot.onNewThreadScreen, true);
  assert.equal(snapshot.projectId, "proj_2");
});

test("execute refuses when this window does not own the call or nothing is bound", async () => {
  const ui = fast();
  assert.equal((await ui.execute({ kind: "show_voice" }, () => false)).status, "cancelled");
  assert.equal((await ui.execute({ kind: "show_voice" }, current)).status, "failed");
});

test("open_thread goes through the sidebar action and succeeds only once the thread is observed", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_old" });
  ui.bind(app.binding);
  const pending = ui.execute({ kind: "open_thread", threadId: "thr_new", split: false }, current);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(app.calls, [{ method: "open", threadId: "thr_new", options: { split: false } }]);
  app.state.threadId = "thr_new";
  const result = await pending;
  assert.equal(result.status, "succeeded");
  assert.match(result.detail, /now the current thread/);
  // Unknown thread: bb ignores the open, the route never changes.
  const missing = await ui.execute({ kind: "open_thread", threadId: "thr_missing", split: false }, current);
  assert.equal(missing.status, "unknown");
});

test("open_thread cancels when the call moves on or the user goes elsewhere, and never navigates back", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_old" });
  ui.bind(app.binding);
  let owned = true;
  const pending = ui.execute({ kind: "open_thread", threadId: "thr_new", split: false }, () => owned);
  owned = false;
  assert.equal((await pending).status, "cancelled");
  const elsewhere = ui.execute({ kind: "open_thread", threadId: "thr_new", split: false }, current);
  app.state.threadId = "thr_third";
  const result = await elsewhere;
  assert.equal(result.status, "cancelled");
  assert.match(result.detail, /somewhere else/);
  assert.equal(app.calls.filter(call => (call as { method: string }).method === "open").length, 2);
});

test("open_thread claims a split only when both threads' composers are mounted", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  ui.bind(fakeComposer({ kind: "thread", threadId: "thr_a" }).binding);
  const pending = ui.execute({ kind: "open_thread", threadId: "thr_b", split: true }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  ui.bind(fakeComposer({ kind: "thread", threadId: "thr_b" }).binding);
  const split = await pending;
  assert.equal(split.status, "succeeded");
  assert.match(split.detail, /in a split/);
  // Compact viewport fallback: bb replaces the view instead. No split claim.
  const compact = fast();
  const app2 = fakeApp({ threadId: "thr_a" });
  compact.bind(app2.binding);
  const fallback = compact.execute({ kind: "open_thread", threadId: "thr_b", split: true }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  app2.state.threadId = "thr_b";
  const result = await fallback;
  assert.equal(result.status, "succeeded");
  assert.doesNotMatch(result.detail, /in a split/);
  assert.match(result.detail, /did not confirm a split/);
  // Already shown: bb focuses the existing pane through the same native open.
  const again = await ui.execute({ kind: "open_thread", threadId: "thr_b", split: true }, current);
  assert.equal(again.status, "succeeded");
  assert.match(again.detail, /focused/);
  assert.equal(app.calls.length, 2);
});

test("open_project waits for the project route and reports unknown when it never arrives", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a", projectId: "proj_1" });
  ui.bind(app.binding);
  const pending = ui.execute({ kind: "open_project", projectId: "proj_2" }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  app.state.projectId = "proj_2"; app.state.threadId = null;
  assert.equal((await pending).status, "succeeded");
  assert.deepEqual(app.calls, [{ method: "toProject", projectId: "proj_2" }]);
  assert.equal((await ui.execute({ kind: "open_project", projectId: "proj_2" }, current)).detail, "Project proj_2 is already open.");
  assert.equal((await ui.execute({ kind: "open_project", projectId: "proj_nope" }, current)).status, "unknown");
});

test("prepare_draft appends by default, replaces only on an explicit replace, and never sends", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  const composer = fakeComposer({ kind: "thread", threadId: "thr_a" }, "keep this");
  ui.bind(composer.binding);
  const target = { kind: "thread", threadId: "thr_a" } as const;
  const appended = await ui.execute({ kind: "prepare_draft", target, text: "and this", mode: "append" }, current);
  assert.equal(appended.status, "succeeded");
  assert.match(appended.detail, /not sent/);
  assert.equal(composer.draft.text, "keep this\nand this");
  const replaced = await ui.execute({ kind: "prepare_draft", target, text: "only this", mode: "replace" }, current);
  assert.equal(replaced.status, "succeeded");
  assert.equal(composer.draft.text, "only this");
  assert.equal((await ui.execute({ kind: "prepare_draft", target, text: "   ", mode: "append" }, current)).status, "failed");
  assert.equal(app.calls.length, 0, "no navigation when the composer is already mounted");
});

test("prepare_draft targets exactly one scope: queued edits and side chats are protected", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  const queued = fakeComposer({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "q1" }, "queued text");
  ui.bind(queued.binding);
  const other = fakeComposer({ kind: "thread", threadId: "thr_b" }, "other thread");
  ui.bind(other.binding);
  const result = await ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_a" }, text: "new", mode: "append" }, current);
  assert.equal(result.status, "failed");
  assert.match(result.detail, /queued message/);
  assert.equal(queued.draft.text, "queued text");
  assert.equal(other.draft.text, "other thread");
  assert.equal(app.calls.length, 0);
  const side = fakeComposer({ kind: "side-chat", projectId: "p", parentThreadId: "thr_c", tabId: "t", childThreadId: null }, "side");
  ui.bind(side.binding);
  const sideResult = await ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_c" }, text: "new", mode: "replace" }, current);
  assert.equal(sideResult.status, "failed");
  assert.match(sideResult.detail, /side chat/);
  assert.equal(side.draft.text, "side");
});

test("prepare_draft opens the target thread on request and waits for its composer, cancelling on hangup", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  const pending = ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_b" }, text: "hi", mode: "append" }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(app.calls, [{ method: "open", threadId: "thr_b", options: undefined }]);
  app.state.threadId = "thr_b";
  const composer = fakeComposer({ kind: "thread", threadId: "thr_b" });
  ui.bind(composer.binding);
  assert.equal((await pending).status, "succeeded");
  assert.equal(composer.draft.text, "hi");
  // A hang-up mid-wait leaves the draft untouched.
  let owned = true;
  const late = ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_c" }, text: "late", mode: "append" }, () => owned);
  await new Promise(resolve => setTimeout(resolve, 10));
  owned = false;
  const c = fakeComposer({ kind: "thread", threadId: "thr_c" });
  ui.bind(c.binding);
  assert.equal((await late).status, "cancelled");
  assert.equal(c.draft.text, "");
  // Never reachable: a bounded failure, no manual instruction.
  const timeout = await ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_z" }, text: "x", mode: "append" }, current);
  assert.equal(timeout.status, "failed");
  assert.match(timeout.detail, /try again/);
});

test("prepare_draft for a new thread reuses the mounted new-thread composer or opens it, keyed by project", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  // Starting from a thread must not abort just because that thread is current.
  const pending = ui.execute({ kind: "prepare_draft", target: { kind: "new", projectId: "proj_2" }, text: "plan it", mode: "append" }, current);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(app.calls, [{ method: "openNewThread", options: { projectId: "proj_2", focusPrompt: false } }]);
  app.state.threadId = null;
  const wrongProject = fakeComposer({ kind: "new-thread", projectId: "proj_1" });
  const disposeWrong = ui.bind(wrongProject.binding);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(wrongProject.draft.text, "", "a composer selecting another project is not the target");
  disposeWrong();
  const right = fakeComposer({ kind: "new-thread", projectId: "proj_2" });
  ui.bind(right.binding);
  assert.equal((await pending).status, "succeeded");
  assert.equal(right.draft.text, "plan it");
  // Without a project any mounted new-thread composer is the target, with no navigation.
  const again = await ui.execute({ kind: "prepare_draft", target: { kind: "new" }, text: "more", mode: "append" }, current);
  assert.equal(again.status, "succeeded");
  assert.equal(right.draft.text, "plan it\nmore");
  assert.equal(app.calls.length, 1);
});

test("preview_file goes through the visible surface's own preview capability and reports acceptance, not rendering", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  const action: UiAction = { kind: "preview_file", target: { kind: "workspace", environmentId: "env_1", path: "src/app.ts" }, location: { kind: "line", line: 12, column: null } };
  // No page or composer surface: a precise failure, no navigation.
  const nowhere = await ui.execute(action, current);
  assert.equal(nowhere.status, "failed");
  assert.match(nowhere.detail, /no file preview panel/);
  assert.equal(app.calls.length, 0);
  // The composer of another thread is not the visible scope either.
  const other = fakeComposer({ kind: "thread", threadId: "thr_b" });
  ui.bind(other.binding);
  assert.equal((await ui.execute(action, current)).status, "failed");
  assert.equal(other.previews.length, 0);
  const visible = fakeComposer({ kind: "thread", threadId: "thr_a" });
  ui.bind(visible.binding);
  const accepted = await ui.execute(action, current);
  assert.equal(accepted.status, "succeeded");
  assert.match(accepted.detail, /accepted .* from thread thr_a/);
  assert.deepEqual(visible.previews, [{ target: action.target, location: action.location }]);
  visible.setPreviewAccepted(false);
  const declined = await ui.execute({ kind: "preview_file", target: { kind: "host", hostId: "h", path: "/tmp/x" } }, current);
  assert.equal(declined.status, "failed");
  assert.match(declined.detail, /declined/);
  assert.equal(app.calls.length, 0);
  // On the Voice page the panel lends its handler.
  const voice = fast();
  const voiceApp = fakeApp({ route: "/plugins/voice-mode/sessions" });
  voice.bind(voiceApp.binding);
  const panelPreviews: unknown[] = [];
  voice.bind(voicePanel(() => true, (options) => { panelPreviews.push(options); return true; }));
  const fromVoice = await voice.execute(action, current);
  assert.equal(fromVoice.status, "succeeded");
  assert.match(fromVoice.detail, /from the Voice page/);
  assert.equal(panelPreviews.length, 1);
});

test("show_voice succeeds only when the Voice panel confirms the conversation view", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a", route: "/threads/thr_a" });
  ui.bind(app.binding);
  const pending = ui.execute({ kind: "show_voice" }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(app.calls, [{ method: "toPluginPanel", path: "sessions", options: { subPath: "conversation" } }]);
  app.state.route = "/plugins/voice-mode/sessions/conversation";
  await new Promise(resolve => setTimeout(resolve, 15));
  const shown: (string | null)[] = [];
  const dispose = ui.bind(voicePanel((id) => { shown.push(id); return true; }));
  assert.equal((await pending).status, "succeeded");
  assert.deepEqual(shown, [null]);
  // Already on the Voice page, even in a debug tab: the panel selects it directly.
  assert.equal((await ui.execute({ kind: "show_voice" }, current)).status, "succeeded");
  assert.equal(app.calls.length, 1);
  dispose();
  ui.bind(voicePanel(() => false));
  const none = await ui.execute({ kind: "show_voice" }, current);
  assert.equal(none.status, "failed");
  assert.match(none.detail, /no current conversation/);
});

test("a dropped transport cancels in-flight waits and blocks new actions until it returns", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  const pending = ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_b" }, text: "x", mode: "append" }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  ui.setTransportConnected(false);
  assert.equal((await pending).status, "cancelled");
  const composer = fakeComposer({ kind: "thread", threadId: "thr_b" });
  ui.bind(composer.binding);
  assert.equal(composer.draft.text, "");
  assert.equal((await ui.execute({ kind: "show_voice" }, current)).status, "cancelled");
  ui.setTransportConnected(true);
  assert.equal(ui.transportConnected(), true);
  assert.equal((await ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_b" }, text: "x", mode: "append" }, current)).status, "succeeded");
});

test("a stale app disposer never clears a newer binding", () => {
  const ui = fast();
  const first = fakeApp({ threadId: "thr_1" });
  const second = fakeApp({ threadId: "thr_2" });
  const disposeFirst = ui.bind(first.binding);
  ui.bind(second.binding);
  disposeFirst();
  assert.equal(ui.snapshot().threadId, "thr_2");
});

test("a composer instance reused for another scope is matched by its live scope, never a captured one", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a" });
  ui.bind(app.binding);
  const reused = fakeComposer({ kind: "thread", threadId: "thr_a" }, "draft A");
  ui.bind(reused.binding);
  // React reassigns the same instance to thread B before any effect re-runs.
  reused.setScope({ kind: "thread", threadId: "thr_b" });
  app.state.threadId = "thr_b";
  assert.deepEqual(ui.snapshot().composers, [{ kind: "thread", threadId: "thr_b" }]);
  const wrong = await ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_a" }, text: "for A", mode: "replace" }, current);
  // Thread A is no longer mounted: the controller opens it and waits rather than writing into B.
  assert.equal(wrong.status, "failed");
  assert.equal(reused.draft.text, "draft A");
  const right = await ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_b" }, text: "for B", mode: "append" }, current);
  assert.equal(right.status, "succeeded");
  assert.equal(reused.draft.text, "draft A\nfor B");
  // The scope flips between matching and writing: nothing is written.
  // (isCurrent is consulted once on entry and once right before the write.)
  let checks = 0;
  const flipper = fakeComposer({ kind: "thread", threadId: "thr_c" }, "C");
  ui.bind(flipper.binding);
  const pending = ui.execute({ kind: "prepare_draft", target: { kind: "thread", threadId: "thr_c" }, text: "late", mode: "append" }, () => {
    if (++checks === 2) flipper.setScope({ kind: "thread", threadId: "thr_d" });
    return true;
  });
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.match(result.detail, /changed before the draft was written/);
  assert.equal(flipper.draft.text, "C");
});

test("show_voice re-checks ownership after the panel mounts and never selects for a stale call", async () => {
  const ui = fast();
  const app = fakeApp({ threadId: "thr_a", route: "/threads/thr_a" });
  ui.bind(app.binding);
  let owned = true;
  const pending = ui.execute({ kind: "show_voice" }, () => owned);
  await new Promise(resolve => setTimeout(resolve, 10));
  let shown = 0;
  // The binding resolves the wait; the call ends before the next microtask.
  ui.bind(voicePanel(() => { shown++; return true; }));
  owned = false;
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(shown, 0);
  // Same for a transport drop in that window.
  const ui2 = fast();
  const app2 = fakeApp({ threadId: "thr_a", route: "/threads/thr_a" });
  ui2.bind(app2.binding);
  const pending2 = ui2.execute({ kind: "show_voice" }, current);
  await new Promise(resolve => setTimeout(resolve, 10));
  ui2.bind(voicePanel(() => { shown++; return true; }));
  ui2.setTransportConnected(false);
  assert.equal((await pending2).status, "cancelled");
  assert.equal(shown, 0);
});
