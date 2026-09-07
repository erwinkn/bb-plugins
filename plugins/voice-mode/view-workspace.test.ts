import test from "node:test";
import assert from "node:assert/strict";
import { ViewWorkspace, type ThreadView } from "./view-workspace.ts";

const view = (id: string): ThreadView => ({ kind: "thread", id: `thread:${id}`, threadId: id, projectId: `project-${id}`, title: `Thread ${id}` });
function workspace() {
  const store = new ViewWorkspace();
  store.registerPresenter({ available: () => true, reveal: () => true });
  return store;
}

test("opening threads retains previous views and deduplicates reopened threads", () => {
  const store = workspace();
  store.open([view("a")]);
  store.open([view("b")]);
  store.open([{ ...view("a"), title: "Updated title" }]);
  assert.deepEqual(store.get(), {
    views: [{ ...view("a"), title: "Updated title" }, view("b")], activeId: "thread:a",
  });
});

test("batches preserve existing threads and deduplicate requested threads", () => {
  const store = workspace();
  store.open([view("a")]);
  store.open([view("b"), view("c"), view("b")]);
  assert.deepEqual(store.get().views, [view("a"), view("b"), view("c")]);
  assert.equal(store.get().activeId, "thread:b");
});

test("declined or throwing opens leave tabs and selection unchanged", () => {
  const store = workspace();
  store.open([view("a")]);
  const before = store.get();
  const unregister = store.registerPresenter({ available: () => true, reveal: () => false });
  assert.throws(() => store.open([view("b")]), /could not show/);
  assert.equal(store.get(), before);
  unregister();
  store.registerPresenter({ available: () => true, reveal: () => { throw new Error("Host unavailable"); } });
  assert.throws(() => store.open([view("b")]), /Host unavailable/);
  assert.equal(store.get(), before);
});

test("windows are isolated and unmounted or unavailable presenters cannot receive opens", () => {
  const otherWindow = workspace();
  const ownWindow = new ViewWorkspace();
  assert.throws(() => ownWindow.open([view("a")]), /Open the Voice area/);
  assert.equal(otherWindow.get().views.length, 0);
  const unregister = ownWindow.registerPresenter({ available: () => true, reveal: () => true });
  unregister();
  ownWindow.registerPresenter({ available: () => false, reveal: () => { throw new Error("Must not run"); } });
  assert.throws(() => ownWindow.open([view("a")]), /Open the Voice area/);
});

test("context follows selected views only while a panel is visible; closing restores another tab", () => {
  const store = workspace();
  store.open([view("a"), view("b"), view("c")]);
  assert.equal(store.current(), null);
  let visible = true;
  const unmount = store.registerVisiblePanel(() => visible);
  assert.equal(store.current()?.threadId, "a");
  store.select("thread:b");
  assert.equal(store.current()?.threadId, "b");
  store.close("thread:b");
  assert.equal(store.current()?.threadId, "c");
  visible = false;
  assert.equal(store.current(), null);
  visible = true;
  unmount();
  assert.equal(store.current(), null);
  assert.deepEqual(store.get().views, [view("a"), view("c")]);
  store.clear();
  assert.deepEqual(store.get(), { views: [], activeId: null });
});
