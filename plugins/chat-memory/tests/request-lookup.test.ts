import { expect, it, vi } from "vitest";
import { fixture } from "./fixture";

async function setup(count: number) {
  const f = fixture();
  await f.attach("initiatives", "p", f.thread("w"));
  for (let i = 1; i <= count; i++) {
    // Sparse event sequences prove the cursor counts requests, not sequence numbers.
    f.history.push({threadId: "w", seq: i * 7, type: "client/turn/requested", data: {requestId: `r${i}`}});
  }
  const original = f.memory["deps"].list;
  const list = vi.spyOn(f.memory["deps"], "list");
  const pages = () => list.mock.calls.map(([args]) => args).filter(args => args.order === "desc" && args.types.length === 1 && args.types[0] === "client/turn/requested");
  return { f, list, pages, original };
}

it.each([
  ["latest request", 1001, "r1001", 1],
  ["identity beyond the first page", 1001, "r901", 2],
  ["exactly the 1000th request", 1001, "r2", 10],
] as const)("locates %s using legal SDK pages", async (_, count, request, calls) => {
  const { f, pages } = await setup(count);
  expect(await f.ask("w", request, "incoming")).toMatchObject({session: "fresh"});
  expect(pages()).toHaveLength(calls);
  expect(pages().every(page => Number(page.limit) <= 100)).toBe(true);
});

it.each(["r1", "missing"])("stops at 1000 requests when %s is outside the bound", async request => {
  const { f, pages } = await setup(1001);
  await expect(f.ask("w", request, "incoming")).rejects.toThrow("could not be located in the latest 1000 requests");
  expect(pages()).toHaveLength(10);
});

it("stops when the request pages make no progress", async () => {
  const { f, list, pages, original } = await setup(101);
  list.mockImplementation(async args => original({...args, beforeSeq: undefined}));
  await expect(f.ask("w", "r1", "incoming")).rejects.toThrow("request pages made no progress");
  expect(pages()).toHaveLength(2);
});

it("does not start another request page after cancellation during a read", async () => {
  const { f, list, pages, original } = await setup(101);
  const stop = new AbortController();
  list.mockImplementation(async args => {
    const rows = await original(args);
    if (args.order === "desc" && args.types[0] === "client/turn/requested") stop.abort();
    return rows;
  });
  await expect(f.memory.turnContext("w", {protocol: 4, requestId: "r1", input: "incoming", sessionId: null}, stop.signal)).rejects.toThrow("the turn stopped");
  expect(pages()).toHaveLength(1);
});

it.each([0, 101])("stops on an exhausted history of %i requests", async count => {
  const { f, pages } = await setup(count);
  await expect(f.ask("w", "missing", "incoming")).rejects.toThrow("could not be located in the latest 1000 requests");
  expect(pages()).toHaveLength(count === 0 ? 1 : 2);
});

it.each([false, true])("preserves the exact chronological cut beyond page one, accepted retry: %s", async retry => {
  const f = fixture();
  const scope = await f.attach("initiatives", "p", f.thread("w"));
  const add = (seq: number, type: string, data: Record<string, unknown>) => f.history.push({threadId: "w", seq, type, data});
  add(1, "client/turn/requested", {requestId: "original", input: [{type: "text", text: "unique incoming"}]});
  if (retry) {
    add(2, "provider/error", {detail: "OptChat memory unavailable for this turn"});
    add(3, "turn/completed", {status: "failed"});
    await f.memory.ingest("w");
  }
  add(4, "item/completed", {item: {type: "agentMessage", text: "IMPORTANT preceding reply"}});
  if (retry) add(5, "client/turn/requested", {requestId: "retry", retryOfRequestId: "original", input: [{type: "text", text: "unique incoming"}]});
  add(6, "turn/input/accepted", {clientRequestId: retry ? "retry" : "original"});
  add(7, "item/completed", {item: {type: "agentMessage", text: "LATER excluded reply"}});
  for (let seq = 8; seq < 108; seq++) add(seq, "client/turn/requested", {requestId: `padding-${seq}`});
  const answer = await f.ask("w", retry ? "retry" : "original", "unique incoming") as {systemPrompt: string; input: string};
  const history = answer.systemPrompt + answer.input.split("New message:")[0];
  expect(history).toContain("IMPORTANT preceding reply");
  expect(history).not.toContain("unique incoming");
  expect(history).not.toContain("LATER excluded reply");
  expect(answer.input.split("unique incoming")).toHaveLength(2);
  expect(f.store.message(scope, 1)).toMatchObject({seq: 1, requestId: retry ? "retry" : "original"});
});

it.each(["deadline", "cancellation"] as const)("stops a stalled page on %s without background paging", async reason => {
  const { f, list, pages, original } = await setup(301);
  const stop = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  if (reason === "deadline") f.memory.waits.turn = 200;
  list.mockImplementation(async args => {
    const rows = await original(args);
    if (args.order === "desc" && args.types[0] === "client/turn/requested" && args.beforeSeq) {
      started();
      await gate;
    }
    return rows;
  });
  const turn = f.memory.turnContext("w", {protocol: 4, requestId: "r1", input: "incoming", sessionId: null}, stop.signal);
  const failed = expect(turn).rejects.toThrow(reason === "deadline" ? "could not be read in time" : "the turn stopped");
  await reading;
  if (reason === "cancellation") stop.abort();
  await failed;
  release();
  await new Promise(resolve => setImmediate(resolve));
  expect(pages()).toHaveLength(2);
});
