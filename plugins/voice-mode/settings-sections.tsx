import { PromptEditor } from "./prompt-editor";
export { PromptEditor } from "./prompt-editor";
// bb-plugin-voice-mode — polished settings sections.
//
// The host renders a single declarative field (the secret OpenAI API key) and
// then these custom sections below it. Everything the user tunes day-to-day —
// which model and voice to use, the prompts, the microphone,
// and the keyboard shortcuts — lives here as curated sections
// instead of a flat auto-form.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_LIVE_BACKEND,
  DEFAULT_LIVE_VOICE,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  LIVE_BACKEND_OPTIONS,
  LIVE_VOICE_OPTIONS,
  MODEL_OPTIONS,
  VOICE_OPTIONS,
  engineForModel,
  isLiveBackend,
  isLiveVoice,
  isModel,
  isVoice,
  type LiveBackend,
  type LiveVoice,
  type RealtimeModel,
  type Voice,
} from "./models";
import { voiceAgent } from "./voice-agent";
import { deviceDisplayLabel } from "./audio-devices";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_LABELS,
  comboFromEvent,
  formatShortcut,
  isModifierKey,
  sameShortcut,
  shortcutLabel,
  shortcutLabelParts,
  shortcutProblem,
  type ShortcutAction,
  type Shortcuts,
} from "./shortcuts";
import { MAC, shortcutStore } from "./shortcut-store";
import { cn } from "@/lib/utils";

type CredentialPreference = "auto" | "apiKey" | "subscription";

interface VoiceConfig {
  model: RealtimeModel;
  voice: Voice;
  liveVoice: LiveVoice;
  liveBackend: LiveBackend;
  credentialPreference: CredentialPreference;
  shortcuts: Shortcuts;
}

/**
 * Shared kv-backed config, fetched over rpc and kept live across windows via
 * the `config-changed` signal. `update` is optimistic and reconciles with the
 * authoritative value the backend returns.
 */
