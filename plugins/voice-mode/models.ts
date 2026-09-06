// Shared between server.ts and the frontend (plain data, no dependencies).
export const MODEL_OPTIONS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
export type RealtimeModel = (typeof MODEL_OPTIONS)[number];
export const DEFAULT_MODEL: RealtimeModel = "gpt-realtime-2.1";

// OpenAI Realtime voices. marin and cedar are the high-quality voices shipped
// with gpt-realtime; the rest are the classic set. Listed recommended-first so
// the picker leads with the best options.
export const VOICE_OPTIONS = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;
export type Voice = (typeof VOICE_OPTIONS)[number];
export const DEFAULT_VOICE: Voice = "marin";
// Voices we surface as "Recommended" in the picker.
export const RECOMMENDED_VOICES: readonly Voice[] = ["marin", "cedar"];

export function isVoice(value: unknown): value is Voice {
  return typeof value === "string" && (VOICE_OPTIONS as readonly string[]).includes(value);
}
export function isModel(value: unknown): value is RealtimeModel {
  return typeof value === "string" && (MODEL_OPTIONS as readonly string[]).includes(value);
}
