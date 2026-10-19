// A minimal Muse Session Protocol client: one `muse serve` child, newline-
// delimited JSON-RPC 2.0 over its stdio, in both directions.
//
// MSP shapes are read leniently (see protocol.ts); this file only moves
// frames, correlates responses, and owns the child's lifetime, including the
// shells left in its process group.

import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  experimental_killPortableProcess as killPortableProcess,
  experimental_readBoundedLines as readBoundedLines,
  experimental_recordProviderChildIo as recordProviderChildIo,
  experimental_spawnPortableProcess as spawnPortableProcess,
} from "@get-bb/plugin-sdk/provider-bridge";

const STDERR_TAIL_CHARS = 4_000;
/** After Muse exits, how long its pipes may stay open (a descendant holding them). */
const EXIT_DRAIN_MS = 2_000;
const GROUP_KILL_GRACE_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** A UUIDv7: MSP requires one for every `commandId`. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  let millis = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(millis & 0xffn);
    millis >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `work`, or a rejection with the abort reason as soon as `signal` aborts. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  const stopped = () => (signal.reason instanceof Error ? signal.reason : new Error("Stopped"));
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(stopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A JSON-RPC error answered by `muse serve`; branch on `kind`, never on text. */
export class MspError extends Error {
  readonly code: number;
  readonly kind: string | null;
  readonly data: unknown;

  constructor(args: { code: number; message: string; data?: unknown }) {
    super(args.message);
    this.name = "MspError";
    this.code = args.code;
    this.data = args.data;
    const kind =
      typeof args.data === "object" && args.data !== null
        ? (args.data as { kind?: unknown }).kind
        : undefined;
    this.kind = typeof kind === "string" ? kind : null;
  }
}

export interface MspExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface MspLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Thread scope for record mode (`null` for sessionless probes). */
  recordThreadId: string | null;
  // Each callback names its connection: they can fire during the handshake,
  // before the caller holds the connection. They fire in wire order, and
  // onExit after the last frame.
  onNotification: (connection: MspConnection, method: string, params: unknown) => void;
  onServerRequest: (connection: MspConnection, id: string | number, method: string, params: unknown) => void;
  onExit: (connection: MspConnection, exit: MspExit) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MspConnection {
  readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stderrTail = "";
  private exitInfo: MspExit | null = null;
  private readonly exited: Promise<MspExit>;
  /** Settles once Muse exited and nothing is left in its process group. */
  private readonly gone: Promise<MspExit>;

  constructor(private readonly launch: MspLaunch) {
    let settle: (exit: MspExit) => void = () => undefined;
    this.exited = new Promise((resolve) => {
      settle = resolve;
    });
    this.gone = this.exited.then(async (exit) => {
      await this.cleanUpGroup();
      return exit;
    });
    this.child = spawnPortableProcess({
      command: launch.command,
      args: [...launch.args],
      cwd: launch.cwd,
      env: launch.env,
      // Its own process group, so a stop reaches the shells Muse spawned.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    recordProviderChildIo(this.child, { threadId: launch.recordThreadId });
    this.child.stdin?.on("error", () => undefined);
    if (this.child.stdout) {
      readBoundedLines({
        input: this.child.stdout,
        onLine: (line) => this.handleLine(line),
        onOverflow: (bytes) =>
          process.stderr.write(`muse bridge: dropped a ${bytes}-byte MSP line\n`),
      });
    }
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exitInfo !== null) return;
      this.exitInfo = { code, signal, stderrTail: this.stderrTail };
      const message = `Muse exited (${describeExit(this.exitInfo)})`;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this.pending.clear();
      settle(this.exitInfo);
      launch.onExit(this, this.exitInfo);
    };
    // Finish on `close`: stdout may still hold the last frames. A descendant
    // that inherited the pipes can hold them open after Muse is gone, so
    // `exit` starts a bounded drain and terminates the group, which frees them.
    this.child.once("close", finish);
    this.child.once("exit", (code, signal) => {
      this.signalGroup("SIGTERM");
      setTimeout(() => {
        finish(code, signal);
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
      }, EXIT_DRAIN_MS).unref?.();
    });
    this.child.once("error", (error) => {
      this.stderrTail = `${this.stderrTail}\n${error.message}`.slice(-STDERR_TAIL_CHARS);
      finish(null, null);
    });
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  lastStderr(): string {
    return this.stderrTail;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.exitInfo !== null) {
      return Promise.reject(new Error(`Muse is not running (${describeExit(this.exitInfo)})`));
    }
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Muse did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** A state-changing MSP command: carries a UUIDv7 `commandId` (a fresh one unless given). */
  command(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request(method, { commandId: uuidv7(), ...params }, timeoutMs);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  /**
   * Stop the child: EOF on stdin lets Muse flush its session log, then
   * SIGTERM and SIGKILL after the grace periods. Settles only once nothing is
   * left in its process group, so a stop never answers before Muse's shells
   * are gone; closing a child that already exited waits for that cleanup too.
   */
  async close(graceMs = 5_000): Promise<MspExit> {
    if (this.exitInfo !== null) return this.gone;
    this.child.stdin?.end();
    const term = setTimeout(() => this.signal("SIGTERM"), graceMs);
    const kill = setTimeout(() => this.signal("SIGKILL"), graceMs + 2_000);
    try {
      return await this.gone;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exitInfo !== null) return;
    if (this.signalGroup(signal)) return;
    killPortableProcess(this.child, signal);
  }

  /**
   * Muse's shells live in its process group and can outlast it: TERM the
   * group, KILL whatever is left after a grace period, and settle once the
   * group is empty.
   */
  private cleanUpGroup(): Promise<void> {
    if (!this.signalGroup("SIGTERM")) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const started = Date.now();
      let killed = false;
      const poll = setInterval(() => {
        const elapsed = Date.now() - started;
        // A zombie answers signal 0 until its parent reaps it; stop waiting
        // a second after SIGKILL.
        if (!this.signalGroup(0) || elapsed >= GROUP_KILL_GRACE_MS + 1_000) {
          clearInterval(poll);
          resolve();
        } else if (!killed && elapsed >= GROUP_KILL_GRACE_MS) {
          killed = true;
          this.signalGroup("SIGKILL");
        }
      }, 50);
    });
  }

  /** Signal the child's whole process group; false when there is none to signal. */
  private signalGroup(signal: NodeJS.Signals | 0): boolean {
    const pid = this.child.pid;
    if (process.platform === "win32" || pid === undefined) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.exitInfo !== null) return;
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const frame = message as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    const hasId = typeof frame.id === "number" || typeof frame.id === "string";
    if (typeof frame.method === "string") {
      if (hasId) {
        this.launch.onServerRequest(this, frame.id as string | number, frame.method, frame.params);
      } else {
        this.launch.onNotification(this, frame.method, frame.params);
      }
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      pending.reject(
        new MspError({
          code: typeof frame.error.code === "number" ? frame.error.code : -32603,
          message:
            typeof frame.error.message === "string"
              ? frame.error.message
              : `${pending.method} failed`,
          data: frame.error.data,
        }),
      );
      return;
    }
    pending.resolve(frame.result);
  }
}

