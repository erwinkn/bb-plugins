import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { providerUsageResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { z } from "zod";
import { AntigravityService } from "../src/agy.js";
import { bridgeUsage, withAntigravityUsage } from "../src/bridge.js";
import { PROVIDER_ID, type UsageState } from "../src/contract.js";

// Mirrors `providerUsageSchema` in plugins/provider-usage-compact/usage-schema.ts
// (strict objects, non-empty strings, `cost` on windows): what the usage popup
// accepts from `bb.sdk.system.usageLimits`.
const nonempty = z.string().min(1);
const providerUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    accountEmail: nonempty.nullable(),
    planLabel: nonempty.nullable(),
    windows: z.array(
      z.strictObject({
        label: nonempty,
        usedPercent: z.number(),
        resetsAt: nonempty.nullable(),
        cost: z.null(),
      }),
    ),
  }),
  z.strictObject({ status: z.literal("not_installed") }),
  z.strictObject({ status: z.literal("unauthenticated") }),
  z.strictObject({ status: z.literal("expired") }),
  z.strictObject({ status: z.literal("error"), message: nonempty }),
]);

const FETCHED_AT = "2026-11-20T00:00:00.000Z";

function harness(usage: () => Promise<UsageState>, raise: (signal: NodeJS.Signals) => void = vi.fn()) {
  const written: Record<string, unknown>[] = [];
  const handled: string[] = [];
  const hooks = { start: vi.fn(), onClose: vi.fn(), onSigterm: vi.fn(), onSigint: vi.fn() };
  const inner = {
    experimental_apiVersion: 1,
    handleLine: (line: string) => void handled.push(line),
    ...hooks,
  } as ProviderBridgeEntry;
  const service = { usage: vi.fn(usage), dispose: vi.fn() };
  const bridge = withAntigravityUsage(inner, service, (line) => void written.push(JSON.parse(line)), raise);
  const request = (params: unknown = { providerId: PROVIDER_ID }, id: string | number = 7) =>
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method: "provider/usage", params }));
  const answer = async () => {
    await vi.waitFor(() => expect(written).toHaveLength(1));
    return written[0] as { id: unknown; result?: unknown; error?: { code: number; message: string } };
  };
  return { bridge, inner, hooks, service, written, handled, request, answer };
}

async function resultFor(state: UsageState) {
  const h = harness(async () => state);
  h.request();
  const { id, result } = await h.answer();
  expect(id).toBe(7);
  const parsed = providerUsageResultSchema.safeParse(result);
  expect(parsed.success).toBe(true);
  return result as { supported: true; usage: Record<string, unknown> & { status: string } };
}

