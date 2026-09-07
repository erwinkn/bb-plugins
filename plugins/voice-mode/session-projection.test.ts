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
