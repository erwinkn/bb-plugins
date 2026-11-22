import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveCursorSessionMcpServer,
  buildCursorMcpApprovalIdentifier,
  releaseCursorSessionMcpServer,
} from "./cursor-mcp-approval.js";
import type { AcpMcpServerConfig } from "./tool-proxy-mcp.js";

// Fails the next `rename` calls, as a full or read-only disk would fail the approval file's write.
const fsFaults = vi.hoisted(() => ({ failRenames: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFaults.failRenames > 0) {
        fsFaults.failRenames -= 1;
        throw Object.assign(new Error("EACCES: permission denied, rename"), {
          code: "EACCES",
        });
      }
      return actual.rename(...args);
    },
  };
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function mcpConfig(threadId = "thread-1"): AcpMcpServerConfig {
  return {
    name: "bb-bridge",
    command: "/usr/local/bin/node",
    args: ["/app/bridge.js", "--mcp-stdio"],
    env: [
      { name: "BB_TOKEN", value: "secret" },
      { name: "BB_THREAD", value: threadId },
    ],
  };
}

function readStored(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function tick(ms: number): Promise<void> {
  await new Promise((resolveTick) => setTimeout(resolveTick, ms));
}

/**
 * Two claims on one approval that both wait on the file's lock, as a turn that gave up on its
 * claim and the session that replaced it do. Returns them installer first.
 */
async function overlappingClaims() {
  const cursorDataDir = makeTempDir("bb-cursor-data-");
  const workspace = makeTempDir("bb-cursor-workspace-");
  const approve = () =>
    approveCursorSessionMcpServer({
      agentCommand: "cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env: { CURSOR_DATA_DIR: cursorDataDir },
    });
  const probe = await approve();
  if (!probe) {
    throw new Error("Cursor approval was not installed");
  }
  await releaseCursorSessionMcpServer(probe);
  const lock = `${probe.path}.bb-lock`;
  mkdirSync(lock);
  const claims = [approve(), approve()];
  await tick(150);
  rmSync(lock, { recursive: true, force: true });
  const [first, second] = await Promise.all(claims);
  if (!first || !second) {
    throw new Error("Cursor approval was not claimed");
  }
  expect([first.installedByBb, second.installedByBb].sort()).toEqual([
    false,
    true,
  ]);
  const installer = first.installedByBb ? first : second;
  const adopter = first.installedByBb ? second : first;
  expect(readStored(probe.path)).toEqual([probe.approval]);
  return { installer, adopter, approve, lock, path: probe.path };
}

function cursorApprover() {
  const cursorDataDir = makeTempDir("bb-cursor-data-");
  const workspace = makeTempDir("bb-cursor-workspace-");
  return async () => {
    const claim = await approveCursorSessionMcpServer({
      agentCommand: "cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env: { CURSOR_DATA_DIR: cursorDataDir },
    });
    if (!claim) {
      throw new Error("Cursor approval was not claimed");
    }
    return claim;
  };
}

afterEach(() => {
  fsFaults.failRenames = 0;
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Cursor ACP session MCP approvals", () => {
  it("matches Cursor's approval fingerprint for a normalized stdio server", () => {
    expect(
      buildCursorMcpApprovalIdentifier({
        config: mcpConfig(),
        projectRoot: "/workspace/project",
      }),
    ).toBe("bb-bridge-d4709a3db84ddb48");
  });

  it("does not touch Cursor data for other ACP agents", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");

    await expect(
      approveCursorSessionMcpServer({
        agentCommand: "opencode",
        config: mcpConfig(),
        cwd: workspace,
        env: { CURSOR_DATA_DIR: cursorDataDir },
      }),
    ).resolves.toBeUndefined();
    expect(() => readFileSync(join(cursorDataDir, "projects"))).toThrow();
  });

  it("preserves unrelated approvals and removes its session approval on release", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");
    const env = { CURSOR_DATA_DIR: cursorDataDir };
    const first = await approveCursorSessionMcpServer({
      agentCommand: "/opt/cursor/cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env,
    });
    if (!first) {
      throw new Error("Cursor approval was not installed");
    }
    await releaseCursorSessionMcpServer(first);
    writeFileSync(first.path, '["user-approved-server"]\n', "utf8");

    const approvals = await Promise.all([
      approveCursorSessionMcpServer({
        agentCommand: "cursor-agent",
        config: mcpConfig("thread-a"),
        cwd: workspace,
        env,
      }),
      approveCursorSessionMcpServer({
        agentCommand: "cursor-agent.exe",
        config: mcpConfig("thread-b"),
        cwd: workspace,
        env,
      }),
    ]);
    expect(approvals.every(Boolean)).toBe(true);
    const installed = approvals.flatMap((approval) =>
      approval ? [approval] : [],
    );
    const stored = JSON.parse(readFileSync(first.path, "utf8")) as string[];
    expect(stored[0]).toBe("user-approved-server");
    expect(stored.slice(1).sort()).toEqual(
      installed.map((approval) => approval.approval).sort(),
    );

    await Promise.all(installed.map(releaseCursorSessionMcpServer));
    expect(JSON.parse(readFileSync(first.path, "utf8")) as unknown).toEqual([
      "user-approved-server",
    ]);
    expect(() => readFileSync(`${first.path}.bb-lock`)).toThrow();
  });

  it("does not remove an approval Cursor already had", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");
    const env = { CURSOR_DATA_DIR: cursorDataDir };
    const installed = await approveCursorSessionMcpServer({
      agentCommand: "cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env,
    });
    if (!installed) {
      throw new Error("Cursor approval was not installed");
    }
    await releaseCursorSessionMcpServer(installed);
    writeFileSync(installed.path, JSON.stringify([installed.approval]), "utf8");

    const existing = await approveCursorSessionMcpServer({
      agentCommand: "cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env,
    });
    expect(existing?.installedByBb).toBe(false);
    if (existing) {
      await releaseCursorSessionMcpServer(existing);
    }
    expect(JSON.parse(readFileSync(installed.path, "utf8")) as unknown).toEqual(
      [installed.approval],
    );
  });

  it("keeps an approval its writer released while another claim holds it", async () => {
    // The turn that gave up wrote the approval; the replacement found it written.
    const { installer, adopter, path } = await overlappingClaims();
    await releaseCursorSessionMcpServer(installer);
    expect(readStored(path)).toEqual([installer.approval]);
    await releaseCursorSessionMcpServer(adopter);
    expect(readStored(path)).toEqual([]);
  });

  it("removes an approval BB wrote with its last claim, whichever wrote it", async () => {
    const { installer, adopter, path } = await overlappingClaims();
    await releaseCursorSessionMcpServer(adopter);
    expect(readStored(path)).toEqual([installer.approval]);
    await releaseCursorSessionMcpServer(installer);
    expect(readStored(path)).toEqual([]);
    // A second release of one claim changes nothing.
    writeFileSync(path, JSON.stringify([installer.approval]), "utf8");
    await releaseCursorSessionMcpServer(installer);
    expect(readStored(path)).toEqual([installer.approval]);
  });

  it("keeps an approval when its last release races a new claim", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");
    const approve = () =>
      approveCursorSessionMcpServer({
        agentCommand: "cursor-agent",
        config: mcpConfig(),
        cwd: workspace,
        env: { CURSOR_DATA_DIR: cursorDataDir },
      });
    // The release and the new claim both wait on the lock and poll it; staggering their start
    // lets either take it first. Whichever does, the approval stays for the new claim.
    for (const stagger of [0, 5, 10, 15, 20, 25, 30, 40]) {
      const held = await approve();
      if (!held?.installedByBb) {
        throw new Error("Cursor approval was not installed");
      }
      const lock = `${held.path}.bb-lock`;
      mkdirSync(lock);
      const releasing = releaseCursorSessionMcpServer(held);
      await tick(stagger);
      const claiming = approve();
      await tick(100);
      rmSync(lock, { recursive: true, force: true });
      const [, next] = await Promise.all([releasing, claiming]);
      expect(readStored(held.path), `stagger ${stagger} ms`).toEqual([
        held.approval,
      ]);
      if (!next) {
        throw new Error("Cursor approval was not claimed");
      }
      await releaseCursorSessionMcpServer(next);
      expect(readStored(held.path)).toEqual([]);
    }
  });
  it("retries removing its approval when the removal write failed", async () => {
    const approve = cursorApprover();
    const claim = await approve();
    expect(claim.installedByBb).toBe(true);
    fsFaults.failRenames = 1;
    await expect(releaseCursorSessionMcpServer(claim)).rejects.toThrow(
      "EACCES",
    );
    expect(readStored(claim.path)).toEqual([claim.approval]);
    await releaseCursorSessionMcpServer(claim);
    expect(readStored(claim.path)).toEqual([]);
    // Settled: another release of the claim changes nothing.
    writeFileSync(claim.path, JSON.stringify([claim.approval]), "utf8");
    await releaseCursorSessionMcpServer(claim);
    expect(readStored(claim.path)).toEqual([claim.approval]);
  });

  it("hands a failed removal to the next claim on the approval", async () => {
    const approve = cursorApprover();
    const claim = await approve();
    fsFaults.failRenames = 1;
    await expect(releaseCursorSessionMcpServer(claim)).rejects.toThrow(
      "EACCES",
    );
    // The replacement finds BB's approval still written: BB still owns it.
    const replacement = await approve();
    expect(replacement.installedByBb).toBe(false);
    await releaseCursorSessionMcpServer(replacement);
    expect(readStored(claim.path)).toEqual([]);
    // The failed claim, released again later, does not count twice.
    const next = await approve();
    await releaseCursorSessionMcpServer(claim);
    expect(readStored(claim.path)).toEqual([claim.approval]);
    await releaseCursorSessionMcpServer(next);
    expect(readStored(claim.path)).toEqual([]);
  });

  it("keeps BB's ownership when the file lock times out on release", async () => {
    const approve = cursorApprover();
    const claim = await approve();
    const lock = `${claim.path}.bb-lock`;
    mkdirSync(lock);
    await expect(releaseCursorSessionMcpServer(claim)).rejects.toThrow(
      "Timed out updating Cursor MCP approvals",
    );
    rmSync(lock, { recursive: true, force: true });
    expect(readStored(claim.path)).toEqual([claim.approval]);
    const replacement = await approve();
    await releaseCursorSessionMcpServer(replacement);
    expect(readStored(claim.path)).toEqual([]);
  }, 15_000);

  it("does not own an approval whose write failed", async () => {
    const approve = cursorApprover();
    const probe = await approve();
    await releaseCursorSessionMcpServer(probe);
    // A session holds the user's approval; the user then withdraws it.
    writeFileSync(probe.path, JSON.stringify([probe.approval]), "utf8");
    const held = await approve();
    expect(held.installedByBb).toBe(false);
    writeFileSync(probe.path, "[]", "utf8");
    // A second session's write of the approval fails.
    fsFaults.failRenames = 1;
    await expect(approve()).rejects.toThrow("EACCES");
    expect(readStored(probe.path)).toEqual([]);
    // The user approves the server again: it is still theirs when the session ends.
    writeFileSync(probe.path, JSON.stringify([probe.approval]), "utf8");
    await releaseCursorSessionMcpServer(held);
    expect(readStored(probe.path)).toEqual([probe.approval]);
  });
});
