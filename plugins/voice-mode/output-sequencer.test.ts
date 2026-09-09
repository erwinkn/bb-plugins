import test from "node:test";
import assert from "node:assert/strict";
import { OutputSequencer } from "./output-sequencer.ts";

const audio = [{ type: "message", content: [{ type: "audio" }] }];
const call = (id: string, index: number) => ({ call_id: id, output_index: index });

test("natural drain requires generation done, and claims remain serial", () => {
  const output = new OutputSequencer();
  output.created("a"); output.started("a");
  output.hold("a", call("second", 2)); output.hold("a", call("first", 1));
  output.stopped("a");
  assert.equal(output.next(), undefined);
  output.done("a", audio);
  const first = output.next()!;
  assert.equal(first.event.call_id, "first");
  assert.equal(output.next(), undefined, "a running call blocks the next claim");
  assert.equal(output.pendingCalls, 2);
  output.finished(first);
  const second = output.next()!;
  assert.equal(second.event.call_id, "second");
  output.finished(second);
  assert.equal(output.pendingCalls, 0);
});

test("interruption is terminal even after late started, stopped and done events", () => {
  const output = new OutputSequencer();
  output.created("a"); output.hold("a", call("held", 0));
  assert.equal(output.interrupted("a").length, 1);
  output.started("a"); output.stopped("a"); output.done("a", audio);
  assert.equal(output.playbackPending, false);
  assert.equal(output.next(), undefined);
  assert.equal(output.hold("a", call("late", 1)), false);
  assert.equal(output.pendingCalls, 0);
});

test("no audio item does not release a response whose audio started", () => {
  const output = new OutputSequencer();
  output.created("a"); output.started("a"); output.hold("a", call("held", 0));
  output.done("a", []);
  assert.equal(output.next(), undefined);
  assert.equal(output.playbackPending, true);
  output.stopped("a"); assert.ok(output.next());
});

test("failure cancels only the remaining calls of its response", () => {
  const output = new OutputSequencer();
  for (const id of ["a", "b"]) {
    output.created(id); output.hold(id, call(`${id}-first`, 0)); output.done(id, []);
  }
  output.hold("a", call("a-second", 1));
  const running = output.next()!;
  assert.deepEqual(output.failed("a").map(call => call.event.call_id), ["a-second"]);
  assert.equal(output.pendingCalls, 2);
  output.finished(running);
  assert.equal(output.next()!.event.call_id, "b-first");
});

test("item identity supplies order when the argument event omits output_index", () => {
  const output = new OutputSequencer(); output.created("a");
  output.item("a", { outputIndex: 2, itemId: "second", type: "function_call" });
  output.item("a", { outputIndex: 1, itemId: "first", type: "function_call" });
  output.hold("a", { call_id: "second-call", item_id: "second" });
  output.hold("a", { call_id: "first-call", item_id: "first" });
  output.done("a", []);
  assert.equal(output.next()!.event.call_id, "first-call");
});

test("a violation is detected from item order even when item events arrive in reverse", () => {
  const output = new OutputSequencer(); output.created("a");
  const speech = { outputIndex: 1, itemId: "speech", type: "message" };
  assert.equal(output.item("a", speech), false);
  assert.equal(output.item("a", { outputIndex: 0, itemId: "tool", type: "function_call" }), true);
  assert.equal(output.item("a", speech), false);
});

test("duplicate calls cannot produce duplicate work, and reset clears the session", () => {
  const output = new OutputSequencer(); output.created("a");
  assert.equal(output.hold("a", call("read", 0)), true);
  assert.equal(output.hold("a", call("read", 0)), false);
  output.started("a"); output.reset();
  assert.equal(output.pendingCalls, 0);
  assert.equal(output.playbackPending, false);
  output.stopped("a"); output.done("a", []);
  assert.equal(output.hold("a", call("late", 1)), false);
  assert.equal(output.next(), undefined);
});