describe("provider/usage", () => {
  it("answers ok with windows, the account email and no plan", async () => {
    const result = await resultFor({
      status: "ok",
      accountEmail: "dev@example.com",
      fetchedAt: FETCHED_AT,
      windows: [
        { label: "Gemini 5h", usedPercent: 25, resetsAt: "2026-11-20T05:00:00.000Z" },
        { label: "Gemini 7d", usedPercent: 0, resetsAt: null },
      ],
    });
    expect(result).toEqual({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: "dev@example.com",
        planLabel: null,
        windows: [
          { label: "Gemini 5h", usedPercent: 25, resetsAt: "2026-11-20T05:00:00.000Z" },
          { label: "Gemini 7d", usedPercent: 0, resetsAt: null },
        ],
      },
    });
    expect(providerUsageSchema.safeParse(
      { ...result.usage, windows: (result.usage.windows as object[]).map((w) => ({ ...w, cost: null })) },
    ).success).toBe(true);
  });

  it("nulls an email that is not one and drops or clamps unusable windows", async () => {
    const result = await resultFor({
      status: "ok",
      accountEmail: "not-an-email",
      fetchedAt: FETCHED_AT,
      windows: [
        { label: "  ", usedPercent: 10, resetsAt: null },
        { label: "NaN", usedPercent: Number.NaN, resetsAt: null },
        { label: "Inf", usedPercent: Number.POSITIVE_INFINITY, resetsAt: null },
        { label: "Over", usedPercent: 140, resetsAt: "" },
        { label: "Under", usedPercent: -3, resetsAt: null },
      ],
    });
    expect(result.usage).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        { label: "Over", usedPercent: 100, resetsAt: null },
        { label: "Under", usedPercent: 0, resetsAt: null },
      ],
    });
  });

  it("passes the account email through as null when there is none", () => {
    expect(bridgeUsage({ status: "ok", accountEmail: null, fetchedAt: FETCHED_AT, windows: [] })).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [],
    });
  });

  it.each(["not_installed", "unauthenticated", "expired"] as const)("answers %s", async (status) => {
    const result = await resultFor({ status });
    expect(result).toEqual({ supported: true, usage: { status } });
    expect(providerUsageSchema.safeParse(result.usage).success).toBe(true);
  });

  it("answers error with its message, and a default when it is blank", async () => {
    const failed = await resultFor({ status: "error", message: "agy broke" });
    expect(failed.usage).toEqual({ status: "error", message: "agy broke", planLabel: null, accountEmail: null });
    const blank = await resultFor({ status: "error", message: "  " });
    expect(blank.usage).toEqual({ status: "error", message: "Unknown error", planLabel: null, accountEmail: null });
    expect(providerUsageSchema.safeParse({ status: "error", message: "Unknown error" }).success).toBe(true);
  });

  it("answers a throwing service as an error result instead of crashing", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    h.request();
    const { result } = await h.answer();
    expect(result).toEqual({
      supported: true,
      usage: { status: "error", message: "boom", planLabel: null, accountEmail: null },
    });
    expect(providerUsageResultSchema.safeParse(result).success).toBe(true);
  });

  it("does not block other lines while usage is running", async () => {
    let finish: (state: UsageState) => void = () => undefined;
    const h = harness(() => new Promise<UsageState>((resolve) => (finish = resolve)));
    h.request();
    h.bridge.handleLine('{"jsonrpc":"2.0","id":8,"method":"thread/start","params":{}}');
    expect(h.handled).toEqual(['{"jsonrpc":"2.0","id":8,"method":"thread/start","params":{}}']);
    expect(h.written).toEqual([]);
    finish({ status: "expired" });
    const { result } = await h.answer();
    expect(result).toEqual({ supported: true, usage: { status: "expired" } });
  });

  it("keeps the request id, string or number", async () => {
    const h = harness(async () => ({ status: "expired" }));
    h.request({ providerId: PROVIDER_ID }, "req-1");
    expect((await h.answer()).id).toBe("req-1");
  });

  it("answers unsupported for another provider without running agy", async () => {
    const h = harness(async () => ({ status: "expired" }));
    h.request({ providerId: "acp-other" });
    expect((await h.answer()).result).toEqual({ supported: false });
    expect(h.service.usage).not.toHaveBeenCalled();
  });

  it("rejects missing params with an invalid-params error", async () => {
    const h = harness(async () => ({ status: "expired" }));
    h.request({});
    const { error } = await h.answer();
    expect(error?.code).toBe(-32602);
    expect(h.service.usage).not.toHaveBeenCalled();
  });
});

describe("pass-through", () => {
  it("forwards every other line, including ones that are not JSON-RPC requests", () => {
    const h = harness(async () => ({ status: "expired" }));
    const lines = [
      '{"jsonrpc":"2.0","id":1,"method":"provider/health","params":{"providerId":"acp-antigravity"}}',
      '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}',
      '{"jsonrpc":"2.0","method":"provider/usage"}',
      '{"jsonrpc":"2.0","id":3,"result":{}}',
      "not json",
      "",
    ];
    for (const line of lines) h.bridge.handleLine(line);
    expect(h.handled).toEqual(lines);
    expect(h.written).toEqual([]);
    expect(h.service.usage).not.toHaveBeenCalled();
  });

  it("passes the start context to the inner bridge", () => {
    const h = harness(async () => ({ status: "expired" }));
    const context = { pluginId: "provider-antigravity", dataDir: "/d", tempDir: "/t" };
    h.bridge.start?.(context);
    expect(h.hooks.start).toHaveBeenCalledWith(context);
  });

  it.each(["onClose", "onSigterm", "onSigint"] as const)("disposes the service, then runs %s", (hook) => {
    const h = harness(async () => ({ status: "expired" }));
    const order: string[] = [];
    h.service.dispose.mockImplementation(() => void order.push("dispose"));
    h.hooks[hook].mockImplementation(() => void order.push(hook));
    h.bridge[hook]?.();
    expect(order).toEqual(["dispose", hook]);
  });

  it("still runs the inner hook when dispose throws", () => {
    const h = harness(async () => ({ status: "expired" }));
    h.service.dispose.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    expect(() => h.bridge.onClose?.()).toThrow("dispose failed");
    expect(h.hooks.onClose).toHaveBeenCalledOnce();
  });
});

