import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptBuffer, withLiveTranscript } from "./live-transcript.ts";
import { projectConversation, type SessionEvent } from "./session-projection.ts";

const event = (id: number, kind: string, payload: object, callId = "call"): SessionEvent => ({ id, ts: id * 100, kind, payload: JSON.stringify(payload), callId });

test("streamed words grow in a stable bubble, final text replaces the draft, and late deltas stay closed", () => {
  const stream = new TranscriptBuffer();
  stream.delta("user", "u", "Open", 100, {}, "delta1");
  const first = projectConversation(withLiveTranscript([], stream.snapshot("call")));
  assert.equal(first[0].text, "Open");
  assert.equal(first[0].partial, true);
  stream.delta("user", "u", " Build", 150, {}, "delta2");
  stream.delta("user", "u", " Build", 150, {}, "delta2");
  const next = projectConversation(withLiveTranscript([], stream.snapshot("call")));
  assert.equal(next[0].id, first[0].id);
  assert.equal(next[0].text, "Open Build");
  const final = projectConversation(withLiveTranscript([event(3, "user", { itemId: "u", text: "Open the build thread." })], stream.snapshot("call")));
  assert.equal(final.length, 1); assert.equal(final[0].id, first[0].id);
  assert.equal(final[0].text, "Open the build thread."); assert.equal(final[0].partial, false);
  stream.complete("user", "u");
  assert.equal(stream.delta("user", "u", "late", 200), null);
});

test("streaming output replaces planned speech and keeps actual playback separate", () => {
  const stream = new TranscriptBuffer();
  const events = [event(1, "reply.speaking", { replyId: "r", text: "All of this was planned.", streaming: true })];
  assert.equal(projectConversation(events).length, 0, "planned text is not generated text");
  stream.delta("assistant", "a", "The build", 200, { responseId: "response", replyId: "r", source: "coordinator" });
  let messages = projectConversation(withLiveTranscript(events, stream.snapshot("call")));
  assert.equal(messages.length, 1); assert.equal(messages[0].text, "The build");
  events.push(event(3, "speech.lifecycle", { responseId: "response", replyId: "r", state: "interrupted" }));
  events.push(event(4, "assistant", { responseId: "response", itemId: "a", replyId: "r", text: "The build passed.", source: "coordinator" }));
  messages = projectConversation(withLiveTranscript(events, stream.snapshot("call")));
  assert.equal(messages.length, 1); assert.equal(messages[0].text, "The build passed.");
  assert.equal(messages[0].delivery, "interrupted"); assert.equal(messages[0].partial, false);
});

test("empty final input removes its provisional draft without erasing another call's words", () => {
  const stream = new TranscriptBuffer();
  stream.delta("user", "u", "Hmm", 200);
  const events = [event(1, "user", { itemId: "u", text: "Keep this." }, "older-call"), event(3, "transcription.result", { itemId: "u", outcome: "empty" })];
  const messages = projectConversation(withLiveTranscript(events, stream.snapshot("call")));
  assert.deepEqual(messages.map(message => message.text), ["Keep this."]);
});

test("non-speech annotations are not words, while short spoken commands remain valid", async () => {
  const {hasSpokenWords} = await import("./spoken-input.ts");
  for (const text of ["[BLANK_AUDIO]", "(cough)", "[noise]", "[music]", "...", "um uh"]) assert.equal(hasSpokenWords(text),false,text);
  for (const text of ["Stop", "Wait", "Yes", "No", "I", "[noise] wait"]) assert.equal(hasSpokenWords(text),true,text);
});
