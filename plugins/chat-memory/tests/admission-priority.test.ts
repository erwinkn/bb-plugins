import { expect, it, vi } from "vitest";
import { fixture, fakeLuna, stuckLuna } from "./fixture";

const ticks = async () => { for (let i = 0; i < 40; i++) await new Promise<void>(r => setImmediate(r)); };

it("gives queued coordinator preparation the next shared permit ahead of background migration", async () => {
  const f = fixture();
  const scope = await f.attach("initiatives", "p", f.thread("c"));
  const stop = new AbortController();
  const held: Array<() => void> = [];
  const blockers = Array.from({length: 8}, (_, i) => f.memory.permits.run(`busy-${i}`, stop.signal, () => new Promise<void>(r => held.push(r))));
  await ticks();
  const order: string[] = [];
  const background = f.memory.permits.run("migration", stop.signal, async () => { order.push("background"); });
  f.memory.useSummarizer(async r => { order.push("coordinator"); return fakeLuna(r); });
  f.turn("c", "past", "long history ".repeat(200));
  f.memory.kick("c");
  await ticks();
  try {
    expect(await f.dispatch("c")).toMatchObject({action: "wait"});
    held.shift()!();
    await ticks();
    expect(order[0]).toBe("coordinator");
    expect((await f.memory.status(scope)).tree.ready).toBe(true);
    expect(f.memory["builders"].get(scope)!["needs"].size).toBe(0);
  } finally {
    stop.abort(); held.splice(0).forEach(r => r());
    f.memory.dispose(); await Promise.all([...blockers, background]); await f.memory.settled();
  }
});

it("bounds and renews admission urgency without accumulating needs", async () => {
  const f = fixture();
  const scope = await f.attach("initiatives", "p", f.thread("c"));
  f.memory.useSummarizer(stuckLuna);
  f.turn("c", "past", "x".repeat(2000)); f.memory.kick("c"); await ticks();
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
  try {
    await f.dispatch("c"); await f.dispatch("c");
    const needs = f.memory["builders"].get(scope)!["needs"];
    expect(needs.size).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(needs.size).toBe(0);
    await f.dispatch("c"); expect(needs.size).toBe(1);
    f.memory.dispose(); expect(needs.size).toBe(0);
    await f.memory.settled();
  } finally { vi.useRealTimers(); }
});

for (const ending of ["cancelled", "dispatched", "other owner", "archived", "deleted", "failed"] as const) {
  it(`releases preparation on ${ending}, retaining other queued rows until removed`, async () => {
    const f = fixture();
    const scope = await f.attach("initiatives", "p", f.thread("c"));
    let finish!: () => void;
    const gate = new Promise<void>(r => finish = r);
    f.memory.useSummarizer(async r => {
      if (ending === "failed") { await gate; return {ok: false, reason: "failed", error: "terminal failure"}; }
      return stuckLuna(r);
    });
    f.turn("c", "past", "x".repeat(2000)); f.memory.kick("c"); await ticks();
    await f.dispatch("c");
    const needs = f.memory["builders"].get(scope)!["needs"];
    expect(needs.size).toBe(1);
    const queued = async (id: string) => f.harness.behavior.emitThreadEvent("message.queued", {entry: {id, threadId: "c", waitingOn: {kind: "plugin", pluginId: "chat-memory"}}} as never);
    await queued("one"); await queued("two");
    if (ending === "cancelled" || ending === "dispatched") {
      await f.harness.behavior.emitThreadEvent(`message.${ending}`, {entry: {id: "one", threadId: "c"}} as never);
      expect(needs.size).toBe(1);
      await f.harness.behavior.emitThreadEvent(`message.${ending}`, {entry: {id: "two", threadId: "c"}} as never);
    } else if (ending === "other owner") {
      for (const id of ["one", "two"]) await f.harness.behavior.emitThreadEvent("message.queued", {entry: {id, threadId: "c", waitingOn: {kind: "plugin", pluginId: "other"}}} as never);
    } else if (ending === "failed") {
      finish(); await f.memory.settled();
      expect(await f.dispatch("c")).toMatchObject({action: "reject"});
    } else {
      const {makeThreadResponse} = await import("@get-bb/plugin-sdk/testing");
      await f.harness.behavior.emitThreadEvent(`thread.${ending}`, {thread: makeThreadResponse({id: "c"})} as never);
    }
    expect(needs.size).toBe(0);
    f.memory.dispose(); await f.memory.settled();
  });
}