describe("signals", () => {
  it.each([
    ["onSigterm", "SIGTERM"],
    ["onSigint", "SIGINT"],
  ] as const)("disposes, then re-raises %s when the inner bridge has no hook", (hook, signal) => {
    const raise = vi.fn();
    const service = { usage: vi.fn(), dispose: vi.fn() };
    const inner = { experimental_apiVersion: 1, handleLine: vi.fn() } as ProviderBridgeEntry;
    const bridge = withAntigravityUsage(inner, service, undefined, raise);
    bridge[hook]?.();
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(raise).toHaveBeenCalledExactlyOnceWith(signal);
  });

  it("leaves termination to an inner hook that has one", () => {
    const raise = vi.fn();
    const h = harness(async () => ({ status: "expired" }), raise);
    h.bridge.onSigterm?.();
    expect(h.hooks.onSigterm).toHaveBeenCalledOnce();
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("shutdown (real processes)", () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agy-bridge-test-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("terminates the process on SIGTERM the way the SDK worker installs the hooks", async () => {
    const dir = await tmp();
    const source = `import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { withAntigravityUsage } from ${JSON.stringify(path.resolve("src/bridge.ts"))};
const inner = experimental_defineProviderBridge({ handleLine() {} });
const bridge = withAntigravityUsage(inner, { usage: async () => ({ status: "expired" }), dispose() { console.log("disposed"); } });
// Same wiring as the SDK's worker entry.
process.once("SIGTERM", bridge.onSigterm);
process.once("SIGINT", bridge.onSigint);
console.log("ready");
setInterval(() => {}, 1000);
`;
    const out = path.join(dir, "entry.mjs");
    await build({
      stdin: { contents: source, resolveDir: path.resolve("."), loader: "ts" },
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      absWorkingDir: path.resolve("."),
      logLevel: "silent",
    });
    const child = spawn(process.execPath, [out], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    try {
      await vi.waitFor(() => expect(stdout).toContain("ready"), { timeout: 10_000 });
      child.kill("SIGTERM");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(exit.signal).toBe("SIGTERM");
      expect(stdout).toContain("disposed");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  it("kills a usage probe still running when the service is disposed", async () => {
    const dir = await tmp();
    const pidFile = path.join(dir, "pid");
    const agy = path.join(dir, "agy");
    await writeFile(agy, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 60\n`, { mode: 0o755 });
    const tokenDir = path.join(dir, ".gemini", "antigravity-cli");
    await mkdir(tokenDir, { recursive: true });
    await writeFile(
      path.join(tokenDir, "antigravity-oauth-token"),
      JSON.stringify({ token: { refresh_token: "r" }, id_token_email: "a@b.co" }),
    );
    const service = new AntigravityService({ home: dir, resolveAgy: async () => agy });
    const pending = service.usage();
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(pid).toBeGreaterThan(0);
    });
    expect(alive(pid)).toBe(true);
    service.dispose();
    await expect(pending).rejects.toThrow("shutting down");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  }, 30_000);

  it("does not launch a probe once disposed, even mid-setup", async () => {
    const dir = await tmp();
    const spawned = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tokenDir = path.join(dir, ".gemini", "antigravity-cli");
    await mkdir(tokenDir, { recursive: true });
    await writeFile(path.join(tokenDir, "antigravity-oauth-token"), JSON.stringify({ token: { refresh_token: "r" } }));
    const service = new AntigravityService({
      home: dir,
      resolveAgy: async () => {
        await gate;
        return "/usr/bin/agy";
      },
      runUsage: async () => {
        spawned();
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const pending = service.usage();
    service.dispose();
    release();
    await expect(pending).rejects.toThrow("shutting down");
    expect(spawned).not.toHaveBeenCalled();
  });
});
