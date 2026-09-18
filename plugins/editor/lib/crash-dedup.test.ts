import assert from "node:assert/strict";
import { test } from "node:test";
import { CrashDeduper, isResizeObserverLoopMessage, type CrashFields, type CrashLevel } from "./crash-dedup.js";

function harness() {
  const emitted: { level: CrashLevel; fields: CrashFields }[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  let now = 0;
  const deduper = new CrashDeduper((level, fields) => emitted.push({ level, fields }), {
    windowMs: 400,
    maxWaitMs: 2_000,
    now: () => now,
    schedule: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    unschedule: (id) => {
      timers.delete(id as number);
    },
  });
  return {
    deduper,
    emitted,
    timers,
    setNow(value: number) {
      now = value;
    },
    /** Fire whatever is scheduled, in schedule order. */
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
  };
}

test("identical consecutive reports merge into one with an occurrences count", () => {
  const { deduper, emitted, setNow, runTimers } = harness();
  deduper.push("warn", { message: "loop" }, "k");
  setNow(50);
  deduper.push("warn", { message: "loop" }, "k");
  setNow(100);
  deduper.push("warn", { message: "loop" }, "k");
  assert.equal(emitted.length, 0);
  runTimers();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.level, "warn");
  assert.equal(emitted[0]!.fields.message, "loop");
  assert.equal(emitted[0]!.fields.occurrences, 3);
});

test("a different report flushes the held one first and starts a new window", () => {
  const { deduper, emitted, runTimers } = harness();
  deduper.push("error", { message: "first" }, "k1");
  deduper.push("error", { message: "second" }, "k2");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.fields.message, "first");
  assert.equal(emitted[0]!.fields.occurrences, undefined);
  runTimers();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]!.fields.message, "second");
});

test("a nonstop burst still reports once per max wait, then starts over", () => {
  const { deduper, emitted, timers, setNow, runTimers } = harness();
  deduper.push("warn", { message: "loop" }, "k");
  for (let t = 100; t <= 2_100; t += 100) {
    setNow(t);
    deduper.push("warn", { message: "loop" }, "k");
  }
  // Past the deadline, the repeat's timer is due immediately.
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]!.ms, 0);
  runTimers();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.fields.occurrences, 22);
  setNow(2_200);
  deduper.push("warn", { message: "loop" }, "k");
  runTimers();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]!.fields.occurrences, undefined);
});

test("flush emits the held report once and is safe to repeat", () => {
  const { deduper, emitted } = harness();
  deduper.push("error", { message: "only" }, "k");
  deduper.flush();
  deduper.flush();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.fields.message, "only");
});

test("the ResizeObserver loop notice is the browser's own, in both phrasings", () => {
  assert.ok(isResizeObserverLoopMessage("ResizeObserver loop completed with undelivered notifications."));
  assert.ok(isResizeObserverLoopMessage("ResizeObserver loop limit exceeded"));
  assert.ok(!isResizeObserverLoopMessage("ResizeObserver was created inside a callback"));
  assert.ok(!isResizeObserverLoopMessage("Cannot read properties of undefined"));
});
