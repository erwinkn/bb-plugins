import { WorkerSettings } from "./worker-settings.tsx";
// bb-plugin-voice-mode — frontend registration.
//
// Voice is one continuous assistant that lives in the app overlay
// (VoiceController): it holds the WebRTC call, the realtime signals, and the
// native UI controller that drives bb's own workspace (threads, projects,
// drafts, file previews) by voice. There are no voice buttons inside thread
// composers; the composer customization below is invisible and only lends
// each mounted composer to the native UI controller so a draft can be
// prepared in exactly the thread the user asked for. Call controls live in the
// overlay, on the Voice page, in the command palette, and on the keyboard.
import { useSyncExternalStore } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { voiceAgent } from "./voice-agent";
import { VoiceComposerBinding, VoiceController } from "./voice-realtime";
import { SessionsPanel } from "./sessions-panel";
import { AudioSettings, BehaviorSettings, ModelsSettings, ShortcutsSettings } from "./settings-sections";
import { cn } from "@/lib/utils";
import { AUDIO_DEVICE_STORAGE_KEY } from "./audio-devices";
import { useCallElapsed } from "./voice-chrome";
import { matchShortcut } from "./shortcuts";
import { MAC, SHORTCUT_STORAGE_KEY, shortcutStore } from "./shortcut-store";
import "./app.css";

/** Trailing accessory on the Ada sidebar row: a live indicator with duration. */
function SidebarLiveIndicator() {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const elapsed = useCallElapsed();
  if (state === "idle") return null;
  const muted = state === "muted";
  const connecting = state === "connecting";
  return (
    <span
      className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
      title={muted ? "Muted" : connecting ? "Connecting" : "Live"}
    >
      {/* The timer stays one neutral color (it's just call duration, not an
          error). The dot carries the state: pulsing = connecting (in progress),
          solid = live (established), solid red = muted. */}
      <span
        className={cn(
          "size-2 rounded-full",
          connecting
            ? "bg-primary animate-pulse"
            : muted
              ? "bg-destructive"
              : "bg-primary",
        )}
      />
      {connecting ? "\u2026" : elapsed ?? ""}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "voice-controller", component: VoiceController });
  app.contentScripts.register({
    id: "sidebar-options",
    mount() {
      // BB 0.42 owns this menu and has no per-panel visibility option.
      // Scope the override to its stable row key, not the translated title.
      const style = document.createElement("style");
      style.dataset.voiceModeSidebar = "";
      style.textContent = `
        [data-sidebar-navigation-item="voice-mode/sessions"] > .bb-sidebar-hover-actions {
          display: none !important;
        }
        [data-sidebar-navigation-item="voice-mode/sessions"] > [data-plugin-nav-sidebar-accessory] {
          opacity: 1 !important;
        }
      `;
      document.head.append(style);
      return () => style.remove();
    },
  });
  app.slots.settingsSection({
    id: "models",
    title: "Live model & voice",
    component: ModelsSettings,
  });
  app.slots.settingsSection({
    id: "behavior",
    title: "Prompts",
    component: BehaviorSettings,
  });
  app.slots.settingsSection({id:"workers",title:"Workers",component:WorkerSettings});
  app.slots.settingsSection({
    id: "audio",
    title: "Audio",
    component: AudioSettings,
  });
  app.slots.settingsSection({
    id: "shortcuts",
    title: "Keyboard shortcuts",
    component: ShortcutsSettings,
  });
  app.composer.customize({
    id: "aide-voice",
    actions: [{ id: "composer-binding", component: VoiceComposerBinding }],
  });
  app.slots.navPanel({
    id: "sessions",
    title: "Voice",
    icon: "AudioLines",
    path: "sessions",
    component: SessionsPanel,
    experimental_sidebarAccessory: SidebarLiveIndicator,

  });
  app.slots.commandPaletteAction({
    id: "toggle-voice",
    title: "Voice Mode: start/stop voice",
    run: () => voiceAgent.toggleFromSurface(),
  });
  app.slots.commandPaletteAction({
    id: "toggle-mute",
    title: "Voice Mode: mute/unmute",
    isAvailable: () => voiceAgent.getState() === "live" || voiceAgent.getState() === "muted",
    run: () => voiceAgent.toggleMuteFromSurface(),
  });
  // The session deliberately outlives any component, so tie it to the plugin
  // frontend generation instead: on reload/disable the old bundle's singleton
  // would otherwise keep a zombie WebRTC call no button controls.
  app.contentScripts.register({
    id: "aide-voice-lifecycle",
    mount({ signal }) {
      window.addEventListener("storage", (event) => {
        if (event.key === AUDIO_DEVICE_STORAGE_KEY) voiceAgent.refreshAudioPreferences();
        if (event.key === SHORTCUT_STORAGE_KEY) shortcutStore.refresh();
      }, { signal });
      // Keyboard shortcuts (rebindable under Settings → Keyboard shortcuts).
      // Bindings come from the mirror in shortcut-store.ts, so an edit applies
      // without a reload; while the settings page is recording a new combo the
      // listener stands down so the old binding can't fire mid-capture.
      window.addEventListener("keydown", (event) => {
        if (shortcutStore.isRecording()) return;
        const action = matchShortcut(event, MAC, shortcutStore.get());
        if (!action) return;
        event.preventDefault();
        if (action === "toggle") voiceAgent.toggleFromSurface();
        else voiceAgent.toggleMuteFromSurface();
      }, { signal });
      // Release the mic synchronously before the page tears down. Without this,
      // a hard reload (Cmd+R) leaves the previous page holding the input device,
      // so the fresh page enumerates zero microphones until the OS reclaims it.
      window.addEventListener("pagehide", () => voiceAgent.stop(), { signal });
      signal.addEventListener("abort", () => voiceAgent.stop());
      return () => voiceAgent.stop();
    },
  });
});
