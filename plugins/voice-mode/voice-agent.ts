import { LiveClient, continuedSpeaking, type ResponseBinding, type ToolUtterance } from "./live-client.ts";
import { OutputSequencer, type HeldCall } from "./output-sequencer.ts";
import { InputController, type InputItem } from "./input-controller.ts";
import { startMicrophoneMeter, type MeterHandle } from "./microphone-meter.ts";
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
import { currentSpace } from "./spaces-bridge.ts";
import { TRANSCRIPTION_MODEL, type VoiceEngine } from "./models.ts";

/** The saved space the Threads sidebar shows on this device, or null for all projects or no storage. */
function currentSpaceName(): string | null {
  try { return typeof window === "undefined" ? null : currentSpace(window.localStorage).id ? currentSpace(window.localStorage).name : null; } catch { return null; }
}
import { clientId, realmId, identityTag, clientDescriptor, deviceSummary } from "./client-identity.ts";

export type VoiceState = "idle" | "connecting" | "reconnecting" | "live" | "muted";
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
  /** Which OpenAI session contract this call speaks; set from createCall. */
  engine: VoiceEngine;
  /** The live mic track feeding the pc; swapped in when iOS suspends the mic. */
  micTrack: MediaStreamTrack | null;
  /** The pc's audio sender, so a fresh mic track can replace a suspended one. */
  micSender: RTCRtpSender | null;
  /** Tears down the page/visibility listeners installed for this session. */
  disposeLifecycle?: () => void;
}

interface Recovery {
  fromNonce: string;
  nonce: string;
  muted: boolean;
  stream: MediaStream;
  audio: HTMLAudioElement;
  attempt: number;
  deadlineAt: number;
  deadline?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
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
const HEALTH_LOG_MS = 30_000;
const REPAIR_INSTRUCTION = "Input transcription failed. Ask once for the complete request. Do not call effect tools.";
const GREETING_INSTRUCTION = "The call just started; the system item before this is the call-start context. Speak first: follow the Call start section of your instructions for a new conversation. Do not call effect tools.";
const RESUME_INSTRUCTION = "The call resumed an earlier conversation; the system item before this is the call-start context. Speak first: follow the Call start section of your instructions for a resumed conversation. Do not call effect tools.";
const DISCONNECT_GRACE_MS = 10_000;
const RECOVERY_WINDOW_MS = 60_000;
const RECOVERY_ATTEMPT_MS = 15_000;
/**
 * How long a call may hold with its mic suspended (mobile backgrounding) before
 * it ends on its own. A screen lock must not drop the call — the user walks with
 * the phone locked and expects Ada to resume on unlock — so this is generous.
 * It is only a safety net for a mic that never returns while the WebRTC link
 * somehow stays up; a real connection drop ends the call far sooner on its own.
 */
const SUSPEND_DEADLINE_MS = 15 * 60_000;

/** The Screen Wake Lock sentinel, typed loosely so we don't depend on a lib version. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

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

/** Live append contents cap at 500 tokens; chunk conservatively by length. */
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [""];
}

/**
 * Owns WebRTC in the runtime where a call starts. Other runtimes mirror call
 * presence and relay explicit stop/mute controls. Global bindings keep calls
 * active across routes; the native UI adapter supplies the current context.
 */
export class VoiceAgent {
  constructor(private meterFactory: typeof startMicrophoneMeter = startMicrophoneMeter) {}
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
  private input: InputController | null = null;
  private meterStop: MeterHandle | null = null;
  /** Throttled input health log while live, so a silent call leaves evidence (issue #33). */
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private sessionReady = false;
  private inputState = "";
  private responseRequestVersion: number | null = null;
  private get userTurn(){return this.input?.version ?? 0;}
  private get userTurnPending(){return this.input?.pending ?? false;}
  private outputSequencer = new OutputSequencer();
  private get pendingToolCalls() { return this.outputSequencer.pendingCalls; }
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private get userSpeaking(){return this.input?.speaking ?? false;}
  /**
   * True while Ada's audio is actually playing — tracked from the WebRTC
   * `output_audio_buffer.started/stopped/cleared` events, NOT `responseActive`
   * (which ends at generation done, well before playback finishes).
   */
  private assistantSpeaking = false;
  /** Aborts a session that never reaches "live", so it can't hang connecting. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recovery: Recovery | null = null;
  private connectionAttempt = 0;
  private disconnectedMuted = false;
  /**
   * Ends a call whose mic has stayed suspended past the deadline (mobile
   * backgrounding). Armed on a hidden mic-mute, cleared the moment the mic
   * recovers. Null while the mic is healthy.
   */
  private suspendDeadline: ReturnType<typeof setTimeout> | null = null;
  /**
   * A held Screen Wake Lock, so the phone does not idle-lock mid-call while the
   * user walks or reads. Auto-released by the browser when the page hides, so it
   * is re-requested on every return to the foreground; null when not held.
   */
  private wakeLock: WakeLockSentinelLike | null = null;
  /** When the call first went live (ms), for elapsed-duration UI; null if not. */
  private liveStartedAt: number | null = null;
  /**
   * True while the OS has suspended the mic (typically iOS backgrounding the
   * owning realm). The uplink is dead until recovered — surfaced honestly rather
   * than leaving the call looking "Connected" while Ada can't hear you.
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
  /** Current live tool dispatcher. */
  private liveClient: LiveClient | null = null;
  private responseBinding: ResponseBinding | null = null;
  private pendingBinding: ResponseBinding | null = null;
  /**
   * Per-response instructions for the next model turn that has no user utterance:
   * a transcription repair, or the greeting at call start. Sent once, then cleared.
   */
  private responseInstruction: string | null = null;
  private openOffer: { id: string; nonce: string; responseId: string | null } | null = null;
  private batchPending = false;
  private reports: Promise<unknown> = Promise.resolve();
  private pendingReports = 0;
  private exchanges = new Map<string, { version: number; finished: boolean }>();
  /** When speaking/generation/tool state last changed, for the quiet gate. */
  private conversationChangedAt = 0;
  /** The next start() opens a separate logical conversation. */
  private startNewConversation = false;
  private nextConversationId: string | undefined;
  private logicalConversationId: string | null = null;
  private playbackResponseId: string | null = null;
  private interruptedResponses = new Set<string>();
  private completedPlayback = new Set<string>();
  private completedResponses = new Set<string>();
  private cancellationEvents = new Map<string, {responseId: string; reason: string}>();
  private rejectedToolCalls = new Set<string>();
  private clearedInterruptedPlayback = new Set<string>();
  private transcriptBuffer = new TranscriptBuffer();
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptSend: Promise<unknown> | null = null;
  private transcriptDirty = false;
  private responseIdentity = new Map<string, { userTurn: number; requestId: string | null; replyId: string | null; source: string; binding: ResponseBinding }>();
  /** end_call was requested; the call ends once the goodbye has played. */
  private endCallAfterResponse = false;

