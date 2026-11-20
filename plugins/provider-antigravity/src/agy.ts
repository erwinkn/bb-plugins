import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { SignInFlow, Status, UsageState, UsageWindow } from "./contract.js";

export const AGY_COMMAND = "agy";
export const CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";

const OVERRIDING_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GEMINI_HOME",
  "AGY_ADC_AUTH",
];

const SIGN_IN_PROMPT = /Authentication required|log in with Google/iu;
const USAGE_CACHE_TTL_MS = 3 * 60_000;
const USAGE_TIMEOUT_MS = 20_000;
const LINK_WAIT_MS = 5_000;
const SUBMIT_WAIT_MS = 20_000;
const FLOW_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CAP = 64 * 1024;
const MAX_RESPONSE_LENGTH = 16_384;
// After SIGTERM a login child gets this long to exit before SIGKILL, then this
// long to be reaped before the service stops waiting for it.
const KILL_GRACE_MS = 2_500;
const KILL_WAIT_MS = 1_000;

export function agyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of OVERRIDING_ENV) delete env[key];
  return {
    ...env,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
  };
}

export function tokenFilePath(home: string = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

export async function resolveAgy(envPath: string | undefined = process.env.PATH): Promise<string | null> {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, AGY_COMMAND);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  return null;
}

const tokenFileSchema = z.object({
  token: z.object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
  }),
  id_token_email: z.string().optional(),
});

export interface AgyAccount {
  signedIn: boolean;
  email: string | null;
  credential: string | null;
}

export const SIGNED_OUT: AgyAccount = { signedIn: false, email: null, credential: null };

export function accountFromTokenText(text: string): AgyAccount {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return SIGNED_OUT;
  }
  const parsed = tokenFileSchema.safeParse(json);
  if (!parsed.success) return SIGNED_OUT;
  const { token, id_token_email: email } = parsed.data;
  if (!token.refresh_token && !token.access_token) return SIGNED_OUT;
  return {
    signedIn: true,
    email: email !== undefined && email.includes("@") ? email : null,
    credential: createHash("sha256")
      .update(token.refresh_token || token.access_token || "")
      .digest("hex")
      .slice(0, 16),
  };
}

export async function readAccount(home: string = os.homedir()): Promise<AgyAccount> {
  try {
    return accountFromTokenText(await readFile(tokenFilePath(home), "utf8"));
  } catch {
    return SIGNED_OUT;
  }
}

export function parseAuthorizationUrl(output: string): { url: string; state: string } | null {
  // A URL counts only once whitespace follows it: output arrives in chunks, and
  // a link cut mid-`state=` would otherwise lock in a truncated flow.
  for (const match of output.matchAll(/https:\/\/accounts\.google\.com\/\S+(?=\s)/gu)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const state = url.searchParams.get("state");
    if (
      url.origin === "https://accounts.google.com" &&
      url.searchParams.get("redirect_uri") === CODE_REDIRECT_URI &&
      url.searchParams.get("response_type") === "code" &&
      state
    ) {
      return { url: url.toString(), state };
    }
  }
  return null;
}

export function loginResponse(state: string, response: string): string | null {
  const value = response.trim();
  if (!value || value.length > MAX_RESPONSE_LENGTH || /\s/u.test(value)) return null;
  if (/^[\w./~-]+$/u.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return `${url.origin}${url.pathname}` === CODE_REDIRECT_URI &&
    url.searchParams.get("state") === state &&
    Boolean(url.searchParams.get("code"))
    ? value
    : null;
}

const bucketSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number().optional(),
  reset_time: z.string().optional(),
});

const usageAnswerSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  command: z
    .object({
      name: z.string(),
      data: z.object({
        groups: z
          .array(z.object({ name: z.string(), buckets: z.array(bucketSchema).default([]) }))
          .default([]),
      }),
    })
    .optional(),
});

const WINDOW_ORDER: Record<string, number> = { "5h": 0, weekly: 1 };

