import { expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { CALL_TIMEOUT_MS } from "../lib/builder";
import { responsesSummarizer } from "../lib/summarizer";
import { fixture, stuckLuna } from "./fixture";

const ticks = async () => { for (let i = 0; i < 40; i++) await new Promise<void>(r => setImmediate(r)); };

for (const otherWait of [{kind: "plugin", pluginId: "other"}, {kind: "thread-busy"}]) {
  it(`releases a lead-only group handoff to ${otherWait.kind}, preserving independent groups and threads`, async () => {
    const f = fixture();
    f.memory.ceiling = 300; // R12: only a view past its ceiling holds a turn
    const scope = await f.attach("initiatives", "p", f.thread("c"), f.thread("d"));
    f.memory.useSummarizer(stuckLuna);
    f.turn("c", "past", "x".repeat(2000)); f.memory.kick("c"); await ticks();
    const admit = (threadId: string, queuedIds: string[]) => f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
      thread: makeThreadResponse({id: threadId}),
      requestedExecution: {providerId: "claude-code"},
      queuedMessages: queuedIds.map(id => ({id, threadId}) as never),
    }));
    const queued = (id: string, waitingOn: object) => f.harness.behavior.emitThreadEvent("message.queued", {entry: {id, threadId: "c", waitingOn}} as never);
    const needs = f.memory["builders"].get(scope)!["needs"];
    try {
      await admit("c", ["one", "two"]);
      await queued("one", {kind: "plugin", pluginId: "chat-memory"});
      await admit("c", ["three", "four"]);
      await queued("three", {kind: "plugin", pluginId: "chat-memory"});
      await admit("d", ["five", "six"]);
      expect(needs.size).toBe(2);
      await queued("one", otherWait);
      expect(needs.size).toBe(2); // c's other group and d still wait.
      await queued("three", otherWait);
      expect(needs.size).toBe(1); // Only d still waits.
      await f.harness.behavior.emitThreadEvent("message.queued", {entry: {id: "five", threadId: "d", waitingOn: otherWait}} as never);
      expect(needs.size).toBe(0);
    } finally { f.memory.dispose(); await f.memory.settled(); }
  });
}

it("renews urgency continuously for release observers", async () => {
  const f = fixture();
  f.memory.ceiling = 300; // R12: only a view past its ceiling holds a turn
  const scope = await f.attach("initiatives", "p", f.thread("c"));
  f.memory.useSummarizer(stuckLuna);
  f.turn("c", "past", "x".repeat(2000)); f.memory.kick("c"); await ticks();
  await f.dispatch("c");
  const builder = f.memory["builders"].get(scope)!;
  const observations: boolean[] = [];
  builder["releases"].add(() => observations.push(builder["urgent"]([0, 1])));
  await f.dispatch("c");
  expect(observations).not.toContain(false);
  f.memory.dispose(); await f.memory.settled();
});

// Queued priority must never extend the call timeout. This deliberately replaces
// the review's 40s no-abort expectation, which depended on an admission extension.
it("keeps real summary-call bounds under repeated queued renewals, then honors a genuine turn need", async () => {
  const f = fixture();
  f.memory.ceiling = 300; // R12: only a view past its ceiling holds a turn
  const scope = await f.attach("initiatives", "p", f.thread("c"));
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
  (f.store as unknown as {now: () => number}).now = () => Date.now();
  const t0 = Date.now();
  const aborts: number[] = [];
  const timeouts: number[] = [];
  const summarize = responsesSummarizer({
    fetch: ((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => {
        aborts.push(Date.now() - t0);
        reject(new DOMException("aborted", "AbortError"));
      }, {once: true});
    })) as typeof fetch,
    url: () => "http://local-test-stub", headers: async () => ({}),
  });
  f.memory.useSummarizer(r => { timeouts.push(r.timeoutMs!); return summarize(r); });
  try {
    f.turn("c", "past", "x".repeat(2000)); f.memory.kick("c"); await ticks();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await f.dispatch("c");
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timeouts[0]).toBe(CALL_TIMEOUT_MS);
    expect(aborts).toEqual([CALL_TIMEOUT_MS]);
    // The retry started at 30s with the existing doubled bound of 60s.
    // A real provider turn now needs it through 120s.
    await ticks();
    expect(timeouts).toEqual([CALL_TIMEOUT_MS, 2 * CALL_TIMEOUT_MS]);
    const builder = f.memory["builders"].get(scope)!;
    const releaseTurn = builder.need(Infinity, t0 + 120_000);
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await f.dispatch("c");
    }
    expect(aborts).toEqual([CALL_TIMEOUT_MS]);
    // Renewal, then removal of queued priority at 100s must not cancel the
    // separate real turn's extension past the retry's normal 90s deadline.
    f.memory.releasePreparation("c");
    expect(aborts).toEqual([CALL_TIMEOUT_MS]);
    releaseTurn();
    await ticks();
    expect(aborts).toEqual([CALL_TIMEOUT_MS, 100_000]);
  } finally { f.memory.dispose(); await f.memory.settled(); vi.useRealTimers(); }
});

it("preserves a remaining row when its former lead joins a different dispatch group", async () => {
  const f = fixture();
  f.memory.ceiling = 300; // R12: only a view past its ceiling holds a turn
  const scope = await f.attach("initiatives", "p", f.thread("c"));
  f.memory.useSummarizer(stuckLuna);
  f.turn("c", "past", "x".repeat(2000)); f.memory.kick("c"); await ticks();
  const admit = (queuedIds: string[]) => f.memory.admit({threadId: "c", providerId: "claude-code", attempt: "start-turn", queuedIds});
  try {
    await admit(["one", "two"]);
    await admit(["one", "three"]);
    await f.harness.behavior.emitThreadEvent("message.queued", {entry: {id: "one", threadId: "c", waitingOn: {kind: "thread-busy"}}} as never);
    const needs = f.memory["builders"].get(scope)!["needs"];
    expect(needs.size).toBe(1); // two was not in the group handed off.
    await f.harness.behavior.emitThreadEvent("message.cancelled", {entry: {id: "two", threadId: "c"}} as never);
    expect(needs.size).toBe(0);
  } finally { f.memory.dispose(); await f.memory.settled(); }
});
