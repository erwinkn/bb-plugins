// Versioned envelopes exchanged between the voice bridge, the hidden BB
// coordinator thread, and the plugin server. Every envelope is validated at
// the plugin boundary; nothing here trusts the realtime model, the coordinator
// model, or persisted rows blindly.
import { z } from "zod";
import { quickActionSchema } from "../quick-actions.ts";

export const ENVELOPE_VERSION = 1 as const;

/** Bounded view snapshot: what the user was looking at when they spoke. */
export const viewSnapshotSchema = z
  .object({
    threadId: z.string().max(128).nullable(),
    projectId: z.string().max(128).nullable(),
    onNewThreadScreen: z.boolean(),
  })
  .strict();

export const transcriptItemSchema = z
  .object({
    itemId: z.string().min(1).max(128),
    /** Null when transcription failed or never completed for this item. */
    text: z.string().max(4000).nullable(),
  })
  .strict();

/**
 * A user request handed from the realtime voice session to the coordinator.
 * `originalText` is the user's own words from input transcription. The voice
 * model's reading of them lives in `interpretation` and is never presented as
 * user text.
 */
export const userRequestEnvelopeSchema = z
  .object({
    v: z.literal(ENVELOPE_VERSION),
    conversationId: z.string().min(1).max(64),
    callNonce: z.string().min(1).max(256),
    callSequence: z.number().int().nonnegative(),
    requestId: z.string().min(1).max(64),
    /** Committed user audio items this request binds to, oldest first. */
    utteranceItemIds: z.array(z.string().min(1).max(128)).max(20),
    transcriptRevision: z.number().int().nonnegative(),
    /** True when every bound item has a completed transcript. */
    transcriptAvailable: z.boolean(),
    /** The user's own words for the bound items, joined in order. */
    originalText: z.string().max(8000),
    /** Earlier utterances since the previous handoff, for context/corrections. */
    transcriptDelta: z.array(transcriptItemSchema).max(20),
    interpretation: z.string().max(2000).nullable(),
    urgency: z.enum(["new", "steer", "after_current"]),
    /** Set when the user is answering a coordinator question by voice. */
    answersQuestionId: z.string().max(64).nullable(),
    view: viewSnapshotSchema,
    quickAction: quickActionSchema.optional(),
  })
  .strict();
export type UserRequestEnvelope = z.infer<typeof userRequestEnvelopeSchema>;

export const actionReceiptSchema = z
  .object({
    action: z.string().min(1).max(80),
    thread_id: z.string().max(128).optional(),
    outcome: z.enum(["done", "pending", "failed", "unknown"]),
    note: z.string().max(400).optional(),
  })
  .strict();
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;