function useVoiceConfig() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<VoiceConfig | null>(null);

  // Whatever the backend says is also pushed into the shortcut mirror, so the
  // content-script listener and tooltips follow an edit made on this page.
  const adopt = useCallback((next: VoiceConfig) => {
    setConfig(next);
    shortcutStore.set(next.shortcuts);
  }, []);
  const refetch = useCallback(() => {
    rpc.call("getConfig", null).then(adopt, () => undefined);
  }, [rpc, adopt]);
  useEffect(refetch, [refetch]);
  useRealtime("config-changed", refetch);

  const update = useCallback(
    async (patch: Partial<VoiceConfig>) => {
      setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        adopt(await rpc.call("setConfig", patch));
        return true;
      } catch (cause) {
        refetch();
        toast.error(`Could not save: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      }
    },
    [rpc, refetch, adopt],
  );

  return { config, update };
}

function voiceLabel(voice: Voice | LiveVoice): string {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}

const linkClass = "text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";

const selectClass =
  "block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60";

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.7 2.5V5H11.2" />
    </svg>
  );
}

/**
 * A labelled sub-group: a title-case heading (matching the host's section
 * headings, never all-caps) and an optional one-line explanation, then the
 * control. Used across every section so the page reads consistently.
 */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-border/50 pt-4 first:border-t-0 first:pt-0">
      <div>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models: credential status + realtime model + voice.
// ---------------------------------------------------------------------------

interface CredentialStatus {
  effective: "apiKey" | "env" | "subscription" | "none";
  preference: CredentialPreference;
  hasApiKey: boolean;
  envKeyPresent: boolean;
  subscriptionAvailable: boolean;
}

/**
 * Shows which credential Ada is using, and — only when both an API key and a
 * ChatGPT subscription are available — lets the user pick between them.
 */
function CredentialCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CredentialStatus | null>(null);

  const refetch = useCallback(() => {
    rpc.call("getCredentialStatus", null).then(setStatus, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("config-changed", refetch);
  // Adding the key above is a host settings save with no plugin signal we can
  // hook, so poll while this page is open. That's why entering a key here
  // surfaces the credential picker on its own within a couple of seconds.
  useEffect(() => {
    const id = setInterval(refetch, 2500);
    return () => clearInterval(id);
  }, [refetch]);

  const statusText = (() => {
    switch (status?.effective) {
      case "apiKey":
      case "env":
        return "Using your OpenAI API key";
      case "subscription":
        return "Using your ChatGPT subscription";
      default:
        return "No credentials yet";
    }
  })();

  const canChoose = !!status && status.hasApiKey && status.subscriptionAvailable;
  const chooserValue: "apiKey" | "subscription" =
    status?.preference === "subscription" ? "subscription" : "apiKey";

  async function choose(preference: "apiKey" | "subscription") {
    setStatus((prev) => (prev ? { ...prev, preference } : prev));
    try {
      await rpc.call("setConfig", { credentialPreference: preference });
    } catch {
      refetch();
    }
  }

  async function removeKey() {
    try {
      await rpc.call("clearApiKey", null);
      refetch();
      toast.success("API key removed");
    } catch (cause) {
      toast.error(`Could not remove key: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  // Both credentials present: pick which one Ada uses. The dropdown speaks for
  // itself, so no hint.
  if (canChoose) {
    return (
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">Credential</span>
        <select
          value={chooserValue}
          onChange={(event) => void choose(event.target.value as "apiKey" | "subscription")}
          className={selectClass}
        >
          <option value="subscription">ChatGPT subscription</option>
          <option value="apiKey">OpenAI API key</option>
        </select>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void removeKey()}>
            Remove API key
          </Button>
        </div>
      </div>
    );
  }

  // A single credential (or none): a status line plus an italic helper — the
  // auth method, or the next step when nothing is set.
  const helper =
    status?.effective === "subscription"
      ? "Signed in with codex login."
      : status?.effective === "none"
        ? "Add an API key above, or run codex login to use your ChatGPT subscription."
        : null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              status && status.effective !== "none" ? "bg-primary" : "bg-destructive/80",
            )}
          />
          <span className="text-sm text-foreground">{status ? statusText : "Checking…"}</span>
        </span>
        {status?.hasApiKey ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void removeKey()}>
            Remove API key
          </Button>
        ) : null}
      </div>
      {helper ? <p className="text-xs italic text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

export function ModelsSettings() {
  const { config, update } = useVoiceConfig();
  const model = config?.model ?? DEFAULT_MODEL;
  const voice = config?.voice ?? DEFAULT_VOICE;
  const liveVoice = config?.liveVoice ?? DEFAULT_LIVE_VOICE;
  const liveBackend = config?.liveBackend ?? DEFAULT_LIVE_BACKEND;
  const loading = config === null;
  const live = engineForModel(model) === "live";

  return (
    <div className="space-y-4">
      <CredentialCard />
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">Live model</span>
        <select
          value={model}
          disabled={loading}
          onChange={(event) => {
            const next = event.target.value;
            if (isModel(next)) void update({ model: next });
          }}
          className={selectClass}
        >
          {MODEL_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      {live ? (
        <>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">Backend model</span>
            <select
              value={liveBackend}
              disabled={loading}
              onChange={(event) => {
                const next = event.target.value;
                if (isLiveBackend(next)) void update({ liveBackend: next });
              }}
              className={selectClass}
            >
              {LIVE_BACKEND_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">
              The delegated model that reasons and calls tools for gpt-live-1.
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">Voice</span>
            <select
              value={liveVoice}
              disabled={loading}
              onChange={(event) => {
                const next = event.target.value;
                if (isLiveVoice(next)) void update({ liveVoice: next });
              }}
              className={selectClass}
            >
              {LIVE_VOICE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {voiceLabel(option)}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">Voice</span>
          <select
            value={voice}
            disabled={loading}
            onChange={(event) => {
              const next = event.target.value;
              if (isVoice(next)) void update({ voice: next });
            }}
            className={selectClass}
          >
            {VOICE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {voiceLabel(option)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Behavior: the prompt (how Ada acts).
// ---------------------------------------------------------------------------

export function BehaviorSettings() {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <div className="min-w-0 space-y-5">
      <PromptEditor role="aide" />
      <PromptEditor role="worker" />
      <details className="min-w-0 space-y-3" onToggle={event => setHistoryOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium">Previous prompts</summary>
        {historyOpen ? <><PromptEditor role="live" /><PromptEditor role="coordinator" /></> : null}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt editor — edit and save your own prompt, or reset to the default.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Audio: microphone picker and a live level meter to test it.
// ---------------------------------------------------------------------------

/** Live RMS of the selected mic, 0..1, while `active`. Cleans up fully on stop. */
export function MicLevelMeter({ deviceId, active }: { deviceId: string; active: boolean }) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    setError(null);
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const sample of data) {
            const centered = (sample - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / data.length);
          // Light compression so speech visibly fills the bar.
          setLevel(Math.min(1, rms * 3));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      setLevel(0);
    };
  }, [deviceId, active]);

  if (!active) return null;
  if (error) return <p className="text-xs text-destructive">Mic test failed: {error}</p>;

  const segments = 20;
  const lit = Math.round(level * segments);
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-3 flex-1 items-stretch gap-0.5">
        {Array.from({ length: segments }, (_, index) => (
          <span
            key={index}
            className={cn(
              "flex-1 rounded-[1px] transition-colors",
              index < lit
                ? index > segments * 0.85
                  ? "bg-destructive"
                  : "bg-primary"
                : "bg-muted",
            )}
          />
        ))}
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {Math.round(level * 100)}%
      </span>
    </div>
  );
}

export function AudioSettings() {
  const preferences = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getAudioPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const testingRef = useRef(false);
  testingRef.current = testing;

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceError("Audio device discovery is not supported in this browser.");
      setLoading(false);
      return;
    }
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
      setDeviceError(null);
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const labelsHidden = inputs.length > 0 && inputs.every((device) => !device.label);
  const savedMicMissing =
    !!preferences.inputDeviceId &&
    !inputs.some((device) => device.deviceId === preferences.inputDeviceId);

  async function allowAccess() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refresh();
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function change(deviceId: string) {
    const label = inputs.find((device) => device.deviceId === deviceId)?.label ?? "";
    voiceAgent.setAudioPreferences({ inputDeviceId: deviceId, inputLabel: label });
    toast.success("Microphone saved");
  }

  return (
    <div className="space-y-5">
      <Group label="Microphone">
        <div className="flex items-center gap-2">
          <select
            value={preferences.inputDeviceId}
            disabled={loading}
            onChange={(event) => change(event.target.value)}
            className={cn(selectClass, "flex-1")}
          >
            <option value="">System default</option>
            {savedMicMissing ? (
              <option value={preferences.inputDeviceId}>
                {preferences.inputLabel
                  ? `${preferences.inputLabel} (not connected)`
                  : "Selected microphone (not connected)"}
              </option>
            ) : null}
            {inputs.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceDisplayLabel(device, index)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh devices"
            title="Refresh devices"
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <RefreshIcon />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={testing ? "secondary" : "outline"}
            size="sm"
            onClick={() => setTesting((prev) => !prev)}
          >
            {testing ? "Stop test" : "Test microphone"}
          </Button>
          {labelsHidden ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void allowAccess()}>
              Allow access
            </Button>
          ) : null}
        </div>

        {testing ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <MicLevelMeter deviceId={savedMicMissing ? "" : preferences.inputDeviceId} active={testing} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">Speak — the bar should move with your voice.</p>
          </div>
        ) : null}

        {labelsHidden ? (
          <p className="text-xs text-muted-foreground">Allow mic access to see device names and test it.</p>
        ) : savedMicMissing ? (
          <p className="text-xs text-muted-foreground">This mic isn't connected, so Ada falls back to your default.</p>
        ) : null}
        {deviceError ? <p className="text-xs text-destructive">{deviceError}</p> : null}
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts: one row per action showing the current binding as
// keycaps, with a recorder that captures the next combination pressed.
// ---------------------------------------------------------------------------

/** The binding as keycaps, e.g. [⌘][Shift][H]; an ellipsis while recording. */
function Keycaps({ value }: { value: string | null }) {
  const parts = value === null ? ["…"] : shortcutLabelParts(value, MAC);
  return (
    <span className="flex items-center gap-1" aria-hidden={value === null}>
      {parts.map((part, index) => (
        <kbd
          key={index}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-[11px] font-medium text-foreground shadow-[inset_0_-1px_0_var(--border)]"
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutRow({
  action,
  shortcuts,
  disabled,
  onChange,
}: {
  action: ShortcutAction;
  shortcuts: Shortcuts;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The recorder is installed once per recording session; read the latest
  // bindings and callback through a ref so it never goes stale.
  const latest = useRef({ shortcuts, onChange });
  latest.current = { shortcuts, onChange };
  const value = shortcuts[action];
  const isDefault = sameShortcut(value, DEFAULT_SHORTCUTS[action]);

  useEffect(() => {
    if (!recording) return;
    shortcutStore.setRecording(true);
    const onKeyDown = (event: KeyboardEvent) => {
      // Capture phase on window: ahead of bb's own bindings and our global
      // listener, so the keystroke reaches only this recorder and nothing is
      // typed into whatever has focus.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      if (isModifierKey(event.key)) return; // waiting for the key itself
      const combo = comboFromEvent(event, MAC);
      if (!combo) {
        setProblem(MAC ? "Use ⌘ rather than Control." : "Use Ctrl rather than the Windows or Command key.");
        return;
      }
      const next = formatShortcut(combo);
      const why = shortcutProblem(next, action, latest.current.shortcuts, MAC);
      if (why) {
        setProblem(why); // stay in recording mode so they can try again
        return;
      }
      setRecording(false);
      latest.current.onChange(next);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      shortcutStore.setRecording(false);
    };
  }, [recording, action]);

  const status = recording ? (
    <span className={cn("block text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
      {problem ?? "Press the new combination, or Esc to keep the current one."}
    </span>
  ) : isDefault ? null : (
    <button type="button" className={linkClass} disabled={disabled} onClick={() => onChange(DEFAULT_SHORTCUTS[action])}>
      Reset to {shortcutLabel(DEFAULT_SHORTCUTS[action], MAC)}
    </button>
  );

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <span className="block text-sm text-foreground">{SHORTCUT_ACTION_LABELS[action]}</span>
        {status}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Keycaps value={recording ? null : value} />
        <Button
          type="button"
          variant={recording ? "secondary" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => {
            setProblem(null);
            setRecording((prev) => !prev);
          }}
        >
          {recording ? "Cancel" : "Change"}
        </Button>
      </div>
    </div>
  );
}

export function ShortcutsSettings() {
  const { config, update } = useVoiceConfig();
  const shortcuts = config?.shortcuts ?? DEFAULT_SHORTCUTS;
  const loading = config === null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        These work anywhere in bb, even while typing in the composer. Click Change, then press the new
        combination. Bindings are shared across your devices; ⌘ here means Ctrl on Windows and Linux.
      </p>
      <div className="divide-y divide-border/50 rounded-md border border-border">
        {SHORTCUT_ACTIONS.map((action) => (
          <ShortcutRow
            key={action}
            action={action}
            shortcuts={shortcuts}
            disabled={loading}
            onChange={(value) => {
              void update({ shortcuts: { ...shortcuts, [action]: value } }).then((ok) => {
                if (ok) toast.success(`Shortcut saved: ${shortcutLabel(value, MAC)}`);
              });
            }}
          />
        ))}
      </div>
    </div>
  );
}
