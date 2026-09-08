import { TranscriptBuffer } from "./live-transcript.ts";
// Voice session singleton for one loaded plugin module. Web slots share it;
// separate windows/native webviews have separate instances. Presence and call
// controls cross those boundaries, but opening views stays local to the caller.
import { toast } from "sonner";
import { hasSpokenWords } from "./spoken-input.ts";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  audioCaptureConstraint,
  describeAudioSupport,
  queryMicPermission,
  readAudioDevicePreferences,
  resolveDevice,
  writeAudioDevicePreferences,
  type AudioDevicePreferences,
} from "./audio-devices.ts";
import { actionStatus } from "./session-events.ts";
import { nativeUi } from "./native-ui.ts";
import { UiCommandSchema, type UiCommand, type UiActionResult } from "./ui-actions.ts";
import { clientId, realmId, identityTag, clientDescriptor, deviceSummary } from "./client-identity.ts";
import { CoordinatorBridge, type BridgeSnapshot } from "./coordinator-bridge.ts";

export type VoiceState = "idle" | "connecting" | "live" | "muted";
/** Who currently has the floor during a live call, for the "listening" UI. */
export type VoiceActivity = "you" | "aide" | "idle";
/** A control intent relayed from a non-owning surface to the owning realm. */
export type VoiceCommandAction = "stop" | "mute" | "unmute";

/**
 * A live call owned by another surface's realm, mirrored here from the
 * `voice-presence` broadcast so this realm's controls reflect it. `receivedAt`
 * lets us expire a call whose owner realm vanished without a clean stop.
 */
interface RemotePresence {
  nonce: string;
  phase: Exclude<VoiceState, "idle">;
  startedAt: number | null;
  receivedAt: number;
  /** Which client/realm owns the mirrored call (observability / future "live on X"). */
  ownerClient?: string;
  ownerRealm?: string;
}

/** A mirror is stale (owner realm likely gone) after two missed heartbeats. */
const PRESENCE_STALE_MS = 25_000;
/** How often the owning realm re-announces a live call, for the mirror above. */
const PRESENCE_HEARTBEAT_MS = 10_000;

interface RpcClient {
  call: ReturnType<typeof useRpc<typeof rpcContract>>["call"];
}

export interface Bindings {
  rpc: RpcClient;
  context: {
    threadId: string | null;
    projectId: string | null;
    /** True when the user is on the New thread screen (no thread exists yet). */
    onNewThreadScreen: boolean;
  };

}

interface SessionHandle {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  dc: RTCDataChannel | null;
  /** The live mic track feeding the pc; swapped in when iOS suspends the mic. */
  micTrack: MediaStreamTrack | null;
  /** The pc's audio sender, so a fresh mic track can replace a suspended one. */
  micSender: RTCRtpSender | null;
  /** Tears down the page/visibility listeners installed for this session. */
  disposeLifecycle?: () => void;
}

/**
 * Detach a timer from the event loop where the runtime supports it (Node's
 * `unref`). No-op in the browser (timer ids have no `unref`), where it isn't
 * needed — this just keeps background presence timers from holding a process
 * (e.g. tests) open.
 */
function maybeUnref(timer: ReturnType<typeof setInterval>) {
  (timer as { unref?: () => void }).unref?.();
}

const REPLY_QUIET_MS = 2000;
const DISCONNECT_GRACE_MS = 10_000;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Wait for ICE gathering to finish (bounded) so we send a complete offer. */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Owns WebRTC in the runtime where a call starts. Other runtimes mirror call
 * presence and relay explicit stop/mute controls. Global bindings keep calls
 * active across routes; the native UI adapter supplies the current context.
 */
export class VoiceAgent {
  private state: VoiceState = "idle";
  private session: SessionHandle | null = null;
  private listeners = new Set<() => void>();
  private bindings: Bindings | null = null;
  private nonce: string | null = null;
  private storage = browserStorage();
  private audioPreferences: AudioDevicePreferences =
    this.storage
      ? readAudioDevicePreferences(this.storage)
      : { inputDeviceId: "", inputLabel: "" };
  /** Serializes tool executions so outputs are submitted in call order. */
  private uiChain: Promise<void> = Promise.resolve();
  private uiConnected = false;
  private uiReady = false;
  private uiSync: Promise<void> | null = null;
  private uiRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private uiRetryAttempt = 0;
  private uiConnectionGeneration = 0;
  private bufferedUiCommands = new Map<string, UiCommand>();
  private revokedUiCommands = new Set<string>();
  private cancelledQuickRequests = new Set<string>();
  private uiCommands = new Map<string, { command: UiCommand; result?: UiActionResult }>();

  private ownsUiCommand(command: UiCommand): boolean {
    return this.session !== null && (this.state === "live" || this.state === "muted") &&
      this.nonce === command.callNonce && this.logicalConversationId === command.conversationId && !this.cancelledQuickRequests.has(command.requestId);
  }

  setUiConnectionState(connected: boolean): void {
    if (this.uiConnected === connected) return;
    this.resetUiRecovery();
    this.uiConnected = connected;
    if (!connected) this.bridge?.pauseSequence("The connection was lost.",true);
    this.uiReady = false;
    this.uiConnectionGeneration++;
    this.bufferedUiCommands.clear();
    if (connected) void this.syncUiCommands();
  }

  ingestUiCancellation(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const value = payload as Record<string, unknown>;
    if (typeof value.commandId !== "string" || !value.commandId ||
      value.callNonce !== this.nonce || value.conversationId !== this.logicalConversationId || !this.session) return;
    this.revokedUiCommands.add(`${value.callNonce}:${value.commandId}`);
  }

  /** Signals can reach every realm. Only the call owner may claim an action. */
  ingestUiCommand(payload: unknown): Promise<void> {
    const parsed = UiCommandSchema.safeParse(payload);
    if (!parsed.success || !this.ownsUiCommand(parsed.data)) return Promise.resolve();
    const command = parsed.data;
    if (!this.uiConnected || (command.expiresAt !== undefined && command.expiresAt <= Date.now())) return Promise.resolve();
    if (!this.uiReady) {
      this.bufferedUiCommands.set(command.id, command);
      if (!this.uiRetryTimer) void this.syncUiCommands();
      return Promise.resolve();
    }
    const key = `${command.callNonce}:${command.id}`;
    if (this.revokedUiCommands.has(key)) return Promise.resolve();
    if (this.uiCommands.has(key)) return this.uiChain;
    const receipt: { command: UiCommand; result?: UiActionResult } = { command };
    this.uiCommands.set(key, receipt);
    const connectionGeneration = this.uiConnectionGeneration;
    this.uiChain = this.uiChain.then(async () => {
      const rpc = this.bindings?.rpc;
      const isCurrent = () => this.uiConnected && this.uiReady && this.uiConnectionGeneration === connectionGeneration && !this.revokedUiCommands.has(key) && this.ownsUiCommand(command) &&
        (command.expiresAt === undefined || command.expiresAt > Date.now());
      if (!rpc || !isCurrent()) { this.uiCommands.delete(key); return; }
      let claimed = false;
      try {
        const claim = await rpc.call("claimUiCommand", {
          conversationId: command.conversationId, callNonce: command.callNonce, commandId: command.id,
        });
        if (!claim.claimed) return;
        claimed = true;
        const validated = UiCommandSchema.safeParse(claim.command);
        if (!validated.success || validated.data.id !== command.id ||
          validated.data.callNonce !== command.callNonce || validated.data.conversationId !== command.conversationId ||
          validated.data.requestId !== command.requestId) {
          receipt.result = { status: "failed", detail: "The server returned an invalid UI command." };
        } else if (!isCurrent()) {
          receipt.result = { status: "cancelled", detail: "The call ended or the command expired." };
        } else {
          receipt.command = validated.data;
          const isClaimCurrent = () => isCurrent() && (validated.data.expiresAt === undefined || validated.data.expiresAt > Date.now());
          if (!isClaimCurrent()) receipt.result = { status: "cancelled", detail: "The command expired." };
          else {
            try { receipt.result = await nativeUi.execute(validated.data.action, isClaimCurrent); }
            catch (error) { receipt.result = { status: "unknown", detail: String(error).slice(0, 2000) }; }
          }
        }
        await this.reportUiReceipt(receipt);
      } catch (error) {
        // Only a pre-execution claim may retry. The server refuses a second
        // claim if its first acceptance was lost in transport.
        if (!claimed) this.uiCommands.delete(key);
        this.log("ui.commandFailed", { commandId: command.id, error: String(error) });
      }
    }).catch(error => this.log("ui.commandFailed", { commandId: command.id, error: String(error) }));
    return this.uiChain;
  }

  private async reportUiReceipt(receipt: { command: UiCommand; result?: UiActionResult }) {
    if (!receipt.result || !this.ownsUiCommand(receipt.command)) return;
    const command = receipt.command;
    // Keep the receipt if reporting fails. A reconnect retries only the report.
    const response = await this.bindings?.rpc.call("reportUiCommandResult", {
      conversationId: command.conversationId, callNonce: command.callNonce,
      commandId: command.id, result: receipt.result,
    });
    if (response?.accepted) receipt.result = undefined;
  }

  private resetUiRecovery(): void {
    if (this.uiRetryTimer) clearTimeout(this.uiRetryTimer);
    this.uiRetryTimer = null;
    this.uiRetryAttempt = 0;
    this.uiSync = null;
  }

  syncUiCommands(): Promise<void> {
    if (this.uiSync) return this.uiSync;
    if (this.uiRetryTimer) clearTimeout(this.uiRetryTimer);
    this.uiRetryTimer = null;
    const pending = this.reconcileUiCommands();
    this.uiSync = pending;
    void pending.finally(() => { if (this.uiSync === pending) this.uiSync = null; });
    return pending;
  }

