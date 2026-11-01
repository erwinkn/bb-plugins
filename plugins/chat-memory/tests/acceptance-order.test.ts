import { expect, it } from "vitest";
import { fixture } from "./fixture";

for (const boundary of ["same pass", "pending across restart", "reply committed before acceptance"] as const) {
  it(`keeps accepted queued input after the preceding reply: ${boundary}`, async () => {
    const f = fixture();
    const scope = await f.attach("initiatives", "p:worker:1", f.thread("w"));
    const add = (seq: number, type: string, data: Record<string, unknown>) => f.history.push({threadId: "w", seq, type, data});
    add(1, "client/turn/requested", {requestId: "A", input: [{type: "text", text: "first task"}]});
    add(2, "turn/input/accepted", {clientRequestId: "A"});
    await f.memory.ingest("w");
    add(3, "client/turn/requested", {requestId: "B", input: [{type: "text", text: "use that result"}]});
    if (boundary === "pending across restart") {
      await f.memory.ingest("w");
      f.memory.dispose();
      await f.memory.settled();
      f.memory.start();
    }
    add(4, "item/completed", {item: {type: "agentMessage", text: "IMPORTANT previous answer"}});
    add(5, "turn/completed", {status: "completed"});
    if (boundary === "reply committed before acceptance") await f.memory.ingest("w");
    add(6, "turn/input/accepted", {clientRequestId: "B"});
    await f.memory.ingest("w");
    expect(f.log(scope)).toEqual(["user: first task", "agent: IMPORTANT previous answer", "user: use that result"]);
    expect(f.store.messages(scope).map(m => ({seq: m.seq, request: m.requestId, part: m.sourcePart}))).toEqual([
      {seq: 1, request: "A", part: 0}, {seq: 4, request: null, part: 0}, {seq: 3, request: "B", part: 0},
    ]);
    expect(f.store.thread("w")!.cursor).toBe(6);
    const answer = await f.ask("w", "B", "use that result") as {systemPrompt: string; input: string};
    const history = answer.systemPrompt + answer.input.split("New message:")[0];
    expect(history).toContain("IMPORTANT previous answer");
    expect(history).not.toContain("use that result");
    expect(answer.input.split("use that result")).toHaveLength(2);
    await f.memory.ingest("w");
    expect(f.store.count(scope)).toBe(3);
  });
}

it("orders an accepted retry at acceptance while retaining the original canonical source and exact retry identity", async () => {
  const f = fixture();
  const scope = await f.attach("initiatives", "p:worker:1", f.thread("w"));
  const add = (seq: number, type: string, data: Record<string, unknown>) => f.history.push({threadId: "w", seq, type, data});
  add(1, "client/turn/requested", {requestId: "original", input: [{type: "text", text: "unique retry question"}]});
  add(2, "provider/error", {detail: "OptChat memory unavailable for this turn"});
  add(3, "turn/completed", {status: "failed"});
  await f.memory.ingest("w");
  f.memory.dispose();
  await f.memory.settled();
  f.memory.start();
  add(4, "item/completed", {item: {type: "agentMessage", text: "IMPORTANT intervening answer"}});
  add(5, "client/turn/requested", {requestId: "retry", retryOfRequestId: "original", input: [{type: "text", text: "unique retry question"}]});
  add(6, "turn/input/accepted", {clientRequestId: "retry"});
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["agent: IMPORTANT intervening answer", "user: unique retry question"]);
  expect(f.store.message(scope, 1)).toMatchObject({seq: 1, requestId: "retry", sourcePart: 0});
  const answer = await f.ask("w", "retry", "unique retry question") as {systemPrompt: string; input: string};
  expect(answer.systemPrompt + answer.input.split("New message:")[0]).toContain("IMPORTANT intervening answer");
  expect(answer.systemPrompt).not.toContain("unique retry question");
  expect(answer.input.split("unique retry question")).toHaveLength(2);
});
