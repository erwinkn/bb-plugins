import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
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
  for (const match of output.matchAll(/https:\/\/accounts\.google\.com\/\S+/gu)) {
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

function killChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    // Already exited.
  }
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
  usageCacheTtlMs?: number;
  resolveAgy?: () => Promise<string | null>;
  spawnLogin?: (command: string, env: NodeJS.ProcessEnv) => ChildProcess;
  runUsage?: (command: string, env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

interface ActiveFlow {
  id: string;
  phase: "starting" | "waiting" | "verifying";
  authorizationUrl: string | null;
  state: string | null;
  message: string | null;
  child: ChildProcess;
  output: string;
  timer: NodeJS.Timeout;
  linkReady: Promise<void>;
  exited: Promise<number | null>;
}

function defaultRunUsage(command: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
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
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export class AntigravityService {
  private readonly home: string;
  private readonly now: () => number;
  private readonly flowTimeoutMs: number;
  private readonly usageCacheTtlMs: number;
  private readonly resolveCmd: () => Promise<string | null>;
  private readonly spawnLogin: (command: string, env: NodeJS.ProcessEnv) => ChildProcess;
  private readonly runUsage: (command: string, env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;

  private active: ActiveFlow | null = null;
  private finished: SignInFlow | null = null;
  private usageCache: { credential: string; fetchedAt: number; value: UsageState } | null = null;
  private usageInFlight: Promise<UsageState> | null = null;

  constructor(deps: ServiceDeps = {}) {
    this.home = deps.home ?? os.homedir();
    this.now = deps.now ?? (() => Date.now());
    this.flowTimeoutMs = deps.flowTimeoutMs ?? FLOW_TIMEOUT_MS;
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
    if (!force && this.usageInFlight) return this.usageInFlight;
    const credential = account.credential;
    const run = (async (): Promise<UsageState> => {
      const result = await this.runUsage(command, agyEnv());
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
    this.usageInFlight = run;
    try {
      return await run;
    } finally {
      if (this.usageInFlight === run) this.usageInFlight = null;
    }
  }

  private stopActive(outcome: SignInFlow | null = null): void {
    const current = this.active;
    if (!current) return;
    this.active = null;
    clearTimeout(current.timer);
    killChild(current.child);
    if (outcome) this.finished = outcome;
  }

  async signInStart(): Promise<Status> {
    const command = await this.resolveCmd();
    if (command === null) throw new Error("agy is not installed on this machine.");
    this.stopActive();
    this.finished = null;

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
      linkReady,
      exited,
      timer: setTimeout(() => {
        if (this.active !== flow) return;
        this.stopActive({
          id,
          phase: "failed",
          authorizationUrl: null,
          message: "Sign-in timed out after 5 minutes.",
          active: false,
        });
      }, this.flowTimeoutMs),
    };
    this.active = flow;

    const onOutput = (chunk: Buffer) => {
      flow.output = (flow.output + chunk.toString("utf8")).slice(0, OUTPUT_CAP);
      if (flow.authorizationUrl === null) {
        const parsed = parseAuthorizationUrl(flow.output);
        if (parsed) {
          flow.authorizationUrl = parsed.url;
          flow.state = parsed.state;
          flow.phase = "waiting";
          flow.message = null;
          resolveLink();
        }
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
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

    await Promise.race([linkReady, new Promise((resolve) => setTimeout(resolve, LINK_WAIT_MS))]);
    return this.status();
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
    await Promise.race([flow.exited, new Promise((resolve) => setTimeout(resolve, SUBMIT_WAIT_MS))]);
    if (this.active === flow) {
      this.stopActive({
        id: flow.id,
        phase: "failed",
        authorizationUrl: null,
        message: "Timed out waiting for agy to finish sign-in.",
        active: false,
      });
    }
    this.usageCache = null;
    return this.status();
  }

  async signInCancel(flowId: string): Promise<Status> {
    if (this.active?.id === flowId) {
      this.stopActive();
      this.finished = null;
    }
    return this.status();
  }

  async signOut(): Promise<Status> {
    this.stopActive();
    this.finished = null;
    this.usageCache = null;
    await rm(tokenFilePath(this.home), { force: true });
    return this.status();
  }

  dispose(): void {
    this.stopActive();
  }
}
