// Typed projection of a logical voice session's raw event log into one
// conversation: the user's words and one assistant message per correlated
// response or coordinator reply. Internal handoffs, tools, receipts, and
// diagnostics stay out; the raw records are untouched and remain available in
// the Diagnostics tab.
//
// Correlation uses identities only (responseId, replyId, itemId). Text is
// never used to merge two records. Legacy speech without identities stays
// separate, with unknown delivery. Delivery is reported honestly:
// generation is not playback, and an unknown state stays "unknown".

export interface SessionEvent {
  id: number;
  ts: number;
  kind: string;
  payload: string;
  /** Physical call the event belongs to; absent on older per-call records. */
  callId?: string;
}

export type Delivery = "delivered" | "interrupted" | "unplayed" | "unknown";
export type MessageSource = "realtime" | "coordinator" | "bridge" | "unknown";
export type MessageKind = "speech" | "acknowledgment" | "answer" | "question" | "update" | "failure" | "progress";

export interface ConversationMessage {
  /** Stable key: the correlating identity when known, else the raw event id. */
  id: string;
  who: "you" | "aide";
  text: string;
  ts: number;
  callId: string | null;
  /** Null for the user's own words. */
  delivery: Delivery | null;
  source: MessageSource;
  kind: MessageKind;
  /** Raw event ids folded into this message, for cross-reference. */
  eventIds: number[];
  /** True when correlation relied on an open reply window plus identical text. */
  attributedByWindow?: boolean;
}

function parse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function replyKind(kind: unknown): MessageKind {
  switch (kind) {
    case "clarification": return "question";
    case "update": return "update";
    case "failure": return "failure";
    case "progress": return "progress";
    case "final": return "answer";
    default: return "speech";
  }
}

interface AssistantDraft {
  message: ConversationMessage;
  /** itemId → text, so a repeated event for one item replaces instead of appending. */
  parts: Map<string, string>;
  order: string[];
  lifecycle: "none" | "started" | "delivered" | "interrupted";
  /** Set when a bridge reply's requested speech is the only text source so far. */
  requestedSpeech: string | null;
  /** Legacy bridge window: still open until a settle event arrives. */
  open: boolean;
}

/** A transcript boundary, independent of the provider's short audio VAD. */
export const USER_MESSAGE_PAUSE_MS = 5000;

function groupUserMessages(messages: ConversationMessage[], events: readonly SessionEvent[]): ConversationMessage[] {
  const key = (call: string | null, id: string) => JSON.stringify([call, id]);
  const boundaries = new Map<string, { start?: number; end?: number; audioStart?: number; audioEnd?: number }>();
  const itemByEvent = new Map<number, string>();
  const speechStarts = new Map<string | null, number[]>();
  const playbackIds = new Set<string>();
  for (const event of events) {
    const p = parse(event.payload), call = event.callId ?? null;
    if (event.kind === "speech.lifecycle" && str(p.responseId)) playbackIds.add(key(call, String(p.responseId)));
    if (event.kind === "speech.lifecycle" && p.state === "started") speechStarts.set(call, [...(speechStarts.get(call) ?? []), event.ts]);
    const id = str(p.itemId);
    if (id && event.kind === "user") itemByEvent.set(event.id, key(call, id));
    if (!id || event.kind !== "realtime.event") continue;
    const itemKey = key(call, id), boundary = boundaries.get(itemKey) ?? {};
    if (p.eventType === "input_audio_buffer.speech_started") {
      boundary.start = event.ts;
      if (typeof p.audioStartMs === "number") boundary.audioStart = p.audioStartMs;
    } else if (p.eventType === "input_audio_buffer.speech_stopped") {
      boundary.end = event.ts;
      if (typeof p.audioEndMs === "number") boundary.audioEnd = p.audioEndMs;
    }
    boundaries.set(itemKey, boundary);
  }
  // Older recordings lack playback events. Their assistant transcript is a
  // conservative boundary; it never supplies invented playback evidence.
  for (const event of events) {
    if (event.kind !== "assistant" && event.kind !== "notice") continue;
    const p = parse(event.payload), call = event.callId ?? null;
    if (!str(p.text) || (str(p.responseId) && playbackIds.has(key(call, String(p.responseId))))) continue;
    speechStarts.set(call, [...(speechStarts.get(call) ?? []), event.ts]);
  }
  const users = messages.filter(message => message.who === "you").map(message => {
    const boundary = boundaries.get(itemByEvent.get(message.eventIds[0]) ?? "");
    return { message, start: boundary?.start ?? message.ts, end: boundary?.end ?? message.ts, boundary };
  }).sort((a,b) => a.start - b.start || a.message.eventIds[0] - b.message.eventIds[0]);
  const grouped: ConversationMessage[] = [];
  let previous: typeof users[number] | undefined;
  for (const current of users) {
    const call = current.message.callId;
    const gap = previous?.boundary?.audioEnd !== undefined && current.boundary?.audioStart !== undefined
      ? current.boundary.audioStart - previous.boundary.audioEnd : current.start - (previous?.end ?? current.start);
    const previousStart = previous?.start;
    const answered = previousStart !== undefined && (speechStarts.get(call) ?? []).some(ts => ts >= previousStart && ts <= current.start);
    if (previous && previous.message.callId === call && gap >= 0 && gap < USER_MESSAGE_PAUSE_MS && !answered) {
      const group = grouped.at(-1)!;
      group.text += ` ${current.message.text}`;
      group.eventIds.push(...current.message.eventIds);
    } else {
      grouped.push({ ...current.message, ts: current.start, eventIds: [...current.message.eventIds] });
    }
    previous = current;
  }
  return [...messages.filter(message => message.who !== "you"), ...grouped]
    .sort((a,b) => a.ts - b.ts || a.eventIds[0] - b.eventIds[0]);
}