export function usageWindowsFromAnswer(answer: unknown): UsageWindow[] | null {
  const parsed = usageAnswerSchema.safeParse(answer);
  if (!parsed.success || parsed.data.command?.name !== "usage") return null;
  const windows: UsageWindow[] = [];
  for (const group of parsed.data.command.data.groups) {
    const groupLabel = group.name
      .replace(/\s+models?$/iu, "")
      .replace(/\s+and\s+/giu, " & ")
      .trim();
    const buckets = group.buckets
      .filter((b) => b.remaining_fraction !== undefined)
      .sort((a, b) => (WINDOW_ORDER[a.window ?? ""] ?? 2) - (WINDOW_ORDER[b.window ?? ""] ?? 2));
    for (const bucket of buckets) {
      const remaining = Math.max(0, Math.min(1, bucket.remaining_fraction ?? 1));
      const label =
        bucket.window === "5h" ? "5h" : bucket.window === "weekly" ? "7d" : bucket.name?.trim() || bucket.id;
      const at = bucket.reset_time ? Date.parse(bucket.reset_time) : Number.NaN;
      windows.push({
        label: `${groupLabel} ${label}`,
        usedPercent: (1 - remaining) * 100,
        resetsAt: remaining >= 1 || !Number.isFinite(at) ? null : new Date(at).toISOString(),
      });
    }
  }
  return windows;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  try {
    if (pid === undefined || process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
}

/** Resolves true when `promise` settles within `ms`, false when the wait ran out. The timer never outlives the wait. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function lastLine(output: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((l) => l.replace(/https?:\/\/\S+/gu, "<link>").trim())
    .filter(Boolean)
    .at(-1);
  return line ? line.slice(0, 300) : null;
}

function parseJsonTail(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const idx = trimmed.indexOf("{");
    if (idx < 0) return null;
    try {
      return JSON.parse(trimmed.slice(idx));
    } catch {
      return null;
    }
  }
}

export interface ServiceDeps {
  home?: string;
  now?: () => number;
  flowTimeoutMs?: number;
  killGraceMs?: number;
  killWaitMs?: number;
  submitWaitMs?: number;
  usageCacheTtlMs?: number;
  resolveAgy?: () => Promise<string | null>;
  spawnLogin?: (command: string, env: NodeJS.ProcessEnv) => ChildProcess;
  runUsage?: UsageRunner;
}

type UsageRunner = (
  command: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

interface ActiveFlow {
  id: string;
  phase: "starting" | "waiting" | "verifying";
  authorizationUrl: string | null;
  state: string | null;
  message: string | null;
  child: ChildProcess;
  output: string;
  streams: { stdout: string; stderr: string };
  timer: NodeJS.Timeout;
  linkReady: Promise<void>;
  exited: Promise<number | null>;
}

const defaultRunUsage: UsageRunner = (command, env, signal) => {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    if (signal.aborted) {
      resolve({ code: null, stdout: "", stderr: "" });
      return;
    }
    const child = spawn(command, ["-p", "/usage", "--output-format", "json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => killChild(child), USAGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(0, 512 * 1024);
      if (SIGN_IN_PROMPT.test(stdout + stderr)) killChild(child);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 64 * 1024);
      if (SIGN_IN_PROMPT.test(stdout + stderr)) killChild(child);
    });
    // The probe is detached, so nothing else would end it once the service is gone.
    const abort = () => killChild(child, "SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
};

export class AntigravityService {
  private readonly home: string;
  private readonly now: () => number;
  private readonly flowTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly killWaitMs: number;
  private readonly submitWaitMs: number;
  private readonly usageCacheTtlMs: number;
  private readonly resolveCmd: () => Promise<string | null>;
  private readonly spawnLogin: (command: string, env: NodeJS.ProcessEnv) => ChildProcess;
  private readonly runUsage: UsageRunner;
  /** Aborted on dispose: ends every usage probe still running. */
  private readonly shutdown = new AbortController();

  private active: ActiveFlow | null = null;
  private stopping: { flow: ActiveFlow; done: Promise<boolean> } | null = null;
  /** A login child that outlived SIGKILL; nothing may touch the token file until it exits. */
  private lingering: ActiveFlow | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private disposed = false;
  private finished: SignInFlow | null = null;
  private usageCache: { credential: string; fetchedAt: number; value: UsageState } | null = null;
  private usageInFlight: { credential: string; run: Promise<UsageState> } | null = null;

  constructor(deps: ServiceDeps = {}) {
    this.home = deps.home ?? os.homedir();
    this.now = deps.now ?? (() => Date.now());
    this.flowTimeoutMs = deps.flowTimeoutMs ?? FLOW_TIMEOUT_MS;
    this.killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
    this.killWaitMs = deps.killWaitMs ?? KILL_WAIT_MS;
    this.submitWaitMs = deps.submitWaitMs ?? SUBMIT_WAIT_MS;
    this.usageCacheTtlMs = deps.usageCacheTtlMs ?? USAGE_CACHE_TTL_MS;
    this.resolveCmd = deps.resolveAgy ?? (() => resolveAgy());
    this.spawnLogin =
      deps.spawnLogin ??
      ((command, env) =>
        spawn(command, ["acp", "--login"], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        }));
    this.runUsage = deps.runUsage ?? defaultRunUsage;
  }

  private flowView(): SignInFlow | null {
    if (this.active) {
      return {
        id: this.active.id,
        phase: this.active.phase,
        authorizationUrl: this.active.authorizationUrl,
        message: this.active.message,
        active: true,
      };
    }
    return this.finished;
  }

  async status(): Promise<Status> {
    const [command, account] = await Promise.all([this.resolveCmd(), readAccount(this.home)]);
    return {
      installed: command !== null,
      signedIn: account.signedIn,
      email: account.email,
      flow: this.flowView(),
    };
  }

  async usage(force = false): Promise<UsageState> {
    const [command, account] = await Promise.all([this.resolveCmd(), readAccount(this.home)]);
    this.assertRunning();
    if (command === null) return { status: "not_installed" };
    if (!account.signedIn || !account.credential) return { status: "unauthenticated" };
    if (
      !force &&
      this.usageCache &&
      this.usageCache.credential === account.credential &&
      this.now() - this.usageCache.fetchedAt < this.usageCacheTtlMs
    ) {
      return this.usageCache.value;
    }
    const credential = account.credential;
    // Only share a request made for the same account: another one's answer must not reach this caller.
    if (!force && this.usageInFlight?.credential === credential) return this.usageInFlight.run;
    const run = (async (): Promise<UsageState> => {
      this.assertRunning();
      const result = await this.runUsage(command, agyEnv(), this.shutdown.signal);
      this.assertRunning();
      if (SIGN_IN_PROMPT.test(result.stdout + result.stderr)) {
        return { status: "expired" };
      }
      const parsed = parseJsonTail(result.stdout);
      const windows = parsed ? usageWindowsFromAnswer(parsed) : null;
      if (windows) {
        const value: UsageState = {
          status: "ok",
          accountEmail: account.email,
          windows,
          fetchedAt: new Date(this.now()).toISOString(),
        };
        this.usageCache = { credential, fetchedAt: this.now(), value };
        return value;
      }
      const detail = lastLine(result.stderr) ?? lastLine(result.stdout) ?? "agy /usage returned an unreadable answer.";
      return { status: "error", message: detail };
    })();
    const entry = { credential, run };
    this.usageInFlight = entry;
    try {
      return await run;
    } finally {
      if (this.usageInFlight === entry) this.usageInFlight = null;
    }
  }

  private assertRunning(): void {
    if (this.disposed) throw new Error("The Antigravity service is shutting down.");
  }

  /** Runs lifecycle operations (start, cancel, sign-out, forced stop) one at a time, so none can interleave with another's awaits. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(fn);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** SIGTERM, then SIGKILL after a grace period. True when the child's exit was observed. */
  private async terminate(flow: ActiveFlow): Promise<boolean> {
    killChild(flow.child);
    let exited = await settlesWithin(flow.exited, this.killGraceMs);
    if (!exited) {
      killChild(flow.child, "SIGKILL");
      exited = await settlesWithin(flow.exited, this.killWaitMs);
    }
    if (!exited) {
      this.lingering = flow;
      void flow.exited.then(() => {
        if (this.lingering === flow) this.lingering = null;
      });
    }
    if (this.stopping?.flow === flow) this.stopping = null;
    return exited;
  }

  /** Starts ending the active login child (no-op without one); `stopping` tracks it until the child has exited. */
  private stopFlow(outcome: SignInFlow | null = null): void {
    const current = this.active;
    if (!current) return;
    this.active = null;
    clearTimeout(current.timer);
    if (outcome) this.finished = outcome;
    this.stopping = { flow: current, done: this.terminate(current) };
  }

  /**
   * Resolves once no login child can still write to the token file: the active
   * flow is stopped, any shutdown already underway is joined, and a child that
   * outlived SIGKILL is tried once more. Throws if one still has not exited.
   * With `only`, just that flow is handled, so a late caller cannot end a newer one.
   */
  private async quiesce(only?: ActiveFlow): Promise<void> {
    const failure = new Error("The previous agy sign-in process did not exit. Try again in a moment.");
    const mine = (flow: ActiveFlow) => !only || flow === only;
    if (this.active && mine(this.active)) this.stopFlow();
    let confirmed = true;
    while (this.stopping && mine(this.stopping.flow)) confirmed = (await this.stopping.done) && confirmed;
    if (!confirmed) throw failure;
    const stuck = this.lingering;
    if (stuck && mine(stuck)) {
      killChild(stuck.child, "SIGKILL");
      if (!(await settlesWithin(stuck.exited, this.killWaitMs))) throw failure;
      if (this.lingering === stuck) this.lingering = null;
    }
  }

  async signInStart(): Promise<Status> {
    const command = await this.resolveCmd();
    if (command === null) throw new Error("agy is not installed on this machine.");
    const flow = await this.exclusive(async () => {
      await this.quiesce();
      if (this.disposed) throw new Error("The Antigravity service is shutting down.");
      this.finished = null;
      return this.launch(command);
    });
    await settlesWithin(flow.linkReady, LINK_WAIT_MS);
    return this.status();
  }

  private launch(command: string): ActiveFlow {
    const id = randomUUID();
    const child = this.spawnLogin(command, agyEnv());
    let resolveLink!: () => void;
    const linkReady = new Promise<void>((resolve) => (resolveLink = resolve));
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));

    const flow: ActiveFlow = {
      id,
      phase: "starting",
      authorizationUrl: null,
      state: null,
      message: "Starting Google sign-in…",
      child,
      output: "",
      streams: { stdout: "", stderr: "" },
      linkReady,
      exited,
      timer: setTimeout(() => {
        if (this.active !== flow) return;
        this.stopFlow({
          id,
          phase: "failed",
          authorizationUrl: null,
          message: "Sign-in timed out after 5 minutes.",
          active: false,
        });
      }, this.flowTimeoutMs),
    };
    this.active = flow;

    // Each stream is parsed on its own: a newline on stderr says nothing about
    // whether a URL still arriving on stdout has ended.
    const onOutput = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      flow.output = (flow.output + text).slice(0, OUTPUT_CAP);
      flow.streams[stream] = (flow.streams[stream] + text).slice(0, OUTPUT_CAP);
      if (flow.authorizationUrl === null) {
        const parsed = parseAuthorizationUrl(flow.streams[stream]);
        if (parsed) {
          flow.authorizationUrl = parsed.url;
          flow.state = parsed.state;
          flow.phase = "waiting";
          flow.message = null;
          resolveLink();
        }
      }
    };
    child.stdout?.on("data", onOutput("stdout"));
    child.stderr?.on("data", onOutput("stderr"));
    const onDone = (code: number | null) => {
      resolveLink();
      resolveExit(code);
      if (this.active !== flow) return;
      this.active = null;
      clearTimeout(flow.timer);
      this.usageCache = null;
      if (code === 0) {
        this.finished = {
          id,
          phase: "succeeded",
          authorizationUrl: null,
          message: "Signed in to Antigravity.",
          active: false,
        };
      } else {
        this.finished = {
          id,
          phase: "failed",
          authorizationUrl: null,
          message: lastLine(flow.output) ?? `agy sign-in exited with code ${code ?? "error"}.`,
          active: false,
        };
      }
    };
    child.on("error", () => onDone(null));
    child.on("close", (code) => onDone(code));
    return flow;
  }

  async signInSubmit(flowId: string, response: string): Promise<Status> {
    const flow = this.active;
    if (!flow || flow.id !== flowId || !flow.state) {
      throw new Error("No active sign-in is waiting for a code.");
    }
    const answer = loginResponse(flow.state, response);
    if (!answer) {
      throw new Error("Paste the authorization code or the Antigravity callback URL from Google.");
    }
    flow.phase = "verifying";
    flow.message = "Verifying authorization code…";
    flow.child.stdin?.write(`${answer}\n`);
    flow.child.stdin?.end();
    await settlesWithin(flow.exited, this.submitWaitMs);
    try {
      await this.exclusive(async () => {
        if (this.active === flow) {
          this.stopFlow({
            id: flow.id,
            phase: "failed",
            authorizationUrl: null,
            message: "Timed out waiting for agy to finish sign-in.",
            active: false,
          });
        }
        await this.quiesce(flow);
      });
    } finally {
      this.usageCache = null;
    }
    return this.status();
  }

  async signInCancel(flowId: string): Promise<Status> {
    await this.exclusive(async () => {
      const flow = [this.active, this.stopping?.flow, this.lingering].find((candidate) => candidate?.id === flowId);
      if (!flow) return;
      await this.quiesce(flow);
      this.finished = null;
    });
    return this.status();
  }

  async signOut(): Promise<Status> {
    await this.exclusive(async () => {
      await this.quiesce();
      // A reload may have replaced this service while we waited; its successor
      // owns the token file now, so a late sign-out must not touch it.
      if (this.disposed) throw new Error("The Antigravity service is shutting down.");
      this.finished = null;
      this.usageCache = null;
      // Synchronous on purpose: no await sits between the disposed check above
      // and the unlink, so a replacement service cannot save credentials in the gap.
      rmSync(tokenFilePath(this.home), { force: true });
    });
    return this.status();
  }

  dispose(): void {
    // Nonthrowing; the escalation timers are unref'd so they never hold the host open.
    this.disposed = true;
    this.shutdown.abort();
    this.stopFlow();
  }
}