  private async reconcileUiCommands(): Promise<void> {
    const conversationId = this.logicalConversationId;
    const callNonce = this.nonce;
    const rpc = this.bindings?.rpc;
    const connectionGeneration = this.uiConnectionGeneration;
    if (!this.uiConnected || !rpc || !conversationId || !callNonce || !this.session || (this.state !== "live" && this.state !== "muted")) return;
    try {
      const { commands, revokedCommandIds } = await rpc.call("pendingUiCommands", { conversationId, callNonce });
      if (this.nonce !== callNonce || !this.uiConnected || this.uiConnectionGeneration !== connectionGeneration) return;
      for (const commandId of revokedCommandIds) this.ingestUiCancellation({ commandId, conversationId, callNonce });
      this.uiRetryAttempt = 0;
      this.uiReady = true;
      const recovered = [...commands, ...this.bufferedUiCommands.values()];
      this.bufferedUiCommands.clear();
      for (const receipt of this.uiCommands.values()) {
        try { await this.reportUiReceipt(receipt); } catch { /* retain the receipt */ }
      }
      for (const command of recovered) await this.ingestUiCommand(command);
    } catch (error) {
      if (this.nonce !== callNonce || !this.uiConnected || this.uiConnectionGeneration !== connectionGeneration) return;
      this.log("ui.syncFailed", { error: String(error) });
      const delay = Math.min(500 * 2 ** Math.min(this.uiRetryAttempt++, 4), 5000);
      this.uiRetryTimer = setTimeout(() => {
        this.uiRetryTimer = null;
        if (this.nonce === callNonce && this.uiConnected && this.uiConnectionGeneration === connectionGeneration) void this.syncUiCommands();
      }, delay);
      maybeUnref(this.uiRetryTimer);
    }
  }

  private toolChain: Promise<void> = Promise.resolve();
  /** True while the model is generating a response (response.created→done). */
  private responseActive = false;
  /** A response.create is owed once the active response finishes. */
  private responsePending = false;
  private callSequence: number | null = null;
  private newerClaim: { nonce: string; sequence: number } | null = null;
  private activeResponseId: string | null = null;
  /** Only known conversational responses may dispatch tools; notice responses never may. */
  private toolResponseIds = new Set<string>();
  private responseUserTurn: number | null = null;
  private userTurn = 0;
  private userTurnPending = false;
  private userTurnCommitted = false;
  private pendingToolCalls = 0;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private userSpeaking = false;
  /**
   * True while Aide's audio is actually playing — tracked from the WebRTC
   * `output_audio_buffer.started/stopped/cleared` events, NOT `responseActive`
   * (which ends at generation done, well before playback finishes).
   */
  private assistantSpeaking = false;
  /** Aborts a session that never reaches "live", so it can't hang connecting. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the call first went live (ms), for elapsed-duration UI; null if not. */
  private liveStartedAt: number | null = null;
  /**
   * True while the OS has suspended the mic (typically iOS backgrounding the
   * owning realm). The uplink is dead until recovered — surfaced honestly rather
   * than leaving the call looking "Connected" while Aide can't hear you.
   */
  private micSuspended = false;
  /** The most recent meaningful event, for the dock's live activity ticker. */
  private lastActivity: { kind: string; name: string; text: string } | null = null;
  /**
   * A call owned by another surface's realm, mirrored from `voice-presence`.
   * Non-null only when THIS realm does not own the call; drives the effective
   * getters so every surface reflects the one live call. Null when we own it.
   */
  private remotePresence: RemotePresence | null = null;
  /** Re-announces our live call so other realms' mirrors don't go stale. */
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** Expires a stale mirror (owner realm gone) so we never show a ghost call. */
  private remoteExpiryTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards the once-per-realm `client.hello` observability record. */
  private helloed = false;
  private bindingSources = new Map<symbol, { bindings: Bindings; priority: 0 | 1 | 2 }>();
  private logQueue: Promise<unknown> | null = null;
  /** Coordinator bridge state for the current call. */
  private bridge: CoordinatorBridge | null = null;
  /** When speaking/generation/tool state last changed, for the quiet gate. */
  private conversationChangedAt = 0;
  /** The next start() opens a separate logical conversation. */
  private startNewConversation = false;
  private nextConversationId: string | undefined;
  private logicalConversationId: string | null = null;
  private delegatedTurn: number | null = null;
  private spokenTurns = new Set<number>();
  private playbackResponseId: string | null = null;
  private interruptedResponses = new Set<string>();
  private completedPlayback = new Set<string>();
  private completedResponses = new Set<string>();
  private cancellationEvents = new Map<string, {responseId: string; reason: string}>();
  private rejectedToolCalls = new Set<string>();
  private clearedInterruptedPlayback = new Set<string>();
  private inputSegment: {itemId: unknown; startedAt: number; audioStartMs: number | null; playbackResponseId: string | null; activeResponseId: string | null} | null = null;
  private transcriptBuffer = new TranscriptBuffer();
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptSend: Promise<unknown> | null = null;
  private transcriptDirty = false;
  private inputOrder = 0;
  private inputItems = new Map<string, { order: number; startedAt: number; speaking: boolean; confirmed: boolean; complete: boolean; requested: boolean; text: string; timer: ReturnType<typeof setTimeout> | null }>();
  private responseIdentity = new Map<string, { userTurn: number; requestId: string | null; replyId: string | null; source: string }>();
  /** end_call was requested; the call ends once the goodbye has played. */
  private endCallAfterResponse = false;


  /** The most recent tool call, so a suspend/teardown can name its likely cause. */
  private lastTool: { name: string; at: number } | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * The effective call state for the UI: our own if we own a call, otherwise a
   * call mirrored from another surface's realm (`voice-presence`). This is what
   * makes every surface reflect the single live call, not just the one that
   * started it.
   */
  readonly getState = (): VoiceState =>
    this.state !== "idle" ? this.state : this.remotePresenceLive()?.phase ?? "idle";

  readonly getRemoteCallLabel = (): string | null => {
    if (this.hasLocalCall()) return null;
    const remote = this.remotePresenceLive();
    return !remote ? null : remote.ownerClient === clientId ? "Call in another window" : "Call on another device";
  };

  /** A click explicitly transfers the mirrored call after local microphone access succeeds. */
  switchToThisDevice() {
    if (this.hasLocalCall()) return;
    const remote = this.remotePresenceLive();
    if (!remote) return;
    this.nextConversationId = undefined;
    this.startNewConversation = false;
    void this.start(remote.nonce);
  }

  /** Epoch ms when the call went live, or null when not in a live/muted call. */
  readonly getLiveStartedAt = (): number | null =>
    this.state !== "idle" ? this.liveStartedAt : this.remotePresenceLive()?.startedAt ?? null;

  /**
   * The active session id (the call nonce, which doubles as the session id used
   * when logging events), or null when idle. Lets the page jump straight to the
   * live session's transcript — including a call owned by another surface.
   */
  readonly getSessionId = (): string | null =>
    this.state !== "idle" ? this.nonce : this.remotePresenceLive()?.nonce ?? null;

  /** True while THIS realm owns (or is opening) the call. */
  private hasLocalCall(): boolean {
    return this.state !== "idle";
  }

  /** The mirrored remote call if still fresh; null once its heartbeats lapse. */
  private remotePresenceLive(): RemotePresence | null {
    const remote = this.remotePresence;
    if (!remote) return null;
    if (Date.now() - remote.receivedAt > PRESENCE_STALE_MS) return null;
    return remote;
  }

  /**
   * The latest meaningful event (speech / tool call / notice), for the dock's
   * activity ticker. Stable identity between changes so it's safe for
   * useSyncExternalStore. The UI owns human phrasing (tool → verb).
   */
  readonly getLastActivity = (): { kind: string; name: string; text: string } | null => this.lastActivity;

  /**
   * Who is talking right now, from the data-channel signals we already track
   * (VAD for the user, response lifecycle for Aide). Deliberately no audio
   * analysis — it stays reliable and never touches the audio pipeline. The
   * user takes precedence so a barge-in reads as "you".
   */
  readonly getActivity = (): VoiceActivity => {
    if (this.state !== "live" && this.state !== "muted") return "idle";
    if (this.userSpeaking) return "you";
    if (this.assistantSpeaking) return "aide";
    return "idle";
  };

  /**
   * True when THIS realm owns a call whose mic the OS has suspended — the
   * uplink is down (Aide can't hear you) until it comes back to the foreground
   * and recovers. Only meaningful for the owner; mirrors don't hold the mic.
   */
  readonly getMicSuspended = (): boolean =>
    this.micSuspended && (this.state === "live" || this.state === "muted");

  private setMicSuspended(value: boolean) {
    if (this.micSuspended === value) return;
    this.micSuspended = value;
    this.emitChange();
  }

  private setUserSpeaking(value: boolean) {
    if (this.userSpeaking === value) return;
    this.userSpeaking = value;
    this.markConversationChange();
    this.emitChange();
  }

  private setAssistantSpeaking(value: boolean) {
    if (this.assistantSpeaking === value) return;
    this.assistantSpeaking = value;
    this.markConversationChange();
    this.emitChange();
  }

  private setResponseActive(value: boolean) {
    if (this.responseActive === value) return;
    this.responseActive = value;
    this.markConversationChange();
    this.emitChange();
  }

  readonly getAudioPreferences = (): AudioDevicePreferences => this.audioPreferences;

  /** Coordinator-path status for the UI (working, queued replies, open question). */
  readonly getBridgeSnapshot = (): BridgeSnapshot | null => this.bridgeSnapshot;
  private bridgeSnapshot: BridgeSnapshot | null = null;
  private refreshBridgeSnapshot() {
    this.bridgeSnapshot = this.bridge ? this.bridge.snapshot() : null;
    this.emitChange();
  }

  /** Start the next call in a fresh logical conversation instead of resuming. */
  startConversationFresh() { this.startConversation(); }

  getConversationId = (): string | null => this.logicalConversationId;

  startConversation(conversationId?: string): void {
    if (this.hasLocalCall() || this.remotePresenceLive()) {
      toast.error("End the current call before starting or continuing a session.");
      return;
    }
    this.nextConversationId = conversationId;
    this.startNewConversation = !conversationId;
    void this.start();
  }

  private settleDelegatedTurn() {
    const turn = this.delegatedTurn;
    if (turn === null || this.responseActive || this.pendingToolCalls > 0) return;
    this.delegatedTurn = null;
    if (turn !== this.userTurn || this.userSpeaking) return;
    this.userTurnPending = false;
    this.userTurnCommitted = false;
    this.bridge?.acknowledge(turn, this.spokenTurns.has(turn));
  }

