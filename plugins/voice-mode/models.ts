// Shared between server.ts and the frontend (plain data, no dependencies).
export const MODEL_OPTIONS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-live-1"] as const;
export type RealtimeModel = (typeof MODEL_OPTIONS)[number];
export const DEFAULT_MODEL: RealtimeModel = "gpt-realtime-2.1";

/**
 * Which OpenAI session contract a voice model uses. Realtime models speak,
 * reason, and call tools in one session; gpt-live-1 is a full-duplex voice
 * layer that delegates reasoning and tool calls to a backend model.
 */
export type VoiceEngine = "realtime" | "live";
export function engineForModel(model: RealtimeModel): VoiceEngine {
  return model === "gpt-live-1" ? "live" : "realtime";
}

/** Streaming input transcription inside realtime sessions. */
export const TRANSCRIPTION_MODEL = "gpt-live-transcribe";

// The Responses backend a gpt-live-1 session delegates reasoning and tool
// calls to. Terra is OpenAI's recommended balance; Luna is the cheaper,
// faster option; Astra is the deeper reasoner.
export const LIVE_BACKEND_OPTIONS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"] as const;
export type LiveBackend = (typeof LIVE_BACKEND_OPTIONS)[number];
export const DEFAULT_LIVE_BACKEND: LiveBackend = "gpt-5.6-terra";

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

// GPT-Live voices. The twelve new voices are documented for gpt-live-1;
// marin is the shared Live default and also valid there.
export const LIVE_VOICE_OPTIONS = [
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "bossa",
  "tempo",
  "beacon",
  "delta",
  "cinder",
  "marin",
] as const;
export type LiveVoice = (typeof LIVE_VOICE_OPTIONS)[number];
export const DEFAULT_LIVE_VOICE: LiveVoice = "quartz";

export function isVoice(value: unknown): value is Voice {
  return typeof value === "string" && (VOICE_OPTIONS as readonly string[]).includes(value);
}
export function isLiveVoice(value: unknown): value is LiveVoice {
  return typeof value === "string" && (LIVE_VOICE_OPTIONS as readonly string[]).includes(value);
}
export function isModel(value: unknown): value is RealtimeModel {
  return typeof value === "string" && (MODEL_OPTIONS as readonly string[]).includes(value);
}
export function isLiveBackend(value: unknown): value is LiveBackend {
  return typeof value === "string" && (LIVE_BACKEND_OPTIONS as readonly string[]).includes(value);
}
