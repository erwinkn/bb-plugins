import { expect, it } from "vitest";
import { UNAVAILABLE } from "../lib/log";
import { fixture } from "./fixture";

/**
 * D565: an accepted message that exactly repeats the last logged user message (same text, same
 * attachments) while that message's turn produced no assistant text or tool use is not logged
 * again. Anything else is logged on acceptance as before.
 */
async function setup() {
  const f = fixture();
  const scope = await f.attach("initiatives", "p:worker:1", f.thread("w"));
  /** The user sends `text`; the provider accepts it. Returns the request id. */
  const send = (text: string, data: Record<string, unknown> = {}) => {
    const id = f.say("w", text, data);
    f.accept("w", id);
    return id;
  };
  /** The turn fails before any output, as an OptChat memory failure after acceptance does. */
  const fail = () => {
    f.providerError("w", `${UNAVAILABLE}: its wait ran out. The message was not sent; send it again.`);
    f.done("w", "failed");
  };
  return { f, scope, send, fail };
}

it("logs an exact resend after a turn without output once, across passes and a restart", async () => {
  const { f, scope, send, fail } = await setup();
  send("deploy it");
  fail();
  await f.memory.ingest("w");
  f.memory.dispose();
  await f.memory.settled();
  f.memory.start();
  const again = send("deploy it");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["user: deploy it"]);
  // The resend's turn still gets its memory.
  const answer = await f.ask("w", again, "deploy it") as { input: string };
  expect(answer.input).toContain("deploy it");
  f.reply("w", "deployed");
  f.done("w");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["user: deploy it", "agent: deployed"]);
});

it("logs an exact resend once when both arrive in one pass, and a third copy too", async () => {
  const { f, scope, send, fail } = await setup();
  send("deploy it");
  fail();
  send("deploy it");
  fail();
  send("deploy it");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["user: deploy it"]);
});

it("logs a resend with changed text, and the original again after it", async () => {
  const { f, scope, send, fail } = await setup();
  send("deploy it");
  fail();
  send("Please continue.");
  fail();
  send("do it now");
  fail();
  send("deploy it");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["user: deploy it", "user: Please continue.", "user: do it now", "user: deploy it"]);
});

it("logs a resend with the same text but changed attachments", async () => {
  const { f, scope, send, fail } = await setup();
  const image = (url: string) => ({ input: [{ type: "text", text: "what is this?" }, { type: "image", url }] });
  send("what is this?", image("data:image/png;base64,AAAA"));
  fail();
  // Two inline images read alike in the log, but are not the same message.
  send("what is this?", image("data:image/png;base64,BBBB"));
  fail();
  send("what is this?", { input: [{ type: "text", text: "what is this?" }, { type: "localImage", path: "/a.png" }] });
  fail();
  send("what is this?", { input: [{ type: "text", text: "what is this?" }, { type: "localImage", path: "/b.png" }] });
  fail();
  send("what is this?");
  fail();
  // The same image again is the same message.
  send("what is this?");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual([
    "user: what is this?\n[attachment: inline image]",
    "user: what is this?\n[attachment: inline image]",
    "user: what is this?\n[attachment: /a.png]",
    "user: what is this?\n[attachment: /b.png]",
    "user: what is this?",
  ]);
});

it("logs an exact repeat after a turn that answered, or used a tool", async () => {
  const { f, scope, send } = await setup();
  send("status?");
  f.reply("w", "green");
  f.done("w");
  await f.memory.ingest("w");
  send("status?");
  f.command("w", "git status", "clean");
  f.done("w", "failed");
  send("status?");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["user: status?", "agent: green", "user: status?", "tool: Bash git status\n→ exit 0\nclean", "user: status?"]);
});

it("ends a skipped resend's history where it was accepted, after another thread wrote on and a restart", async () => {
  const f = fixture();
  const scope = await f.attach("initiatives", "p:worker:1", f.thread("w"), f.thread("o"));
  const turn = (threadId: string, text: string, reply?: string) => {
    const id = f.say(threadId, text);
    f.accept(threadId, id);
    if (reply) { f.reply(threadId, reply); f.done(threadId); }
    return id;
  };
  turn("o", "before the resend", "noted before");
  await f.memory.ingest("o");
  turn("w", "deploy it");
  f.providerError("w", `${UNAVAILABLE}: its wait ran out. The message was not sent; send it again.`);
  f.done("w", "failed");
  await f.memory.ingest("w");
  const again = turn("w", "deploy it");
  await f.memory.ingest("w");
  // The other thread writes on after the resend was accepted, then chat-memory restarts.
  turn("o", "after the resend", "noted after");
  await f.memory.ingest("o");
  expect(f.log(scope)).toEqual(["user: before the resend", "agent: noted before", "user: deploy it", "user: after the resend", "agent: noted after"]);
  await f.reload();
  const answer = await f.ask("w", again, "deploy it") as { systemPrompt: string; input: string };
  const history = answer.systemPrompt + answer.input;
  // Its history holds what came before it, the earlier copy included, and nothing after it.
  expect(history).toContain("before the resend");
  expect(history).toContain("noted before");
  expect(history).toContain("deploy it");
  expect(history).not.toContain("after the resend");
  expect(history).not.toContain("noted after");
});

it("logs an exact resend with the same attachments once", async () => {
  const { f, scope, send, fail } = await setup();
  const input = { input: [{ type: "text", text: "what is this?" }, { type: "image", url: "data:image/png;base64,AAAA" }, { type: "localFile", path: "/r.pdf", name: "r.pdf" }] };
  send("what is this?", input);
  fail();
  const again = send("what is this?", structuredClone(input));
  f.reply("w", "a chart");
  f.done("w");
  await f.memory.ingest("w");
  expect(f.log(scope)).toEqual(["user: what is this?\n[attachment: inline image]\n[attachment: /r.pdf]", "agent: a chart"]);
  // Its cut is where it was accepted, before the reply logged in the same pass.
  expect(f.store.requestCut(scope, "w", again)).toBe(1);
});