  /** Coordinator replies, inbox notices, and questions published by the server. */
  ingestCoordinatorSignal(channel: "voice-reply" | "voice-inbox" | "voice-question" | "voice-coordinator", payload: unknown) {
    const bridge = this.bridge;
    if (!bridge || !this.session) return;
    if (channel === "voice-reply") bridge.ingestReply(payload);
    else if (channel === "voice-inbox") bridge.ingestInbox(payload);
    else if (channel === "voice-coordinator") bridge.ingestStatus(payload);
    this.refreshBridgeSnapshot();
    // Anything the gate refuses now is retried at the quiet boundary.
    this.scheduleReplyDrain();
  }

  private markConversationChange() {
    this.conversationChangedAt = Date.now();
  }

  bind(bindings: Bindings) { return this.registerBindings(bindings, 2); }
  bindFallback(bindings: Bindings) { return this.registerBindings(bindings, 1); }

  bindGlobal(bindings: Bindings) { return this.registerBindings(bindings, 0); }

  private registerBindings(bindings: Bindings, priority: 0 | 1 | 2) {
    const key = Symbol();
    this.bindingSources.set(key, { bindings, priority });
    const refresh = () => {
      const sources = [...this.bindingSources.values()].reverse();
      this.bindings = sources.sort((a, b) => b.priority - a.priority)[0]?.bindings ?? null;
    };
    refresh();
    this.helloOnce(priority === 2 ? "composer" : priority === 1 ? "page" : "app");
    this.requestPresence();
    return () => { this.bindingSources.delete(key); refresh(); };
  }
  /**
   * Announce this realm once it can talk to the backend, so every surface (even
   * idle ones that never start a call) leaves a durable record of its client +
   * realm id, the device descriptor, and which surface it is. This is how we
   * enumerate "which realms exist on which client, and what kind of device".
   */
  private helloOnce(surface: string) {
    if (this.helloed || !this.bindings) return;
    this.helloed = true;
    this.logDiag("client.hello", {
      surface, // realm/usage: which surface this realm is (composer vs page)
      visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
      ...clientDescriptor, // client/device: platform, browser, runtime, ua, …
    });
  }

  private setState(next: VoiceState) {
    this.state = next;
    this.emitChange();
    // Announce our own transitions so other realms mirror this call. Idle is
    // announced explicitly by stop() (which clears the nonce first), so skip it
    // here — a null nonce has nothing to identify.
    if (next !== "idle" && this.nonce && this.callSequence !== null) this.broadcastPresence(next, this.nonce);
  }

  private emitChange() {
    for (const listener of this.listeners) listener();
  }

  // ---- cross-surface presence (see server: voice-presence / voice-command) ----

  /**
   * Announce our own call so other realms mirror it. Fire-and-forget; presence
   * is cosmetic, so a failed publish must never touch the call. Only our own
   * transitions reach here (setState / stop), so `nonce` always identifies us.
   */
  private broadcastPresence(phase: VoiceState, nonce: string) {
    const rpc = this.bindings?.rpc;
    if (!rpc || (phase !== "idle" && this.callSequence === null)) return;
    void rpc
      .call("publishPresence", { nonce, phase, startedAt: this.liveStartedAt, client: clientId, realm: realmId })
      .catch(() => undefined);
  }

  /**
   * Ask any realm that owns a live call to re-announce it now. A surface calls
   * this on mount so it catches up immediately instead of waiting up to a full
   * heartbeat — the "briefly shows Talk to Aide over a live call" gap.
   */
  requestPresence() {
    const rpc = this.bindings?.rpc;
    if (!rpc) return;
    void rpc.call("requestPresence", null).catch(() => undefined);
  }

  /** Re-announce our call in response to a peer's mount-time presence request. */
  answerPresenceQuery() {
    if (this.nonce && this.hasLocalCall()) this.broadcastPresence(this.state, this.nonce);
  }

  /** Keep remote mirrors fresh while we own a live call (see PRESENCE_STALE_MS). */
  private startPresenceHeartbeat() {
    this.stopPresenceHeartbeat();
    this.presenceTimer = setInterval(() => {
      if (this.nonce && this.hasLocalCall()) this.broadcastPresence(this.state, this.nonce);
    }, PRESENCE_HEARTBEAT_MS);
    maybeUnref(this.presenceTimer);
  }

  private stopPresenceHeartbeat() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  /**
   * Ingest a `voice-presence` broadcast. Ignores our own echo and anything while
   * we own a call (our local state already drives the UI); otherwise mirrors the
   * remote call so this realm's controls reflect it.
   */
  ingestPresence(payload: unknown) {
    const p = payload as
      | { nonce?: unknown; phase?: unknown; startedAt?: unknown; client?: unknown; realm?: unknown }
      | null;
    const nonce = typeof p?.nonce === "string" ? p.nonce : null;
    // Never mirror our own broadcast. Match on realm too, not just nonce: after
    // stop() nulls the nonce, a reordered trailing "live" frame from this realm
    // would otherwise slip past the nonce check and ghost as a remote call.
    if (!nonce || nonce === this.nonce || p?.realm === realmId || this.hasLocalCall()) return;
    const phase = p?.phase;
    if (phase === "idle") {
      // Only the call we're actually mirroring can clear it — a late idle for an
      // older, already-superseded call must not wipe a newer live mirror.
      if (this.remotePresence?.nonce === nonce) {
        this.remotePresence = null;
        this.disarmRemoteExpiry();
        this.emitChange();
      }
      return;
    }
    if (phase !== "connecting" && phase !== "live" && phase !== "muted") return;
    const startedAt = typeof p?.startedAt === "number" ? p.startedAt : null;
    const ownerClient = typeof p?.client === "string" ? p.client : undefined;
    const ownerRealm = typeof p?.realm === "string" ? p.realm : undefined;
    this.remotePresence = { nonce, phase, startedAt, receivedAt: Date.now(), ownerClient, ownerRealm };
    this.armRemoteExpiry();
    this.emitChange();
  }

  /** Poll a mirror to expiry so a vanished owner doesn't leave a ghost "live". */
  private armRemoteExpiry() {
    if (this.remoteExpiryTimer) return;
    this.remoteExpiryTimer = setInterval(() => {
      if (!this.remotePresence) {
        this.disarmRemoteExpiry();
        return;
      }
      if (this.remotePresenceLive()) return; // still fresh
      this.remotePresence = null;
      this.disarmRemoteExpiry();
      this.emitChange();
    }, 5000);
    maybeUnref(this.remoteExpiryTimer);
  }

  private disarmRemoteExpiry() {
    if (this.remoteExpiryTimer) clearInterval(this.remoteExpiryTimer);
    this.remoteExpiryTimer = null;
  }

  /** Relay a control intent to whichever realm owns the call. */
  private sendCommand(nonce: string, action: VoiceCommandAction) {
    const rpc = this.bindings?.rpc;
    if (!rpc) return;
    void rpc
      .call("sendVoiceCommand", { nonce, action, client: clientId, realm: realmId })
      .catch(() => undefined);
  }

  /**
   * End a call server-authoritatively, so it works even when the owner realm is
   * a frozen/backgrounded mobile webview that can't receive commands — the fix
   * for the navigation zombie. Fire-and-forget; cosmetic on failure.
   */
  private forceStop(nonce: string) {
    const rpc = this.bindings?.rpc;
    if (!rpc) return;
    void rpc.call("forceStop", { nonce }).catch(() => undefined);
  }

  /** Stop a call we only mirror: force-stop on the server + drop the mirror now. */
  private stopRemote(nonce: string) {
    this.forceStop(nonce);
    if (this.remotePresence?.nonce === nonce) {
      this.remotePresence = null;
      this.disarmRemoteExpiry();
      this.emitChange();
    }
  }

  /** Apply a relayed command — but only if THIS realm owns that call. */
  applyVoiceCommand(payload: unknown) {
    const p = payload as { nonce?: unknown; action?: unknown } | null;
    const nonce = typeof p?.nonce === "string" ? p.nonce : null;
    if (!nonce || nonce !== this.nonce || !this.hasLocalCall()) return;
    const action = p?.action;
    if (action === "stop") this.stop();
    else if (action === "mute") this.setMuted(true);
    else if (action === "unmute") this.setMuted(false);
  }

  // ---- surface controls: act on the local call, or relay to the owner ----

  /** Start/stop from any surface. A mirrored remote call is stopped, not toggled. */
  toggleFromSurface() {
    if (this.hasLocalCall()) return this.toggle();
    const remote = this.remotePresenceLive();
    if (remote) return this.stopRemote(remote.nonce);
    void this.start();
  }

  /** Mute/unmute from any surface. */
  toggleMuteFromSurface() {
    if (this.hasLocalCall()) return this.toggleMute();
    const remote = this.remotePresenceLive();
    if (remote) this.sendCommand(remote.nonce, remote.phase === "muted" ? "unmute" : "mute");
  }

  /** Stop from any surface — server-authoritative for a call we only mirror. */
  stopFromSurface() {
    if (this.hasLocalCall()) return this.stop();
    const remote = this.remotePresenceLive();
    if (remote) this.stopRemote(remote.nonce);
  }

  setAudioPreferences(next: AudioDevicePreferences) {
    this.audioPreferences = { ...next };
    if (this.storage) writeAudioDevicePreferences(this.storage, this.audioPreferences);
    this.emitChange();
  }

  refreshAudioPreferences() {
    if (!this.storage) return;
    const next = readAudioDevicePreferences(this.storage);
    if (
      next.inputDeviceId === this.audioPreferences.inputDeviceId &&
      next.inputLabel === this.audioPreferences.inputLabel
    ) return;
    this.audioPreferences = next;
    this.emitChange();
  }

  toggle() {
    if (this.state === "idle") void this.start();
    else this.stop();
  }


  private clearConnectWatchdog() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  /** Enumerate devices, degrading to an empty list rather than throwing. */
  private async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  /**
   * Acquire the microphone, tolerating the brief post-reload window where the
   * OS reports zero input devices (a Chromium/Electron re-enumeration race that
   * survives even a clean release). On NotFoundError we wait, bounded, for an
   * input to reappear via `devicechange`, then retry once with the default.
   */
  private async acquireMic(inputId: string): Promise<MediaStream> {
    try {
      return await this.micStream(audioCaptureConstraint(inputId));
    } catch (error) {
      if ((error instanceof Error ? error.name : "") !== "NotFoundError") throw error;
      this.logDiag("audio.getUserMedia.retry", { deviceId: inputId || "default" });
      if (!(await this.waitForInputDevice(6000))) throw error;
      return await this.micStream(true);
    }
  }

