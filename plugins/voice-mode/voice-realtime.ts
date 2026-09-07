// The app-wide voice owner. Mounted once per bb window as an app overlay, so
// realtime signals, the global bindings, the native UI controller, and the
// floating call controls all survive route changes: one continuous assistant
// independent of where the user is in bb.
import React, { useEffect, useRef, useSyncExternalStore } from "react";
import {
  experimental_useSidebarThreadActions,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { voiceAgent } from "./voice-agent";
import { nativeUi } from "./native-ui";
import { LiveCallControls } from "./voice-chrome";
import { useShortcutSync } from "./shortcut-store";
import type { rpcContract } from "./server";

/** Route prefix of the Voice page, which draws its own call console. */
const VOICE_ROUTE_PREFIX = "/plugins/voice-mode/sessions";

function readPathname(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

/**
 * The current pathname. bb navigates with pushState (no popstate), so besides
 * the popstate listener this re-reads on every render caused by a context
 * change and polls slowly as a backstop while a call is live.
 */
function usePathname(live: boolean): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("popstate", onChange);
      const timer = live ? setInterval(onChange, 500) : null;
      return () => {
        window.removeEventListener("popstate", onChange);
        if (timer) clearInterval(timer);
      };
    },
    readPathname,
    () => "",
  );
}

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
  useRealtime("voice-coordinator", (payload) => voiceAgent.ingestCoordinatorSignal("voice-coordinator", payload));
  useRealtime("voice-question", (payload) => voiceAgent.ingestCoordinatorSignal("voice-question", payload));
  // Native UI commands from the coordinator; the agent decides whether this
  // window owns the call before anything runs through nativeUi.execute.
  useRealtime("voice-ui-command", (payload) => void voiceAgent.ingestUiCommand(payload));
  useRealtime("voice-ui-cancelled", (payload) => voiceAgent.ingestUiCancellation(payload));
  // Ephemeral signals can be missed while the shared connection is down. The
  // agent owns the recovery (it re-reads pending and revoked commands on every
  // connected transition while a call is active); this only reports the
  // transport. The native controller also stops any action still waiting on
  // a route or composer, so a lost cancellation cannot land a draft later.
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    const connected = connection === "connected";
    nativeUi.setTransportConnected(connected);
    voiceAgent.setUiConnectionState(connected);
    return () => {
      nativeUi.setTransportConnected(false);
      voiceAgent.setUiConnectionState(false);
    };
  }, [connection]);

  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const threads = experimental_useSidebarThreadActions();
  const context = useBbContext();
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const live = state !== "idle";
  const pathname = usePathname(live);

  // Live refs so the native UI binding is registered once and reads the
  // freshest route/navigation values on every call, never a stale closure.
  const contextRef = useRef(context);
  contextRef.current = context;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  useEffect(() => nativeUi.bind({
    kind: "app",
    context: () => ({ threadId: contextRef.current.threadId, projectId: contextRef.current.projectId }),
    route: readPathname,
    navigate: {
      toProject: (projectId) => navigateRef.current.toProject(projectId),
      toPluginPanel: (path, options) => navigateRef.current.toPluginPanel(path, options),
    },
    threads: {
      open: (threadId, options) => threadsRef.current.open(threadId, options),
      openNewThread: (options) => threadsRef.current.openNewThread(options),
    },
  }), []);
  // Wake anyone waiting on a route change (the binding above is stable).
  useEffect(() => nativeUi.refresh(), [context.threadId, context.projectId, pathname]);

  const onNewThreadScreen = useSyncExternalStore(nativeUi.subscribe, () => nativeUi.snapshot().onNewThreadScreen, () => false);
  useEffect(() => voiceAgent.bindGlobal({
    rpc,
    context: { threadId: context.threadId, projectId: context.projectId, onNewThreadScreen },
  }), [rpc, context.threadId, context.projectId, onNewThreadScreen]);

  // Floating call controls everywhere except the Voice page, which has its
  // own console. Top-centre so it never covers the composer or the keyboard;
  // the wrapper passes pointer events through, only the pill is interactive.
  if (!live || pathname.startsWith(VOICE_ROUTE_PREFIX)) return null;
  return React.createElement(
    "div",
    {
      role: "region",
      "aria-label": "Voice call",
      "data-voice-mode-global-call": "",
      className: "voice-global-call pointer-events-none fixed inset-x-0 z-40 flex justify-center px-2",
      style: { top: "calc(env(safe-area-inset-top, 0px) + 8px)" },
    },
    React.createElement("div", { className: "pointer-events-auto max-w-full shadow-md" }, React.createElement(LiveCallControls)),
  );
}

/**
 * Invisible composer action: renders nothing and lends this composer to the
 * native UI controller for as long as it is mounted. The scope is the exact
 * target (one thread, a queued-message editor, a side chat, or the new-thread
 * screen); the controller refuses to draft into anything but a plain thread
 * composer or the new-thread composer. Several bind at once in a split.
 */
export function VoiceComposerBinding() {
  const composer = useComposer();
  const view = useComposerView();
  // File preview is a capability of this surface, not of the app overlay.
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // Live refs, updated in render: React may hand this instance to another
  // composer scope before the effect re-runs, so the controller reads scope,
  // draft and API together at use time instead of trusting a captured scope.
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => nativeUi.bind({
    kind: "composer",
    view: () => ({ scope: viewRef.current.scope, draft: viewRef.current.draft, run: viewRef.current.run }),
    composer: {
      setText: (text) => composerRef.current.setText(text),
      updateText: (updater) => composerRef.current.updateText(updater),
    },
    openFilePreview: (options) => navigateRef.current.experimental_openFilePreview(options),
  }), []);
  // A scope change is a binding change for anyone waiting on a composer.
  const scopeKey = JSON.stringify(view.scope);
  useEffect(() => nativeUi.refresh(), [scopeKey]);
  // Keep the content-script shortcut mirror in step with the config from any
  // page that has a composer (nearly all of them).
  useShortcutSync();
  return null;
}