  // ---- gpt-live-1 engine state (see handleLiveEvent) ----
  /** Synthetic input item: live transcript fragments carry no item identity. */
  private liveInput: { id: string } | null = null;
  private liveInputCounter = 0;
  /** Current assistant speech run and the silence timer that finalizes it. */
  private liveOutput: { id: string; text: string; lastAt: number } | null = null;
  private liveOutputCounter = 0;
  private liveOutputTimer: ReturnType<typeof setTimeout> | null = null;
  /** Delegated backend responses: nested response id -> tracked calls. */
  private liveResponses = new Map<string, { delegationId: string | null; pending: Set<string>; terminal: boolean }>();
  private liveDelegations = new Map<string, string>(); // delegation id -> nested response id
  /** Outbound append event ids -> purpose, so acks/errors can be matched. */
  private liveAppends = new Map<string, string>();
  /** end_call ran; the delegated response still has to finish and speak. */
  private liveAwaitingGoodbye = false;
  /** The end_call delegation's backend response reached a terminal state. */
  private liveEndCallTerminal = false;
  /** After end_call: wait for the goodbye to go quiet, then session.close. */
  private liveCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private liveCloseFallback: ReturnType<typeof setTimeout> | null = null;
  private liveClosing = false;


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
    void this.start(remote.nonce, undefined, remote.phase === "muted");
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
   * (VAD for the user, response lifecycle for Ada). Deliberately no audio
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
   * uplink is down (Ada can't hear you) until it comes back to the foreground
   * and recovers. Only meaningful for the owner; mirrors don't hold the mic.
   */
  readonly getMicSuspended = (): boolean =>
    this.micSuspended && (this.state === "live" || this.state === "muted");

  private setMicSuspended(value: boolean) {
    // The mic is healthy again: cancel the countdown that would have ended the call.
    if (!value && this.suspendDeadline) { clearTimeout(this.suspendDeadline); this.suspendDeadline = null; }
    if (this.micSuspended === value) return;
    this.micSuspended = value;
    this.input?.setAvailable(!value && this.session?.pc.connectionState === "connected");
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

  private rpc(method: string, input: unknown): Promise<unknown> {
    if (!this.bindings) return Promise.reject(new Error("No BB surface is bound"));
    return this.bindings.rpc.call(method as never, input as never);
  }

  private utterance(): ToolUtterance | null {
    const snapshot = this.input?.snapshot();
    if (!snapshot) return null;
    return { id: snapshot.id, version: snapshot.version, text: snapshot.text,
      startedAt: this.input!.item(snapshot.items[0].itemId)!.startedAt };
  }

  private report(method: string, input: unknown) {
    const rpc = this.bindings?.rpc;
    if (!rpc) return;
    const reportNonce=this.nonce;
    this.pendingReports++;
    this.reports = this.reports.then(() => rpc.call(method as never, input as never))
      .catch(error => { if(reportNonce)this.writeEvent(rpc,reportNonce,"live.reportFailed",{method,error:String(error)}); })
      .finally(() => { this.pendingReports--; });
  }

  private closeOffer(outcome: "delivered" | "not_delivered" | "deferred" | "dismissed") {
    const offer = this.openOffer;
    if (!offer) return;
    this.openOffer = null;
    this.report("closeOffer", { nonce: offer.nonce, offerId: offer.id, outcome,
      ...(offer.responseId ? { responseId: offer.responseId } : {}) });
  }

  private settleLiveOutputs() {
    const offer = this.openOffer;
    const backgroundContinuation = (this.responseActive && this.responseBinding?.origin === "background") ||
      (this.responsePending && this.pendingBinding?.origin === "background");
    if (offer?.responseId && !backgroundContinuation && this.outputSequencer.settled(offer.responseId)) {
      const state = this.outputSequencer.state(offer.responseId)!;
      this.closeOffer(state.drained ? "delivered" : "not_delivered");
    }
    for (const [id, exchange] of this.exchanges) {
      if (exchange.finished) continue;
      const responses = [...this.responseIdentity].filter(([, value]) => value.binding.origin === "user" && (value.binding.utterance?.id === id || (!value.binding.utterance && value.userTurn === exchange.version)));
      if (!responses.length || responses.some(([responseId]) => !this.outputSequencer.settled(responseId))) continue;
      if ((this.responseActive && this.responseBinding?.utterance?.id === id) ||
          (this.responsePending && this.pendingBinding?.utterance?.id === id)) continue;
      if (this.userTurn === exchange.version && (this.userSpeaking || this.input?.unresolved)) continue;
      if (this.userTurn === exchange.version && !responses.some(([, value]) => value.userTurn === exchange.version)) continue;
      exchange.finished = true;
      if (this.userTurn === exchange.version) this.input?.answered(exchange.version);
      if (this.nonce) this.report("finishUserExchange", { nonce: this.nonce, utteranceId: id });
    }
    // Live ends calls through session.close once the goodbye drains instead.
    if (this.session?.engine !== "live" && this.endCallAfterResponse && !this.responseActive && !this.pendingToolCalls && !this.outputSequencer.playbackPending) this.stop("end-call");
  }

  private quietForUpdates() {
    return this.sessionReady && this.state !== "reconnecting" && !this.userSpeaking && !this.input?.unresolved && !this.responseActive &&
      !this.responsePending && !this.pendingToolCalls && !this.outputSequencer.playbackPending &&
      !this.openOffer && Date.now() - this.conversationChangedAt >= REPLY_QUIET_MS;
  }

  private async fetchUpdates() {
    if (!this.quietForUpdates() || this.batchPending || !this.session?.dc || !this.nonce) return;
    const session = this.session, nonce = this.nonce;
    this.batchPending = true;
    try {
      const batch = await this.rpc("nextUpdateBatch", { nonce }) as { offerId: string; items: unknown[] } | null;
      if (!batch?.offerId) return;
      if (this.session !== session || !this.quietForUpdates()) {
        this.report("closeOffer", { nonce, offerId: batch.offerId, outcome: "not_delivered" });
        return;
      }
      this.openOffer = { id: batch.offerId, nonce, responseId: null };
      if (session.engine === "live") {
        // Commentary appends are spoken by the live model; the offer counts as
        // delivered once the last chunk's append is acknowledged.
        const eventId = this.liveAppend(session.dc!, "session.commentary.append", "update", JSON.stringify({ type: "background_updates", ...batch }));
        this.liveAppends.set(eventId, `offer:${batch.offerId}`);
        return;
      }
      session.dc!.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system",
        content: [{ type: "input_text", text: JSON.stringify({ type: "background_updates", ...batch }) }] } }));
      this.requestResponse(session.dc!, { origin: "background", utterance: null });
    } catch (error) { if (this.session === session) this.log("updates.failed", { error: String(error) }); }
    finally { if (this.session === session) { this.batchPending = false; this.scheduleReplyDrain(); } }
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
    // Hold a screen wake lock for the life of the call so the phone does not
    // idle-lock while Ada is live; release it the moment the call goes idle.
    if (next === "idle") this.releaseWakeLock();
    else void this.requestWakeLock();
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
   * heartbeat — the "briefly shows Talk to Ada over a live call" gap.
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
    if (phase !== "connecting" && phase !== "reconnecting" && phase !== "live" && phase !== "muted") return;
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
    if (action === "stop") this.stop("remote-stop");
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
    const event = { sessionId, kind, payload: { ...payload, clientTs: Date.now(), monotonicMs: performance.now(), _id: identityTag() } };
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
        // Backgrounded on mobile (screen lock, app switch): iOS pauses mic
        // capture. Do NOT hang up — that turned every screen lock into a dropped
        // call. Hold the session and connection, mark the mic honestly suspended,
        // and recover when the mic unmutes or the page returns to the foreground.
        // A deadline is the only thing that ends a call this way, and only if the
        // mic never comes back.
        this.logDiag("mic.suspend.hold", { cause });
        this.holdSuspended();
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
   * Hold a call whose mic the OS suspended (mobile backgrounding). Keeps the
   * session and the WebRTC connection so a return to the foreground revives the
   * uplink; arms a generous deadline that ends the call only if the mic never
   * comes back. Idempotent — a repeated mute while already held does not restart
   * the countdown.
   */
  private holdSuspended() {
    this.setMicSuspended(true);
    if (this.suspendDeadline) return; // already counting down
    this.suspendDeadline = setTimeout(() => {
      this.suspendDeadline = null;
      if (this.micSuspended && (this.state === "live" || this.state === "muted")) {
        this.logDiag("mic.suspend.deadline", {});
        this.endBecauseSuspended();
      }
    }, SUSPEND_DEADLINE_MS);
    maybeUnref(this.suspendDeadline);
  }

  /**
   * End a call whose mic stayed suspended past the deadline (mobile). Force-stops
   * server-side FIRST (so the end survives even if this realm is frozen), then
   * tears down locally. This is the honest alternative to a silent one-way
   * zombie: the call ends and every surface goes idle.
   */
  private endBecauseSuspended() {
    const nonce = this.nonce;
    toast.info("Ada: call ended — the microphone stayed off too long");
    if (nonce) this.forceStop(nonce);
    this.stop("microphone-suspended");
  }

  /**
   * Hold a screen wake lock while a call is live, so an idle phone does not lock
   * mid-call. Best-effort: unsupported browsers, denied requests, and non-secure
   * contexts are silently fine. Idempotent — a lock already held is kept.
   */
  private async requestWakeLock() {
    if (this.wakeLock) return;
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & WakeLockNavigator) : null;
    if (!nav?.wakeLock) return;
    try {
      const lock = await nav.wakeLock.request("screen");
      // A late resolve after the call ended (or was replaced) must not leave a
      // dangling lock: release it immediately.
      if (this.state === "idle") { void lock.release().catch(() => undefined); return; }
      this.wakeLock = lock;
      // The browser auto-releases on hide; drop our reference so the next
      // foreground visibility re-requests a fresh one.
      lock.addEventListener?.("release", () => { if (this.wakeLock === lock) this.wakeLock = null; });
    } catch { /* denied or unsupported — the call runs without it */ }
  }

  /** Release the held screen wake lock, if any. Safe to call when none is held. */
  private releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release().catch(() => undefined);
  }

  /** Meter state changes are logged: a suspended AudioContext reads silence and blocks every commit. */
  private meterEvents(session: SessionHandle) {
    return { state: (state: string, resumed: boolean) => { if (this.session === session) this.logDiag(resumed ? "meter.resumed" : "meter.suspended", { state }); } };
  }

  /**
   * Every 30 seconds while live, record what the input path saw: meter samples
   * and peak level, transcription deltas, unconfirmed items, and the meter and
   * connection state. A call that hears nothing then leaves a trace of which
   * half went quiet, instead of an empty log (issue #33).
   */
  private startHealthLog(session: SessionHandle) {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      if (this.session !== session || !this.input) return;
      this.logDiag("input.health", { ...this.input.healthReport(), meter: this.meterStop?.state?.() ?? "unknown",
        connection: session.pc.connectionState, micMuted: session.micTrack?.muted ?? null, micState: session.micTrack?.readyState ?? null, suspended: this.micSuspended });
    }, HEALTH_LOG_MS);
    maybeUnref(this.healthTimer);
  }

  /** On returning to the foreground, try to revive a suspended mic. */
  private attachPageLifecycle(session: SessionHandle) {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (this.session !== session) return;
      this.logDiag("page.visibility", { state: document.visibilityState });
      if (document.visibilityState === "visible") {
        // The browser dropped the wake lock when we hid; take a fresh one and
        // revive the mic the OS suspended while backgrounded.
        void this.requestWakeLock();
        void this.recoverMicIfNeeded(session);
      }
    };
    const onNetwork = () => {
      if (this.session !== session) return;
      this.logDiag("connection.network", { online: navigator.onLine ?? null,
        connection: session.pc.connectionState, ice: session.pc.iceConnectionState ?? null,
        dataChannel: session.dc?.readyState ?? null, visibility: document.visibilityState });
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (typeof window !== "undefined") {
      window.addEventListener?.("online", onNetwork);
      window.addEventListener?.("offline", onNetwork);
    }
    session.disposeLifecycle = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (typeof window !== "undefined") {
        window.removeEventListener?.("online", onNetwork);
        window.removeEventListener?.("offline", onNetwork);
      }
    };
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
      const stopMeter=await this.meterFactory(fresh,rms=>{if(this.session===session && this.sessionReady)this.input?.sample(rms);},this.meterEvents(session));
      if(this.session!==session){stopMeter();newTrack.stop();return;}
      this.meterStop?.();this.meterStop=stopMeter;
      session.stream=fresh;
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
    if (this.state === "reconnecting") {
      this.disconnectedMuted = muted;
      if (this.recovery) this.recovery.muted = muted;
      for (const track of (this.recovery?.stream ?? this.session?.stream)?.getAudioTracks() ?? []) track.enabled = false;
      return;
    }
    const session = this.session;
    if (!session || (this.state !== "live" && this.state !== "muted")) return;
    // Prefer the tracked mic track — recovery may have replaced it with one that
    // is no longer part of the original getUserMedia stream.
    if (session.micTrack) session.micTrack.enabled = !muted;
    else for (const track of session.stream.getAudioTracks()) track.enabled = !muted;
    this.log(muted ? "muted" : "unmuted");
    this.input?.sample(0);
    this.setState(muted ? "muted" : "live");
  }

  toggleMute() {
    this.setMuted(this.state !== "muted");
  }

  private scheduleReplyDrain(delayMs = REPLY_QUIET_MS) {
    if (!this.sessionReady || !this.session || this.replyTimer) return;
    const session = this.session;
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.session !== session) return;
      void this.fetchUpdates();
      this.scheduleReplyDrain();
    }, Date.now() - this.conversationChangedAt < REPLY_QUIET_MS ? REPLY_QUIET_MS - (Date.now() - this.conversationChangedAt) : delayMs);
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
    this.stop("replaced");
  }

  /**
   * Coalesce continuations until generation ends, audio drains or is cut,
   * and every held call has produced its output.
   */
  /**
   * Ask the model for a turn that no user utterance triggered: the greeting at
   * call start or a transcription repair. Bound as a user-origin response with a
   * null utterance, so the server refuses effects but allows reads.
   */
  private speakUnprompted(session: SessionHandle, instruction: string) {
    if (this.session !== session || !session.dc) return;
    // Live speaks on its own; an instructions append is how we ask for a turn.
    if (session.engine === "live") { this.liveAppend(session.dc, "session.instructions.append", "prompt", instruction); return; }
    this.responseInstruction = instruction;
    this.responsePending = true;
    this.pendingBinding = { origin: "user", utterance: null };
    this.requestResponse(session.dc);
  }

  private requestResponse(dc: RTCDataChannel, binding?: ResponseBinding) {
    // Live needs no response.create: the model answers settled input itself.
    if (this.session?.engine === "live") return;
    const requested = binding ?? this.pendingBinding ?? { origin: "user", utterance: this.utterance() };
    this.pendingBinding = requested;
    if (dc.readyState !== "open") return;
    if (!this.sessionReady) return;
    if (this.responseActive || this.pendingToolCalls > 0 || this.outputSequencer.playbackPending || this.userSpeaking || (requested.origin === "user" && !this.input?.snapshot() && !this.responseInstruction)) {
      this.responsePending = true;
      return;
    }
    this.responsePending = false;
    this.pendingBinding = null;
    this.responseBinding = requested;
    this.activeResponseId = null;
    this.responseRequestVersion = this.userTurn;
    this.setResponseActive(true);
    dc.send(JSON.stringify({
      type: "response.create",
      response: { metadata: { bb_voice_origin: requested.origin,
        ...(this.openOffer ? { bb_offer_id: this.openOffer.id } : {}) },
        ...(this.responseInstruction ? { instructions: this.responseInstruction } : {}) },
    }));
    this.responseInstruction = null;
  }

  stop(reason = "user-stop") {
    const recovery = this.recovery;
    this.recovery = null;
    this.clearRecovery(recovery);
    this.connectionAttempt++;
    this.teardown(reason);
    if (recovery) {
      for (const track of recovery.stream.getTracks()) track.stop();
      recovery.audio.srcObject = null;
      recovery.audio.remove();
      // A claim response may have been lost. Release both possible owners;
      // forceStop only changes ownership when the nonce still matches.
      this.forceStop(recovery.fromNonce);
      this.forceStop(recovery.nonce);
    }
  }

  private teardown(reason: string, recovering = false) {
    const endedNonce = this.nonce;
    if (endedNonce) {
      for (const item of this.transcriptBuffer.unfinished()) {
        if (hasSpokenWords(item.payload.text)) this.log(item.kind, { ...item.payload, partial: false, unfinished: true });
      }
      if (this.playbackResponseId) this.log("speech.lifecycle", {responseId:this.playbackResponseId,state:"interrupted",...this.responseIdentity.get(this.playbackResponseId),reason});
      this.log("session.stopped", { reason });
    }
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    this.transcriptSend = null; this.transcriptDirty = false;
    this.transcriptBuffer.reset();
    this.input?.dispose();this.input=null;
    this.meterStop?.();this.meterStop=null;
    if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = null;
    this.sessionReady=false;this.inputState="";this.responseRequestVersion=null;
    this.endCallAfterResponse = false;
    this.closeOffer("not_delivered");
    this.liveClient = null;
    this.batchPending = false;
    this.responseBinding = null; this.pendingBinding = null; this.responseInstruction = null;
    this.exchanges.clear();
    this.clearConnectWatchdog();
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    if (this.suspendDeadline) clearTimeout(this.suspendDeadline);
    this.suspendDeadline = null;
    this.releaseWakeLock();
    this.stopPresenceHeartbeat();
    if (!recovering) this.liveStartedAt = null;
    const session = this.session;
    this.session = null;
    this.nonce = null;
    this.callSequence = null;
    this.newerClaim = null;
    this.toolChain = Promise.resolve();
    this.setResponseActive(false);
    this.setAssistantSpeaking(false);
    this.responsePending = false;
    this.activeResponseId = null;
    this.toolResponseIds.clear();
    this.outputSequencer.reset();
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.replyTimer = null;
    this.setMicSuspended(false);
    this.liveInput = null; this.liveInputCounter = 0;
    if (this.liveOutputTimer) clearTimeout(this.liveOutputTimer);
    this.liveOutputTimer = null; this.liveOutput = null; this.liveOutputCounter = 0;
    this.liveResponses.clear(); this.liveDelegations.clear();
    this.liveAppends.clear();
    this.liveAwaitingGoodbye = false; this.liveEndCallTerminal = false;
    if (this.liveCloseTimer) clearTimeout(this.liveCloseTimer);
    if (this.liveCloseFallback) clearTimeout(this.liveCloseFallback);
    this.liveCloseTimer = null; this.liveCloseFallback = null; this.liveClosing = false;
    if (session) {
      // A graceful live close lets final usage arrive; teardown does not wait.
      if (session.engine === "live" && session.dc?.readyState === "open") {
        try { session.dc.send(JSON.stringify({ type: "session.close" })); } catch { /* closing anyway */ }
      }
      session.disposeLifecycle?.();
      session.dc?.close();
      session.pc.close();
      if (session.micTrack) {
        session.micTrack.onmute = null;
        session.micTrack.onunmute = null;
        session.micTrack.onended = null;
      }
      if (!recovering || session.stream !== this.recovery?.stream) {
        for (const track of session.stream.getTracks()) track.stop();
        session.micTrack?.stop();
      } else for (const track of session.stream.getTracks()) track.enabled = false;
      session.audio.srcObject = null;
      if (!recovering) session.audio.remove();
    }
    this.setState(recovering ? "reconnecting" : "idle");
    // Clear every mirror now that the call is over. Done after nulling nonce so
    // setState's own broadcast is skipped and this is the single idle announce.
    // Terminal offer reports must reach the server before presence releases the nonce.
    if (endedNonce && !recovering) {
      if (this.pendingReports) void this.reports.then(() => this.broadcastPresence("idle", endedNonce));
      else this.broadcastPresence("idle", endedNonce);
    }
  }

  private clearRecovery(recovery: Recovery | null) {
    if (!recovery) return;
    if (recovery.deadline) clearTimeout(recovery.deadline);
    if (recovery.retry) clearTimeout(recovery.retry);
    recovery.dispose?.();
  }

  private recoverConnection(reason: string) {
    if (this.recovery) { this.retryConnection(reason); return; }
    const session = this.session;
    if (!session || !this.nonce || !this.sessionReady || this.endCallAfterResponse) {
      this.stop(reason);
      return;
    }
    const recovery: Recovery = {
      fromNonce: this.nonce, nonce: crypto.randomUUID(),
      muted: this.state === "reconnecting" ? this.disconnectedMuted : this.state === "muted",
      stream: session.stream, audio: session.audio, attempt: 0,
      deadlineAt: Date.now() + RECOVERY_WINDOW_MS,
    };
    this.recovery = recovery;
    this.logDiag("connection.recovery.started", { reason, replacementNonce: recovery.nonce });
    this.teardown(reason, true);
    this.nonce = recovery.nonce;
    recovery.deadline = setTimeout(() => {
      if (this.recovery !== recovery) return;
      this.logDiag("connection.recovery.exhausted", { attempts: recovery.attempt });
      this.stop("network-timeout");
      toast.error("Ada: connection could not be restored. Resume the session to try again.");
    }, RECOVERY_WINDOW_MS);
    const wake = () => {
      if (this.recovery !== recovery) return;
      this.logDiag("connection.network", { online: navigator.onLine ?? null, visibility: typeof document === "undefined" ? null : document.visibilityState });
      if (!this.session && !this.connectTimer) this.tryConnection(recovery);
    };
    if (typeof window !== "undefined") window.addEventListener?.("online", wake);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
    recovery.dispose = () => {
      if (typeof window !== "undefined") window.removeEventListener?.("online", wake);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
    };
    this.tryConnection(recovery);
  }

  private tryConnection(recovery: Recovery) {
    if (this.recovery !== recovery) return;
    if (Date.now() >= recovery.deadlineAt) { this.stop("network-timeout"); return; }
    if (recovery.retry) clearTimeout(recovery.retry);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      recovery.retry = setTimeout(() => this.tryConnection(recovery), 1000);
      return;
    }
    recovery.attempt++;
    this.logDiag("connection.recovery.attempt", { attempt: recovery.attempt });
    this.clearConnectWatchdog();
    this.connectTimer = setTimeout(() => this.retryConnection("connect-timeout"), RECOVERY_ATTEMPT_MS);
    void this.start(recovery.fromNonce, recovery);
  }

  private retryConnection(reason: string) {
    const recovery = this.recovery;
    if (!recovery) return;
    this.logDiag("connection.recovery.failed", { reason, attempt: recovery.attempt });
    this.connectionAttempt++;
    this.teardown(reason, true);
    this.nonce = recovery.nonce;
    const delay = Math.min(8000, 1000 * 2 ** Math.min(recovery.attempt - 1, 3));
    recovery.retry = setTimeout(() => this.tryConnection(recovery), delay);
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
    this.log("tool.call", { name, args, callId, responseId:event.response_id ?? null, userTurn:this.userTurn, responseUserTurn:this.responseIdentity.get(String(event.response_id))?.userTurn ?? null, confirmedSpeech:this.userSpeaking, audioActivity:this.input?.audioActive ?? false });
    this.lastTool = { name, at: Date.now() };
    let output: string;
    let status: "success" | "error" | undefined;
    let label: string | undefined;
    let requestResponseAfter = true;
    const identity = this.responseIdentity.get(String(event.response_id));
    const binding = identity?.binding;
    let result: unknown;
    try {
      if (!this.liveClient || !binding) throw new Error("The live conversation is unavailable");
      await this.reports;
      if (this.nonce !== toolSessionId) return;
      result = await this.liveClient.execute(callId, name, args, binding, String(event.response_id));
      if (result === continuedSpeaking) requestResponseAfter = false;
      const directive = result as { action?: string; updates?: string } | null;
      if (directive?.action === "remain_silent") {
        requestResponseAfter = false; this.responsePending = false; this.pendingBinding = null;
        this.closeOffer(directive.updates === "dismiss" ? "dismissed" : "deferred");
      } else if (directive?.action === "end_call") {
        this.endCallAfterResponse = true; requestResponseAfter = false;
      }
      output = typeof result === "string" ? result : JSON.stringify(result);
      const receipt = result as { status?: string } | null;
      status = receipt && ["failed", "unknown", "cancelled"].includes(receipt.status ?? "") ? "error" : "success";
    } catch (error) {
      status = "error";
      output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
    }
    const failed = status === "error";
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
    const origin = this.responseIdentity.get(String(event.response_id));
    if (requestResponseAfter && origin?.userTurn === this.userTurn && !this.interruptedResponses.has(String(event.response_id))) this.requestResponse(dc, binding);
    else this.scheduleReplyDrain();
    return failed;
  }

  private cancelHeldCalls(dc: RTCDataChannel, calls: HeldCall[], output: string) {
    for (const call of calls) {
      const callId = String(call.event.call_id ?? "");
      this.log("tool.result", { name: call.event.name, callId, responseId: call.event.response_id, output, status: "error" });
      if (dc.readyState === "open") dc.send(JSON.stringify({
        type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output },
      }));
    }
  }

  private interruptOutput(responseId: string) {
    this.interruptedResponses.add(responseId);
    this.toolResponseIds.delete(responseId);
    if (this.responseIdentity.get(responseId)?.userTurn === this.userTurn) this.responsePending = false;
    const calls = this.outputSequencer.interrupted(responseId);
    if (this.session?.dc) this.cancelHeldCalls(this.session.dc, calls, "Not executed: interrupted.");
    if (this.openOffer?.responseId === responseId) this.closeOffer("not_delivered");
  }

  private releaseOutput(dc: RTCDataChannel, session: SessionHandle) {
    this.toolChain = this.toolChain.then(async () => {
      while (this.session === session) {
        const call = this.outputSequencer.next();
        if (!call) break;
        try {
          const failed = await this.handleToolCall(dc, call.event);
          if (this.session !== session) return;
          if (failed) this.cancelHeldCalls(dc, this.outputSequencer.failed(String(call.event.response_id)), "Not executed: an earlier action failed.");
        } finally {
          if (this.session === session) this.outputSequencer.finished(call);
        }
        if (this.responsePending) this.requestResponse(dc);
        this.settleLiveOutputs();
        this.markConversationChange();
        this.scheduleReplyDrain();
      }
    }).catch(error => this.log("tool.dispatchFailed", { error: String(error) }));
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

  private inputChanged() {
    const input=this.input;if(!input)return;
    const state=`${input.version}:${input.speaking}:${input.unresolved}:${input.pending}:${input.unavailable}`;
    if(state!==this.inputState){this.inputState=state;this.markConversationChange();this.emitChange();this.scheduleReplyDrain();}
    if(this.sessionReady && input.takeResponse() && this.session?.dc){
      // Live answers settled input itself; the settled utterance only needs to
      // exist so a later delegation can bind to it.
      if(this.session.engine!=="live")this.requestResponse(this.session.dc, { origin: "user", utterance: this.utterance() });
    }
  }

  /** One owner stops local playback and sends at most one clear per response. */
  private interruptSpeech(reason:string) {
    // The live model hears barge-in itself and owns turn-taking; there is no
    // response to cancel and no playback buffer to clear. Local state settles
    // so a new utterance supersedes pending waits via its version.
    if (this.session?.engine === "live") { this.setAssistantSpeaking(false); this.settleLiveOutputs(); return; }
    const generation=this.activeResponseId,playback=this.playbackResponseId;
    for (const id of new Set([generation, playback, ...this.outputSequencer.unsettledResponseIds()])) {
      if (id) this.interruptOutput(id);
    }
    if(this.session)this.session.audio.muted=true;
    if(generation){this.interruptedResponses.add(generation);this.toolResponseIds.delete(generation);this.cancelResponse(generation,reason);}
    if(playback){
      this.interruptedResponses.add(playback);
      this.log("speech.lifecycle",{responseId:playback,state:"interrupted",...this.responseIdentity.get(playback),reason});
      this.clearPlayback(playback,reason);this.playbackResponseId=null;
    }
    this.setAssistantSpeaking(false);
  }

  private clearPlayback(responseId:string,reason:string) {
    if(this.clearedInterruptedPlayback.has(responseId))return;
    this.clearedInterruptedPlayback.add(responseId);
    const eventId=`clear_${crypto.randomUUID()}`;
    this.session?.dc?.send(JSON.stringify({type:"output_audio_buffer.clear",event_id:eventId}));
    this.log("speech.clearRequested",{responseId,eventId,reason});
  }

  private finishInput(item:InputItem,late:boolean) {
    if(item.confirmed && item.final){
      this.log("user",{text:item.final,itemId:item.id,userTurn:item.version,utteranceId:item.utteranceId,startedAt:item.startedAt,endedAt:item.endedAt,late});
    }
    this.log("transcription.result",{itemId:item.id,userTurn:item.version,utteranceId:item.utteranceId,outcome:item.confirmed && item.final ? "complete" : item.confirmed && item.state==="failed" ? "failed" : "empty",characters:item.final?.length??0,late});
    this.completeStream("user",item.id);
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

  private async start(transferFromNonce?: string, recovery?: Recovery, muted = false) {
    const bindings = this.bindings;
    if (!bindings) return;
    // Assign the nonce before entering "connecting" so that state's presence
    // broadcast already carries our identity.
    const nonce = recovery?.nonce ?? crypto.randomUUID();
    const attempt = ++this.connectionAttempt;
    const current = () => this.nonce === nonce && this.connectionAttempt === attempt;
    this.nonce = nonce;
    this.callSequence = null;
    this.newerClaim = null;
    this.setState(recovery ? "reconnecting" : "connecting");
    this.log("session.started", { ...bindings.context, device: deviceSummary() });
    let acquiredStream: MediaStream | null = null;
    try {
      this.interruptedResponses.clear();
      this.completedPlayback.clear();
      this.completedResponses.clear();
      this.cancellationEvents.clear();
      this.rejectedToolCalls.clear();
      this.clearedInterruptedPlayback.clear();
        this.responseIdentity.clear();
      this.playbackResponseId = null;
      const selectedConversationId = this.nextConversationId;
      this.nextConversationId = undefined;
      const newConversation = this.startNewConversation;
      this.startNewConversation = false;
      let conversationId: string | null = null;
      const claimOwnership = async (): Promise<boolean> => {
        const claim = recovery ? await bindings.rpc.call("reconnectCall", { nonce, previousNonce: recovery.fromNonce }) : await bindings.rpc.call("claimCall", {
          nonce,
          newConversation,
          ...(transferFromNonce ? {transferFromNonce} : {}),
          ...(selectedConversationId ? {conversationId: selectedConversationId} : {}),
          threadId: bindings.context.threadId,
          projectId: bindings.context.projectId,
        });
        if (!current()) {
          if (this.nonce !== nonce) void bindings.rpc.call("forceStop", { nonce }).catch(() => undefined);
          return false;
        }
        if (!claim) { this.stop("replaced"); return false; }
        const { sequence } = claim;
        this.callSequence = sequence;
        this.remotePresence = null;
        this.disarmRemoteExpiry();
        conversationId = claim.conversationId;
        if (!conversationId) throw new Error("The server did not provide a voice conversation.");
        this.logicalConversationId = conversationId;
        this.emitChange();
        if (conversationId) this.log("voice.conversation", { conversationId, resumed: claim.resumed, newConversation });
        const newerClaim = this.newerClaim as { nonce: string; sequence: number } | null;
        if (newerClaim) this.onCallStarted(newerClaim.nonce, newerClaim.sequence);
        if (!current()) return false;
        this.broadcastPresence(recovery ? "reconnecting" : "connecting", nonce);
        if (recovery) this.startPresenceHeartbeat();
        return true;
      };
      // Keep the other device's call alive while this device asks for microphone access.
      if ((!transferFromNonce || recovery) && !await claimOwnership()) return;
      // Deterministic acquisition: enumerate what is actually present, resolve
      // the saved ids against it (a saved id whose salt rotated across restarts
      // simply resolves to the system default), then acquire. No "try an exact
      // id, catch, retry" dance — every branch is decided up front and logged.
      const devices = await this.enumerateDevices();
      if (!current()) return;
      const support = describeAudioSupport(devices, this.audioPreferences);
      const micPermission = await queryMicPermission(navigator.permissions);
      if (!current()) return;
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
        toast.info(`Ada: ${name} isn't available — using the system default. Pick one in Voice Mode settings.`);
      }

      let stream: MediaStream;
      try {
        stream = recovery && recovery.stream.getAudioTracks().some(track => track.readyState !== "ended")
          ? recovery.stream : await this.acquireMic(inputId);
        if (recovery && current()) recovery.stream = stream;
        acquiredStream = stream;
        if (!current()) {
          if (this.recovery?.stream !== stream && this.session?.stream !== stream) stream.getTracks().forEach(track => track.stop());
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
      for(const track of stream.getAudioTracks())track.enabled=false;
      const micSettings = micTrack?.getSettings?.();
      this.logDiag("audio.getUserMedia.ok", { deviceId: inputId || "default",
        settings: micSettings ? {sampleRate: micSettings.sampleRate ?? null, channelCount: micSettings.channelCount ?? null,
          echoCancellation: micSettings.echoCancellation ?? null, noiseSuppression: micSettings.noiseSuppression ?? null,
          autoGainControl: micSettings.autoGainControl ?? null} : null });
      if (transferFromNonce && !recovery && !await claimOwnership()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      if (!conversationId) throw new Error("The voice conversation is unavailable.");
      const callConversationId = conversationId;


      const pc = new RTCPeerConnection();
      const audio = recovery?.audio ?? new Audio();
      audio.autoplay = true;
      // iOS plays inline (not fullscreen) and is far more reliable across
      // navigation/backgrounding when the element is actually in the DOM — a
      // detached `new Audio()` can go silent. Hidden so it never shows.
      this.prepareAudioElement(audio);
      const session: SessionHandle = { pc, stream, audio, dc: null, micTrack: null, micSender: null, engine: "realtime" };
      this.session = session;
      this.input=new InputController({
        now:()=>Date.now(),view:()=>{const native=nativeUi.snapshot();const view=native.bound ? native : this.bindings?.context ?? native;return {threadId:view.threadId,projectId:view.projectId,onNewThreadScreen:view.onNewThreadScreen ?? false};},
        send:event=>{
          if(this.session!==session || !this.sessionReady || session.dc?.readyState!=="open")return false;
          // Live has no input_audio_buffer.commit: the model owns turn-taking.
          // A commit decision means the utterance is final locally, so settle
          // the item with its accumulated transcript ourselves.
          if(session.engine==="live" && event.type==="input_audio_buffer.commit"){
            const itemId=String(event.event_id??"").slice("commit_".length);
            const item=this.input?.item(itemId);
            this.input?.committed(itemId);
            if(item)this.input?.completed(itemId,item.text);
            return true;
          }
          session.dc.send(JSON.stringify(event));return true;},
        changed:()=>this.inputChanged(),
        interrupt:item=>{this.responsePending=false;this.pendingBinding=null;
          if (item.utteranceId) this.exchanges.set(item.utteranceId, { version:item.version, finished:false });
          this.interruptSpeech("recognised-words");this.settleLiveOutputs();},
        draft:item=>{this.transcriptBuffer.update("user",item.id,item.text,item.startedAt,{userTurn:item.version,utteranceId:item.utteranceId!});this.streamChanged();},
        final:(item,late)=>this.finishInput(item,late),repair:()=>this.speakUnprompted(session,REPAIR_INSTRUCTION),
        log:(kind,data)=>this.log(kind,data),
      });
      const stopMeter=await this.meterFactory(stream,rms=>{if(this.session===session && this.sessionReady)this.input?.sample(rms);},this.meterEvents(session));
      if(this.session!==session){stopMeter();return;}this.meterStop=stopMeter;

      // Never stay "connecting" forever: if the data channel hasn't opened in
      // time, tear the attempt down and let the user retry cleanly.
      if (!recovery) {
        this.clearConnectWatchdog();
        this.connectTimer = setTimeout(() => {
          if (this.session?.pc === pc && !this.sessionReady) {
            this.logDiag("conn.timeout", { state: pc.connectionState });
            toast.error("Ada: could not connect. Please try again.");
            this.stop("connect-timeout");
          }
        }, RECOVERY_ATTEMPT_MS);
      }
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
            toast.error("Ada: can't play audio. Check your system sound settings.");
          },
        );
      };
      pc.onconnectionstatechange = () => {
        if (this.session?.pc !== pc) return;
        this.logDiag("conn.state", { state: pc.connectionState });
        this.input?.setAvailable(pc.connectionState === "connected" && !this.micSuspended);
        if (pc.connectionState === "connected") {
          if (session.dc?.readyState === "closed" || session.dc?.readyState === "closing") {
            this.recoverConnection("data-channel-closed");
            return;
          }
          if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
          if (this.state === "reconnecting" && !this.recovery) {
            for (const track of session.stream.getAudioTracks()) track.enabled = !this.disconnectedMuted;
            this.setState(this.disconnectedMuted ? "muted" : "live");
          }
        } else if (pc.connectionState === "failed") {
          this.recoverConnection("connection-failed");
        } else if (pc.connectionState === "disconnected" && !this.disconnectTimer) {
          if (!this.sessionReady) { this.recoverConnection("connect-interrupted"); return; }
          this.disconnectedMuted = this.state === "muted";
          for (const track of session.stream.getAudioTracks()) track.enabled = false;
          this.setState("reconnecting");
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (this.session?.pc === pc && pc.connectionState !== "connected") {
              this.recoverConnection("disconnect-timeout");
            }
          }, DISCONNECT_GRACE_MS);
          maybeUnref(this.disconnectTimer);
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (this.session !== session) return;
        this.logDiag("conn.ice", { state: pc.iceConnectionState });
      };

      const dc = pc.createDataChannel("oai-events");
      session.dc = dc;
      let contextPending = false;
      const acceptSession = async () => {
        if(this.session!==session || this.sessionReady || contextPending)return;
        contextPending=true;
        try {
          const view = nativeUi.snapshot();
          const context = await this.rpc("callStartContext", { nonce, conversationId: callConversationId,
            device: { platform: clientDescriptor.platform, mobile: clientDescriptor.mobile, browser: clientDescriptor.browser, runtime: clientDescriptor.runtime },
            view: { threadId:view.threadId, projectId:view.projectId, space: currentSpaceName() } });
          if(this.session!==session || this.nonce!==nonce || dc.readyState!=="open")return;
          if(session.engine==="live"){
            // Live has no conversation items: the context lands as thinking
            // appends (<=500 tokens each, so it is chunked conservatively).
            this.liveAppend(dc,"session.thinking.append","context",JSON.stringify(context));
          } else {
            dc.send(JSON.stringify({type:"conversation.item.create",item:{type:"message",role:"system",content:[{type:"input_text",text:JSON.stringify(context)}]}}));
          }
          this.liveClient=new LiveClient((method,input)=>this.rpc(method,input),()=>this.session===session && this.nonce===nonce && this.state!=="reconnecting",this.input!,nonce,callConversationId);
          this.sessionReady=true;this.clearConnectWatchdog();
          for(const track of stream.getAudioTracks())track.enabled=!(recovery?.muted ?? muted);
          if (recovery) {
            this.logDiag("connection.recovery.succeeded", { attempts: recovery.attempt });
            this.clearRecovery(recovery); this.recovery = null;
          }
          this.setState((recovery?.muted ?? muted) ? "muted" : "live");this.startPresenceHeartbeat();this.startHealthLog(session);
          if (session.micTrack?.muted) {
            this.holdSuspended();
            void this.recoverMicIfNeeded(session);
          }
          this.log("session.live");this.inputChanged();
          // A deliberate resume gets a status. Transfers and network recovery stay silent.
          const resumed = Array.isArray((context as { recentTurns?: unknown[] } | null)?.recentTurns) && (context as { recentTurns: unknown[] }).recentTurns.length > 0;
          if (!transferFromNonce && session.engine==="live") this.liveAppend(dc,"session.instructions.append","greeting",resumed ? RESUME_INSTRUCTION : GREETING_INSTRUCTION);
          else if (!transferFromNonce) this.speakUnprompted(session, resumed ? RESUME_INSTRUCTION : GREETING_INSTRUCTION);
          this.scheduleReplyDrain();
        } catch(error) { if(this.session===session){this.log("session.contextFailed",{error:String(error)});if(this.recovery)this.retryConnection("context-failed");else this.stop("context-failed");} }
      };
      dc.onopen = () => {
        if(this.session!==session)return;
        this.logDiag("conn.dc.open");
        // Live sessions are fully configured by the creation POST; the client
        // waits for session.started instead of sending session.update.
        if(session.engine==="live")return;
        dc.send(JSON.stringify({type:"session.update",event_id:"configure_input",session:{type:"realtime",audio:{input:{turn_detection:null,transcription:{model:TRANSCRIPTION_MODEL,delay:"minimal"}}}}}));
      };
      dc.onclose = () => {
        if (this.session !== session) return;
        this.logDiag("conn.dc.close");
        this.recoverConnection("data-channel-closed");
      };
      dc.onmessage = (message) => {
        if (this.session !== session || !current()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const type = String(event.type ?? "");
        if (session.engine === "live") { this.handleLiveEvent(session, dc, event, acceptSession); return; }
        if(type==="session.created" || type==="session.updated") {
          const config=event.session as {audio?:{input?:{turn_detection?:unknown;transcription?:{model?:string}}}}|undefined;
          this.log("session.configuration",{eventType:type,input:config?.audio?.input??null});
          if(config?.audio?.input?.turn_detection===null && config.audio.input.transcription?.model===TRANSCRIPTION_MODEL)acceptSession();
          else if(this.sessionReady && type==="session.updated"){this.stop("configuration-changed");toast.error("Voice input settings changed. Reconnect to restore word-based interruption.");}
          return;
        }
        if(!this.sessionReady && type!=="error")return;
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
          if (this.activeResponseId) this.outputSequencer.created(this.activeResponseId);
          const binding = this.responseBinding;
          const background = binding?.origin === "background";
          if (this.activeResponseId) {
            const id = this.activeResponseId;
            const current = !!binding && (background || (this.responseRequestVersion === this.userTurn && !!this.input?.snapshot()) || !binding.utterance);
            this.responseIdentity.set(id, { userTurn: this.responseRequestVersion ?? this.userTurn, requestId:null, replyId:null,
              source:background ? "background" : "realtime", binding: binding ?? {origin:"background",utterance:null} });
            if (!current) { this.interruptOutput(id); this.cancelResponse(id,"input-not-eligible"); }
            else this.toolResponseIds.add(id);
            if (background && this.openOffer) this.openOffer.responseId=id;
          }
          this.setResponseActive(true);
          this.responseRequestVersion=null;
          this.scheduleReplyDrain();
        } else if (type === "response.output_item.added" || type === "response.output_item.done") {
          const item = event.item as Record<string, unknown> | undefined;
          if (eventResponseId && item && typeof event.output_index === "number") {
            if (this.outputSequencer.item(eventResponseId, {
              outputIndex: event.output_index, itemId: String(item.id ?? event.item_id ?? ""), type: String(item.type ?? ""),
            })) this.log("ordering.violation", { responseId: eventResponseId, outputIndex: event.output_index, itemId: item.id });
          }
        } else if (type === "output_audio_buffer.started") {
          const id = eventResponseId ?? this.activeResponseId;
          if (id) this.outputSequencer.started(id);
          if (id && this.interruptedResponses.has(id)) {
            // Ignoring the UI event does not stop the audio. Clear late playback,
            // but never clear a different response that has since taken its place.
            if ((!this.playbackResponseId || this.playbackResponseId === id) &&
                (!this.activeResponseId || this.activeResponseId === id) && !this.clearedInterruptedPlayback.has(id)) {
              this.cancelResponse(id, "interrupted-playback");
              this.clearPlayback(id,"late interrupted playback");
              this.log("speech.discarded", {responseId: id, reason: "late playback after interruption"});
            }
            return;
          }
          if (!id || !this.responseIdentity.has(id) || this.interruptedResponses.has(id) || this.completedPlayback.has(id)) return;
          this.playbackResponseId = id;
          session.audio.muted=false;
          this.setAssistantSpeaking(true);
          const identity = this.responseIdentity.get(id)!;
          this.log("speech.lifecycle", {responseId:id,state:"started",...identity,monotonicMs:performance.now()});
          this.scheduleReplyDrain();
        } else if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
          const id = eventResponseId ?? this.playbackResponseId;
          if (!id) return;
          const cleared = type.endsWith("cleared");
          const prior = this.outputSequencer.state(id);
          if (!cleared && prior?.audioStarted && !prior.drained && !prior.interrupted) this.report("reportDrain", { nonce, responseId:id, at:Date.now() });
          if (cleared) this.interruptOutput(id);
          else this.outputSequencer.stopped(id);
          if (id === this.playbackResponseId) {
            const interrupted = this.interruptedResponses.has(id);
            this.log("speech.lifecycle", {responseId:id,state:interrupted ? "interrupted" : "delivered",...this.responseIdentity.get(id),monotonicMs:performance.now()});
            if (!interrupted) this.completedPlayback.add(id);
            this.playbackResponseId = null;
            this.setAssistantSpeaking(false);
            if (this.endCallAfterResponse && !this.responseActive) { this.stop("end-call"); return; }
          }
          if (!cleared) {
            this.releaseOutput(dc, session);
            if (this.responsePending) this.requestResponse(dc);
          }
          this.settleLiveOutputs();
          this.scheduleReplyDrain();
        } else if (type === "input_audio_buffer.committed") {
          this.input?.committed(String(event.item_id??""));
        } else if(type==="conversation.item.input_audio_transcription.delta") {
          this.input?.delta(String(event.item_id??""),String(event.delta??""),typeof event.event_id==="string" ? event.event_id : undefined);
        } else if(type==="conversation.item.input_audio_transcription.failed") {
          this.input?.completed(String(event.item_id??""),"",event.error as Record<string,unknown>);
        } else if (type === "response.function_call_arguments.done") {
          if (typeof event.response_id !== "string" || !this.toolResponseIds.has(event.response_id)) {
            this.log("tool.blocked", { reason: "Response is not authorized to call tools", name: event.name, responseId: event.response_id, callId: event.call_id });
            // Close a known rejected conversational call without executing it or
            // requesting another answer. A dangling tool call poisons later turns.
            if (typeof event.response_id === "string" && this.responseIdentity.get(event.response_id)?.source === "realtime" &&
                this.interruptedResponses.has(event.response_id) && typeof event.call_id === "string" &&
                !this.outputSequencer.hasCall(event.response_id, event.call_id) && !this.rejectedToolCalls.has(event.call_id)) {
              this.rejectedToolCalls.add(event.call_id);
              if (this.rejectedToolCalls.size > 300) this.rejectedToolCalls.delete(this.rejectedToolCalls.values().next().value!);
              dc.send(JSON.stringify({type: "conversation.item.create", item: {type: "function_call_output", call_id: event.call_id,
                output: "Not executed: interrupted."}}));
            }
            return;
          }
          if (this.outputSequencer.hold(event.response_id, event)) this.markConversationChange();
        } else if (type === "conversation.item.input_audio_transcription.completed") {
          this.input?.completed(String(event.item_id ?? ""), String(event.transcript ?? "").trim());
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
            this.log("assistant", {text,responseId:eventResponseId,itemId:event.item_id ?? null,userTurn:this.userTurn,...identity});
            this.completeStream("assistant", String(event.item_id ?? ""));
          }
        } else if (type === "response.done") {
          const response = event.response as Record<string, unknown> | undefined;
          if (typeof response?.id === "string") {
            this.outputSequencer.done(response.id, response.output);
            this.releaseOutput(dc, session);
            this.toolResponseIds.delete(response.id);
            this.completedResponses.add(response.id);
            if (this.completedResponses.size > 300) this.completedResponses.delete(this.completedResponses.values().next().value!);
          }
          if (response?.id === this.activeResponseId) {
            const turnFinished = response?.status === "completed" || response?.status === "failed" || response?.status === "incomplete";
            const hasToolCalls = response?.status === "completed" && Array.isArray(response.output) && response.output.some(item => item?.type === "function_call");
            this.activeResponseId = null;
            this.setResponseActive(false);
            this.settleLiveOutputs();
            if (this.endCallAfterResponse && !hasToolCalls && !this.assistantSpeaking) { this.stop("end-call"); return; }
            if (this.responsePending) {
              this.requestResponse(dc);
            }
            this.scheduleReplyDrain();
          }
          this.settleLiveOutputs();
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
          toast.error(`Ada: ${detail ?? "realtime error"}`);
        }
      };

      const offer = await pc.createOffer();
      if (!current()) return;
      await pc.setLocalDescription(offer);
      if (!current()) return;
      await waitForIceGathering(pc);
      if (!current()) return;
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) throw new Error("No local SDP offer");

      const call = await bindings.rpc.call("createCall", {
        sdp: localSdp,
        nonce,
        mobile: clientDescriptor.mobile,
        ...bindings.context,
      }) as { sdp: string; engine?: VoiceEngine; sessionId?: string | null };
      if (this.session?.pc !== pc) return; // stopped while exchanging
      session.engine = call.engine === "live" ? "live" : "realtime";
      this.log("session.endpoint", { engine: session.engine, sessionId: call.sessionId ?? null });
      await pc.setRemoteDescription({ type: "answer", sdp: call.sdp });
    } catch (error) {
      if (acquiredStream && this.recovery?.stream !== acquiredStream && this.session?.stream !== acquiredStream) acquiredStream.getTracks().forEach(track => track.stop());
      if (!current()) return;
      if (recovery && this.recovery === recovery) { this.retryConnection(String(error)); return; }
      this.stop("connect-failed");
      toast.error(`Ada: ${error instanceof Error ? error.message : String(error)}`);
      this.requestPresence();
    }
  }

  // ---- gpt-live-1 (live engine) ----
  //
  // A live session differs from realtime in the ways this section adapts:
  // the creation POST carries the whole session config, so the data channel
  // only carries events; the model owns turn-taking (full duplex), so no
  // response.create/response.cancel/buffer control exists; transcripts arrive
  // as timestamped fragments with no item identity; and tool calls arrive as
  // nested Responses events inside `response.event` envelopes whose results go
  // back as response.item.create followed by response.create.

  /** Send a chunked session.*.append (500-token cap) and track its event ids. */
  private liveAppend(dc: RTCDataChannel, type: string, tag: string, content: string, delegationId: string | null = null): string {
    const chunks = chunkText(content, 1400);
    let lastId = "";
    chunks.forEach((chunk, index) => {
      lastId = `live_${tag}_${index}_${crypto.randomUUID()}`;
      this.liveAppends.set(lastId, tag);
      dc.send(JSON.stringify({ type, event_id: lastId, delegation_id: delegationId, content: chunk }));
    });
    if (this.liveAppends.size > 300) this.liveAppends.delete(this.liveAppends.keys().next().value!);
    return lastId;
  }

  /** Acks/errors match the outgoing event id through client_event_id. */
  private liveAppendAck(event: Record<string, unknown>, failed = false) {
    const error = event.error as { client_event_id?: unknown } | undefined;
    const clientId = typeof event.client_event_id === "string" ? event.client_event_id
      : typeof error?.client_event_id === "string" ? error.client_event_id : null;
    if (!clientId) return;
    const tag = this.liveAppends.get(clientId);
    this.liveAppends.delete(clientId);
    if (tag?.startsWith("offer:") && this.openOffer?.id === tag.slice(6)) this.closeOffer(failed ? "not_delivered" : "delivered");
  }

  /** Transcript fragments carry no item id; one open input item per speech run. */
  private liveInputId(): string {
    const current = this.liveInput;
    if (current && this.input?.item(current.id)?.state === "open") return current.id;
    const id = `live_in_${++this.liveInputCounter}`;
    this.liveInput = { id };
    return id;
  }

  /** The utterance a delegation belongs to: settled if possible, else open. */
  private liveBindingUtterance(): ToolUtterance | null {
    return this.utterance() ?? this.input?.currentUtterance() ?? null;
  }

  /** Assistant speech or a delegation covers the pending user utterances. */
  private finishLiveExchanges() {
    for (const [id, exchange] of this.exchanges) {
      if (exchange.finished) continue;
      exchange.finished = true;
      if (this.userTurn === exchange.version) this.input?.answered(exchange.version);
      if (this.nonce) this.report("finishUserExchange", { nonce: this.nonce, utteranceId: id });
    }
  }

  private handleLiveEvent(session: SessionHandle, dc: RTCDataChannel, event: Record<string, unknown>, acceptSession: () => void) {
    const type = String(event.type ?? "");
    if (type === "session.started") {
      this.log("session.configuration", { eventType: type, engine: "live", sessionId: (event.session as { id?: unknown } | undefined)?.id ?? null });
      void acceptSession();
      return;
    }
    if (!this.sessionReady && type !== "error") return;
    if (type === "session.input_transcript.delta") {
      const delta = String(event.delta ?? "");
      if (delta) this.input?.delta(this.liveInputId(), delta, typeof event.event_id === "string" ? event.event_id : undefined);
      return;
    }
    if (type === "session.output_transcript.delta") {
      this.liveAssistantDelta(String(event.delta ?? ""), typeof event.event_id === "string" ? event.event_id : undefined);
      return;
    }
    if (type === "session.delegation.created") { this.liveDelegationCreated(event); return; }
    if (type === "response.event") { this.liveResponseEvent(dc, session, event); return; }
    if (type === "session.commentary.appended" || type === "session.thinking.appended" || type === "session.instructions.appended") { this.liveAppendAck(event); return; }
    if (type === "session.usage.updated") { this.log("session.usage", { usage: event.usage ?? null, context: event.context_window ?? null }); return; }
    if (type === "session.updated") { this.log("session.configuration", { eventType: type, engine: "live" }); return; }
    if (type === "session.closed") {
      const reason = typeof event.reason === "string" ? event.reason : "unknown";
      this.log("session.closed", { reason, usage: event.usage ?? null });
      if (this.session === session) this.stop(this.liveClosing || reason === "close_requested" ? "end-call" : "session-closed");
      return;
    }
    if (type === "error") { this.liveError(event); return; }
  }

  /** Group output transcript fragments into one assistant item per speech run. */
  private liveAssistantDelta(delta: string, eventId?: string) {
    if (!delta) return;
    const now = Date.now();
    if (this.liveOutput && now - this.liveOutput.lastAt > 1400) this.finishLiveAssistant();
    if (!this.liveOutput) this.liveOutput = { id: `live_out_${++this.liveOutputCounter}`, text: "", lastAt: now };
    const item = this.liveOutput;
    item.lastAt = now;
    item.text += delta;
    if (this.liveOutputTimer) clearTimeout(this.liveOutputTimer);
    this.liveOutputTimer = setTimeout(() => {
      this.liveOutputTimer = null;
      this.setAssistantSpeaking(false);
      this.finishLiveAssistant();
      this.scheduleLiveClose();
    }, 1500);
    maybeUnref(this.liveOutputTimer);
    this.setAssistantSpeaking(true);
    this.finishLiveExchanges();
    if (this.transcriptBuffer.delta("assistant", item.id, delta, now, { userTurn: this.userTurn, responseId: null, source: "live" }, eventId)) this.streamChanged();
    this.markConversationChange();
  }

  private finishLiveAssistant() {
    const item = this.liveOutput;
    if (!item) return;
    this.liveOutput = null;
    if (this.liveOutputTimer) { clearTimeout(this.liveOutputTimer); this.liveOutputTimer = null; }
    const text = item.text.trim();
    if (text) this.log("assistant", { text, itemId: item.id, userTurn: this.userTurn, source: "live" });
    this.completeStream("assistant", item.id);
    if (this.liveEndCallTerminal) this.liveAwaitingGoodbye = false;
  }

  private liveDelegationCreated(event: Record<string, unknown>) {
    const delegation = event.delegation as { id?: unknown; target?: unknown } | undefined;
    const delegationId = typeof delegation?.id === "string" ? delegation.id : null;
    const responseId = typeof event.response_id === "string" ? event.response_id : null;
    if (delegationId && responseId) this.liveDelegations.set(delegationId, responseId);
    if (responseId) {
      this.liveResponses.set(responseId, { delegationId, pending: new Set(), terminal: false });
      this.responseIdentity.set(responseId, { userTurn: this.userTurn, requestId: null, replyId: null, source: "live",
        binding: { origin: "user", utterance: this.liveBindingUtterance() } });
    }
    this.log("delegation.created", { delegationId, responseId, target: delegation?.target ?? null, userTurn: this.userTurn });
    this.finishLiveExchanges();
    this.markConversationChange();
  }

  /** Nested Responses events inside a response.event envelope. */
  private liveResponseEvent(dc: RTCDataChannel, session: SessionHandle, event: Record<string, unknown>) {
    const inner = event.event as Record<string, unknown> | undefined;
    if (!inner) return;
    const innerType = String(inner.type ?? "");
    const innerResponse = inner.response as Record<string, unknown> | undefined;
    const delegationId = typeof event.delegation_id === "string" ? event.delegation_id : null;
    const responseId = (typeof inner.response_id === "string" ? inner.response_id : null)
      ?? (typeof innerResponse?.id === "string" ? innerResponse.id : null)
      ?? (delegationId ? this.liveDelegations.get(delegationId) ?? null : null);
    if (innerType === "response.created") {
      if (responseId) {
        if (!this.liveResponses.has(responseId)) this.liveResponses.set(responseId, { delegationId, pending: new Set(), terminal: false });
        if (delegationId) this.liveDelegations.set(delegationId, responseId);
        if (!this.responseIdentity.has(responseId)) this.responseIdentity.set(responseId, { userTurn: this.userTurn, requestId: null, replyId: null, source: "live",
          binding: { origin: "user", utterance: this.liveBindingUtterance() } });
      }
      this.markConversationChange();
      return;
    }
    if (innerType === "response.output_item.done") {
      const item = inner.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call" && responseId) this.queueLiveToolCall(dc, session, responseId, item);
      return;
    }
    if (innerType === "response.completed" || innerType === "response.failed" || innerType === "response.incomplete") {
      const record = responseId ? this.liveResponses.get(responseId) : undefined;
      if (record) record.terminal = true;
      this.log("delegation.response", { responseId, delegationId, status: innerResponse?.status ?? innerType, calls: record ? record.pending.size : null });
      const usage = innerResponse?.usage;
      if (usage && typeof usage === "object" && this.nonce) {
        void this.bindings?.rpc.call("recordUsage", { model: typeof innerResponse?.model === "string" ? innerResponse.model : null, sessionId: this.nonce, usage: usage as Record<string, unknown> }).catch(() => undefined);
      }
      if (this.endCallAfterResponse) this.liveEndCallTerminal = true;
      this.markConversationChange();
      this.settleLiveOutputs();
      this.scheduleLiveClose();
      return;
    }
  }

  /** Run one delegated function call through the same auth + RPC path as realtime. */
  private queueLiveToolCall(dc: RTCDataChannel, session: SessionHandle, responseId: string, item: Record<string, unknown>) {
    const record = this.liveResponses.get(responseId) ?? { delegationId: null, pending: new Set<string>(), terminal: false };
    this.liveResponses.set(responseId, record);
    const callId = String(item.call_id ?? "");
    if (callId) record.pending.add(callId);
    this.log("realtime.event", { eventType: "live:function_call", responseId, callId, name: item.name ?? null, monotonicMs: performance.now() });
    this.toolChain = this.toolChain.then(async () => {
      const submitted = await this.executeLiveToolCall(dc, session, responseId, item);
      if (this.session !== session) return;
      if (callId) record.pending.delete(callId);
      // Continue the backend once every collected call has its output back.
      if (submitted && record.pending.size === 0 && !record.terminal && dc.readyState === "open")
        dc.send(JSON.stringify({ type: "response.create", event_id: `continue_${crypto.randomUUID()}` }));
    }).catch(error => this.log("tool.dispatchFailed", { error: String(error) }));
  }

  private async executeLiveToolCall(dc: RTCDataChannel, session: SessionHandle, responseId: string, item: Record<string, unknown>): Promise<boolean> {
    if (dc.readyState !== "open" || !this.nonce) return false;
    const bindings = this.bindings;
    const name = String(item.name ?? "");
    const callId = String(item.call_id ?? "");
    const toolSessionId = this.nonce;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
    } catch { /* keep {} */ }
    const binding = this.responseIdentity.get(responseId)?.binding ?? { origin: "user" as const, utterance: this.liveBindingUtterance() };
    this.log("tool.call", { name, args, callId, responseId, engine: "live", userTurn: this.userTurn, confirmedSpeech: this.userSpeaking, audioActivity: this.input?.audioActive ?? false });
    this.lastTool = { name, at: Date.now() };
    let output: string;
    let status: "success" | "error" | undefined;
    if (binding.origin !== "user" || !binding.utterance) {
      // Same rule as realtime: an action needs a bound user utterance.
      output = "Not executed: the request is not authorized.";
      status = "error";
      this.log("tool.blocked", { reason: "no bound user utterance", name, responseId, callId, engine: "live" });
      if (toolSessionId && bindings) this.writeEvent(bindings.rpc, toolSessionId, "tool.result", { name, callId, output, status: "error" });
      if (callId && dc.readyState === "open" && this.nonce === toolSessionId && this.session === session)
        dc.send(JSON.stringify({ type: "response.item.create", item: { type: "function_call_output", call_id: callId, output } }));
      return true;
    }
    try {
      if (!this.liveClient) throw new Error("The live conversation is unavailable");
      await this.reports;
      if (this.nonce !== toolSessionId || this.session !== session) return false;
      const result = await this.liveClient.execute(callId, name, args, binding, responseId);
      const directive = result as { action?: string; updates?: string } | null;
      if (directive?.action === "end_call") { this.endCallAfterResponse = true; this.liveAwaitingGoodbye = true; this.armLiveCloseFallback(); }
      else if (directive?.action === "remain_silent") this.closeOffer(directive.updates === "dismiss" ? "dismissed" : "deferred");
      output = typeof result === "string" ? result : JSON.stringify(result);
      const receipt = result as { status?: string } | null;
      status = receipt && ["failed", "unknown", "cancelled"].includes(receipt.status ?? "") ? "error" : "success";
    } catch (error) {
      status = "error";
      output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Use the captured session: a stopped call's late result must not land in a new one.
    if (toolSessionId && bindings) this.writeEvent(bindings.rpc, toolSessionId, "tool.result", {
      name, callId, output: output.slice(0, 4000), status: status ?? actionStatus({ output }) });
    if (!callId || dc.readyState !== "open" || this.nonce !== toolSessionId || this.session !== session) return false;
    dc.send(JSON.stringify({ type: "response.item.create", item: { type: "function_call_output", call_id: callId, output } }));
    this.markConversationChange();
    this.settleLiveOutputs();
    this.scheduleLiveClose();
    return true;
  }

  /** end_call under live: close once the spoken result has played and gone quiet. */
  private scheduleLiveClose() {
    const session = this.session;
    if (!session || session.engine !== "live" || !this.endCallAfterResponse || this.liveClosing) return;
    if (this.liveAwaitingGoodbye || !this.liveEndCallTerminal) return;
    if (this.assistantSpeaking || this.liveOutput) return;
    if ([...this.liveResponses.values()].some(record => !record.terminal)) return;
    this.forceLiveClose();
  }

  private forceLiveClose() {
    const session = this.session;
    if (!session || this.liveClosing) return;
    this.liveClosing = true;
    if (session.dc?.readyState === "open") session.dc.send(JSON.stringify({ type: "session.close" }));
    this.log("session.closeRequested", { engine: "live" });
    this.liveCloseTimer = setTimeout(() => { if (this.session === session) this.stop("end-call"); }, 8000);
    maybeUnref(this.liveCloseTimer);
  }

  /** Never leave a live call hanging if the goodbye or the backend stalls. */
  private armLiveCloseFallback() {
    if (this.liveCloseFallback) return;
    this.liveCloseFallback = setTimeout(() => {
      this.liveAwaitingGoodbye = false;
      this.liveEndCallTerminal = true;
      this.forceLiveClose();
    }, 15000);
    maybeUnref(this.liveCloseFallback);
  }

  private liveError(event: Record<string, unknown>) {
    const error = event.error as { message?: string; code?: string; type?: string; client_event_id?: string } | undefined;
    this.liveAppendAck(event, true);
    this.log("error", { message: error?.message ?? "live error", code: error?.code ?? null, type: error?.type ?? null,
      clientEventId: error?.client_event_id ?? event.client_event_id ?? null, engine: "live" });
    toast.error(`Ada: ${error?.message ?? "voice error"}`);
  }
}

export const voiceAgent = new VoiceAgent();
