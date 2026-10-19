// The Muse provider bridge: bb's provider-bridge protocol on one side, one
// `muse serve` child per thread on the other (see session.ts).

import { constants as fsConstants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  type InitializeResult,
  type ProviderHealthResult,
  type ProviderUsageResult,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  createBridgeLineHandler,
  decodeBridgeJsonRpcResponse,
  experimental_BridgeRecoveryError as BridgeRecoveryError,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  sanitizeInheritedChildProcessEnv,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { z } from "zod";
import type { SkillRoot } from "./input.js";
import { BbToolServer } from "./mcp-http.js";
import { abortable, connectMsp, uuidv7 } from "./msp.js";
import {
  type MspAccountUsage,
  accountUsageSchema,
  initializeResultSchema,
  modelListSchema,
  parseFrame,
} from "./protocol.js";
import { MuseSession, type BridgeServices } from "./session.js";
import { availableModels, usageWindows } from "./translate.js";
import { MSP_CLIENT_NAME, MUSE_EXECUTABLE_ENV } from "./vocabulary.js";

const MODEL_LIST_TTL_MS = 5 * 60_000;
const USAGE_FILE = "account-usage.json";

const io = createBridgeIo<Record<string, unknown>>();

class BridgeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ process state

const sessions = new Map<string, MuseSession>();
/** Sessions out of `sessions` whose stop has not finished: a later stop and shutdown wait for them. */
const retiring = new Set<MuseSession>();
const toolServer = new BbToolServer();
let skillRoots: SkillRoot[] = [];
let dataDir: string | null = null;
let tempDir: string | null = null;
let accountUsage: MspAccountUsage | null = null;
let modelCache: { at: number; models: ReturnType<typeof availableModels> } | null = null;
/** Set once the bridge is on its way out: nothing launches Muse any more. */
let exiting = false;

/** Requests this bridge sent to the runtime, by id, with the session that sent them. */
const runtimeRequests = new Map<
  string,
  { owner: object; resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function runtimeRequest(owner: object, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `muse-${uuidv7()}`;
  return new Promise((resolve, reject) => {
    runtimeRequests.set(id, { owner, resolve, reject });
    io.send({ jsonrpc: "2.0", id, method, params });
  });
}

/** Fail the requests one session sent; a newer session of the same thread keeps its own. */
function cancelRequests(owner: object, reason: string): void {
  for (const [id, pending] of runtimeRequests) {
    if (pending.owner !== owner) continue;
    runtimeRequests.delete(id);
    pending.reject(new Error(reason));
  }
}

/** Whether `path` is an executable file (a symlink to one counts; a directory does not). */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `name` on PATH, looked up in-process: the bridge spawns nothing it does not own. */
async function onPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The `muse` to launch; every launch asks right before it spawns. Once the
 * bridge is exiting it refuses: the exit would orphan whatever started.
 */
async function museExecutable(): Promise<string> {
  const found = await findMuse();
  if (exiting) throw new BridgeError(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "The Muse bridge is shutting down");
  return found;
}

async function findMuse(): Promise<string> {
  const configured = process.env[MUSE_EXECUTABLE_ENV]?.trim();
  if (configured) return configured;
  const found = await onPath("muse");
  if (found !== null) return found;
  // The official installer's location, often missing from a daemon's PATH.
  const installed = join(homedir(), ".local", "bin", "muse");
  if (await isExecutableFile(installed)) return installed;
  throw new BridgeError(
    BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
    `Muse Code is not installed on this machine (no \`muse\` on PATH or in ~/.local/bin; set ${MUSE_EXECUTABLE_ENV} to its path).`,
  );
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...withoutBridgeRuntimeEnv(sanitizeInheritedChildProcessEnv({ env: process.env })),
    // bb owns the session; Muse's background self-update would race it.
    MUSE_NO_AUTO_UPDATE: "1",
    ...overrides,
  };
}

function spillDir(): string {
  const dir = join(tempDir ?? join(homedir(), ".cache", "bb-muse"), "muse");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function noteAccountUsage(usage: MspAccountUsage): void {
  accountUsage = usage;
  if (dataDir === null) return;
  try {
    writeFileSync(join(dataDir, USAGE_FILE), JSON.stringify(usage));
  } catch {
    // Best effort: the next report rewrites it.
  }
}

function storedAccountUsage(): MspAccountUsage | null {
  if (accountUsage !== null || dataDir === null) return accountUsage;
  try {
    const parsed = accountUsageSchema.safeParse(JSON.parse(readFileSync(join(dataDir, USAGE_FILE), "utf8")));
    accountUsage = parsed.success ? parsed.data : null;
  } catch {
    accountUsage = null;
  }
  return accountUsage;
}

const services: BridgeServices = {
  send: (message) => io.send(message),
  request: runtimeRequest,
  toolServer,
  executable: museExecutable,
  childEnv,
  skills: () => skillRoots,
  spillDir,
  noteAccountUsage,
  cancelRequests,
};

// ------------------------------------------------------- sessionless probes

/** Requests that may launch a probe host: shutdown stops them and waits until they are done. */
const probes = new Set<Promise<unknown>>();
let probesStopping = new AbortController();

/**
 * Own a probing request from the moment it arrives, so a shutdown that
 * begins before it launches anything still stops and awaits it.
 */
function probing<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const run = work(probesStopping.signal);
  probes.add(run);
  void run.catch(() => undefined).finally(() => probes.delete(run));
  return run;
}

type ProbeAsk<T> = (
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  /** The version Muse reported in the handshake. */
  version: string | null,
) => Promise<T>;

/**
 * A short-lived read-only host for questions that need no session: the model
 * catalog, the login state and the version.
 */
async function withProbeHost<T>(cwd: string, ask: ProbeAsk<T>, signal: AbortSignal): Promise<T> {
  const command = await museExecutable();
  signal.throwIfAborted();
  const { connection, initializeResult } = await connectMsp(
    {
      command,
      args: ["serve", "--no-session-log", "--disable-shell", "--disable-write"],
      cwd,
      env: childEnv({}),
      recordThreadId: null,
      onNotification: () => undefined,
      onServerRequest: (connection, id) => connection.respond(id, {}),
      onExit: () => undefined,
    },
    { clientInfo: { name: MSP_CLIENT_NAME, version: "1" }, capabilities: { experimentalApi: true } },
    signal,
  );
  const version = parseFrame(initializeResultSchema, "initialize", initializeResult)?.serverInfo?.version ?? null;
  try {
    return await ask((method, params = {}) => abortable(connection.request(method, params, 20_000), signal), version);
  } finally {
    await connection.close(2_000);
  }
}

async function listModels(cwd: string | undefined, signal: AbortSignal) {
  if (modelCache !== null && Date.now() - modelCache.at < MODEL_LIST_TTL_MS) return modelCache.models;
  const list = await withProbeHost(cwd ?? homedir(), (request) => request("model/list"), signal);
  const parsed = parseFrame(modelListSchema, "model/list", list);
  const models = parsed === null ? [] : availableModels(parsed);
  if (models.length === 0) {
    throw new BridgeRecoveryError({
      code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      message:
        "Muse's model catalog is empty. Run `muse login` on this machine; if you are signed in, Meta may be refusing this network (check that api.meta.ai is reachable over IPv4).",
      recovery: {
        kind: "authRequired",
        message: "Muse returned no models; sign in with `muse login`.",
        retryable: false,
      },
    });
  }
  modelCache = { at: Date.now(), models };
  return models;
}

const NOT_READY = {
  accountEmail: null,
  planLabel: null,
  minimumSupportedVersion: null,
  canInstall: false,
  canUpdate: false,
};

const HEALTH_TTL_MS = 60_000;
let healthCache: { at: number; result: ProviderHealthResult } | null = null;

/** Health spawns a probe host, so one answer serves a minute of polling. */
async function health(signal: AbortSignal): Promise<ProviderHealthResult> {
  if (healthCache !== null && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.result;
  const result = await probeHealth(signal);
  // Only a healthy answer is reused; a problem is probed again next time.
  healthCache = result.supported && result.health.status === "ready" ? { at: Date.now(), result } : null;
  return result;
}

async function probeHealth(signal: AbortSignal): Promise<ProviderHealthResult> {
  let executable: string;
  try {
    executable = await museExecutable();
  } catch (error) {
    return {
      supported: true,
      health: {
        status: "not_installed",
        statusMessage: error instanceof Error ? error.message : String(error),
        installedVersion: null,
        loginCommand: null,
        ...NOT_READY,
      },
    };
  }
  let version: string | null = null;
  let account: unknown = null;
  let probeError: string | null = null;
  try {
    ({ version, account } = await withProbeHost(
      homedir(),
      async (request, reported) => ({ version: reported, account: await request("account/read") }),
      signal,
    ));
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }
  const state = (account as { state?: unknown } | null)?.state;
  const label = (account as { label?: unknown } | null)?.label;
  const base = { installedVersion: version, loginCommand: "muse login", ...NOT_READY };
  if (state === "loggedOut") {
    return {
      supported: true,
      health: { ...base, status: "unauthenticated", statusMessage: "Muse is not signed in. Run `muse login` on this machine." },
    };
  }
  if (state === "accountLogin" || state === "apiKey" || state === "envKey") {
    return {
      supported: true,
      health: {
        ...base,
        status: "ready",
        statusMessage: null,
        accountEmail: typeof label === "string" && label.includes("@") ? label : null,
      },
    };
  }
  return {
    supported: true,
    health: {
      ...base,
      status: "unknown",
      statusMessage:
        probeError === null
          ? `Muse reported an unknown sign-in state (${JSON.stringify(state ?? null)}).`
          : `Could not read Muse's sign-in state: ${probeError}`,
    },
  };
}

function usage(): ProviderUsageResult {
  const usage = storedAccountUsage();
  return {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: usage === null ? [] : usageWindows(usage),
    },
  };
}

// ----------------------------------------------------------------- threads

/** Stop a session; it stays owned until Muse and its shells are gone. */
function retire(session: MuseSession, intent: "interrupt" | "release"): Promise<void> {
  if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
  retiring.add(session);
  return session.stop(intent).finally(() => retiring.delete(session));
}

/** Stop a thread's session and wait for any earlier stop of that thread still under way. */
async function stopThread(threadId: string, intent: "interrupt" | "release"): Promise<void> {
  const current = sessions.get(threadId);
  const all = [...retiring, ...(current === undefined ? [] : [current])];
  await Promise.all(all.filter((session) => session.threadId === threadId).map((session) => retire(session, intent)));
}

function sendIdentity(threadId: string, providerThreadId: string): void {
  io.send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId, sessionRestorable: true },
  });
  io.send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [{ kind: "session.reset" }] },
  });
}