export function describeExit(exit: Pick<MspExit, "code" | "signal" | "stderrTail">): string {
  const status =
    exit.signal !== null
      ? `signal ${exit.signal}`
      : exit.code === null
        ? "failed to start"
        : `code ${exit.code}${exitMeaning(exit.code)}`;
  const lastLine = exit.stderrTail.trim().split("\n").at(-1)?.trim();
  return lastLine ? `${status}: ${lastLine}` : status;
}

function exitMeaning(code: number): string {
  switch (code) {
    case 2:
      return ", usage error";
    case 3:
      return ", configuration error";
    case 4:
      return ", the session is held by another Muse client";
    case 5:
      return ", SDK surface unavailable";
    default:
      return "";
  }
}

/**
 * Launch `muse serve` and complete the MSP handshake. When the handshake
 * fails, times out or `signal` aborts, rejects once the child and its
 * process group are gone.
 */
export async function connectMsp(
  launch: MspLaunch,
  initializeParams: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ connection: MspConnection; initializeResult: unknown }> {
  const connection = new MspConnection(launch);
  try {
    const initializeResult = await abortable(connection.request("initialize", initializeParams, timeoutMs), signal);
    connection.notify("initialized");
    return { connection, initializeResult };
  } catch (error) {
    await connection.close(1_000);
    const stderr = connection.lastStderr().trim().split("\n").at(-1);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stderr ? `${message} (${stderr})` : message);
  }
}
