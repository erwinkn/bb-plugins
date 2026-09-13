import { z } from "zod";

/**
 * Voice's per-thread plugin metadata namespace (plugin id `voice-mode`),
 * seeded when Voice spawns a worker or visible thread. It records provenance
 * only: which voice conversation and operation created the thread, the worker
 * profile it launched with, and, for a handoff, the source thread and the
 * event sequence the copied context ended at. The operation store stays
 * authoritative for receipts, delivery, and task state; nothing reads this
 * back to grant authorization.
 */
export const VOICE_THREAD_METADATA_VERSION = 1;
export const voiceThreadMetadataSchema = z.object({
  version: z.literal(VOICE_THREAD_METADATA_VERSION),
  conversationId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  profileId: z.string().min(1).max(64),
  handoff: z.object({
    sourceThreadId: z.string().min(1).max(200),
    /** The source thread's event sequence at which the copied context ends. */
    contextBoundary: z.number().int().nonnegative(),
  }).optional(),
}).strict();
export type VoiceThreadMetadata = z.infer<typeof voiceThreadMetadataSchema>;

export function voiceThreadMetadata(input: { conversationId: string; operationId: string; profileId: string; handoff?: { sourceThreadId: string; contextBoundary: number } }): VoiceThreadMetadata {
  return voiceThreadMetadataSchema.parse({ version: VOICE_THREAD_METADATA_VERSION, ...input });
}

/** Metadata is untrusted input: any client or the thread's agent can write the namespace. */
export function readVoiceThreadMetadata(value: unknown): VoiceThreadMetadata | null {
  const parsed = voiceThreadMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
