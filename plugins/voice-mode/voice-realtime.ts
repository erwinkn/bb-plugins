import { useEffect } from "react";
import { useRealtime, useRpc, useBbNavigate, experimental_useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { voiceAgent } from "./voice-agent";
import type { rpcContract } from "./server";

/** One app-wide owner keeps call controls and RPC alive across route changes. */
export function VoiceController() {
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
  useRealtime("voice-reply", (payload) => voiceAgent.ingestCoordinatorSignal("voice-reply", payload));
  useRealtime("voice-inbox", (payload) => voiceAgent.ingestCoordinatorSignal("voice-inbox", payload));
  useRealtime("voice-question", (payload) => voiceAgent.ingestCoordinatorSignal("voice-question", payload));
  useRealtime("aide-thread-event", (payload) => {
    const event = payload as { kind?: unknown; threadId?: unknown; title?: unknown; detail?: unknown } | null;
    if (typeof event?.kind === "string" && typeof event.threadId === "string" && typeof event.title === "string") {
      voiceAgent.enqueueThreadEvent({
        kind: event.kind, threadId: event.threadId, title: event.title,
        detail: typeof event.detail === "string" ? event.detail : null,
      });
    }
  });
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const sidebarActions = experimental_useSidebarThreadActions();
  useEffect(() => voiceAgent.bindGlobal({
    rpc,
    openVoice: () => navigate.toPluginPanel("sessions"),
    context: { threadId: null, projectId: null, onNewThreadScreen: false },
    openNewThread: (projectId) => sidebarActions.openNewThread({ ...(projectId ? { projectId } : {}), focusPrompt: true }),
  }), [rpc, sidebarActions, navigate]);
  return null;
}