export const REPLY_KINDS = [ "assigned", "blocked", "final", "clarification", "silent"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/** Parameters of the coordinator-only `voice_reply` tool. */
export const voiceReplyParamsSchema = z
  .object({
    request_id: z.string().max(64).optional(),
    batch_id: z.string().max(64).optional(),
    kind: z.enum(REPLY_KINDS),
    /** What to say. Empty for silent results. */
    speech: z.string().max(1200).default(""),
    detail: z.string().max(4000).optional(),
    thread_ids: z.array(z.string().min(1).max(128)).max(20).optional(),
    receipts: z.array(actionReceiptSchema).max(20).optional(),
    state: z
      .object({
        topic: z.string().max(200).optional(),
        discussed_thread_id: z.string().max(128).optional(),
        watch_add: z.array(z.string().min(1).max(128)).max(20).optional(),
        watch_remove: z.array(z.string().min(1).max(128)).max(20).optional(),
        authorized_scope: z.string().max(400).optional(),
      })
      .strict()
      .optional(),

  })
  .strict();
export type VoiceReplyParams = z.infer<typeof voiceReplyParamsSchema>;

/** Parameters of the coordinator-only `voice_ask` tool. */
export const voiceAskParamsSchema = z
  .object({
    request_id: z.string().max(64).optional(),
    question: z.string().min(1).max(600),
    options: z.array(z.string().min(1).max(120)).min(2).max(6).optional(),
    allow_free_text: z.boolean().default(true),
  })
  .strict();
export type VoiceAskParams = z.infer<typeof voiceAskParamsSchema>;

/**
 * A reply as published to the voice bridge. Identity and sequence come from
 * the bridge, never from the coordinator; `source` says whether the
 * coordinator authored it, the bridge derived it from final assistant text,
 * or the bridge wrote it (failures, re-asked questions).
 */
export const REPLY_SOURCES = ["tool", "fallback", "bridge"] as const;
export const DELIVERY_STATES = ["pending", "generated", "playing", "delivered", "interrupted", "partial", "superseded", "held", "deferred", "silent", "mismatch"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const publishedReplySchema = z
  .object({
    v: z.literal(ENVELOPE_VERSION),
    replyId: z.string(),
    conversationId: z.string(),
    seq: z.number().int(),
    requestId: z.string().nullable(),
    batchId: z.string().nullable(),
    questionId: z.string().nullable(),
    kind: z.enum([...REPLY_KINDS, "progress", "update", "failure"]),
    source: z.enum(REPLY_SOURCES),
    speech: z.string(),
    detail: z.string().nullable(),
    threadIds: z.array(z.string()),
    receipts: z.array(actionReceiptSchema),
    /** Call the reply is addressed to; null when no call is active. */
    targetCallNonce: z.string().nullable(),
    createdAt: z.number(),
  })
  .strict();
export type PublishedReply = z.infer<typeof publishedReplySchema>;

export function truncateSpeech(text: string, max = 400): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const prefix = normalized.slice(0, max);
  const sentenceEnd = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "));
  return `${prefix.slice(0, sentenceEnd >= max / 2 ? sentenceEnd + 1 : max).trimEnd()}…`;
}

/**
 * The message the coordinator receives for one user request. Original words
 * come first and are labelled as the user's; the voice model's interpretation
 * is labelled separately so the coordinator never mistakes it for user text.
 */
export function formatRequestMessage(envelope: UserRequestEnvelope, extras: {
  omitContext?: boolean;
  preferences?: string;
  questionText?: string | null;
  latestAnnouncement?: { threadIds: string[]; text: string; delivery: string } | null;
  discussedThreadId?: string | null;
  topic?: string | null;
}): string {
  const items = envelope.transcriptDelta.map(item => ({id:item.itemId,text:item.text}));
  const currentText = items.filter(item=>envelope.utteranceItemIds.includes(item.id)).map(item=>item.text ?? "").join(" ");
  const data = {
    request_id: envelope.requestId,
    user: {items, ...(currentText === envelope.originalText ? {} : {text:envelope.originalText}), complete:envelope.transcriptAvailable},
    ...(envelope.interpretation ? {model_interpretation:envelope.interpretation} : {}),
    urgency:envelope.urgency,
    ...(!extras.omitContext && extras.preferences ? {user_preferences:extras.preferences} : {}),
    ...(envelope.answersQuestionId ? {answer_to:{id:envelope.answersQuestionId,question:extras.questionText ?? null}} : {}),
    ...(extras.omitContext ? {context:"unchanged"} : {view:envelope.view}),
    ...(!extras.omitContext && extras.topic ? {topic:extras.topic} : {}),
    ...(!extras.omitContext && extras.discussedThreadId ? {discussed_thread:extras.discussedThreadId} : {}),
    ...(!extras.omitContext && extras.latestAnnouncement ? {heard:extras.latestAnnouncement} : {}),
  };
  return `[voice request ${envelope.requestId}]\n${JSON.stringify(data)}${envelope.transcriptAvailable ? "" : "\nIncomplete transcript: ask before any destructive action."}`;
}

export interface DigestUpdate {
  id: string;
  threadId: string;
  title: string;
  kind: string;
  detail: string | null;
}

/** The message that opens a separate digest turn on the coordinator. */
export function formatDigestMessage(batchId: string, updates: DigestUpdate[]): string {
  return `[background updates batch ${batchId}]\n${JSON.stringify({batch_id:batchId,updates:updates.map(update=>({id:update.id,thread:update.threadId,title:update.title,state:update.kind,detail:update.detail}))})}`;
}
