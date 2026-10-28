// One bb thread on Muse: a `muse serve` child hosting exactly one Muse
// session, translated into bb's delta grammar.
//
// Why one child per thread: Muse fixes the sandbox posture and settings
// (bb's instructions ride `-c run.developer_prompt`) per process, and both
// differ per thread.
//
// State has one writer: a queue of jobs that run one at a time, in order.
// bb's commands (open, turn start, steer, stop), every frame Muse writes (in
// wire order), Muse exiting, and bb's answers to approvals and questions are
// all jobs. A job may await Muse's answer to a command it sent; frames that
// arrive meanwhile wait behind it, so nothing changes under a job while it
// waits. Nothing outside a job writes state: no timer, no promise callback.
//
// Every input bb hands over ends exactly one way: its request fails, or it is
// accepted inside a bb turn that later closes. A host's work ends with the
// host: whatever is open closes when Muse exits, is replaced, is stopped, or
// drops events from its live stream (then the next turn resumes the session
// from Muse's own record; nothing is read back).
//
// Turns are unkeyed on the bb side (the assembler mints the ids). One bb turn
// stands for one or more Muse turns (Muse can launch a queued report inside
// it) and closes when the last of them completes. A turn Muse starts on its
// own opens a bb turn too.

import { realpathSync } from "node:fs";
import {
  type BridgeExecutionOptions,
  type DeltaItemKey,
  type DeltaPresentation,
  type DeltaTextChannel,
  type DynamicTool,
  type PromptInput,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  buildShellEnvOverrides,
  decodeToolCallResponsePayload,
  experimental_BridgeRecoveryError as BridgeRecoveryError,
  experimental_buildBridgeToolCallContent as buildBridgeToolCallContent,
  experimental_planStepsPresentation as planStepsPresentation,
  isStandaloneBuiltinCompactCommand,
} from "@get-bb/plugin-sdk/provider-bridge";
import { developerPrompt, museTurnInput, type SkillRoot } from "./input.js";
import type { BbToolServer, RegisteredRoute, ToolCallOutcome } from "./mcp-http.js";
import {
  abortable,
  connectMsp,
  describeExit,
  MspError,
  type MspConnection,
  type MspExit,
  uuidv7,
} from "./msp.js";
import {
  type MspAccountUsage,
  type MspApproval,
  type MspApprovalChoice,
  type MspItem,
  type MspTurnError,
  type MspUserInput,
  accountUsageSchema,
  approvalRequestedSchema,
  approvalResolvedSchema,
  approvalUpdatedSchema,
  contextUsageSchema,
  initializeResultSchema,
  itemDeltaSchema,
  itemEventSchema,
  parseFrame,
  sessionClosedSchema,
  sessionResultSchema,
  todoListSchema,
  tokenUsageSchema,
  turnCompletedSchema,
  turnRetrySchema,
  turnStartAckSchema,
  turnStartedSchema,
  turnUnqueuedSchema,
  userInputRequestedSchema,
  userInputSettledSchema,
} from "./protocol.js";
import {
  approvalPayload,
  callUsage,
  choiceFor,
  describeItem,
  describeTurnFailure,
  errorInfo,
  isSkippedItemKind,
  itemStatus,
  museAnswers,
  museReasoningEffort,
  questionPayload,
  rateLimitState,
  withSettledStatus,
} from "./translate.js";
import { MSP_CLIENT_NAME } from "./vocabulary.js";

const INTERRUPT_SETTLE_MS = 10_000;
const INTERRUPT_ACK_MS = 5_000;
const START_ACK_MS = 60_000;
const HOST_CLOSE_GRACE_MS = 3_000;

type PermissionMode = BridgeExecutionOptions["permissionMode"];

/** bb's permission modes as Muse's approval mode and permission profile. */
export const PERMISSION_PROFILES: Record<
  PermissionMode,
  { approvalMode: string; permissionProfile: string; disableSandbox: boolean }
> = {
  full: { approvalMode: "allowAll", permissionProfile: ":unrestricted", disableSandbox: true },
  // Muse's AI reviewer decides what it can; the rest reaches the user.
  auto: { approvalMode: "promptUnmatched", permissionProfile: ":auto-review", disableSandbox: false },
  // Workspace edits run; protected writes, network and the like ask.
  "accept-edits": { approvalMode: "promptUnmatched", permissionProfile: ":ask-me", disableSandbox: false },
};

/** What the bridge process offers every session. */
export interface BridgeServices {
  /** Write a JSON-RPC message to the runtime. */
  send(message: Record<string, unknown>): void;
  /** A request to the runtime (`item/tool/call`, `interaction/request`) on behalf of `owner`. */
  request(owner: object, method: string, params: Record<string, unknown>): Promise<unknown>;
  toolServer: BbToolServer;
  executable(): Promise<string>;
  childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv;
  skills(): readonly SkillRoot[];
  spillDir(): string;
  /** Host-wide subscription usage Muse reported. */
  noteAccountUsage(usage: MspAccountUsage): void;
  /** Fail the unanswered runtime requests `owner` sent (it stopped). */
  cancelRequests(owner: object, reason: string): void;
}

export interface SessionSpec {
  threadId: string;
  sessionId: string;
  cwd: string;
  dynamicTools: readonly DynamicTool[];
  options: BridgeExecutionOptions;
}

interface TurnEnding {
  status: "completed" | "failed" | "interrupted";
  error?: string;
}

/** How the work of a host that goes away ends. */
type HostEnding = TurnEnding & { status: "failed" | "interrupted" };

const SEVERITY = { completed: 0, interrupted: 1, failed: 2 } as const;

/** The worse of two endings; on a tie the earlier one keeps its message. */
function worse(a: TurnEnding, b: TurnEnding): TurnEnding {
  return SEVERITY[b.status] > SEVERITY[a.status] ? b : a;
}

/** The bb turn on screen. */
interface OpenTurn {
  /** The Muse turns it stands for. */
  museTurns: Set<string>;
  /** Those still running; the bb turn closes when the last one completes. */
  running: Set<string>;
  /** A `/compact`: it closes when Muse's compaction item settles. */
  compaction: boolean;
  usage: ThreadEventTokenUsageBreakdown | null;
  /** The worst ending among its Muse turns so far. */
  ending: TurnEnding;
  /** Todo snapshots in this turn share one plan row. */
  planKey: string | null;
}

