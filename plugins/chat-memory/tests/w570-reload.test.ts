import { describe, expect, it, vi } from "vitest";
import { fixture, stuckLuna } from "./fixture";
import { TURN_CONTEXT_RESTARTING } from "../lib/memory";
import { UNAVAILABLE } from "../lib/log";

/**
 * W570: on 2026-11-02 at 13:05:15, W569's turn had waited 29,580 ms of its 90 s for the summaries
 * of 100 messages when chat-memory reloaded. BB aborted the old instance's tool call with
 * "plugin-disposed"; the turn failed with "the turn stopped", and nothing asked again. These tests
 * replay that shape at 1/30 scale (90 s → 3 s, 29.6 s → 1 s).
 */
const WAIT = 3_000;
const INTO_WAIT = 1_000;
/** R12: a turn waits this long only past its ceiling: 100 lines without summaries are about 50 KB. */
const CEILING = 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A worker thread with 100 messages none of which has a summary yet, and its incoming request. */
async function w569(stuck = true) {
  const f = fixture();
  const scope = await f.attach("initiatives", "p", f.thread("w"));
  if (stuck) f.memory.useSummarizer(stuckLuna);
  f.memory.waits.turn = WAIT;
  f.memory.ceiling = CEILING;
  // The turn's own catch-up copies them.
  for (let i = 0; i < 50; i++) f.turn("w", `ask ${i} ${"q".repeat(1_500)}`, `answer ${i} ${"x".repeat(1_500)}`);
  const request = f.say("w", "go on");
  return { f, scope, request };
}

describe("W570 a reload during a turn's memory wait", () => {
  it("fails the old instance's call with the fixed restarting error, and the new instance answers the call asked again", async () => {
    const { f, request } = await w569();
    const log = vi.spyOn(f.memory["deps"], "log");
    const first = Date.now();
    const turn = f.ask("w", request, "go on");
    const failure = turn.then(() => null, (error: Error) => error);
    await sleep(INTO_WAIT);
    const fresh = await f.reload();
    fresh.waits.turn = WAIT;
    fresh.ceiling = CEILING;
    // The old call ends at once, with the error the provider recognises; not "the turn stopped".
    expect((await failure)?.message).toBe(TURN_CONTEXT_RESTARTING);
    expect(log.mock.calls.flat().join("\n")).toMatch(/waited [\d,]+ ms for the summaries of 100 messages; chat-memory is restarting; the provider asks again/);
    // The provider asks the new instance, whose summarizer answers.
    const answer = (await f.ask("w", request, "go on", { elapsedMs: Date.now() - first })) as { session: string; systemPrompt: string; input: string };
    expect(answer.session).toBe("fresh");
    const text = answer.systemPrompt + answer.input;
    expect(text).toContain("summary of");
    expect(text).toContain("go on");
    // R12: of the raw history, never more than a line's start.
    expect(text).not.toContain("x".repeat(1_000));
  });

  it("keeps the first ask's deadline: still unsummarized, the turn fails visibly WAIT after its first ask, not after the second", async () => {
    const { f, request } = await w569();
    const first = Date.now();
    const turn = f.ask("w", request, "go on").catch((error: Error) => error);
    await sleep(INTO_WAIT);
    const fresh = await f.reload();
    fresh.waits.turn = WAIT;
    fresh.ceiling = CEILING;
    fresh.useSummarizer(stuckLuna);
    expect(((await turn) as Error).message).toBe(TURN_CONTEXT_RESTARTING);
    const again = Date.now();
    await expect(f.ask("w", request, "go on", { elapsedMs: again - first })).rejects.toThrow(`${UNAVAILABLE}: its view of the history is over its 10,000-byte ceiling`);
    const end = Date.now();
    expect(end - first).toBeGreaterThanOrEqual(WAIT - 50);
    // A fresh 3 s wait would end at about 4 s after the first ask.
    expect(end - first).toBeLessThan(WAIT + 500);
  });

  it("fails at once, visibly, when the first ask's wait has already run out", async () => {
    const { f, request } = await w569();
    await f.reload();
    const start = Date.now();
    await expect(f.ask("w", request, "go on", { elapsedMs: f.memory.waits.turn })).rejects.toThrow(`${UNAVAILABLE}: its wait ran out while chat-memory restarted`);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("says restarting to a call that reaches an instance already disposed", async () => {
    const { f, request } = await w569();
    const old = f.memory;
    old.dispose();
    await expect(old.turnContext("w", { protocol: 4, input: "go on", requestId: request, sessionId: null })).rejects.toThrow(TURN_CONTEXT_RESTARTING);
  });

  it.each([undefined, "thread-stopped"])("still says the turn stopped when the call is aborted for another reason (%s)", async (reason) => {
    const { f, request } = await w569();
    const stop = new AbortController();
    const turn = f.memory.turnContext("w", { protocol: 4, input: "go on", requestId: request, sessionId: null }, stop.signal);
    await sleep(100);
    stop.abort(reason);
    const error = await turn.then(() => null, (e: Error) => e);
    expect(error?.message).toContain("the turn stopped");
    expect(error?.message).not.toBe(TURN_CONTEXT_RESTARTING);
  });

  it("leaves the unsent message out of memory when restarting is the turn's final failure (D502)", async () => {
    const { f, scope } = await w569(false);
    await f.idle("w");
    const before = f.log(scope);
    expect(before).toHaveLength(100);
    f.providerError("w", `Claude Code could not get the turn's memory context: Tool "claude_code_turn_context" failed: ${TURN_CONTEXT_RESTARTING}`);
    f.done("w", "failed");
    await f.failed("w");
    expect(f.log(scope)).toEqual(before);
  });
});