type ConstructionParams = z.infer<typeof threadStartParamsSchema>;

async function constructSession(
  params: ConstructionParams,
  sessionId: string,
  kind: "start" | "resume",
): Promise<MuseSession> {
  const previous = sessions.get(params.threadId);
  const session = new MuseSession(
    {
      threadId: params.threadId,
      sessionId,
      cwd: params.cwd,
      dynamicTools: params.dynamicTools ?? [],
      options: params.options,
    },
    services,
  );
  // Registered before the first await, so a stop that arrives at any point
  // of the construction finds it and cancels it.
  sessions.set(params.threadId, session);
  try {
    if (previous !== undefined) await retire(previous, "release");
    await session.open(kind);
  } catch (error) {
    await retire(session, "release").catch(() => undefined);
    throw error;
  }
  sendIdentity(params.threadId, sessionId);
  return session;
}

function liveSession(threadId: string): MuseSession {
  const session = sessions.get(threadId);
  if (session === undefined) {
    throw new BridgeError(
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      `No Muse session for thread ${threadId}; send thread/start or thread/resume first`,
    );
  }
  return session;
}

// ---------------------------------------------------------------- dispatch

type Handler = (params: unknown) => Promise<unknown>;

function parsed<T>(schema: z.ZodType<T>, method: string, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new BridgeError(
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for ${method}: ${result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

const handlers: Record<string, Handler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: async (params) => {
    parsed(initializeParamsSchema, "initialize", params);
    const result: InitializeResult = {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "inject",
        skills: { configure: true },
      },
    };
    return result;
  },

  [BRIDGE_REQUEST_METHODS.modelList]: async (params) => {
    const { cwd } = parsed(modelListParamsSchema, "model/list", params);
    return { models: await probing((signal) => listModels(cwd, signal)), selectedOnlyModels: [] };
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: async (params) => {
    parsed(providerMaintenanceParamsSchema, "provider/health", params);
    return probing(health);
  },

  [BRIDGE_REQUEST_METHODS.providerUsage]: async (params) => {
    parsed(providerMaintenanceParamsSchema, "provider/usage", params);
    return usage();
  },

  [BRIDGE_REQUEST_METHODS.skillsConfigure]: async (params) => {
    skillRoots = parsed(skillsConfigureParamsSchema, "skills/configure", params).roots;
    return { ok: true };
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: async (params) => {
    const start = parsed(threadStartParamsSchema, "thread/start", params);
    const sessionId = uuidv7();
    const session = await constructSession(start, sessionId, "start");
    if (start.input !== undefined && start.input.length > 0) {
      session.startFirstTurn(start.input, start.options);
    }
    return { providerThreadId: sessionId, sessionRestorable: true };
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: async (params) => {
    const resume = parsed(threadResumeParamsSchema, "thread/resume", params);
    await constructSession(resume, resume.providerThreadId, "resume");
    return { providerThreadId: resume.providerThreadId, sessionRestorable: true };
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: async (params) => {
    const turn = parsed(turnStartParamsSchema, "turn/start", params);
    await liveSession(turn.threadId).startTurn({
      input: turn.input,
      clientRequestId: turn.clientRequestId,
      options: turn.options,
    });
    return {};
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: async (params) => {
    const steer = parsed(turnSteerParamsSchema, "turn/steer", params);
    const session = sessions.get(steer.threadId);
    if (session === undefined) {
      throw new BridgeRecoveryError({
        code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        message: "No Muse session to steer",
        recovery: { kind: "staleTurn", message: "No Muse session to steer", retryable: false },
      });
    }
    await session.steer({ input: steer.input, clientRequestId: steer.clientRequestId });
    return {};
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: async (params) => {
    const stop = parsed(threadStopParamsSchema, "thread/stop", params);
    await stopThread(stop.threadId, stop.intent);
    return {};
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: async (params) => {
    const discard = parsed(threadDiscardParamsSchema, "thread/discard", params);
    await stopThread(discard.threadId, "release");
    return { ok: true };
  },
};

function handleParsedMessage(message: unknown): void {
  const response = decodeBridgeJsonRpcResponse(message);
  if (response !== null && typeof response.id === "string" && runtimeRequests.has(response.id)) {
    const pending = runtimeRequests.get(response.id);
    runtimeRequests.delete(response.id);
    if ("error" in response) {
      pending?.reject(new Error(response.error.message ?? "The runtime refused the request"));
    } else {
      pending?.resolve(response.result);
    }
    return;
  }
  if (typeof message !== "object" || message === null) return;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string" || (typeof id !== "string" && typeof id !== "number")) return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => {
      try {
        io.sendResult(request.id, await handler(request.params));
      } catch (error) {
        if (error instanceof BridgeError) {
          io.sendError(request.id, error.code, error.message);
          return;
        }
        throw error;
      }
    },
  });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

/**
 * Stop every session and the tool server (bridge shutdown, test teardown).
 * A session's stop settles once its Muse processes are gone, shells that
 * ignore SIGTERM included.
 */
export async function shutdown(): Promise<void> {
  const all = [...sessions.values(), ...retiring];
  probesStopping.abort(new Error("The Muse bridge is shutting down"));
  await Promise.allSettled([...all.map((session) => retire(session, "release")), ...probes]);
  probesStopping = new AbortController();
  for (const pending of runtimeRequests.values()) pending.reject(new Error("Muse bridge shutting down"));
  runtimeRequests.clear();
  await toolServer.close();
  modelCache = null;
  healthCache = null;
}

function exitAfterShutdown(): void {
  exiting = true;
  void shutdown().finally(() => process.exit(0));
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: (context) => {
    dataDir = context.dataDir;
    tempDir = context.tempDir;
  },
  onClose: exitAfterShutdown,
  onSigterm: exitAfterShutdown,
  onSigint: exitAfterShutdown,
});