  /**
   * getUserMedia with a hard timeout. After a rapid stop→start the audio input
   * can be mid-release and getUserMedia hangs forever (never resolves or
   * rejects) — which stranded the UI in "connecting". A late-arriving stream is
   * released so a timeout can't leak the mic.
   */
  private micStream(
    constraint: true | MediaTrackConstraints,
    timeoutMs = 10000,
  ): Promise<MediaStream> {
    const request = navigator.mediaDevices.getUserMedia({ audio: constraint });
    let timedOut = false;
    return new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        this.logDiag("audio.getUserMedia.timeout", {});
        reject(new DOMException("microphone did not respond", "TimeoutError"));
      }, timeoutMs);
      request.then(
        (stream) => {
          clearTimeout(timer);
          if (timedOut) for (const track of stream.getTracks()) track.stop();
          else resolve(stream);
        },
        (error) => {
          clearTimeout(timer);
          if (!timedOut) reject(error);
        },
      );
    });
  }

  /** Resolve true once an audio input is present, else false after `timeoutMs`. */
  private waitForInputDevice(timeoutMs: number): Promise<boolean> {
    const media = navigator.mediaDevices;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        media.removeEventListener?.("devicechange", probe);
        resolve(ok);
      };
      const probe = () => {
        void this.enumerateDevices().then((devices) => {
          if (devices.some((device) => device.kind === "audioinput" && device.deviceId)) finish(true);
        });
      };
      media.addEventListener?.("devicechange", probe);
      const poll = setInterval(probe, 500);
      const timer = setTimeout(() => finish(false), timeoutMs);
      probe();
    });
  }

  /** Fire-and-forget transcript logging; must never affect the call. */
  private log(kind: string, payload: Record<string, unknown> = {}) {
    const sessionId = this.nonce;
    const bindings = this.bindings;
    if (!sessionId || !bindings) return;
    this.noteActivity(kind, payload);
    // Stamp which client/realm produced this event (see client-identity.ts) so
    // the transcript/DB shows where things actually happened across surfaces.
    this.writeEvent(bindings.rpc, sessionId, kind, payload);
  }

  /** Track the latest meaningful event for the dock ticker (ignores diagnostics). */
  private noteActivity(kind: string, payload: Record<string, unknown>) {
    let next: { kind: string; name: string; text: string } | null;
    if (kind === "session.started") next = null;
    else if (kind === "user" || kind === "assistant" || kind === "notice") next = { kind, name: "", text: String(payload.text ?? "") };
    else if (kind === "reply.speaking") next = { kind: "notice", name: "", text: String(payload.text ?? "") };
    else if (kind === "tool.call") next = { kind: "notice", name: "", text: "Working…" };
    else return; // diagnostics / tool.result don't move the ticker
    this.lastActivity = next;
    this.emitChange();
  }

  /**
   * Durable audio-device diagnostics. Unlike `log`, this does NOT require an
   * active nonce — device work (and playback failures that land after teardown
   * has cleared the nonce) must still be recorded, or the diagnostic is lost
   * exactly when it matters. Falls back to a stable synthetic session id.
   */
  private logDiag(kind: string, payload: Record<string, unknown> = {}) {
    const rpc = this.bindings?.rpc;
    if (!rpc) return;
    this.writeEvent(rpc, this.nonce ?? "audio-diagnostics", kind, payload);
  }

  private writeEvent(rpc: RpcClient, sessionId: string, kind: string, payload: Record<string, unknown>) {
    const event = { sessionId, kind, payload: { ...payload, _id: identityTag() } };
    const send = () => rpc.call("logEvent", event);
    // Preserve call/result ordering while letting the realtime audio proceed.
    const pending = (this.logQueue ? this.logQueue.then(send) : Promise.resolve().then(send))
      .catch(error => { console.warn("Voice Mode session event could not be saved", { sessionId, kind, error }); });
    this.logQueue = pending;
    void pending.finally(() => { if (this.logQueue === pending) this.logQueue = null; });
  }

  // ---- audio lifecycle: keep inbound audio playing and the mic alive across
  // navigation/backgrounding (see HF-2). Everything here is defensive; a browser
  // without DOM (tests) simply skips the DOM/track wiring.

  /** Inline playback + in-DOM element: the reliable iOS shape for WebRTC audio. */
  private prepareAudioElement(audio: HTMLAudioElement) {
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    if (typeof document === "undefined") return;
    try {
      audio.setAttribute("playsinline", "");
      audio.style.display = "none";
      document.body.appendChild(audio);
    } catch {
      /* no DOM to attach to — inbound audio still plays via srcObject */
    }
  }

  /**
   * Watch a mic track for OS suspension. iOS mutes (and sometimes ends) the mic
   * track when it backgrounds the owning realm; `enabled=false` from our own
   * mute does NOT fire these, so `mute` here always means the source stopped.
   */
  private attachMicLifecycle(session: SessionHandle, track: MediaStreamTrack) {
    track.onmute = () => {
      if (this.session !== session) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // Name the tool that ran just before this, so a suspension caused by a
      // navigation tool we haven't classified yet is self-reporting in the logs.
      const cause =
        this.lastTool && Date.now() - this.lastTool.at < 4000 ? this.lastTool.name : null;
      this.logDiag("mic.track.muted", { hidden, cause });
      if (hidden) {
        // Backgrounded on mobile: the mic is gone and this realm is about to
        // freeze. End cleanly NOW (while the handler still runs) and enforce it
        // server-side, so it never becomes an unstoppable zombie.
        this.logDiag("mic.suspend.teardown", { cause });
        this.endBecauseSuspended();
      } else {
        // Mic muted while visible (another app grabbed it, glitch): try to heal.
        this.setMicSuspended(true);
        void this.recoverMicIfNeeded(session);
      }
    };
    track.onunmute = () => {
      if (this.session !== session) return;
      this.logDiag("mic.track.unmuted", {});
      this.setMicSuspended(false); // OS resumed the same track — uplink is back
    };
    track.onended = () => {
      if (this.session !== session) return;
      this.logDiag("mic.track.ended", {});
      this.setMicSuspended(true);
      void this.recoverMicIfNeeded(session);
    };
  }

  /**
   * End a call because the OS suspended its mic while backgrounded (mobile).
   * Force-stops server-side FIRST (so the end survives even if this realm freezes
   * a beat later), then tears down locally. This is the honest alternative to a
   * silent one-way zombie: the call ends and every surface goes idle.
   */
  private endBecauseSuspended() {
    const nonce = this.nonce;
    toast.info("Aide: call ended — the app moved to the background");
    if (nonce) this.forceStop(nonce);
    this.stop();
  }

  /** On returning to the foreground, try to revive a suspended mic. */
  private attachPageLifecycle(session: SessionHandle) {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (this.session !== session) return;
      this.logDiag("page.visibility", { state: document.visibilityState });
      if (document.visibilityState === "visible") void this.recoverMicIfNeeded(session);
    };
    document.addEventListener("visibilitychange", onVisibility);
    session.disposeLifecycle = () => document.removeEventListener("visibilitychange", onVisibility);
  }

  /**
   * Replace a dead/suspended mic track with a fresh one, keeping the same pc and
   * realtime session (replaceTrack needs no renegotiation). Only attempts in the
   * foreground — iOS blocks getUserMedia while backgrounded. A no-op when the mic
   * is already healthy.
   */
  private async recoverMicIfNeeded(session: SessionHandle) {
    if (this.session !== session) return;
    const sender = session.micSender;
    const track = session.micTrack;
    if (!sender) return;
    if (track && track.readyState === "live" && !track.muted) {
      this.setMicSuspended(false); // already healthy
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    this.logDiag("mic.recover.attempt", { readyState: track?.readyState ?? null, muted: track?.muted ?? null });
    try {
      const fresh = await this.acquireMic(this.audioPreferences.inputDeviceId);
      if (this.session !== session) {
        for (const t of fresh.getTracks()) t.stop();
        return;
      }
      const newTrack = fresh.getAudioTracks()[0];
      if (!newTrack) throw new Error("no audio track");
      newTrack.enabled = this.state !== "muted"; // preserve the user's mute
      await sender.replaceTrack(newTrack);
      // Detach the old track's lifecycle handlers before stopping it — otherwise
      // its onended fires (session still current) and re-enters suspend/recover,
      // flashing a false "mic paused".
      if (session.micTrack) {
        session.micTrack.onmute = null;
        session.micTrack.onunmute = null;
        session.micTrack.onended = null;
        session.micTrack.stop();
      }
      session.micTrack = newTrack;
      this.attachMicLifecycle(session, newTrack);
      this.setMicSuspended(false);
      this.logDiag("mic.recover.ok", {});
    } catch (error) {
      this.logDiag("mic.recover.failed", { name: error instanceof Error ? error.name : "unknown" });
    }
  }

  /** Mute = mic track sends silence; the call and playback stay up. */
  setMuted(muted: boolean) {
    const session = this.session;
    if (!session || (this.state !== "live" && this.state !== "muted")) return;
    // Prefer the tracked mic track — recovery may have replaced it with one that
    // is no longer part of the original getUserMedia stream.
    if (session.micTrack) session.micTrack.enabled = !muted;
    else for (const track of session.stream.getAudioTracks()) track.enabled = !muted;
    this.log(muted ? "muted" : "unmuted");
    this.setUserSpeaking(false); // a muted mic can't be mid-utterance
    this.setState(muted ? "muted" : "live");
  }

  toggleMute() {
    this.setMuted(this.state !== "muted");
  }

  private scheduleReplyDrain(delayMs = REPLY_QUIET_MS) {
    if (!this.bridge) return;
    this.bridge.drain();
    this.refreshBridgeSnapshot();
    if (this.replyTimer) clearTimeout(this.replyTimer);
    const session = this.session;
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.session !== session) return;
      this.bridge?.drain();
      this.refreshBridgeSnapshot();
    }, delayMs);
    maybeUnref(this.replyTimer);
  }

  /** Another window (or this one) started a call: only the newest survives. */
  onCallStarted(nonce: string, sequence?: number) {
    if (nonce === this.nonce || this.state === "idle") return;
    if (sequence !== undefined) {
      if (this.callSequence === null) {
        if (!this.newerClaim || sequence > this.newerClaim.sequence) this.newerClaim = { nonce, sequence };
        return;
      }
      if (sequence <= this.callSequence) return;
    }
    this.stop();
  }

  /**
   * Ask the model to continue — at most one response.create in flight.
   * The realtime API rejects response.create while a response is being
   * generated (e.g. two tool calls in one response would send two), so an
   * active response defers a single coalesced create until response.done.
   */
  private requestResponse(dc: RTCDataChannel) {
    if (dc.readyState !== "open") return;
    if (this.responseActive || this.userSpeaking || this.inputPending() || (this.userTurnPending && this.responseUserTurn !== this.userTurn)) {
      this.responsePending = true;
      return;
    }
    this.activeResponseId = null;
    this.setResponseActive(true);
    dc.send(JSON.stringify({
      type: "response.create",
    }));
  }

  stop() {
    const endedNonce = this.nonce;
    if (endedNonce) {
      for (const item of this.transcriptBuffer.unfinished()) {
        if (hasSpokenWords(item.payload.text)) this.log(item.kind, { ...item.payload, partial: false, unfinished: true });
      }
      if (this.playbackResponseId) this.log("speech.lifecycle", {responseId:this.playbackResponseId,state:"interrupted",...this.responseIdentity.get(this.playbackResponseId),reason:"hangup"});
      this.log("session.stopped");
    }
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    this.transcriptSend = null; this.transcriptDirty = false;
    this.transcriptBuffer.reset();
    for (const item of this.inputItems.values()) if (item.timer) clearTimeout(item.timer);
    this.inputItems.clear(); this.inputOrder = 0;
    this.endCallAfterResponse = false;
    if (this.bridge) {
      this.bridge.dispose("hangup");
      this.bridge = null;
      this.bridgeSnapshot = null;
    }
    this.clearConnectWatchdog();
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.stopPresenceHeartbeat();
    this.liveStartedAt = null;
    const session = this.session;
    this.session = null;
    this.nonce = null;
    this.callSequence = null;
    this.newerClaim = null;
    this.toolChain = Promise.resolve();
    this.uiChain = Promise.resolve();
    this.resetUiRecovery();
    this.uiCommands.clear();
    this.cancelledQuickRequests.clear();
    this.revokedUiCommands.clear();
    this.bufferedUiCommands.clear();
    this.uiReady = false;
    this.uiConnectionGeneration++;
    this.setResponseActive(false);
    this.setAssistantSpeaking(false);
    this.responsePending = false;
    this.activeResponseId = null;
    this.toolResponseIds.clear();
    this.responseUserTurn = null;
    this.userTurn = 0;
    this.userTurnPending = false;
    this.userTurnCommitted = false;
    this.pendingToolCalls = 0;
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.replyTimer = null;
    this.setUserSpeaking(false);
    this.setMicSuspended(false);
    if (session) {
      session.disposeLifecycle?.();
      session.dc?.close();
      session.pc.close();
      for (const track of session.stream.getTracks()) track.stop();
      session.micTrack?.stop(); // a recovered track lives outside stream
      session.audio.srcObject = null;
      session.audio.remove();
    }
    this.setState("idle");
    // Clear every mirror now that the call is over. Done after nulling nonce so
    // setState's own broadcast is skipped and this is the single idle announce.
    if (endedNonce) this.broadcastPresence("idle", endedNonce);
  }

  private async handleToolCall(dc: RTCDataChannel, event: Record<string, unknown>) {
    if (dc.readyState !== "open" || !this.nonce) return;
    const bindings = this.bindings;
    const name = String(event.name ?? "");
    const callId = String(event.call_id ?? "");
    const toolSessionId = this.nonce;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(typeof event.arguments === "string" ? event.arguments : "{}");
    } catch {
      /* keep {} */
    }
    this.log("tool.call", { name, args, callId });
    this.lastTool = { name, at: Date.now() };
    let output: string;
    let status: "success" | "error" | undefined;
    let label: string | undefined;
    let requestResponseAfter = true;
    try {
      if (!bindings) {
        throw new Error("No bb surface is bound right now.");
      } else if (!this.bridge) {
        throw new Error("The coordinator conversation is unavailable.");
      } else if (this.interruptedResponses.has(String(event.response_id))) {
        requestResponseAfter = false;
        throw new Error("Held: this response was interrupted. Wait for the user's next complete request.");
      } else if (name === "read_thread") {
        const origin = this.responseIdentity.get(String(event.response_id));
        const result = await bindings.rpc.call("readVoiceThread",{nonce:toolSessionId,threadId:typeof args.threadId === "string" ? args.threadId : ""});
        if (origin?.userTurn !== this.userTurn || this.interruptedResponses.has(String(event.response_id))) {
          requestResponseAfter = false;
          throw new Error("This read belongs to an earlier spoken turn.");
        }
        output = JSON.stringify(result);
        status = "success";
      } else if (name === "lookup_targets") {
        const origin = this.responseIdentity.get(String(event.response_id));
        const result = await bindings.rpc.call("lookupVoiceTargets", {nonce:toolSessionId,query:typeof args.query === "string" ? args.query : ""});
        if (origin?.userTurn !== this.userTurn || this.interruptedResponses.has(String(event.response_id))) {
          requestResponseAfter = false;
          throw new Error("The lookup belongs to an earlier spoken turn.");
        }
        output = JSON.stringify(result);
        status = "success";
      } else if (name === "delegate_to_coordinator" || name === "quick_action") {
        const origin = typeof event.response_id === "string" ? this.responseIdentity.get(event.response_id) : null;
        if (!origin || origin.userTurn !== this.userTurn || this.userSpeaking) {
          requestResponseAfter = false;
          throw new Error("Held: the user continued speaking. Wait for their complete current request.");
        }
        output = this.bridge.delegate(callId, args, name === "quick_action");
        requestResponseAfter = false;
        this.delegatedTurn = this.userTurn;
        status = "success";
        label = "Request recorded";
        this.refreshBridgeSnapshot();
      } else if (name === "sequence_control") {
        const origin = this.responseIdentity.get(String(event.response_id));
        if (!origin || origin.userTurn !== this.userTurn || this.userSpeaking) throw new Error("Wait for the current spoken instruction.");
        const result = await this.bridge.controlSequence(args);
        output = result.message;
        requestResponseAfter = result.status !== "accepted";
        status = "success";
      } else if (name === "remain_silent") {
        output = this.bridge.remainSilent();
        this.delegatedTurn = this.userTurn;
        status = "success";
        requestResponseAfter = false;
      } else if (name === "end_call") {
        this.endCallAfterResponse = true;
        output = "Ending the call after this reply.";
        status = "success";
      } else {
        throw new Error(`Unknown realtime tool: ${name}`);
      }
    } catch (error) {
      status = "error";
      output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Use the captured session: a stopped call's late result must not land in a new one.
    if (toolSessionId && bindings) this.writeEvent(bindings.rpc, toolSessionId, "tool.result", {
      name, callId, output: output.slice(0, 4000), status: status ?? actionStatus({ output }),
      ...(label ? { label } : {}),
    });
    if (!callId || dc.readyState !== "open" || this.nonce !== toolSessionId) return;
    // Creating the output item is always safe; only response.create must wait.
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    if (requestResponseAfter) this.requestResponse(dc);
    else this.scheduleReplyDrain();
  }

  /** Publish bounded, replaceable drafts; durable logs contain final text only. */
  private streamChanged() {
    this.transcriptDirty = true;
    if (this.transcriptTimer || this.transcriptSend || !this.nonce) return;
    const nonce = this.nonce;
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null;
      if (this.nonce !== nonce || !this.bindings) return;
      this.transcriptDirty = false;
      const rpc = this.bindings.rpc, snapshot = this.transcriptBuffer.snapshot(nonce);
      const pending = Promise.resolve().then(() => rpc.call("publishTranscript", snapshot)).catch(() => {});
      this.transcriptSend = pending;
      void pending.finally(() => {
        if (this.transcriptSend !== pending || this.nonce !== nonce) return;
        this.transcriptSend = null;
        if (this.transcriptDirty) this.streamChanged();
      });
    }, 100);
  }

  private completeStream(kind: "user" | "assistant", itemId: string) {
    this.transcriptBuffer.complete(kind, itemId);
    const nonce = this.nonce;
    // Keep the draft until its durable final is saved, so it cannot blink out
    // between a live snapshot and the history refresh on another device.
    void (this.logQueue ?? Promise.resolve()).then(() => {
      if (this.nonce !== nonce) return;
      this.transcriptBuffer.remove(kind, itemId);
      this.streamChanged();
    });
  }

  private inputItem(itemId: string) {
    let item = this.inputItems.get(itemId);
    if (!item) {
      item = { order: ++this.inputOrder, startedAt: performance.now(), speaking: false, confirmed: false, complete: false, requested: false, text: "", timer: null };
      this.inputItems.set(itemId, item);
      // Finished identities remain long enough to reject duplicate late events.
      if (this.inputItems.size > 300) {
        const oldest = [...this.inputItems].find(([, value]) => value.complete);
        if (oldest) this.inputItems.delete(oldest[0]);
      }
    }
    return item;
  }

  private inputPending() { return [...this.inputItems.values()].some(item => !item.complete); }

  /** A VAD candidate becomes an interruption only after recognised words. */
  private confirmWords(itemId: string, text: string) {
    const item = this.inputItem(itemId);
    if (item.complete || item.confirmed || !hasSpokenWords(text) || item.order < this.userTurn) return;
    item.confirmed = true;
    this.userTurn = item.order;
    this.userTurnPending = true;
    this.userTurnCommitted = false;
    this.responsePending = false;
    this.setUserSpeaking(item.speaking);
    const generation = this.activeResponseId, playback = this.playbackResponseId;
    this.log("input.wordsConfirmed", { itemId, userTurn: item.order, sinceDetectionMs: performance.now() - item.startedAt, generation, playback });
    if (generation) {
      this.interruptedResponses.add(generation);
      this.toolResponseIds.delete(generation);
      this.cancelResponse(generation, "recognised-words");
    }
    if (playback) {
      this.interruptedResponses.add(playback);
      this.log("speech.lifecycle", { responseId: playback, state: "interrupted", ...this.responseIdentity.get(playback), reason: "recognised-words" });
      this.session?.dc?.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
      this.playbackResponseId = null;
    }
    this.bridge?.onSpeechStarted();
    this.setAssistantSpeaking(false);
    this.scheduleReplyDrain();
  }

  private completeInput(itemId: string, text: string, error?: Record<string, unknown>) {
    if (!itemId) return;
    const item = this.inputItem(itemId);
    if (item.complete) {
      if (!item.text && hasSpokenWords(text)) {
        item.text = text;
        this.log("user", { text, itemId, userTurn: item.order });
        this.log("transcription.result", { itemId, userTurn: item.order, outcome: "complete", characters: text.length, late: true });
        this.completeStream("user", itemId);
      }
      return;
    }
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    this.confirmWords(itemId, text);
    item.complete = true;
    item.text = text;
    if (item.order === this.userTurn) this.setUserSpeaking(false);
    if (hasSpokenWords(text)) {
      this.log("user", { text, itemId, userTurn: item.order });
      if (item.order === this.userTurn) {
        this.userTurnCommitted = true;
        this.bridge?.onUserItemCommitted(itemId, item.order);
        this.bridge?.onTranscript(itemId, text);
      } else {
        if (this.bridge?.hasUserItem(itemId)) this.bridge.onTranscript(itemId, text);
        this.log("transcription.result", { itemId, userTurn: item.order, outcome: "complete", characters: text.length, late: true });
      }
    } else if (item.confirmed && item.order === this.userTurn) {
      this.bridge?.onUserItemCommitted(itemId, item.order);
      this.bridge?.onTranscript(itemId, "", error);
    } else {
      if (this.bridge?.hasUserItem(itemId)) this.bridge.onTranscript(itemId, "", error);
      // Noise owns no semantic turn, and cannot cancel an earlier valid answer.
      this.log("transcription.result", { itemId, outcome: error ? "failed" : "empty", characters: 0, ...(error ? { error } : {}) });
    }
    this.completeStream("user", itemId);
    this.maybeRespondToInput();
    this.refreshBridgeSnapshot();
    this.scheduleReplyDrain();
  }

  private maybeRespondToInput() {
    const dc = this.session?.dc;
    if (!dc || this.inputPending()) return;
    const items = [...this.inputItems.values()].filter(item => item.order === this.userTurn);
    if (!this.userTurnPending || this.bridge?.inputUnavailable() || !items.length || items.some(item => !item.complete || item.requested || !hasSpokenWords(item.text))) return;
    for (const item of items) item.requested = true;
    this.responseUserTurn = this.userTurn;
    this.requestResponse(dc);
  }

  /** Generation may finish well before playback. Never cancel a finished response. */
  private cancelResponse(responseId: string, reason: string) {
    const dc = this.session?.dc;
    if (dc?.readyState !== "open" || this.activeResponseId !== responseId || this.completedResponses.has(responseId)) return;
    if ([...this.cancellationEvents.values()].some(event => event.responseId === responseId)) return;
    const eventId = `cancel_${crypto.randomUUID()}`;
    this.cancellationEvents.set(eventId, {responseId, reason});
    if (this.cancellationEvents.size > 300) this.cancellationEvents.delete(this.cancellationEvents.keys().next().value!);
    dc.send(JSON.stringify({type: "response.cancel", response_id: responseId, event_id: eventId}));
    this.log("response.cancelRequested", {responseId, eventId, reason});
  }

  /** Cancel only the current realtime answer when its input cannot be transcribed. */
  private cancelUntranscribedResponse(turn: number) {
    if (turn !== this.userTurn) return;
    this.userTurnPending = false;
    this.userTurnCommitted = false;
    this.responsePending = false;
    const dc = this.session?.dc;
    const id = this.activeResponseId;
    if (id && this.responseIdentity.get(id)?.source === "realtime" && this.responseIdentity.get(id)?.userTurn === turn) {
      this.toolResponseIds.delete(id);
      this.interruptedResponses.add(id);
      this.cancelResponse(id, "transcript-unavailable");
      this.log("response.ignored", {responseId: id, reason: "transcript-unavailable", userTurn: turn});
    }
    const playback = this.playbackResponseId;
    if (playback && this.responseIdentity.get(playback)?.source === "realtime" && this.responseIdentity.get(playback)?.userTurn === turn) {
      dc?.send(JSON.stringify({type: "output_audio_buffer.clear"}));
      this.log("speech.lifecycle", {responseId: playback, state: "interrupted", ...this.responseIdentity.get(playback), reason: "transcript-unavailable"});
      this.interruptedResponses.add(playback);
      this.playbackResponseId = null;
      this.setAssistantSpeaking(false);
    }
    this.scheduleReplyDrain();
  }

  private createBridge(dc: RTCDataChannel, conversationId: string): CoordinatorBridge {
    const host = {
      nonce: () => this.nonce,
      callSequence: () => this.callSequence,
      send: (event: Record<string, unknown>) => {
        if (dc.readyState !== "open" || this.session?.dc !== dc) return false;
        dc.send(JSON.stringify(event));
        return true;
      },
      rpc: async <T,>(method: string, args: unknown): Promise<T> => {
        const rpc = this.bindings?.rpc;
        if (!rpc) throw new Error("No bb surface is bound right now.");
        return (await rpc.call(method as never, args as never)) as T;
      },
      log: (kind: string, payload: Record<string, unknown> = {}) => this.log(kind, payload),
      facts: () => ({
        userSpeaking: this.userSpeaking,
        inputUnresolved: this.inputPending() || (this.userTurnPending && this.responseUserTurn !== this.userTurn),
        responseActive: this.responseActive,
        assistantSpeaking: this.assistantSpeaking,
        responsePending: this.responsePending,
        pendingToolCalls: this.pendingToolCalls,
        handoffPending: this.bridge?.snapshot().pendingHandoff !== null && this.bridge !== null,
        questionOpen: this.bridge?.snapshot().openQuestion !== null && this.bridge !== null,
        quietForMs: Date.now() - this.conversationChangedAt,
      }),
      view: () => {
        const { threadId, projectId, onNewThreadScreen } = nativeUi.snapshot();
        return { threadId, projectId, onNewThreadScreen };
      },
      now: () => Date.now(),
      speaking: () => {
        this.activeResponseId = null;
        this.setResponseActive(true);
      },
      changed: () => this.refreshBridgeSnapshot(),
      cancelResponse: (responseId: string, reason: string) => this.cancelResponse(responseId, reason),
      subscribeNavigation: (listener:()=>void) => {
        let route=nativeUi.snapshot().route;
        return nativeUi.subscribe(()=>{const next=nativeUi.snapshot().route;if(next!==route){route=next;listener();}});
      },
      inputUnavailable: (turn: number) => this.cancelUntranscribedResponse(turn),
      cancelQuickRequest: (requestId: string) => { this.cancelledQuickRequests.add(requestId); },
    };
    return new CoordinatorBridge(host, conversationId, () => this.userTurn);
  }

  private async start(transferFromNonce?: string) {
    const bindings = this.bindings;
    if (!bindings) return;
    // Assign the nonce before entering "connecting" so that state's presence
    // broadcast already carries our identity.
    const nonce = crypto.randomUUID();
    this.nonce = nonce;
    this.callSequence = null;
    this.newerClaim = null;
    this.setState("connecting");
    this.log("session.started", { ...bindings.context, device: deviceSummary() });
    let acquiredStream: MediaStream | null = null;
    try {
      this.delegatedTurn = null;
      this.spokenTurns.clear();
      this.interruptedResponses.clear();
      this.completedPlayback.clear();
      this.completedResponses.clear();
      this.cancellationEvents.clear();
      this.rejectedToolCalls.clear();
      this.clearedInterruptedPlayback.clear();
      this.inputSegment = null;
      this.responseIdentity.clear();
      this.playbackResponseId = null;
      const selectedConversationId = this.nextConversationId;
      this.nextConversationId = undefined;
      const newConversation = this.startNewConversation;
      this.startNewConversation = false;
      let conversationId: string | null = null;
      const claimOwnership = async (): Promise<boolean> => {
        const claim = await bindings.rpc.call("claimCall", {
          nonce,
          newConversation,
          ...(transferFromNonce ? {transferFromNonce} : {}),
          ...(selectedConversationId ? {conversationId: selectedConversationId} : {}),
          threadId: bindings.context.threadId,
          projectId: bindings.context.projectId,
        });
        const { sequence } = claim;
        if (this.nonce !== nonce) {
          void bindings.rpc.call("forceStop", { nonce }).catch(() => undefined);
          return false;
        }
        this.callSequence = sequence;
        this.remotePresence = null;
        this.disarmRemoteExpiry();
        conversationId = claim.conversationId;
        if (!conversationId) throw new Error("The server did not provide a coordinator conversation.");
        this.logicalConversationId = conversationId;
        this.emitChange();
        if (conversationId) this.log("coordinator.conversation", { conversationId, resumed: claim.resumed, queuedUpdates: claim.queuedUpdates, newConversation });
        const newerClaim = this.newerClaim as { nonce: string; sequence: number } | null;
        if (newerClaim) this.onCallStarted(newerClaim.nonce, newerClaim.sequence);
        if (this.nonce !== nonce) return false;
        this.broadcastPresence("connecting", nonce);
        return true;
      };
      // Keep the other device's call alive while this device asks for microphone access.
      if (!transferFromNonce && !await claimOwnership()) return;
      // Deterministic acquisition: enumerate what is actually present, resolve
      // the saved ids against it (a saved id whose salt rotated across restarts
      // simply resolves to the system default), then acquire. No "try an exact
      // id, catch, retry" dance — every branch is decided up front and logged.
      const devices = await this.enumerateDevices();
      if (this.nonce !== nonce) return;
      const support = describeAudioSupport(devices, this.audioPreferences);
      const micPermission = await queryMicPermission(navigator.permissions);
      if (this.nonce !== nonce) return;
      const saved = this.audioPreferences;
      const inputMatch = resolveDevice(devices, "audioinput", saved.inputDeviceId, saved.inputLabel);
      const inputId = inputMatch.deviceId;
      this.logDiag("audio.snapshot", {
        micPermission,
        inputs: devices.filter((device) => device.kind === "audioinput").length,
        outputs: devices.filter((device) => device.kind === "audiooutput").length,
        savedInput: saved.inputLabel || saved.inputDeviceId || null,
        matchedBy: inputMatch.matchedBy,
        inputValid: support.inputValid,
        labelsHidden: support.labelsHidden,
      });
      // Re-matched by label after an id rotation: quietly adopt the new id so it
      // is a clean id-match next time. Speaker always uses the system default.
      if (inputMatch.matchedBy === "label" && inputId !== saved.inputDeviceId) {
        this.setAudioPreferences({ ...saved, inputDeviceId: inputId });
      } else if (saved.inputDeviceId && inputMatch.matchedBy === "default") {
        // The chosen mic is genuinely gone. Tell the user (not an error) and keep
        // their selection so they can see it and re-pick — do not silently wipe.
        const name = saved.inputLabel || "your selected microphone";
        toast.info(`Aide: ${name} isn't available — using the system default. Pick one in Voice Mode settings.`);
      }

      let stream: MediaStream;
      try {
        stream = await this.acquireMic(inputId);
        acquiredStream = stream;
        if (this.nonce !== nonce) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        this.logDiag("audio.getUserMedia.failed", { name, deviceId: inputId || "default" });
        throw new Error(
          name === "NotAllowedError"
            ? "microphone permission blocked — open Voice Mode settings to fix it"
            : name === "NotFoundError"
              ? "no microphone available — check Voice Mode settings"
              : `microphone error (${name})`,
        );
      }
      const micTrack = stream.getAudioTracks()[0];
      const micSettings = micTrack?.getSettings?.();
      this.logDiag("audio.getUserMedia.ok", { deviceId: inputId || "default",
        settings: micSettings ? {sampleRate: micSettings.sampleRate, channelCount: micSettings.channelCount,
          echoCancellation: micSettings.echoCancellation, noiseSuppression: micSettings.noiseSuppression,
          autoGainControl: micSettings.autoGainControl} : null });
      if (transferFromNonce && !await claimOwnership()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      if (!conversationId) throw new Error("The voice conversation is unavailable.");
      const callConversationId = conversationId;


      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      // iOS plays inline (not fullscreen) and is far more reliable across
      // navigation/backgrounding when the element is actually in the DOM — a
      // detached `new Audio()` can go silent. Hidden so it never shows.
      this.prepareAudioElement(audio);
      const session: SessionHandle = { pc, stream, audio, dc: null, micTrack: null, micSender: null };
      this.session = session;
      // Never stay "connecting" forever: if the data channel hasn't opened in
      // time, tear the attempt down and let the user retry cleanly.
      this.clearConnectWatchdog();
      this.connectTimer = setTimeout(() => {
        if (this.session?.pc === pc && this.state === "connecting") {
          this.logDiag("conn.timeout", { state: pc.connectionState });
          toast.error("Aide: couldn't connect — please try again");
          this.stop();
        }
      }, 15000);
      if (this.session?.pc !== pc) return;

      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      // Track the mic sender + track so a suspended mic (iOS backgrounding) can
      // be swapped for a fresh one via replaceTrack, no renegotiation needed.
      session.micTrack = stream.getAudioTracks()[0] ?? null;
      session.micSender =
        pc.getSenders?.().find((sender) => sender.track?.kind === "audio") ?? null;
      if (session.micTrack) this.attachMicLifecycle(session, session.micTrack);
      this.attachPageLifecycle(session);
      pc.ontrack = (event) => {
        if (this.session?.pc !== pc) return; // torn down mid-negotiation
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        // Never swallow a real playback failure ("live" but silent). But a
        // play() aborted because the session was torn down (srcObject cleared,
        // element removed) is not a speaker fault — log it, don't cry wolf.
        void audio.play().then(
          () => this.logDiag("audio.play.ok"),
          (error) => {
            const name = error instanceof Error ? error.name : "unknown";
            if (name === "AbortError" || this.session?.pc !== pc) {
              this.logDiag("audio.play.aborted", { name });
              return;
            }
            this.logDiag("audio.play.failed", { name });
            toast.error("Aide: can't play audio. Check your system sound settings.");
          },
        );
      };
      pc.onconnectionstatechange = () => {
        if (this.session?.pc !== pc) return;
        this.logDiag("conn.state", { state: pc.connectionState });
        if (pc.connectionState === "connected") {
          if (session.dc?.readyState === "closed" || session.dc?.readyState === "closing") {
            toast.error("Aide: voice event connection closed");
            this.stop();
            return;
          }
          if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        } else if (pc.connectionState === "failed") {
          toast.error("Aide: voice connection lost");
          this.stop();
        } else if (pc.connectionState === "disconnected" && !this.disconnectTimer) {
          toast.info("Aide: connection interrupted — waiting to reconnect");
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (this.session?.pc === pc && pc.connectionState !== "connected") {
              toast.error("Aide: voice connection lost");
              this.stop();
            }
          }, DISCONNECT_GRACE_MS);
          maybeUnref(this.disconnectTimer);
        }
      };
      pc.oniceconnectionstatechange = () => {
        this.logDiag("conn.ice", { state: pc.iceConnectionState });
      };

      const dc = pc.createDataChannel("oai-events");
      session.dc = dc;
      dc.onopen = () => {
        if (this.session?.pc === pc) {
          this.clearConnectWatchdog();
          this.liveStartedAt = Date.now();
          this.markConversationChange();
          this.bridge = this.createBridge(dc, callConversationId);
          this.refreshBridgeSnapshot();
          void this.bridge.reconcile();
          this.setState("live");
          void this.syncUiCommands();
          this.startPresenceHeartbeat();
          this.log("session.live");
          this.logDiag("conn.dc.open");
          this.scheduleReplyDrain();
        }
      };
      dc.onclose = () => {
        if (this.session !== session) return;
        this.logDiag("conn.dc.close");
        toast.error("Aide: voice event connection closed");
        this.stop();
      };
      dc.onmessage = (message) => {
        if (this.session !== session || this.nonce !== nonce) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const type = String(event.type ?? "");
        const bridge = this.bridge;
        const responseData = event.response as Record<string, unknown> | undefined;
        const eventResponseId = typeof event.response_id === "string" ? event.response_id : typeof responseData?.id === "string" ? responseData.id : null;
        if (/^(input_audio_buffer\.|output_audio_buffer\.|response\.(created|done))/.test(type) || type === "conversation.item.input_audio_transcription.failed" || type === "conversation.item.truncated") {
          this.log("realtime.event", { eventType: type, responseId: eventResponseId, itemId: event.item_id ?? null,
            userTurn: this.userTurn, monotonicMs: performance.now(), audioStartMs: event.audio_start_ms ?? null, audioEndMs: event.audio_end_ms ?? null, status: responseData?.status ?? null,
            statusDetails: responseData?.status_details ?? null, activeResponseId: this.activeResponseId, playbackResponseId: this.playbackResponseId });
        }
        if (type === "response.created") {
          const response = event.response as Record<string, unknown> | undefined;
          const metadata = response?.metadata as Record<string, unknown> | undefined;
          this.activeResponseId = typeof response?.id === "string" ? response.id : null;
          const bridgeOwned = !!bridge && bridge.ownsResponse(this.activeResponseId, metadata);
          if (bridge && metadata?.bb_voice_source === "coordinator_reply" && !bridge.speechIdentity(this.activeResponseId)) {
            const staleId = this.activeResponseId;
            if (staleId) this.interruptedResponses.add(staleId);
            if (staleId) this.cancelResponse(staleId, "reply-superseded");
            this.log("response.ignored", {responseId:staleId,replyId:metadata.bb_reply_id,reason:"reply was interrupted or replaced before generation started"});
            // Keep the generation slot until response.done, including cancellation races.
            this.setResponseActive(true);
            this.scheduleReplyDrain();
            return;
          }
          const background = !!metadata?.bb_voice_source || bridgeOwned;
          if (this.activeResponseId) {
            const identity = bridge?.speechIdentity(this.activeResponseId);
            this.responseIdentity.set(this.activeResponseId, {userTurn:this.userTurn, requestId:identity?.requestId ?? null, replyId:identity?.replyId ?? null, source:identity?.source ?? (background ? "background" : "realtime")});
            if (this.responseIdentity.size > 300) {
              const oldest = this.responseIdentity.keys().next().value!;
              this.responseIdentity.delete(oldest); this.interruptedResponses.delete(oldest); this.completedPlayback.delete(oldest);
              this.completedResponses.delete(oldest); this.clearedInterruptedPlayback.delete(oldest);
            }
          }
          if (this.activeResponseId && !background) this.toolResponseIds.add(this.activeResponseId);
          this.responseUserTurn = this.userTurnPending && this.userTurnCommitted && !this.userSpeaking && !background ? this.userTurn : null;
          this.setResponseActive(true);
          if (!background && (bridge?.inputUnavailable() || !this.userTurnPending)) this.cancelUntranscribedResponse(this.userTurn);
          this.scheduleReplyDrain();
        } else if (type === "output_audio_buffer.started") {
          const id = eventResponseId ?? this.activeResponseId;
          if (id && this.interruptedResponses.has(id)) {
            // Ignoring the UI event does not stop the audio. Clear late playback,
            // but never clear a different response that has since taken its place.
            if ((!this.playbackResponseId || this.playbackResponseId === id) &&
                (!this.activeResponseId || this.activeResponseId === id) && !this.clearedInterruptedPlayback.has(id)) {
              this.cancelResponse(id, "interrupted-playback");
              dc.send(JSON.stringify({type: "output_audio_buffer.clear"}));
              this.clearedInterruptedPlayback.add(id);
              this.log("speech.discarded", {responseId: id, reason: "late playback after interruption"});
            }
            return;
          }
          if (!id || !this.responseIdentity.has(id) || this.interruptedResponses.has(id) || this.completedPlayback.has(id)) return;
          this.playbackResponseId = id;
          this.setAssistantSpeaking(true);
          const identity = this.responseIdentity.get(id)!;
          if (identity.source === "realtime") this.spokenTurns.add(identity.userTurn);
          this.log("speech.lifecycle", {responseId:id,state:"started",...identity,monotonicMs:performance.now()});
          bridge?.onAudioStarted(id);
          this.scheduleReplyDrain();
        } else if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
          const id = eventResponseId ?? this.playbackResponseId;
          if (!id || id !== this.playbackResponseId) return;
          this.log("speech.lifecycle", {responseId:id,state:type.endsWith("stopped") ? "delivered" : "interrupted",...this.responseIdentity.get(id),monotonicMs:performance.now()});
          if (type.endsWith("cleared")) this.interruptedResponses.add(id);
          else this.completedPlayback.add(id);
          this.playbackResponseId = null;
          this.setAssistantSpeaking(false);
          if (type.endsWith("stopped")) bridge?.onAudioStopped(id); else bridge?.onAudioCleared(id);
          if (this.endCallAfterResponse && !this.responseActive) { this.stop(); return; }
          this.scheduleReplyDrain();
        } else if (type === "input_audio_buffer.speech_started") {
          bridge?.onInputDetected();
          this.inputSegment = {itemId: event.item_id ?? null, startedAt: performance.now(),
            audioStartMs: typeof event.audio_start_ms === "number" ? event.audio_start_ms : null,
            playbackResponseId: this.playbackResponseId, activeResponseId: this.activeResponseId};
          if (typeof event.item_id !== "string" || !event.item_id) return;
          const candidate = this.inputItem(event.item_id);
          if (!candidate.complete) candidate.speaking = true;
          if (candidate.confirmed && candidate.order === this.userTurn) this.setUserSpeaking(true);
          // Detect sound without touching the current response or its playback.
          this.scheduleReplyDrain();
        } else if (type === "input_audio_buffer.speech_stopped") {
          const segment = this.inputSegment;
          const track = stream.getAudioTracks()[0];
          this.log("audio.inputSegment", {itemId: event.item_id ?? null, userTurn: this.userTurn,
            durationMs: segment && segment.itemId === event.item_id && segment.audioStartMs !== null && typeof event.audio_end_ms === "number" ? event.audio_end_ms - segment.audioStartMs : null,
            detectedForMs: segment ? performance.now() - segment.startedAt : null,
            interruptedPlaybackResponseId: segment?.playbackResponseId ?? null,
            interruptedGenerationResponseId: segment?.activeResponseId ?? null,
            microphone: {enabled: track?.enabled ?? null, muted: track?.muted ?? null, readyState: track?.readyState ?? null}});
          this.inputSegment = null;
          if (typeof event.item_id !== "string" || !event.item_id) return;
          const candidate = this.inputItem(event.item_id);
          candidate.speaking = false;
          if (candidate.confirmed && candidate.order === this.userTurn) this.setUserSpeaking(false);
          this.scheduleReplyDrain();
        } else if (type === "input_audio_buffer.committed") {
          const itemId = String(event.item_id ?? "");
          if (!itemId) return;
          const existing = this.inputItems.has(itemId);
          const candidate = this.inputItem(itemId);
          // Multiple commits without another VAD start belong to the same
          // unfinished utterance. Missing words there must still block work.
          if (!existing && this.userTurnPending && [...this.inputItems.values()].some(item => item !== candidate && item.order === this.userTurn && item.confirmed && !item.complete)) {
            candidate.order = this.userTurn;
            candidate.confirmed = true;
          }
          if (candidate.confirmed) this.bridge?.onUserItemCommitted(itemId, candidate.order);
          if (!candidate.complete && !candidate.timer) {
            candidate.timer = setTimeout(() => this.completeInput(itemId, "", { code: "transcript_timeout", message: "No final transcript arrived." }), 4000);
          }
        } else if (type === "conversation.item.input_audio_transcription.delta") {
          const itemId = String(event.item_id ?? "");
          if (!itemId || this.inputItem(itemId).complete) return;
          const draft = this.transcriptBuffer.delta("user", itemId, String(event.delta ?? ""), Date.now(), {}, typeof event.event_id === "string" ? event.event_id : undefined);
          if (draft) { this.confirmWords(itemId, draft.payload.text); this.streamChanged(); }
        } else if (type === "conversation.item.input_audio_transcription.failed") {
          const error = event.error as Record<string, unknown> | undefined;
          this.completeInput(String(event.item_id ?? ""), "", Object.fromEntries(
            ["code", "type", "message"].filter(key => typeof error?.[key] === "string").map(key => [key, String(error![key]).slice(0, 1000)])));
        } else if (type === "response.function_call_arguments.done") {
          if (typeof event.response_id !== "string" || !this.toolResponseIds.has(event.response_id)) {
            this.log("tool.blocked", { reason: "Response is not authorized to call tools", name: event.name, responseId: event.response_id, callId: event.call_id });
            // Close a known rejected conversational call without executing it or
            // requesting another answer. A dangling tool call poisons later turns.
            if (typeof event.response_id === "string" && this.responseIdentity.get(event.response_id)?.source === "realtime" &&
                this.interruptedResponses.has(event.response_id) && typeof event.call_id === "string" && !this.rejectedToolCalls.has(event.call_id)) {
              this.rejectedToolCalls.add(event.call_id);
              if (this.rejectedToolCalls.size > 300) this.rejectedToolCalls.delete(this.rejectedToolCalls.values().next().value!);
              dc.send(JSON.stringify({type: "conversation.item.create", item: {type: "function_call_output", call_id: event.call_id,
                output: "Not executed: this response was interrupted or its input could not be transcribed. Wait silently for the user's next instruction."}}));
            }
            return;
          }
          this.pendingToolCalls += 1;
          this.markConversationChange();
          this.toolChain = this.toolChain
            .then(() => this.session === session ? this.handleToolCall(dc, event) : undefined)
            .catch(() => undefined)
            .finally(() => {
              if (this.session !== session) return;
              this.pendingToolCalls -= 1;
              this.settleDelegatedTurn();
              this.markConversationChange();
              this.scheduleReplyDrain();
            });
        } else if (type === "conversation.item.input_audio_transcription.completed") {
          this.completeInput(String(event.item_id ?? ""), String(event.transcript ?? "").trim());
        } else if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
          const itemId = String(event.item_id ?? "");
          const identity = eventResponseId ? this.responseIdentity.get(eventResponseId) : undefined;
          if (itemId && identity) {
            if (this.transcriptBuffer.delta("assistant", itemId, String(event.delta ?? ""), Date.now(), { ...identity, responseId: eventResponseId }, typeof event.event_id === "string" ? event.event_id : undefined)) this.streamChanged();
          }
        } else if (
          type === "response.output_audio_transcript.done" ||
          type === "response.audio_transcript.done"
        ) {
          const text = String(event.transcript ?? "").trim();
          if (text) {
            const identity = eventResponseId ? this.responseIdentity.get(eventResponseId) : undefined;
            if (identity?.source === "realtime") this.spokenTurns.add(identity.userTurn);
            bridge?.onAssistantTranscript(eventResponseId,text);
            this.log("assistant", {text,responseId:eventResponseId,itemId:event.item_id ?? null,userTurn:this.userTurn,...identity});
            this.completeStream("assistant", String(event.item_id ?? ""));
          }
        } else if (type === "response.done") {
          const response = event.response as Record<string, unknown> | undefined;
          if (typeof response?.id === "string") {
            this.toolResponseIds.delete(response.id);
            this.completedResponses.add(response.id);
            if (this.completedResponses.size > 300) this.completedResponses.delete(this.completedResponses.values().next().value!);
          }
          bridge?.onResponseDone(typeof response?.id === "string" ? response.id : null, String(response?.status ?? ""));
          if (response?.id === this.activeResponseId) {
            const turnFinished = response?.status === "completed" || response?.status === "failed" || response?.status === "incomplete";
            const hasToolCalls = response?.status === "completed" && Array.isArray(response.output) && response.output.some(item => item?.type === "function_call");
            if (turnFinished && this.responseUserTurn === this.userTurn && !this.userSpeaking && !hasToolCalls && this.pendingToolCalls === 0) {
              this.userTurnPending = false;
              this.userTurnCommitted = false;
            }
            this.activeResponseId = null;
            this.setResponseActive(false);
            this.settleDelegatedTurn();
            if (this.endCallAfterResponse && !hasToolCalls && !this.assistantSpeaking) { this.stop(); return; }
            if (this.responsePending) {
              this.responsePending = false;
              this.requestResponse(dc);
            }
            this.scheduleReplyDrain();
          }
          const usage = response?.usage;
          // A response.done can land after stop() cleared the nonce; without one
          // the cost can't be attributed to a session, so drop it rather than
          // writing an orphan usage row.
          if (usage && typeof usage === "object" && this.nonce) {
            void this.bindings?.rpc
              .call("recordUsage", {
                model: typeof response?.model === "string" ? response.model : null,
                sessionId: this.nonce,
                usage: usage as Record<string, unknown>,
              })
              .catch(() => undefined); // cost tracking must never break the call
          }
        } else if (type === "error") {
          const error = event.error as {message?: string; code?: string; type?: string; event_id?: string} | undefined;
          const detail = error?.message;
          const cancellation = error?.event_id ? this.cancellationEvents.get(error.event_id) : undefined;
          const benign = !!cancellation && this.completedResponses.has(cancellation.responseId) &&
            (error?.code === "response_cancel_not_active" || detail === "Cancellation failed: no active response found");
          this.log(benign ? "response.cancelSettled" : "error", {message: detail ?? "realtime error",
            code: error?.code ?? null, type: error?.type ?? null, eventId: error?.event_id ?? null, ...cancellation});
          if (error?.event_id) this.cancellationEvents.delete(error.event_id);
          if (benign) return;
          toast.error(`Aide: ${detail ?? "realtime error"}`);
        }
      };

      const offer = await pc.createOffer();
      if (this.nonce !== nonce) return;
      await pc.setLocalDescription(offer);
      if (this.nonce !== nonce) return;
      await waitForIceGathering(pc);
      if (this.nonce !== nonce) return;
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) throw new Error("No local SDP offer");

      const { sdp } = await bindings.rpc.call("createCall", {
        sdp: localSdp,
        nonce,
        mobile: clientDescriptor.mobile,
        ...bindings.context,
      });
      if (this.session?.pc !== pc) return; // stopped while exchanging
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      acquiredStream?.getTracks().forEach(track => track.stop());
      if (this.nonce !== nonce) return;
      this.stop();
      toast.error(`Aide: ${error instanceof Error ? error.message : String(error)}`);
      this.requestPresence();
    }
  }
}

export const voiceAgent = new VoiceAgent();
