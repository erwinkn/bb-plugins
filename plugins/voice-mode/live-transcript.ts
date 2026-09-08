import { z } from "zod";
import type { SessionEvent } from "./session-projection.ts";

export const transcriptItemSchema = z.object({
  key: z.string().max(300), ts: z.number(), kind: z.enum(["user", "assistant"]),
  payload: z.object({
    itemId: z.string().min(1).max(128), text: z.string().max(16000), partial: z.literal(true),
    responseId: z.string().nullable().optional(), requestId: z.string().nullable().optional(), replyId: z.string().nullable().optional(),
    userTurn: z.number().optional(), source: z.string().max(32).optional(),
  }).strict(),
}).strict();
export const transcriptSnapshotSchema = z.object({
  callNonce: z.string().nullable(), revision: z.number().int().nonnegative(),
  items: z.array(transcriptItemSchema).max(32),
}).strict();
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;
export type TranscriptSnapshot = z.infer<typeof transcriptSnapshotSchema>;
export const EMPTY_TRANSCRIPT: TranscriptSnapshot = { callNonce: null, revision: 0, items: [] };

/** Transient snapshots, not one durable event per token. Final events win. */
export function withLiveTranscript(events: readonly SessionEvent[], snapshot: TranscriptSnapshot): SessionEvent[] {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.callId !== snapshot.callNonce) continue;
    try {
      const p = JSON.parse(event.payload);
      if (event.kind === "user" || event.kind === "transcription.result") settled.add(`user:${p.itemId}`);
      if (event.kind === "assistant" && !p.partial) settled.add(`assistant:${p.itemId}`);
    } catch { /* Historical malformed events do not own a draft. */ }
  }
  return [...events, ...snapshot.items.filter(item => !settled.has(item.key)).map((item, index) => ({
    id: index - snapshot.items.length, ts: item.ts, kind: item.kind, payload: JSON.stringify(item.payload), callId: snapshot.callNonce ?? undefined,
  }))];
}

export class TranscriptBuffer {
  private items = new Map<string, TranscriptItem>();
  private completed = new Set<string>();
  private eventIds = new Set<string>();
  private revision = 0;
  reset() { this.items.clear(); this.completed.clear(); this.eventIds.clear(); this.revision = 0; }
  delta(kind: TranscriptItem["kind"], itemId: string, delta: string, ts: number, identity: Omit<TranscriptItem["payload"], "itemId" | "text" | "partial"> = {}, eventId?: string): TranscriptItem | null {
    const key = `${kind}:${itemId}`;
    if (!itemId || !delta || this.completed.has(key) || (eventId && this.eventIds.has(eventId))) return null;
    if (eventId) { this.eventIds.add(eventId); if (this.eventIds.size > 2000) this.eventIds.delete(this.eventIds.values().next().value!); }
    const prior = this.items.get(key);
    const item: TranscriptItem = { key, ts: prior?.ts ?? ts, kind, payload: { ...prior?.payload, ...identity, itemId, text: ((prior?.payload.text ?? "") + delta).slice(0, 16000), partial: true } };
    this.items.set(key, item); this.revision++;
    if (this.items.size > 32) this.items.delete(this.items.keys().next().value!);
    return item;
  }
  complete(kind: TranscriptItem["kind"], itemId: string) {
    this.completed.add(`${kind}:${itemId}`);
    if (this.completed.size > 1000) this.completed.delete(this.completed.values().next().value!);
  }
  remove(kind: TranscriptItem["kind"], itemId: string) { if (this.items.delete(`${kind}:${itemId}`)) this.revision++; }
  unfinished(): TranscriptItem[] { return [...this.items.values()].filter(item => !this.completed.has(item.key)); }
  snapshot(callNonce: string): TranscriptSnapshot { return { callNonce, revision: this.revision, items: [...this.items.values()] }; }
}
