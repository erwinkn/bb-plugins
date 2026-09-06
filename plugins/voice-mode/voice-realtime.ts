import { useRealtime } from "@get-bb/plugin-sdk/app";
import { voiceAgent } from "./voice-agent";

/** Every surface that can own a call subscribes to the same control channels. */
export function useVoiceRealtime() {
  useRealtime("voice-call", (payload) => {
    const claim = payload as { nonce?: unknown; sequence?: unknown } | null;
    if (typeof claim?.nonce === "string") voiceAgent.onCallStarted(claim.nonce, typeof claim.sequence === "number" ? claim.sequence : undefined);
  });
  useRealtime("voice-mute", (payload) => {
    const muted = (payload as { muted?: unknown } | null)?.muted;
    if (typeof muted === "boolean") voiceAgent.setMuted(muted);
  });
  useRealtime("voice-presence", (payload) => voiceAgent.ingestPresence(payload));
  useRealtime("voice-command", (payload) => voiceAgent.applyVoiceCommand(payload));
  useRealtime("voice-presence-query", () => voiceAgent.answerPresenceQuery());
  useRealtime("aide-thread-event", (payload) => {
    const event = payload as { kind?: unknown; threadId?: unknown; title?: unknown; detail?: unknown } | null;
    if (typeof event?.kind === "string" && typeof event.threadId === "string" && typeof event.title === "string") {
      voiceAgent.enqueueThreadEvent({
        kind: event.kind, threadId: event.threadId, title: event.title,
        detail: typeof event.detail === "string" ? event.detail : null,
      });
    }
  });
}
