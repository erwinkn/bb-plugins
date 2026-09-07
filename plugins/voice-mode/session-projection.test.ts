import test from "node:test";
import assert from "node:assert/strict";
import { projectConversation, type SessionEvent } from "./session-projection.ts";
const event = (id:number,kind:string,payload:unknown,callId="call_a"):SessionEvent => ({id,ts:id,kind,payload:JSON.stringify(payload),callId});

test("unified conversation excludes handoffs, tools and diagnostic progress while correlating spoken replies",()=>{
  const rows = projectConversation([
    event(1,"user",{text:"Check threads",itemId:"u1"}),
    event(2,"handoff.recorded",{requestId:"r1",text:"Internal request"}),
    event(3,"tool.result",{output:"Internal instructions"}),
    event(4,"reply.received",{replyId:"reply1",speech:"Internal transport"}),
    event(5,"reply.speaking",{replyId:"reply1",kind:"final",text:"Two threads are active."}),
    event(6,"speech.lifecycle",{responseId:"response1",replyId:"reply1",state:"started"}),
    event(7,"assistant",{responseId:"response1",replyId:"reply1",itemId:"a1",text:"Two threads are active."}),
    event(8,"speech.lifecycle",{responseId:"response1",replyId:"reply1",state:"delivered"}),
  ]);
  assert.equal(rows.length,2);
  assert.equal(rows[1].text,"Two threads are active.");
  assert.equal(rows[1].delivery,"delivered");
});

test("identities correlate late transcripts; repeated words in different responses remain distinct",()=>{
  const rows=projectConversation([
    event(1,"speech.lifecycle",{responseId:"a",state:"interrupted"}),
    event(2,"assistant",{responseId:"a",replyId:"r",itemId:"item1",text:"On it."}),
    event(3,"assistant",{responseId:"b",itemId:"item2",text:"On it."}),
    event(4,"speech.lifecycle",{responseId:"a",replyId:"r",state:"started"}),
    event(5,"speech.lifecycle",{responseId:"a",replyId:"r",state:"delivered"}),
  ]);
  assert.equal(rows.length,2); assert.equal(rows[0].delivery,"interrupted");
  assert.equal(rows[1].delivery,"unknown");
});

test("historical transcripts never gain playback evidence from another call or matching text",()=>{
  const rows=projectConversation([
    event(1,"reply.speaking",{replyId:"old",text:"Same words."}),
    event(2,"assistant",{text:"Same words."}),
    event(3,"reply.delivered",{replyId:"old"}),
    event(4,"assistant",{text:"Same words."}),
    event(5,"speech.lifecycle",{responseId:"new",state:"delivered"},"call_b"),
    event(6,"assistant",{responseId:"new",text:"New answer."},"call_b"),
  ]);
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map(row=>row.delivery),["unknown","unknown","delivered"]);
});

test("a bridge acknowledgment remains one ordinary assistant message",()=>{
  const rows=projectConversation([
    event(1,"reply.speaking",{replyId:"local_ack_r1",kind:"progress",text:"On it."}),
    event(2,"assistant",{replyId:"local_ack_r1",responseId:"ack",source:"acknowledgment",text:"On it."}),
    event(3,"speech.lifecycle",{replyId:"local_ack_r1",responseId:"ack",state:"delivered"}),
  ]);
  assert.equal(rows.length,1); assert.equal(rows[0].kind,"acknowledgment");
  assert.equal(rows[0].source,"bridge"); assert.equal(rows[0].delivery,"delivered");
});

test("repeated item events replace text, a late 'started' never downgrades a settled reply, and interruption is final",()=>{
  const rows=projectConversation([
    event(1,"assistant",{responseId:"r1",itemId:"i1",text:"Archived the"}),
    event(2,"assistant",{responseId:"r1",itemId:"i1",text:"Archived the speech thread."}),
    event(3,"assistant",{responseId:"r1",itemId:"i2",text:"Nothing else remains."}),
    event(4,"speech.lifecycle",{responseId:"r1",state:"delivered"}),
    event(5,"speech.lifecycle",{responseId:"r1",state:"started"}),
    event(6,"speech.lifecycle",{responseId:"r2",state:"started"}),
    event(7,"assistant",{responseId:"r2",itemId:"i3",text:"Second answer."}),
    event(8,"speech.lifecycle",{responseId:"r2",state:"interrupted"}),
    event(9,"speech.lifecycle",{responseId:"r2",state:"delivered"}),
  ]);
  assert.deepEqual(rows.map(row=>[row.text,row.delivery]),[
    ["Archived the speech thread. Nothing else remains.","delivered"],
    ["Second answer.","interrupted"],
  ]);
  assert.deepEqual(rows[0].eventIds,[1,2,3,4,5]);
});

