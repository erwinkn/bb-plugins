import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ACP_BRIDGE_MCP_SERVER_NAME,
  type AcpMcpServerConfig,
} from "./tool-proxy-mcp.js";

const CURSOR_MCP_APPROVAL_FILE = "mcp-approvals.json";
const CURSOR_APPROVAL_LOCK_STALE_MS = 30_000;
const CURSOR_APPROVAL_LOCK_TIMEOUT_MS = 5_000;

/**
 * One claim on a Cursor MCP approval. Release each claim once, with
 * `releaseCursorSessionMcpServer`.
 */
export interface CursorMcpApproval {
  approval: string;
  /** This claim wrote the approval (for logs: ownership is tracked per approval, see below). */
  installedByBb: boolean;
  path: string;
}

/**
 * Every claim this process holds on one approval in one file. Sessions of a thread can claim the
 * same approval at once (a fresh session replacing the last one, a turn that gave up while its
 * claim waited on the file lock), so BB's ownership belongs to the approval, not to a claim: the
 * approval stays while any claim holds it, and goes with the last release if BB wrote it. Claims
 * count before they wait on the lock, and the file changes only under it, so a release that
 * races a new claim sees that claim and keeps the approval.
 *
 * `installedByBb` changes only once the file write it describes has succeeded, under the lock. A
 * removal that fails leaves the entry owned with no claims: releasing any of its claims again, or
 * the last release of a later claim, retries the removal.
 */
interface ApprovalClaims {
  key: string;
  claims: number;
  installedByBb: boolean;
}

interface ClaimRecord {
  entry: ApprovalClaims;
  released: boolean;
}

const claimsByApproval = new Map<string, ApprovalClaims>();
const claimOf = new WeakMap<CursorMcpApproval, ClaimRecord>();

function claimApproval(path: string, approval: string): ApprovalClaims {
  const key = `${path}\n${approval}`;
  let entry = claimsByApproval.get(key);
  if (entry === undefined) {
    entry = { key, claims: 0, installedByBb: false };
    claimsByApproval.set(key, entry);
  }
  entry.claims += 1;
  return entry;
}

function forgetSettledEntry(entry: ApprovalClaims): void {
  if (
    entry.claims === 0 &&
    !entry.installedByBb &&
    claimsByApproval.get(entry.key) === entry
  ) {
    claimsByApproval.delete(entry.key);
  }
}

/** Removes an approval BB wrote once no claim holds it. Throws, keeping BB's ownership, on failure. */
async function settleApproval(
  path: string,
  approval: string,
  entry: ApprovalClaims,
): Promise<void> {
  if (entry.claims === 0 && entry.installedByBb) {
    await mutateApprovals(path, (approvals) => {
      // A claim that arrived while this release waited on the lock keeps the approval.
      if (entry.claims > 0 || !entry.installedByBb) {
        return undefined;
      }
      return {
        approvals: approvals.filter((candidate) => candidate !== approval),
        committed: () => {
          entry.installedByBb = false;
        },
      };
    });
  }
  forgetSettledEntry(entry);
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function cursorAgentCommand(command: string): boolean {
  return (
    basename(command)
      .toLowerCase()
      .replace(/\.(?:bat|cmd|exe)$/u, "") === "cursor-agent"
  );
}

function cursorProjectSlug(projectRoot: string): string {
  return projectRoot
    .replace(/[^a-zA-Z0-9]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function cursorDataDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.CURSOR_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".cursor");
}

function cursorMcpServerConfig(config: AcpMcpServerConfig): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: config.command,
    args: config.args,
    env: Object.fromEntries(config.env.map(({ name, value }) => [name, value])),
  };
}

export function buildCursorMcpApprovalIdentifier(args: {
  config: AcpMcpServerConfig;
  projectRoot: string;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        path: args.projectRoot,
        server: cursorMcpServerConfig(args.config),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${args.config.name}-${fingerprint}`;
}

async function resolveCursorProjectRoot(args: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string> {
  return new Promise((resolveRoot) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: args.cwd, env: args.env, windowsHide: true },
      (error, stdout) => {
        const root = stdout.trim();
        resolveRoot(error === null && root !== "" ? root : resolve(args.cwd));
      },
    );
  });
}

async function readApprovals(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Cursor MCP approval file is not a string array: ${path}`);
  }
  return value;
}

async function writeApprovals(path: string, approvals: readonly string[]) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.bb-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(approvals, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function acquireApprovalLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.bb-lock`;
  const deadline = Date.now() + CURSOR_APPROVAL_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out updating Cursor MCP approvals: ${path}`);
    }
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (
        errorCode(error) !== "EEXIST" &&
        !(process.platform === "win32" && errorCode(error) === "EPERM")
      ) {
        throw error;
      }
    }

    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > CURSOR_APPROVAL_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        continue;
      }
      throw error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

/**
 * Rewrites the approval file under its lock. `mutate` returns the new list, or `undefined` to
 * leave the file alone; `committed` runs once the new list is on disk, still under the lock.
 */
async function mutateApprovals(
  path: string,
  mutate: (
    approvals: string[],
  ) => { approvals: string[]; committed: () => void } | undefined,
): Promise<void> {
  const releaseLock = await acquireApprovalLock(path);
  try {
    const approvals = await readApprovals(path);
    const next = mutate(approvals);
    if (next === undefined) {
      return;
    }
    if (
      approvals.length !== next.approvals.length ||
      approvals.some((approval, index) => approval !== next.approvals[index])
    ) {
      await writeApprovals(path, next.approvals);
    }
    next.committed();
  } finally {
    await releaseLock();
  }
}

export async function approveCursorSessionMcpServer(args: {
  agentCommand: string;
  config: AcpMcpServerConfig;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<CursorMcpApproval | undefined> {
  if (
    !cursorAgentCommand(args.agentCommand) ||
    args.config.name !== ACP_BRIDGE_MCP_SERVER_NAME
  ) {
    return undefined;
  }
  const projectRoot = await resolveCursorProjectRoot({
    cwd: args.cwd,
    env: args.env,
  });
  const path = join(
    cursorDataDirectory(args.env),
    "projects",
    cursorProjectSlug(projectRoot),
    CURSOR_MCP_APPROVAL_FILE,
  );
  const approval = buildCursorMcpApprovalIdentifier({
    config: args.config,
    projectRoot,
  });
  const entry = claimApproval(path, approval);
  let installedByBb = false;
  try {
    await mutateApprovals(path, (approvals) => {
      if (approvals.includes(approval)) {
        return undefined;
      }
      return {
        approvals: [...approvals, approval],
        committed: () => {
          installedByBb = true;
          entry.installedByBb = true;
        },
      };
    });
  } catch (error) {
    entry.claims -= 1;
    await settleApproval(path, approval, entry).catch(() => undefined);
    throw error;
  }
  const claim = { approval, installedByBb, path };
  claimOf.set(claim, { entry, released: false });
  return claim;
}

/**
 * Releases one claim; the last claim on an approval BB wrote removes it. If that removal fails,
 * releasing the claim again retries it without counting the claim twice.
 */
export async function releaseCursorSessionMcpServer(
  claim: CursorMcpApproval,
): Promise<void> {
  const record = claimOf.get(claim);
  if (record === undefined) {
    return;
  }
  if (!record.released) {
    record.released = true;
    record.entry.claims -= 1;
  }
  await settleApproval(claim.path, claim.approval, record.entry);
}
