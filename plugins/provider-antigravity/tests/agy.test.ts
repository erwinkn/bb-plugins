import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AntigravityService,
  accountFromTokenText,
  loginResponse,
  parseAuthorizationUrl,
  tokenFilePath,
  usageWindowsFromAnswer,
} from "../src/agy.js";

function fakeChild() {
  const ee = new EventEmitter() as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    written: string;
    killed: boolean;
  };
  ee.stdin = new PassThrough();
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.written = "";
  ee.killed = false;
  ee.stdin.on("data", (chunk: Buffer) => {
    ee.written += chunk.toString("utf8");
  });
  Object.defineProperty(ee, "pid", { value: undefined });
  return ee;
}

const dirs: string[] = [];
async function tmpHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("account and parsing", () => {
  it("reads account email and credential hash from token JSON", () => {
    const valid = accountFromTokenText(
      JSON.stringify({
        token: { refresh_token: "rt-123" },
        id_token_email: "erwin@example.com",
      }),
    );
    expect(valid.signedIn).toBe(true);
    expect(valid.email).toBe("erwin@example.com");
    expect(valid.credential).toHaveLength(16);
    expect(accountFromTokenText("{bad")).toEqual({ signedIn: false, email: null, credential: null });
    expect(accountFromTokenText(JSON.stringify({ token: {} }))).toEqual({
      signedIn: false,
      email: null,
      credential: null,
    });
  });

  it("extracts Google OAuth URL and validates pasted code or callback URL", () => {
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=abc123";
    expect(parseAuthorizationUrl(`Open:\n${url}\nPaste code:`)).toEqual({ url, state: "abc123" });
    expect(parseAuthorizationUrl("https://example.com/?state=abc")).toBeNull();

    expect(loginResponse("abc123", "4/0A-code_123")).toBe("4/0A-code_123");
    expect(loginResponse("abc123", "https://antigravity.google/oauth-callback?state=abc123&code=xyz")).toBe(
      "https://antigravity.google/oauth-callback?state=abc123&code=xyz",
    );
    expect(loginResponse("abc123", "https://antigravity.google/oauth-callback?state=wrong&code=xyz")).toBeNull();
    expect(loginResponse("abc123", "code\nsecond-line")).toBeNull();
  });

  it("parses agy /usage JSON windows with 5h before 7d", () => {
    const windows = usageWindowsFromAnswer({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "w", window: "weekly", remaining_fraction: 0.75, reset_time: "2026-11-27T14:00:00Z" },
                { id: "h", window: "5h", remaining_fraction: 0.9, reset_time: "2026-11-20T19:00:00Z" },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [{ id: "3p", window: "5h", remaining_fraction: 1, reset_time: "2026-11-20T23:00:00Z" }],
            },
          ],
        },
      },
    });
    expect(windows).toEqual([
      { label: "Gemini 5h", usedPercent: expect.closeTo(10, 5), resetsAt: "2026-11-20T19:00:00.000Z" },
      { label: "Gemini 7d", usedPercent: expect.closeTo(25, 5), resetsAt: "2026-11-27T14:00:00.000Z" },
      { label: "Claude & GPT 5h", usedPercent: 0, resetsAt: null },
    ]);
  });
});

describe("AntigravityService", () => {
  it("runs sign-in happy path, caches usage per credential, and signs out", async () => {
    const home = await tmpHome();
    let now = 1_000_000;
    const child = fakeChild();
    const runUsage = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: { groups: [{ name: "Gemini Models", buckets: [{ id: "h", window: "5h", remaining_fraction: 0.8 }] }] },
        },
      }),
    }));

    const svc = new AntigravityService({
      home,
      now: () => now,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
      runUsage,
    });

    const startPromise = svc.signInStart();
    child.stdout.write(
      "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=st1\n",
    );
    const started = await startPromise;
    expect(started.flow?.phase).toBe("waiting");
    expect(started.flow?.authorizationUrl).toContain("state=st1");

    const submitPromise = svc.signInSubmit(started.flow!.id, "my-auth-code");
    await mkdir(path.dirname(tokenFilePath(home)), { recursive: true });
    await writeFile(
      tokenFilePath(home),
      JSON.stringify({ token: { refresh_token: "tok-1" }, id_token_email: "a@b.com" }),
    );
    child.emit("close", 0);
    const done = await submitPromise;
    expect(done.signedIn).toBe(true);
    expect(done.email).toBe("a@b.com");
    expect(done.flow?.phase).toBe("succeeded");
    expect(child.written).toBe("my-auth-code\n");

    const u1 = await svc.usage();
    const u2 = await svc.usage();
    expect(u1.status).toBe("ok");
    expect(u2).toEqual(u1);
    expect(runUsage).toHaveBeenCalledTimes(1);

    // Force refresh bypasses cache.
    now += 1_000;
    await svc.usage(true);
    expect(runUsage).toHaveBeenCalledTimes(2);

    const out = await svc.signOut();
    expect(out.signedIn).toBe(false);
    expect(await svc.usage()).toEqual({ status: "unauthenticated" });
    svc.dispose();
  });

  it("times out an unanswered sign-in flow", async () => {
    const home = await tmpHome();
    const child = fakeChild();
    const svc = new AntigravityService({
      home,
      flowTimeoutMs: 40,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const startPromise = svc.signInStart();
    child.stdout.write(
      "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=st2\n",
    );
    await startPromise;
    await new Promise((r) => setTimeout(r, 80));
    const status = await svc.status();
    expect(status.flow?.active).toBe(false);
    expect(status.flow?.phase).toBe("failed");
    expect(status.flow?.message).toMatch(/timed out/i);
    svc.dispose();
  });
});