test("legacy transcripts show once; calls with only bridge records retain question and update kinds",()=>{
  const rows=projectConversation([
    event(1,"user",{text:"   "}),
    event(2,"user",{text:"Which thread?"}),
    event(3,"reply.speaking",{replyId:"reply_q",kind:"clarification",text:"The speech thread or the CI thread?"}),
    event(4,"reply.playing",{replyId:"reply_q"}),
    event(5,"assistant",{text:"The speech thread or the CI thread?"}),
    event(6,"reply.delivered",{replyId:"reply_q"}),
    event(7,"reply.speaking",{replyId:"reply_u",kind:"update",text:"Docs failed on the build script."}),
    event(8,"reply.interrupted",{replyId:"reply_u"}),
    event(9,"notice",{text:"Thread update — finished: CI."}),
  ]);
  assert.deepEqual(rows.map(row=>[row.who,row.kind,row.delivery]),[
    ["you","speech",null],
    ["aide","speech","unknown"],
    ["aide","update","unknown"],
  ]);
  assert.equal(rows[1].text,"The speech thread or the CI thread?");
  const bridgeOnly = projectConversation([
    event(1,"reply.speaking",{replyId:"reply_q",kind:"clarification",text:"Which thread?"}),
    event(2,"reply.delivered",{replyId:"reply_q"}),
    event(3,"reply.speaking",{replyId:"reply_u",kind:"update",text:"The build failed."}),
    event(4,"reply.interrupted",{replyId:"reply_u"}),
  ]);
  assert.deepEqual(bridgeOnly.map(row=>[row.text,row.kind,row.delivery]),[
    ["Which thread?","question","delivered"],
    ["The build failed.","update","interrupted"],
  ]);
});

test("events are ordered by time across calls and a transcript that lands after its lifecycle still joins its response",()=>{
  const rows=projectConversation([
    { id: 50, ts: 5000, kind: "assistant", payload: JSON.stringify({ responseId: "late", itemId: "x", text: "Late words." }), callId: "call_b" },
    { id: 10, ts: 1000, kind: "user", payload: JSON.stringify({ text: "First call words." }), callId: "call_a" },
    { id: 40, ts: 4000, kind: "speech.lifecycle", payload: JSON.stringify({ responseId: "late", state: "delivered" }), callId: "call_b" },
    { id: 20, ts: 2000, kind: "user", payload: JSON.stringify({ text: "Second call words." }), callId: "call_b" },
  ]);
  assert.deepEqual(rows.map(row=>[row.text,row.callId,row.delivery]),[
    ["First call words.","call_a",null],
    ["Second call words.","call_b",null],
    ["Late words.","call_b","delivered"],
  ]);
});

test("speech fragments use audio boundaries and retain spoken order when transcripts arrive late", () => {
  const at = (id: number, ts: number, kind: string, payload: unknown) => ({ ...event(id,kind,payload), ts });
  const input = [
    at(1,100,"realtime.event",{eventType:"input_audio_buffer.speech_started",itemId:"u1",audioStartMs:0}),
    at(2,1100,"realtime.event",{eventType:"input_audio_buffer.speech_stopped",itemId:"u1",audioEndMs:1000}),
    at(3,4000,"realtime.event",{eventType:"input_audio_buffer.speech_started",itemId:"u2",audioStartMs:3500}),
    at(4,5100,"realtime.event",{eventType:"input_audio_buffer.speech_stopped",itemId:"u2",audioEndMs:4500}),
    at(5,7000,"user",{itemId:"u2",text:"Only if the checks pass."}),
    at(6,8000,"user",{itemId:"u1",text:"Fix the build."}),
    at(7,10100,"realtime.event",{eventType:"input_audio_buffer.speech_started",itemId:"u3",audioStartMs:9500}),
    at(8,10200,"user",{itemId:"u3",text:"A separate thought."}),
  ];
  const before = JSON.stringify(input);
  const rows = projectConversation(input);
  assert.deepEqual(rows.map(row=>row.text),["Fix the build. Only if the checks pass.","A separate thought."]);
  assert.deepEqual(rows[0].eventIds,[6,5]);
  assert.equal(JSON.stringify(input),before,"raw records remain unchanged");
});

test("assistant playback separates short user turns but internal work and unplayed generation do not", () => {
  const input = [
    event(1,"user",{text:"Check the build."}),
    event(2,"tool.result",{output:"Internal work"}),
    event(3,"user",{text:"And the tests."}),
    event(4,"speech.lifecycle",{responseId:"a",state:"started"}),
    event(5,"user",{text:"One correction."}),
    event(6,"assistant",{responseId:"a",text:"I will check both."}),
    event(7,"speech.lifecycle",{responseId:"a",state:"interrupted"}),
  ];
  assert.deepEqual(projectConversation(input).filter(row=>row.who === "you").map(row=>row.text),["Check the build. And the tests.","One correction."]);
});


test("missing speech is visible once, separate from actual words, and replaced by a late transcript", () => {
  const events = [event(1,"user",{itemId:"u",text:"Hello"}),
    event(2,"transcription.result",{itemId:"empty",outcome:"empty"}),
    event(3,"transcription.result",{itemId:"empty",outcome:"failed"})];
  const rows = projectConversation(events);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, "Hello");
  assert.equal(rows[1].kind, "failure");
  assert.match(rows[1].text, /no transcript/);
  const recovered = projectConversation([...events,event(4,"user",{itemId:"empty",text:"Check my threads"})]);
  assert.ok(recovered.every(row => row.kind !== "failure"));
  assert.match(recovered.map(row => row.text).join(" "), /Check my threads/);
});