/**
 * Build the conversation. Events may arrive out of order (late transcript
 * after a lifecycle settle); everything is correlated by identity and then
 * sorted by first-seen time.
 */
export function projectConversation(events: readonly SessionEvent[]): ConversationMessage[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const messages: ConversationMessage[] = [];
  const responseReplies = new Map<string,string>();
  for (const event of sorted) {
    const p = parse(event.payload);
    const responseId = str(p.responseId), replyId = str(p.replyId);
    if (responseId && replyId) responseReplies.set(responseId,replyId);
  }
  const byResponse = new Map<string, AssistantDraft>();
  const byReply = new Map<string, AssistantDraft>();
  /** Bridge replies started but not yet settled, newest last (legacy attribution). */
  const openReplies: AssistantDraft[] = [];
  const legacyCalls = new Set(sorted.filter(event => event.kind === "assistant" && !str(parse(event.payload).responseId) && !str(parse(event.payload).replyId)).map(event=>event.callId ?? null));

  const draft = (id: string, ts: number, callId: string | null, source: MessageSource, kind: MessageKind): AssistantDraft => {
    const message: ConversationMessage = { id, who: "aide", text: "", ts, callId, delivery: "unknown", source, kind, eventIds: [] };
    messages.push(message);
    return { message, parts: new Map(), order: [], lifecycle: "none", requestedSpeech: null, open: false };
  };
  const setText = (d: AssistantDraft) => {
    const joined = d.order.map((key) => d.parts.get(key) ?? "").filter(Boolean).join(" ").trim();
    d.message.text = joined || d.requestedSpeech || "";
  };
  const addPart = (d: AssistantDraft, key: string, text: string, eventId: number) => {
    if (!d.parts.has(key)) d.order.push(key);
    d.parts.set(key, text);
    d.message.eventIds.push(eventId);
    setText(d);
  };
  const settle = (d: AssistantDraft, state: "started" | "delivered" | "interrupted", eventId: number) => {
    // Never let a late "started" or a repeated event downgrade a settled state.
    if (state === "started" && d.lifecycle !== "none") { d.message.eventIds.push(eventId); return; }
    if (state !== "started" && d.lifecycle === "interrupted") { d.message.eventIds.push(eventId); return; }
    d.lifecycle = state;
    d.message.eventIds.push(eventId);
    if (state !== "started") {
      d.open = false;
      const index = openReplies.indexOf(d);
      if (index >= 0) openReplies.splice(index, 1);
    }
  };
  const forResponse = (responseId: string, ts: number, callId: string | null, source: MessageSource, kind: MessageKind): AssistantDraft => {
    let d = byResponse.get(responseId);
    if (!d) { const replyId = responseReplies.get(responseId); d = replyId ? forReply(replyId, ts, callId, kind) : draft(`response:${responseId}`, ts, callId, source, kind); byResponse.set(responseId, d); }
    return d;
  };
  const forReply = (replyId: string, ts: number, callId: string | null, kind: MessageKind): AssistantDraft => {
    let d = byReply.get(replyId);
    if (!d) { d = draft(`reply:${replyId}`, ts, callId, "coordinator", kind); byReply.set(replyId, d); }
    return d;
  };

  for (const event of sorted) {
    const p = parse(event.payload);
    const callId = event.callId ?? null;
    switch (event.kind) {
      case "user": {
        const text = str(p.text);
        if (!text?.trim()) break;
        messages.push({ id: `user:${event.id}`, who: "you", text, ts: event.ts, callId, delivery: null, source: "realtime", kind: "speech", eventIds: [event.id] });
        break;
      }
      case "notice": {
        const text = str(p.text);
        if (!text) break;
        messages.push({ id: `notice:${event.id}`, who: "aide", text, ts: event.ts, callId, delivery: "unknown", source: "bridge", kind: "update", eventIds: [event.id] });
        break;
      }
      case "reply.speaking": {
        const replyId = str(p.replyId);
        if (!replyId) break;
        // Bridge-owned acknowledgments are real speech; they show as such.
        const ack = replyId.startsWith("local_ack_") || p.source === "bridge" && p.kind === "acknowledgment";
        const d = forReply(replyId, event.ts, callId, ack ? "acknowledgment" : replyKind(p.kind));
        if (ack || p.source === "bridge") d.message.source = "bridge";
        d.requestedSpeech = str(p.text) ?? d.requestedSpeech;
        d.message.eventIds.push(event.id);
        d.open = true;
        if (!openReplies.includes(d)) openReplies.push(d);
        setText(d);
        break;
      }
      case "reply.playing":
      case "reply.delivered":
      case "reply.interrupted":
      case "reply.superseded": {
        const replyId = str(p.replyId);
        if (!replyId) break;
        const d = forReply(replyId, event.ts, callId, replyKind(p.kind));
        settle(d, event.kind === "reply.playing" ? "started" : event.kind === "reply.delivered" ? "delivered" : "interrupted", event.id);
        break;
      }
      case "speech.lifecycle": {
        const responseId = str(p.responseId);
        const replyId = str(p.replyId);
        const state = p.state === "started" || p.state === "delivered" || p.state === "interrupted" ? p.state : null;
        if (!state) break;
        const source: MessageSource = p.source === "coordinator" || p.source === "bridge" || p.source === "realtime" ? p.source : replyId ? "coordinator" : "realtime";
        let d: AssistantDraft | null = null;
        if (replyId && byReply.has(replyId)) d = byReply.get(replyId)!;
        else if (responseId) d = forResponse(responseId, event.ts, callId, source, replyId ? "answer" : "speech");
        else if (replyId) d = forReply(replyId, event.ts, callId, "answer");
        if (!d) break;
        if (responseId && replyId && !byResponse.has(responseId)) byResponse.set(responseId, d);
        settle(d, state, event.id);
        break;
      }
      case "assistant": {
        const text = str(p.text);
        if (!text) break;
        const responseId = str(p.responseId);
        const replyId = str(p.replyId);
        const itemId = str(p.itemId) ?? `event:${event.id}`;
        const source: MessageSource = p.source === "coordinator" || p.source === "bridge" || p.source === "realtime" ? p.source : replyId ? "coordinator" : responseId ? "realtime" : "unknown";
        const kind: MessageKind = replyId ? "answer" : str(p.requestId) && source === "realtime" ? "acknowledgment" : "speech";
        if (replyId) {
          const d = forReply(replyId, event.ts, callId, kind);
          if (responseId && !byResponse.has(responseId)) byResponse.set(responseId, d);
          d.message.source = p.source === "acknowledgment" ? "bridge" : source;
          if (p.source === "acknowledgment") d.message.kind = "acknowledgment";
          addPart(d, itemId, text, event.id);
          break;
        }
        if (responseId) {
          const d = forResponse(responseId, event.ts, callId, source, kind);
          addPart(d, itemId, text, event.id);
          break;
        }
        // Legacy transcript has no reliable playback identity.
        const message: ConversationMessage = { id: `assistant:${event.id}`, who: "aide", text, ts: event.ts, callId, delivery: "unknown", source: "unknown", kind: "speech", eventIds: [event.id] };
        messages.push(message);
        break;
      }
      default:
        break;
    }
  }

  for (const d of [...byResponse.values(), ...byReply.values()]) {
    const message = d.message;
    if (d.lifecycle === "delivered") message.delivery = "delivered";
    else if (d.lifecycle === "interrupted") message.delivery = "interrupted";
    else if (d.lifecycle === "started") message.delivery = "unknown";
    else message.delivery = "unknown";
    if (d.parts.size === 0 && legacyCalls.has(message.callId)) message.text = "";
  }
  const seen = new Set<string>();
  return groupUserMessages(messages
    .filter((message) => message.text.length > 0 && !seen.has(message.id) && seen.add(message.id))
    .sort((a, b) => a.ts - b.ts || (a.eventIds[0] ?? 0) - (b.eventIds[0] ?? 0)), sorted);
}

/** Kinds that the Conversation view never shows; everything is in Diagnostics. */
export const INTERNAL_EVENT_PREFIXES = ["tool.", "handoff.", "reply.received", "reply.deferred", "updates.", "session.", "conn.", "audio.", "mic.", "page.", "coordinator.", "client.", "nav.", "notice.deferred"];

export function describeDelivery(delivery: Delivery | null): string | null {
  switch (delivery) {
    case "interrupted": return "Interrupted before the end";
    case "unplayed": return "Generated but not played";
    case "unknown": return "Playback not recorded";
    default: return null;
  }
}