interface ItemState {
  kind: string;
  revision: number;
  opened: boolean;
  settled: boolean;
  /** Delegations and backgrounded tool calls outlive turns; everything else settles with its turn. */
  threadAttached: boolean;
  channel: DeltaTextChannel | null;
  summaryIndex: number;
  latest: MspItem;
  /** The user declined the approval this item waited on. */
  denied: boolean;
}

interface PendingApproval {
  approval: MspApproval;
  requirementId: unknown;
  choices: MspApprovalChoice[];
  /**
   * The user's answer, once given. Muse asks once per stage of a compound
   * command (`curl … | head`); bb showed the whole command, so the same
   * answer settles every later stage.
   */
  decision: "allow_once" | "allow_for_session" | "deny" | null;
  /** Requirements already answered (Muse repeats `approval/updated`). */
  answered: Set<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalPath(path: string): string {
  try {
    // Muse rejects non-canonical roots (macOS /tmp → /private/tmp).
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Drop the oldest entries of a set or map beyond `limit`. */
function trimOldest(collection: Set<string> | Map<string, unknown>, limit: number): void {
  for (const oldest of collection.keys()) {
    if (collection.size <= limit) break;
    collection.delete(oldest);
  }
}

function isThreadAttached(item: MspItem): boolean {
  return item.kind === "subagent" || item.kind === "workflow" || item.background === true;
}

export class MuseSession {
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  private options: BridgeExecutionOptions;
  private readonly bbTools: Map<string, DynamicTool>;

  // ---- the queue
  private readonly jobs: Array<() => Promise<void>> = [];
  private draining = false;
  /** Woken after the job that leaves no turn open and no input waiting. */
  private readonly idleWaiters: Array<() => void> = [];
  /** Aborted when stop begins: no new work starts, and a running job's Muse requests fail at once. */
  private readonly stopping = new AbortController();
  private stopped: Promise<void> | null = null;
  /** Set by the last job: nothing more reaches the runtime. */
  private released = false;

  // ---- the Muse host
  private host: MspConnection | null = null;
  /** Hosts launched and not yet closed, crashed ones included: stop waits until each process group is gone. */
  private readonly launched = new Set<MspConnection>();
  private hostKey = "";
  private loaded = false;
  private modelId: string | null = null;
  private route: RegisteredRoute | null = null;

  // ---- turns and items
  private turn: OpenTurn | null = null;
  /** Inputs Muse acknowledged, by the Muse turn that carries them, until that turn starts. */
  private readonly awaitingStart = new Map<string, string[]>();
  /** Muse turns already over: a late event must not reopen one. */
  private readonly finishedTurns = new Set<string>();
  private readonly items = new Map<string, ItemState>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** Muse can repeat an approval request after it resolved; never ask twice. */
  private readonly resolvedApprovals = new Set<string>();
  private readonly questions = new Map<string, MspUserInput>();
  private usageTotal: ThreadEventTokenUsageBreakdown = ZERO_TOKEN_USAGE;
  private contextWindow: number | null = null;
  private rateLimitStatus: string | null = null;
  private turnOrdinal = 0;

  constructor(
    spec: SessionSpec,
    private readonly services: BridgeServices,
  ) {
    this.threadId = spec.threadId;
    this.sessionId = spec.sessionId;
    this.cwd = canonicalPath(spec.cwd);
    this.options = spec.options;
    this.bbTools = new Map(spec.dynamicTools.map((tool) => [tool.name, tool]));
  }

  // ------------------------------------------------------------ the queue

  /** Run `work` once every earlier job is done; settles with its result. */
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.released) return Promise.reject(new Error("The Muse thread was stopped"));
    return new Promise<T>((resolve, reject) => {
      this.jobs.push(async () => {
        try {
          resolve(await work());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      void this.drain();
    });
  }

  /** A job nobody awaits (a frame, an answer); a failure is logged. */
  private post(work: () => void | Promise<void>): void {
    this.enqueue(work).catch((error: unknown) => {
      if (!this.released) process.stderr.write(`muse bridge: ${errorMessage(error)}\n`);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    for (let job = this.jobs.shift(); job !== undefined; job = this.jobs.shift()) {
      await job();
      if (this.turn === null && this.awaitingStart.size === 0) {
        for (const wake of this.idleWaiters.splice(0)) wake();
      }
    }
    this.draining = false;
  }

  private throwIfStopping(): void {
    if (this.stopping.signal.aborted) throw new Error("The Muse thread was stopped");
  }

  // ------------------------------------------------------------ commands

  /** Construct the session (`start`) or reattach a stored one (`resume`). */
  open(kind: "start" | "resume"): Promise<void> {
    return this.enqueue(() => this.construct(kind));
  }

  startTurn(params: {
    input: readonly PromptInput[];
    clientRequestId?: string;
    options: BridgeExecutionOptions;
  }): Promise<void> {
    return this.enqueue(() => this.submitTurn(params));
  }

  /** `thread/start`'s own input: nobody awaits it, so a failure shows in the thread. */
  startFirstTurn(input: readonly PromptInput[], options: BridgeExecutionOptions): void {
    this.post(async () => {
      try {
        await this.submitTurn({ input, options });
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        this.emit([
          {
            kind: "provider.error",
            message: `Muse did not start the first turn: ${errorMessage(error)}`,
            threadScoped: true,
          },
        ]);
      }
    });
  }

  steer(params: { input: readonly PromptInput[]; clientRequestId: string }): Promise<void> {
    return this.enqueue(() => this.submitSteer(params));
  }

  /**
   * Release everything this thread holds; `interrupt` lets a live turn settle
   * first. Answers once Muse and every process it left are gone.
   */
  stop(intent: "interrupt" | "release"): Promise<void> {
    this.stopped ??= this.shutDown(intent);
    return this.stopped;
  }

  private async shutDown(intent: "interrupt" | "release"): Promise<void> {
    this.stopping.abort(new Error("The Muse thread was stopped"));
    try {
      if (intent === "interrupt") {
        const settling = await this.enqueue(() => this.interrupt());
        if (settling !== null) await within(settling.idle, INTERRUPT_SETTLE_MS);
      }
    } finally {
      await this.enqueue(() => this.release());
    }
  }

  // ------------------------------------------------------------ lifecycle

  private async construct(kind: "start" | "resume"): Promise<void> {
    this.throwIfStopping();
    await this.launchHost();
    if (kind === "start") {
      const profile = PERMISSION_PROFILES[this.options.permissionMode];
      const result = await this.command("session/start", {
        sessionId: this.sessionId,
        workspaceRoot: this.cwd,
        providerId: "meta",
        ...(this.options.model ? { modelId: this.options.model } : {}),
        approvalMode: profile.approvalMode,
        permissionProfile: profile.permissionProfile,
        ...(await this.sessionConfig()),
      });
      this.modelId = parseFrame(sessionResultSchema, "session/start", result)?.session.modelId ?? null;
      this.loaded = true;
    } else {
      await this.resumeOnHost();
    }
    await this.applyModel();
  }

  /** Ask Muse to stop its running turns; resolves to a wait for them to settle. */
  private async interrupt(): Promise<{ idle: Promise<void> } | null> {
    const host = this.host;
    const turnIds = [...(this.turn?.running ?? []), ...this.awaitingStart.keys()];
    // A compaction has no Muse turn to interrupt; closing the host ends it.
    if (host === null || !host.alive || turnIds.length === 0) return null;
    // Straight to the host: stopping already fails this.command.
    await Promise.all(
      turnIds.map((turnId) =>
        host
          .command("turn/interrupt", { sessionId: this.sessionId, turnId }, INTERRUPT_ACK_MS)
          .catch(() => undefined),
      ),
    );
    return { idle: new Promise((resolve) => this.idleWaiters.push(resolve)) };
  }

  /** The last job: end whatever is open, stop Muse and its shells, send nothing more. */
  private async release(): Promise<void> {
    this.route?.dispose();
    this.route = null;
    await this.closeHost({ status: "interrupted" });
    this.released = true;
    this.services.cancelRequests(this, "The Muse thread stopped");
  }

  /**
   * The host can no longer finish anything: acknowledged inputs are accepted
   * into the open turn, which then closes, and delegations and background
   * tasks settle.
   */
  private endAll(ending: HostEnding): void {
    for (const turnId of [...this.awaitingStart.keys()]) this.joinTurn(turnId);
    if (this.turn !== null) {
      if (ending.status === "failed" && ending.error !== undefined) {
        this.emit([{ kind: "provider.error", message: ending.error, errorInfo: errorInfo("internal") }]);
      }
      this.closeTurn(ending);
    }
    this.settleThreadAttachedItems(ending.status);
  }

  // ---------------------------------------------------------------- turns

  private async submitTurn(params: {
    input: readonly PromptInput[];
    clientRequestId?: string;
    options: BridgeExecutionOptions;
  }): Promise<void> {
    this.throwIfStopping();
    await this.reconcile(params.options);
    if (isStandaloneBuiltinCompactCommand(params.input)) {
      await this.compact(params.clientRequestId);
      return;
    }
    const { input, displayText } = museTurnInput(params.input);
    if (input.length === 0) {
      throw new BridgeRecoveryError({
        code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        message: "The prompt is empty",
        recovery: { kind: "staleTurn", message: "Nothing to send to Muse", retryable: false },
      });
    }
    const reasoningEffort = museReasoningEffort(params.options.reasoningLevel);
    const turnParams = {
      // A fresh turn's id is its command id.
      commandId: uuidv7(),
      sessionId: this.sessionId,
      input,
      ...(displayText.length > 0 ? { displayText } : {}),
      // Pins a resumed session to the current checkout.
      workspaceRoots: [this.cwd],
      ifBusy: "queue",
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
    let ack: unknown;
    try {
      ack = await this.command("turn/start", turnParams, START_ACK_MS);
    } catch (error) {
      // Muse unloaded the idle session and we missed its session/closed.
      if (!(error instanceof MspError) || error.kind !== "sessionNotLoaded") throw error;
      await this.resumeOnHost();
      ack = await this.command("turn/start", turnParams, START_ACK_MS);
    }
    // The frames of that turn wait behind this job, so it has not started in bb yet,
    // unless Muse folded the input into the turn already running.
    const turnId = parseFrame(turnStartAckSchema, "turn/start", ack)?.turnId ?? turnParams.commandId;
    const accepted = params.clientRequestId === undefined ? [] : [params.clientRequestId];
    if (this.turn?.running.has(turnId)) {
      this.emit(accepted.map((clientRequestId) => ({ kind: "input.accepted" as const, clientRequestId })));
      return;
    }
    this.awaitingStart.set(turnId, [...(this.awaitingStart.get(turnId) ?? []), ...accepted]);
  }

  private async submitSteer(params: { input: readonly PromptInput[]; clientRequestId: string }): Promise<void> {
    this.throwIfStopping();
    const target = [...(this.turn?.running ?? [])].at(-1);
    if (target === undefined || !this.host?.alive) throw staleTurn("No Muse turn is running to steer");
    const { input } = museTurnInput(params.input);
    try {
      await this.command("turn/steer", { sessionId: this.sessionId, expectedTurnId: target, input });
    } catch (error) {
      if (error instanceof MspError) throw staleTurn(`Muse refused the steer: ${error.message}`);
      throw error;
    }
    // Muse put the input into the running turn, and this job has held the
    // queue since the check, so that turn is still open in bb.
    this.emit([{ kind: "input.accepted", clientRequestId: params.clientRequestId }]);
  }

  private async compact(clientRequestId: string | undefined): Promise<void> {
    if (this.turn !== null) throw staleTurn("Muse is still working; compact once it is done");
    const turn = this.openTurn();
    turn.compaction = true;
    if (clientRequestId !== undefined) {
      this.emit([{ kind: "input.accepted", clientRequestId }]);
    }
    let status: unknown;
    try {
      const result = await this.command("session/compact", { sessionId: this.sessionId });
      status = (result as { status?: unknown } | null)?.status;
    } catch (error) {
      // A stop closes the turn itself.
      if (!this.stopping.signal.aborted) {
        this.closeTurn({ status: "failed", error: `Muse could not compact: ${errorMessage(error)}` });
      }
      return;
    }
    if (status === "noop") {
      this.emit([{ kind: "provider.warning", summary: "Nothing to compact yet." }]);
      this.closeTurn();
    }
  }

  /**
   * Apply this turn's options: a new permission mode or shell environment
   * needs a new `muse serve` (both are fixed per process); a model change
   * applies in place. Instructions stay as the session was built with.
   */
  private async reconcile(options: BridgeExecutionOptions): Promise<void> {
    const previousKey = this.hostKey;
    this.options = options;
    if (this.host === null || !this.host.alive || this.launchKey() !== previousKey) {
      const hadHost = previousKey !== "";
      await this.closeHost({ status: "interrupted", error: "Muse was restarted to apply this thread's permission mode or environment." });
      await this.launchHost();
      await this.resumeOnHost();
      if (hadHost) {
        this.emit([{ kind: "session.reset" }]);
        this.notify({
          jsonrpc: "2.0",
          method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
          params: {
            threadId: this.threadId,
            providerThreadId: this.sessionId,
            reason:
              previousKey === this.launchKey()
                ? "Muse was restarted after it stopped unexpectedly."
                : "Muse was restarted to apply this thread's permission mode or environment.",
            contextLost: false,
          },
        });
      }
    } else if (!this.loaded) {
      // Muse unloads idle sessions; reattach on the same host.
      await this.resumeOnHost();
    }
    await this.applyModel();
  }

  private async applyModel(): Promise<void> {
    const model = this.options.model;
    if (!model || model === this.modelId) return;
    await this.command("session/setModel", {
      sessionId: this.sessionId,
      model: { modelId: model, providerId: "meta" },
    });
    this.modelId = model;
  }

  // ----------------------------------------------------------------- host

  private launchKey(): string {
    return JSON.stringify([this.options.permissionMode, this.options.envVars ?? {}]);
  }

  private async launchHost(): Promise<void> {
    const profile = PERMISSION_PROFILES[this.options.permissionMode];
    const prompt = developerPrompt({
      instructions: this.options.instructions,
      skills: this.services.skills(),
      spillDir: this.services.spillDir(),
      threadId: this.threadId,
    });
    const args = [
      "serve",
      // Load the workspace's own rules (AGENTS.md) and skills.
      "--trust-workspace",
      ...(profile.disableSandbox ? ["--disable-sandbox"] : []),
      ...(prompt === null ? [] : ["-c", `run.developer_prompt=${JSON.stringify(prompt)}`]),
    ];
    const env = this.services.childEnv({
      BB_THREAD_ID: this.threadId,
      ...buildShellEnvOverrides(this.options.envVars),
    });
    const command = await this.services.executable();
    this.throwIfStopping();
    const { connection, initializeResult } = await connectMsp(
      {
        command,
        args,
        cwd: this.cwd,
        env,
        recordThreadId: this.threadId,
        onNotification: (connection, method, params) =>
          this.post(() => this.applyNotification(connection, method, params)),
        onServerRequest: (connection, id, method, params) => {
          // A presentation receipt, at once: the decision travels as its own command.
          connection.respond(id, {});
          this.post(() => this.applyServerRequest(connection, method, params));
        },
        onExit: (connection, exit) => this.post(() => this.hostExited(connection, exit)),
      },
      {
        clientInfo: { name: MSP_CLIENT_NAME, title: "bb", version: "1" },
        capabilities: {
          experimentalApi: true,
          requestedCapabilities: this.bbTools.size > 0 ? ["sessionMcp"] : [],
        },
      },
      this.stopping.signal,
    );
    this.launched.add(connection);
    this.host = connection;
    this.hostKey = this.launchKey();
    this.loaded = false;
    this.throwIfStopping();
    const granted = parseFrame(initializeResultSchema, "initialize", initializeResult)?.grantedCapabilities ?? [];
    if (this.bbTools.size > 0 && !granted.includes("sessionMcp")) {
      await this.closeHost({ status: "failed" });
      throw new Error("This Muse version cannot attach bb's tools (no sessionMcp capability); update Muse Code.");
    }
  }

  private async resumeOnHost(): Promise<void> {
    const profile = PERMISSION_PROFILES[this.options.permissionMode];
    let result: unknown;
    try {
      result = await this.command("session/resume", {
        sessionId: this.sessionId,
        excludeItems: true,
        permissionProfile: profile.permissionProfile,
        ...(await this.sessionConfig()),
      });
    } catch (error) {
      if (error instanceof MspError && (error.kind === "sessionNotFound" || error.kind === "notFound")) {
        throw new BridgeRecoveryError({
          code: BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
          message: `Muse has no session ${this.sessionId} on this machine`,
          recovery: { kind: "restartRecommended", message: error.message, retryable: false },
        });
      }
      throw error;
    }
    this.modelId = parseFrame(sessionResultSchema, "session/resume", result)?.session.modelId ?? null;
    // Resume takes no approval mode.
    await this.command("session/setApprovalMode", {
      sessionId: this.sessionId,
      mode: profile.approvalMode,
    });
    this.loaded = true;
  }

  private async sessionConfig(): Promise<{ config?: Record<string, unknown> }> {
    if (this.bbTools.size === 0) return {};
    this.route ??= await this.services.toolServer.register({
      tools: [...this.bbTools.values()],
      call: (name, args, callId) => this.callBbTool(name, args, callId),
    });
    return { config: { mcpServers: this.route.mcpServers } };
  }

  /**
   * Close every host this session launched, ending the work they hold; settles
   * once their process groups are gone.
   */
  private async closeHost(ending: HostEnding): Promise<void> {
    this.endAll(ending);
    this.host = null;
    this.hostKey = "";
    this.loaded = false;
    const hosts = [...this.launched];
    this.launched.clear();
    await Promise.all(hosts.map((host) => host.close(HOST_CLOSE_GRACE_MS)));
  }

  private hostExited(connection: MspConnection, exit: MspExit): void {
    // A host this session closed or replaced; closeHost waits for its cleanup.
    if (connection !== this.host) return;
    this.host = null;
    this.loaded = false;
    const message = `Muse exited unexpectedly (${describeExit(exit)})`;
    process.stderr.write(`muse bridge: ${message}\n`);
    this.endAll({ status: "failed", error: message });
  }

  /** A Muse command from inside a job; fails at once when the thread stops. */
  private command(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const host = this.host;
    if (host === null || !host.alive) {
      return Promise.reject(new Error("Muse is not running for this thread"));
    }
    return abortable(host.command(method, params, timeoutMs), this.stopping.signal);
  }

  // ------------------------------------------------------------- inbound

  private applyServerRequest(connection: MspConnection, method: string, params: unknown): void {
    if (connection !== this.host) return;
    if (method === "approval/request") this.onApproval(params);
    else if (method === "userInput/request") this.onQuestion(params);
  }

  private applyNotification(connection: MspConnection, method: string, params: unknown): void | Promise<void> {
    if (connection !== this.host) return;
    const view = params as { sessionId?: unknown; health?: unknown } | null;
    if (view?.sessionId === this.sessionId) {
      if (method === "view/gap") return this.lostView("Muse dropped events from this thread's live stream");
      if (method === "session/viewHealthChanged" && view.health === "unavailable") {
        return this.lostView("Muse's live stream for this thread went down");
      }
    }
    this.applyEvent(method, params);
  }

  /**
   * Muse's live stream for this session is no longer whole (`view/gap`, or
   * `session/viewHealthChanged`): what bb shows of the open turn may miss
   * events. Nothing is read back or spliced in. The host closes and its work
   * fails with a visible error; the next turn resumes the session from Muse's
   * own record.
   */
  private async lostView(what: string): Promise<void> {
    const working = this.turn !== null || this.awaitingStart.size > 0;
    const message = `${what}${working ? ", so this turn was stopped" : ""}. Send a message to continue: Muse picks the session up from its own record.`;
    process.stderr.write(`muse bridge: ${message}\n`);
    // A turn shows the error as it fails; with none open it goes on the thread.
    if (!working) this.emit([{ kind: "provider.error", message, errorInfo: errorInfo("internal"), threadScoped: true }]);
    await this.closeHost({ status: "failed", error: message });
  }

  /** One live Muse event. */
  private applyEvent(method: string, params: unknown): void {
    if (method === "usage/changed") {
      const usage = parseFrame(accountUsageSchema, method, params);
      if (usage !== null) this.onAccountUsage(usage);
      return;
    }
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
    if (sessionId !== this.sessionId) return;
    switch (method) {
      case "turn/started": {
        const frame = parseFrame(turnStartedSchema, method, params);
        if (frame !== null) this.onTurnStarted(frame.turnId);
        return;
      }
      case "turn/completed": {
        const frame = parseFrame(turnCompletedSchema, method, params);
        if (frame !== null) this.onTurnCompleted(frame.turnId, frame.terminal, frame.error ?? null, frame.reason ?? null);
        return;
      }
      case "turn/unqueued": {
        // A queued turn Muse will never run: its inputs end as interrupted.
        const frame = parseFrame(turnUnqueuedSchema, method, params);
        if (frame !== null) this.onTurnCompleted(frame.turnId, "cancelled", null, null);
        return;
      }
      case "turn/retryScheduled":
      case "turn/modelRetryScheduled": {
        const frame = parseFrame(turnRetrySchema, method, params);
        if (frame === null) return;
        const attempt = frame.nextAttempt ?? frame.attempt;
        const status = frame.httpStatus ? ` (HTTP ${frame.httpStatus})` : "";
        this.emit([
          {
            kind: "provider.error",
            message: `Muse is retrying${attempt ? ` (attempt ${attempt}${frame.maxAttempts ? ` of ${frame.maxAttempts}` : ""})` : ""}: ${frame.reason ?? frame.errorKind ?? "provider error"}${status}`,
            willRetry: true,
            errorInfo: errorInfo(frame.httpStatus === 429 ? "rate-limit" : "overloaded", frame.httpStatus ?? null),
          },
        ]);
        return;
      }
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const frame = parseFrame(itemEventSchema, method, params);
        if (frame !== null) this.onItem(frame.item);
        return;
      }
      case "item/delta": {
        const frame = parseFrame(itemDeltaSchema, method, params);
        if (frame !== null) this.onItemDelta(frame.itemId, frame.field ?? "text", frame.delta);
        return;
      }
      case "session/tokenUsage": {
        const frame = parseFrame(tokenUsageSchema, method, params);
        if (frame === null || this.turn === null) return;
        const last = callUsage(frame);
        this.turn.usage = this.turn.usage === null ? last : addTokenUsage(this.turn.usage, last);
        return;
      }
      case "session/contextUsage": {
        const frame = parseFrame(contextUsageSchema, method, params);
        if (frame === null) return;
        if (typeof frame.windowTokens === "number") this.contextWindow = frame.windowTokens;
        this.emit([
          {
            kind: "contextWindow",
            used: frame.usedTokens,
            size: this.contextWindow,
            estimated: false,
            attach: this.turn === null ? "currentOrLast" : "open",
          },
        ]);
        return;
      }
      case "session/todoListChanged": {
        const frame = parseFrame(todoListSchema, method, params);
        if (frame !== null) this.onTodos(frame.items);
        return;
      }
      case "session/closed": {
        if (parseFrame(sessionClosedSchema, method, params) !== null) this.loaded = false;
        return;
      }
      case "approval/requested":
        this.onApproval(params);
        return;
      case "approval/updated": {
        const frame = parseFrame(approvalUpdatedSchema, method, params);
        const pending = frame === null ? undefined : this.approvals.get(frame.approvalId);
        if (frame === null || pending === undefined) return;
        pending.requirementId = frame.currentRequirementId;
        if (frame.availableChoices) pending.choices = frame.availableChoices;
        if (pending.decision !== null) this.decide(frame.approvalId, pending.decision);
        return;
      }
      case "approval/resolved": {
        const frame = parseFrame(approvalResolvedSchema, method, params);
        if (frame === null) return;
        this.approvals.delete(frame.approvalId);
        this.resolvedApprovals.add(frame.approvalId);
        trimOldest(this.resolvedApprovals, 500);
        return;
      }
      case "userInput/requested":
        this.onQuestion(params);
        return;
      case "userInput/settled": {
        const frame = parseFrame(userInputSettledSchema, method, params);
        if (frame !== null) this.questions.delete(frame.userInputId);
        return;
      }
      default:
        return;
    }
  }

  private onAccountUsage(usage: MspAccountUsage): void {
    this.services.noteAccountUsage(usage);
    const state = rateLimitState(usage);
    if (state === null) return;
    const signature = JSON.stringify([state.status, state.windows.map((window) => window.status)]);
    if (signature === this.rateLimitStatus) return;
    this.rateLimitStatus = signature;
    this.emit([{ kind: "provider.rateLimits", rateLimits: state }]);
  }

  // ------------------------------------------------------------ bb turns

  private openTurn(): OpenTurn {
    this.turnOrdinal += 1;
    const turn: OpenTurn = {
      museTurns: new Set(),
      running: new Set(),
      compaction: false,
      usage: null,
      ending: { status: "completed" },
      planKey: null,
    };
    this.turn = turn;
    this.emit([{ kind: "turn.open" }]);
    return turn;
  }

  /** Muse turn `turnId` runs in the open bb turn (opening one if none is); its inputs are accepted there. */
  private joinTurn(turnId: string): OpenTurn {
    const turn = this.turn ?? this.openTurn();
    turn.museTurns.add(turnId);
    turn.running.add(turnId);
    const accepted = this.awaitingStart.get(turnId) ?? [];
    this.awaitingStart.delete(turnId);
    this.emit(accepted.map((clientRequestId) => ({ kind: "input.accepted" as const, clientRequestId })));
    return turn;
  }

  private onTurnStarted(turnId: string): void {
    if (this.finishedTurns.has(turnId) || this.turn?.museTurns.has(turnId)) return;
    this.joinTurn(turnId);
  }

  private onTurnCompleted(
    turnId: string,
    terminal: string,
    error: MspTurnError | null,
    reason: string | null,
  ): void {
    if (this.finishedTurns.has(turnId)) return;
    // A turn Muse ended without starting it (a launch failure) still carried its inputs.
    const turn = this.turn?.museTurns.has(turnId)
      ? this.turn
      : this.awaitingStart.has(turnId)
        ? this.joinTurn(turnId)
        : null;
    if (turn === null) {
      // A turn bb never saw start: nothing is open for it, but its failure still shows.
      this.museTurnEnding(terminal, error, reason);
      this.finishTurns([turnId]);
      return;
    }
    if (!turn.running.delete(turnId)) return;
    turn.ending = worse(turn.ending, this.museTurnEnding(terminal, error, reason));
    if (turn.running.size === 0) this.closeTurn();
  }

  /** How one Muse turn ended; a failure is shown at once. */
  private museTurnEnding(terminal: string, error: MspTurnError | null, reason: string | null): TurnEnding {
    if (terminal === "completed") return { status: "completed" };
    if (terminal === "cancelled") return { status: "interrupted" };
    const failure = describeTurnFailure(error, reason);
    this.emit([
      {
        kind: "provider.error",
        message: failure.message,
        ...(failure.errorInfo ? { errorInfo: failure.errorInfo } : {}),
        ...(this.turn === null ? { threadScoped: true } : {}),
      },
    ]);
    if (failure.recovery !== null) {
      this.notify({
        jsonrpc: "2.0",
        method: BRIDGE_NOTIFICATION_METHODS.providerRecovery,
        params: { threadId: this.threadId, kind: failure.recovery, message: failure.message, retryable: false },
      });
    }
    return { status: "failed", error: failure.message };
  }

  /** Close the open bb turn: its items settle, its usage lands, then the boundary. */
  private closeTurn(override?: TurnEnding): void {
    const turn = this.turn;
    if (turn === null) return;
    const ending = override === undefined ? turn.ending : worse(turn.ending, override);
    const deltas: ThreadDelta[] = [];
    for (const [itemId, state] of this.items) {
      if (state.settled || state.threadAttached) continue;
      deltas.push(...this.closeDeltas(itemId, state, ending.status));
    }
    if (turn.usage !== null) {
      this.usageTotal = addTokenUsage(this.usageTotal, turn.usage);
      deltas.push({
        kind: "usage",
        total: this.usageTotal,
        last: turn.usage,
        modelContextWindow: this.contextWindow,
      });
    }
    deltas.push({
      kind: "turn.boundary",
      status: ending.status,
      ...(ending.error === undefined ? {} : { error: { message: ending.error } }),
    });
    this.turn = null;
    this.finishTurns(turn.museTurns);
    // Turn-scoped item state is done; delegations and background tasks live on.
    for (const [itemId, state] of this.items) {
      if (!state.threadAttached || state.settled) this.items.delete(itemId);
    }
    this.emit(deltas);
  }

  private finishTurns(turnIds: Iterable<string>): void {
    for (const turnId of turnIds) this.finishedTurns.add(turnId);
    trimOldest(this.finishedTurns, 200);
  }

  private settleThreadAttachedItems(status: "failed" | "interrupted"): void {
    const deltas: ThreadDelta[] = [];
    for (const [itemId, state] of this.items) {
      if (!state.threadAttached || state.settled) continue;
      deltas.push(...this.closeDeltas(itemId, state, status));
      this.items.delete(itemId);
    }
    this.emit(deltas);
  }

  // ---------------------------------------------------------------- items

  private itemContext() {
    return { cwd: this.cwd, bbTools: this.bbTools };
  }

  private onItem(item: MspItem): void {
    if (isSkippedItemKind(item.kind)) return;
    let state = this.items.get(item.itemId);
    const revision = item.revision ?? 0;
    if (state !== undefined) {
      if (state.settled) return;
      if (revision !== 0 && revision <= state.revision) return;
    } else {
      state = {
        kind: item.kind,
        revision,
        opened: false,
        settled: false,
        threadAttached: false,
        channel: null,
        summaryIndex: 0,
        latest: item,
        denied: false,
      };
      this.items.set(item.itemId, state);
    }
    state.revision = revision;
    state.latest = item;
    // A tool call Muse sends to the background turns into a background task.
    const backgrounded = !state.threadAttached && isThreadAttached(item);
    state.threadAttached ||= backgrounded;
    const status = itemStatus(item.status);

    if (item.kind === "agentMessage" || item.kind === "reasoning") {
      if (status !== null) this.emit(this.closeDeltas(item.itemId, state, status));
      return;
    }

    const row = describeItem(item, this.itemContext(), status !== null);
    if (row === null) return;
    const key: DeltaItemKey = { providerItemId: item.itemId };
    const deltas: ThreadDelta[] = [];
    // Reopening an open key replaces its row in place.
    if (!state.opened || backgrounded) {
      const openRow = status === null ? row : (describeItem(item, this.itemContext(), false) ?? row);
      deltas.push({ kind: "item.open", key, item: openRow.shape, ...presentationField(openRow.presentation) });
      state.opened = true;
    }
    if (status !== null) {
      deltas.push(...this.closeDeltas(item.itemId, state, status));
      if (item.kind === "compaction") {
        if (item.outcome === "compacted" || (item.outcome == null && status === "completed")) {
          deltas.push({ kind: "context.compacted" });
        }
      }
    }
    this.emit(deltas);
    if (status !== null && item.kind === "compaction" && this.turn?.compaction === true) {
      this.closeTurn(
        status === "completed" && item.outcome !== "noop" && item.outcome !== "failed"
          ? { status: "completed" }
          : { status: "failed", error: item.failureReason ?? `Compaction ${item.outcome ?? item.status}` },
      );
    }
  }

  private onItemDelta(itemId: string, field: string, text: string): void {
    const state = this.items.get(itemId);
    if (state === undefined || state.settled || text.length === 0) return;
    const key: DeltaItemKey = { providerItemId: itemId };
    foldDelta(state.latest, field, text);
    if (state.kind === "agentMessage" && field === "text") {
      state.channel = "agentMessage";
      state.opened = true;
      this.emit([{ kind: "item.textDelta", key, channel: "agentMessage", text }]);
      return;
    }
    if (state.kind === "reasoning") {
      const summary = /^summary\.(\d+)$/u.exec(field);
      if (summary !== null) {
        if (state.channel === "reasoningText") return;
        const index = Number(summary[1]);
        const prefix = state.opened && index !== state.summaryIndex ? "\n\n" : "";
        state.summaryIndex = index;
        state.channel = "reasoningSummary";
        state.opened = true;
        this.emit([{ kind: "item.textDelta", key, channel: "reasoningSummary", text: prefix + text }]);
        return;
      }
      if (field === "text" && state.channel !== "reasoningSummary") {
        state.channel = "reasoningText";
        state.opened = true;
        this.emit([{ kind: "item.textDelta", key, channel: "reasoningText", text }]);
      }
      return;
    }
    if (state.opened && (field === "output" || field === "visibleOutput")) {
      const row = describeItem(state.latest, this.itemContext(), false);
      if (row?.shape.type === "command") {
        this.emit([{ kind: "item.outputDelta", key, channel: "command", text }]);
      }
    }
  }

  /** The deltas that settle one item with `status`. */
  private closeDeltas(
    itemId: string,
    state: ItemState,
    status: "completed" | "failed" | "interrupted",
  ): ThreadDelta[] {
    state.settled = true;
    const key: DeltaItemKey = { providerItemId: itemId };
    const item = state.latest;
    if (state.kind === "agentMessage" || state.kind === "reasoning") {
      const finalText =
        state.kind === "agentMessage"
          ? (item.text ?? "")
          : (item.summary?.filter((part) => part.length > 0).join("\n\n") || item.text || "");
      const channel: DeltaTextChannel =
        state.channel ?? (state.kind === "agentMessage" ? "agentMessage" : item.summary?.length ? "reasoningSummary" : "reasoningText");
      if (!state.opened) {
        // Never streamed: a whitespace-only message completes nothing.
        if (finalText.trim().length === 0) return [];
        return [
          { kind: "item.textDelta", key, channel, text: finalText },
          { kind: "item.textClose", key, channel, text: finalText },
        ];
      }
      return [{ kind: "item.textClose", key, channel, ...(finalText.length > 0 ? { text: finalText } : {}) }];
    }
    if (!state.opened) return [];
    const row = describeItem(item, this.itemContext(), true);
    if (row === null) return [];
    // A declined call that Muse never ran did not complete.
    const closeStatus = state.denied && status === "completed" ? "failed" : status;
    const shape = withSettledStatus(row.shape, closeStatus);
    return [
      {
        kind: "item.close",
        key,
        status: closeStatus,
        item: shape,
        ...presentationField(row.presentation),
        ...(shape.type === "command" && shape.exitCode !== undefined ? { exitCode: shape.exitCode } : {}),
        ...(shape.type === "command" && shape.aggregatedOutput !== undefined
          ? { aggregatedOutput: shape.aggregatedOutput }
          : {}),
        ...(item.status === "rejected" || state.denied ? { approvalStatus: "denied" as const } : {}),
      },
    ];
  }

  private onTodos(items: ReadonlyArray<{ text: string; status: string; activeForm?: string | null }>): void {
    const turn = this.turn;
    if (turn === null) return;
    turn.planKey ??= `todos-${this.turnOrdinal}`;
    const steps = items
      .filter((item) => item.status !== "cancelled")
      .map((item) => ({
        step: item.text,
        status:
          item.status === "completed" ? ("completed" as const) : item.status === "inProgress" ? ("active" as const) : ("pending" as const),
      }));
    const key: DeltaItemKey = { providerItemId: turn.planKey };
    const shape = { type: "planSteps" as const, steps };
    const presentation = planStepsPresentation(steps);
    // Reopening a settled key reuses its row, so each snapshot updates it.
    this.emit([
      { kind: "item.open", key, item: shape, presentation },
      { kind: "item.close", key, status: "completed", item: shape, presentation },
    ]);
  }

  // ------------------------------------------------------- bb tool calls

  /** Served by the MCP endpoint, outside the queue: it only reads the item a call belongs to. */
  private async callBbTool(name: string, args: Record<string, unknown>, callId: string | null): Promise<ToolCallOutcome> {
    if (this.stopping.signal.aborted) {
      return { content: [{ type: "text", text: "This bb thread stopped; the tool did not run." }], isError: true };
    }
    const itemId =
      (callId === null
        ? undefined
        : [...this.items.entries()].find(([, state]) => state.latest.callId === callId)?.[0]) ??
      callId ??
      uuidv7();
    const result = await this.services.request(this, BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
      providerThreadId: this.sessionId,
      threadId: this.threadId,
      turnId: null,
      callId: itemId,
      tool: name,
      arguments: args,
      providerNativeIds: true,
    });
    const decoded = decodeToolCallResponsePayload(result);
    return { content: buildBridgeToolCallContent(decoded), isError: decoded.isError };
  }

  // ----------------------------------------------- approvals and questions

  private onApproval(params: unknown): void {
    const approval = parseFrame(approvalRequestedSchema, "approval/requested", params);
    if (approval === null || approval.sessionId !== this.sessionId) return;
    if (this.approvals.has(approval.approvalId) || this.resolvedApprovals.has(approval.approvalId)) return;
    this.openApprovalItem(approval);
    this.approvals.set(approval.approvalId, {
      approval,
      requirementId: approval.currentRequirementId,
      choices: approval.availableChoices,
      decision: null,
      answered: new Set(),
    });
    if (this.options.permissionMode === "full") {
      // Muse does not pass a session's allowAll on to workflow children.
      this.decide(approval.approvalId, "allow_once");
      return;
    }
    const payload = approvalPayload(approval, this.cwd);
    if (payload === null) {
      this.emit([
        {
          kind: "provider.warning",
          summary: `Muse asked for an approval bb cannot show (${approval.toolName ?? "unknown tool"}); it was declined.`,
        },
      ]);
      this.decide(approval.approvalId, "deny");
      return;
    }
    this.services
      .request(this, BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
        threadId: this.threadId,
        providerThreadId: this.sessionId,
        turnId: null,
        providerNativeIds: true,
        payload,
      })
      .then(
        (resolution) => {
          const decision = (resolution as { decision?: unknown } | null)?.decision;
          this.post(() =>
            this.decide(
              approval.approvalId,
              decision === "allow_once" || decision === "allow_for_session" ? decision : "deny",
            ),
          );
        },
        (error: unknown) =>
          this.post(() => {
            this.emit([
              {
                kind: "provider.warning",
                summary: `A Muse approval could not reach you and was declined: ${errorMessage(error)}`,
              },
            ]);
            this.decide(approval.approvalId, "deny");
          }),
      );
  }

  /**
   * Muse asks before it starts the tool's item; bb shows an approval on its
   * item, so open the row from the request. Muse's own item/started for the
   * same id then updates it.
   */
  private openApprovalItem(approval: MspApproval): void {
    const itemId = approval.itemId;
    if (!itemId || this.items.has(itemId) || this.turn === null) return;
    this.onItem({
      itemId,
      kind: "toolCall",
      status: "inProgress",
      revision: 0,
      tool: approval.toolName ?? "tool",
      args: approval.rawArgs,
    } as MspItem);
  }

  private decide(approvalId: string, decision: "allow_once" | "allow_for_session" | "deny"): void {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) return;
    pending.decision = decision;
    const itemState = pending.approval.itemId ? this.items.get(pending.approval.itemId) : undefined;
    if (itemState !== undefined) itemState.denied = decision === "deny";
    const requirement = JSON.stringify(pending.requirementId);
    if (pending.answered.has(requirement)) return;
    const choice = choiceFor(pending.choices, decision) ?? choiceFor(pending.choices, "deny");
    if (choice === null) return;
    pending.answered.add(requirement);
    // Its answer changes nothing here: Muse reports the outcome as events.
    this.command("approval/decide", {
      sessionId: this.sessionId,
      approvalId,
      requirementId: pending.requirementId,
      choiceId: choice.choiceId,
    }).catch((error: unknown) => {
      // Resolved elsewhere (Muse's reviewer, a timeout) or the thread stopped.
      if (this.stopping.signal.aborted) return;
      process.stderr.write(`muse bridge: approval/decide ${approvalId} failed: ${errorMessage(error)}\n`);
    });
  }

  private onQuestion(params: unknown): void {
    const input = parseFrame(userInputRequestedSchema, "userInput/requested", params);
    if (input === null || input.sessionId !== this.sessionId) return;
    if (this.questions.has(input.userInputId)) return;
    this.questions.set(input.userInputId, input);
    const payload = questionPayload(input);
    if (payload === null) {
      this.cancelQuestion(input.userInputId, "bb could not show this question");
      return;
    }
    this.services
      .request(this, BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
        threadId: this.threadId,
        providerThreadId: this.sessionId,
        turnId: null,
        providerNativeIds: true,
        payload,
      })
      .then(
        (resolution) => this.post(() => this.answerQuestion(input, resolution)),
        (error: unknown) =>
          this.post(() =>
            this.cancelQuestion(input.userInputId, `The question could not reach the user: ${errorMessage(error)}`),
          ),
      );
  }

  private async answerQuestion(input: MspUserInput, resolution: unknown): Promise<void> {
    // Muse settled it meanwhile.
    if (!this.questions.has(input.userInputId)) return;
    const answer = resolution as { kind?: unknown; answers?: unknown } | null;
    if (answer?.kind !== "user_answer" || typeof answer.answers !== "object" || answer.answers === null) {
      this.cancelQuestion(input.userInputId, "The question was dismissed");
      return;
    }
    const answers = museAnswers(input, answer.answers as Record<string, { selected: string[]; freeText?: string }>);
    if (answers.length === 0) {
      this.cancelQuestion(input.userInputId, "No answer was given");
      return;
    }
    try {
      await this.command("userInput/answer", { sessionId: this.sessionId, userInputId: input.userInputId, answers });
      this.questions.delete(input.userInputId);
    } catch (error) {
      if (this.stopping.signal.aborted) return;
      // bb's form closed; don't leave Muse waiting on it.
      this.emit([{ kind: "provider.warning", summary: `Muse did not take the answer: ${errorMessage(error)}` }]);
      this.cancelQuestion(input.userInputId, `The answer was not accepted: ${errorMessage(error)}`);
    }
  }

  private cancelQuestion(userInputId: string, reason: string): void {
    this.questions.delete(userInputId);
    this.command("userInput/cancel", { sessionId: this.sessionId, userInputId, reason }).catch(() => undefined);
  }

  // --------------------------------------------------------------- output

  /** A notification for this thread; nothing reaches the runtime once stop answered. */
  private notify(message: Record<string, unknown>): void {
    if (!this.released) this.services.send(message);
  }

  private emit(deltas: ThreadDelta[]): void {
    if (deltas.length === 0 || this.released) return;
    this.services.send({
      jsonrpc: "2.0",
      method: THREAD_DELTA_NOTIFICATION_METHOD,
      params: { threadId: this.threadId, deltas },
    });
  }
}

/** Wait for `work`, at most `ms`. */
function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Apply one `item/delta` to the item snapshot, so a forced settle keeps what streamed. */
function foldDelta(item: MspItem, field: string, text: string): void {
  if (field === "text") {
    item.text = (item.text ?? "") + text;
    return;
  }
  if (field === "output" || field === "visibleOutput") {
    item.visibleOutput = (item.visibleOutput ?? "") + text;
    return;
  }
  const summary = /^summary\.(\d+)$/u.exec(field);
  if (summary === null) return;
  const parts = [...(item.summary ?? [])];
  const index = Number(summary[1]);
  for (let at = parts.length; at < index; at += 1) parts[at] = "";
  parts[index] = (parts[index] ?? "") + text;
  item.summary = parts;
}

function presentationField(presentation: DeltaPresentation | undefined): { presentation?: DeltaPresentation } {
  return presentation === undefined ? {} : { presentation };
}

function staleTurn(message: string): Error {
  return new BridgeRecoveryError({
    code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
    message,
    recovery: { kind: "staleTurn", message, retryable: false },
  });
}
