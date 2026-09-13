// Shared voice-call chrome: the waveform/mic/stop icons and the live-duration
// ticker, used by the composer button, on-page call console, and mobile
// drawer so every surface speaks the same visual
// language — neutral chrome, activity color only on the waveform.
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { voiceAgent } from "./voice-agent";
import { cn } from "@/lib/utils";
import { HostIcon } from "./lib/host-icon";

export function WaveformIcon({ live }: { live: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4", live && "aide-wave-live")}
      fill="currentColor"
      aria-hidden
    >
      <rect className="aide-bar" x="1.5" y="6" width="1.8" height="4" rx="0.9" />
      <rect className="aide-bar" x="4.9" y="3.5" width="1.8" height="9" rx="0.9" />
      <rect className="aide-bar" x="8.3" y="1.5" width="1.8" height="13" rx="0.9" />
      <rect className="aide-bar" x="11.7" y="4.5" width="1.8" height="7" rx="0.9" />
    </svg>
  );
}

/** The host microphone; muted adds a diagonal slash over it (the registry has no MicOff). */
export function MicIcon({ slashed }: { slashed: boolean }) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <HostIcon name="Mic" className="size-4" />
      {slashed ? (
        <svg viewBox="0 0 16 16" className="absolute inset-0 size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <path d="M2.5 2.5l11 11" />
        </svg>
      ) : null}
    </span>
  );
}

/** The host stop square, filled — ends the voice session. */
export function StopIcon() {
  return <HostIcon name="Square" className="size-3.5 fill-current" />;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Live call duration as m:ss, ticking each second; null when no live call. */
export function useCallElapsed(): string | null {
  const startedAt = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getLiveStartedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt == null ? null : formatElapsed(now - startedAt);
}

/** Controls for an existing call. Mounting/unmounting never starts or stops it. */
export function LiveCallControls() {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const remoteLabel = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getRemoteCallLabel);
  const activity = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getActivity);
  const micSuspended = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getMicSuspended);
  const elapsed = useCallElapsed();
  const muted = state === "muted";
  const connecting = state === "connecting" || state === "reconnecting";
  if (state === "idle") return null;
  if (remoteLabel) return (
    <div className="voice-call-controls flex min-h-11 max-w-full items-center gap-2 rounded-md border border-border bg-background px-3">
      <span className="min-w-0 text-xs text-muted-foreground">{remoteLabel}</span>
      <button type="button" onClick={() => voiceAgent.switchToThisDevice()}
        aria-label="Switch voice call to this device"
        title="Move this conversation here. The other device will disconnect."
        className="min-h-11 shrink-0 px-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        Switch here
      </button>
    </div>
  );

  const speaking = activity === "aide";
  const listening = activity === "you";
  const activityColor = micSuspended
    ? "text-destructive" // uplink down (iOS backgrounded the mic)
    : speaking
      ? "text-[color:var(--success,#6faf76)]" // Ada
      : listening
        ? "text-foreground" // you
        : "text-muted-foreground/70";
  const label = state === "reconnecting" ? "Reconnecting…" : connecting
    ? "Connecting…"
    : micSuspended
      ? "Mic paused"
      : speaking
        ? "Ada speaking…"
        : listening
          ? "Listening…"
          : muted
            ? "Muted"
            : "Connected";

  return (
    <div className="voice-call-controls flex h-11 max-w-full items-center overflow-hidden rounded-md border border-border bg-background">
      <button
        type="button"
        aria-label={muted ? "Unmute Ada microphone" : "Mute Ada microphone"}
        title={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
        disabled={connecting}
        onClick={() => voiceAgent.toggleMuteFromSurface()}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center transition-colors disabled:opacity-50",
          muted
            ? "text-destructive hover:bg-destructive/15"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <MicIcon slashed={muted} />
      </button>
      <span className="h-5 w-px bg-border" />
      <span className="flex min-w-0 items-center gap-2 px-3">
        <span className={cn("flex shrink-0 items-center", activityColor)} title={label} aria-label={label}>
          <WaveformIcon live={speaking || listening} />
        </span>
        <span className="truncate text-sm text-foreground">{label}</span>
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{elapsed ?? ""}</span>
      </span>
      <span className="h-5 w-px bg-border" />
      <button
        type="button"
        aria-label="Stop Ada voice session"
        title="Stop"
        onClick={() => voiceAgent.stopFromSurface()}
        className="flex size-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
      >
        <StopIcon />
      </button>
    </div>
  );
}
