/**
 * Plain Node stand-ins for the few `@bb/process-utils` helpers upstream uses: an agent process in
 * its own process group that stops leader first, a bounded `execFile`, and a path check.
 */
import type { ChildProcess } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { killPortableProcess, spawnPortableProcess } from "./bb.js";

const supportsProcessGroups = process.platform !== "win32";
const GROUP_EXIT_POLL_MS = 100;

export interface ProcessStopResult {
  treeTermination: "confirmed" | "unverified";
}

export interface ManagedProcess {
  child: ChildProcess;
  stop(options?: { gracePeriodMs: number }): Promise<ProcessStopResult>;
}

/** Spawns `command` with piped stdio, in its own process group where the platform has them. */
export function spawnManagedProcess(request: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawnPortableProcess({
    command: request.command,
    args: request.args,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
    detached: supportsProcessGroups,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcess;
  let stopping: Promise<ProcessStopResult> | undefined;
  return {
    child,
    stop: ({ gracePeriodMs } = { gracePeriodMs: 1_000 }) =>
      (stopping ??= stopLeaderFirst(child, gracePeriodMs)),
  };
}

export function isClosedProcessStdinError(error: Error): boolean {
  return (
    "code" in error &&
    (error.code === "EPIPE" ||
      error.code === "EOF" ||
      error.code === "ERR_STREAM_DESTROYED")
  );
}

export function isPathWithinDirectory(
  directoryPath: string,
  candidatePath: string,
): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

/**
 * Runs `command` to completion and returns its output, like `execFile`, in its own process group
 * so a timeout stops its children too. Rejects with an error carrying `code`, `syscall` (when the
 * spawn itself failed), `stdout` and `stderr`.
 */
export function execPortableFile(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    const child = spawnPortableProcess({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      detached: supportsProcessGroups,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;
    const output = { stdout: "", stderr: "" };
    let failure: Error | null = null;
    let settled = false;
    const fail = (error: Error) => {
      failure ??= error;
      void stopLeaderFirst(child, 1_000);
    };
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      output[stream] += chunk.toString("utf8");
      if (output[stream].length > options.maxBuffer) {
        fail(
          Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
      }
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(
            () =>
              fail(new Error(`Command timed out after ${options.timeout}ms`)),
            options.timeout,
          );
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolveExec(output);
        return;
      }
      rejectExec(Object.assign(error, output));
    };
    child.once("error", (error) => settle(failure ?? error));
    child.once("close", (code, signal) => {
      if (failure !== null) {
        settle(failure);
      } else if (code === 0) {
        settle(null);
      } else {
        settle(
          Object.assign(
            new Error(
              `Command failed: ${command} ${args.join(" ")}`.trim() +
                (signal === null ? ` (exit code ${code})` : ` (${signal})`),
            ),
            { code, signal },
          ),
        );
      }
    });
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (supportsProcessGroups && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function isGroupAlive(child: ChildProcess): boolean {
  if (!supportsProcessGroups || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/**
 * SIGTERM to the leader, then to what is left of its group once it exits; SIGKILL to the group
 * after `gracePeriodMs`. Windows has no process groups: the SDK's portable kill ends the tree.
 */
function stopLeaderFirst(
  child: ChildProcess,
  gracePeriodMs: number,
): Promise<ProcessStopResult> {
  if (child.pid === undefined) {
    return Promise.resolve({ treeTermination: "confirmed" });
  }
  if (!supportsProcessGroups) {
    if (hasExited(child)) {
      return Promise.resolve({ treeTermination: "confirmed" });
    }
    return new Promise((resolveStop) => {
      const timer = setTimeout(
        () => resolveStop({ treeTermination: "unverified" }),
        gracePeriodMs + 1_000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop({ treeTermination: "confirmed" });
      });
      killPortableProcess(child, "SIGTERM");
    });
  }
  const groupGone = () => hasExited(child) && !isGroupAlive(child);
  if (groupGone()) {
    return Promise.resolve({ treeTermination: "confirmed" });
  }
  return new Promise((resolveStop) => {
    let settled = false;
    let poll: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", stopSurvivors);
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      clearInterval(poll);
      resolveStop({
        treeTermination: groupGone() ? "confirmed" : "unverified",
      });
    };
    const stopSurvivors = () => {
      if (!isGroupAlive(child)) {
        finish();
        return;
      }
      signalGroup(child, "SIGTERM");
      poll = setInterval(() => {
        if (!isGroupAlive(child)) finish();
      }, GROUP_EXIT_POLL_MS);
    };
    const softTimer = setTimeout(() => {
      if (groupGone()) {
        finish();
        return;
      }
      signalGroup(child, "SIGKILL");
      hardTimer = setTimeout(finish, 1_000);
    }, gracePeriodMs);
    if (hasExited(child)) {
      stopSurvivors();
      return;
    }
    child.once("exit", stopSurvivors);
    child.kill("SIGTERM");
  });
}
