import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    signals: string[];
    onSignal?: (signal: string) => void;
  };
  ee.stdin = new PassThrough();
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.written = "";
  ee.killed = false;
  ee.signals = [];
  // Ignores every signal unless a test wires `onSignal`; `pid` stays undefined
  // so the service signals through `child.kill`.
  ee.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
    ee.signals.push(signal);
    ee.onSignal?.(signal);
    return true;
  }) as ChildProcess["kill"];
  ee.stdin.on("data", (chunk: Buffer) => {
    ee.written += chunk.toString("utf8");
  });
  Object.defineProperty(ee, "pid", { value: undefined });
  return ee;
}

const AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=";
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

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

  it("keeps a URL split across chunks out of the flow until it is complete", async () => {
    const child = fakeChild();
    const svc = new AntigravityService({
      home: await tmpHome(),
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const startPromise = svc.signInStart();
    const full = `${AUTH_URL}split-state-0123456789`;
    const cut = full.indexOf("state=") + "state=spl".length;
    child.stdout.write(`Open this link:\n${full.slice(0, cut)}`);
    await tick();
    expect((await svc.status()).flow?.authorizationUrl).toBeNull();
    child.stdout.write(`${full.slice(cut)}\nPaste the code: `);
    const started = await startPromise;
    expect(started.flow?.phase).toBe("waiting");
    expect(started.flow?.authorizationUrl).toBe(full);
    // The captured state is the whole one: the matching code URL is accepted.
    const submit = svc.signInSubmit(
      started.flow!.id,
      "https://antigravity.google/oauth-callback?state=split-state-0123456789&code=c",
    );
    child.emit("close", 1);
    await submit;
    expect(child.written).toContain("state=split-state-0123456789&code=c");
    svc.dispose();
  });

  it("signInStart waits for the previous login child to exit before spawning", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const spawnLogin = vi.fn(() => children.shift()!);
    const svc = new AntigravityService({
      home: await tmpHome(),
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin,
    });
    const p1 = svc.signInStart();
    first.stdout.write(`${AUTH_URL}one\n`);
    await p1;

    let restarted = false;
    const p2 = svc.signInStart().then((status) => {
      restarted = true;
      return status;
    });
    await tick();
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    expect(restarted).toBe(false);

    first.emit("close", null);
    await tick();
    expect(spawnLogin).toHaveBeenCalledTimes(2);
    second.stdout.write(`${AUTH_URL}two\n`);
    const status = await p2;
    expect(status.flow?.authorizationUrl).toContain("state=two");
    svc.dispose();
    second.emit("close", null);
  });

  it("signInCancel and signOut wait for the child before touching the token", async () => {
    const home = await tmpHome();
    await mkdir(path.dirname(tokenFilePath(home)), { recursive: true });
    await writeFile(tokenFilePath(home), JSON.stringify({ token: { refresh_token: "old" } }));
    const child = fakeChild();
    const svc = new AntigravityService({
      home,
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}x\n`);
    const { flow } = await started;

    let cancelled = false;
    const cancel = svc.signInCancel(flow!.id).then(() => (cancelled = true));
    await tick();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(cancelled).toBe(false);
    child.emit("close", null);
    await cancel;
    expect((await svc.status()).flow).toBeNull();

    // A second flow, signed out while it is still running: the dying child
    // writes its token on the way out, and signOut removes it afterwards.
    const dying = fakeChild();
    const svc2 = new AntigravityService({
      home,
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => dying,
    });
    const started2 = svc2.signInStart();
    dying.stdout.write(`${AUTH_URL}y\n`);
    await started2;
    let signedOut = false;
    const out = svc2.signOut().then((status) => {
      signedOut = true;
      return status;
    });
    await tick();
    expect(signedOut).toBe(false);
    expect((await readFile(tokenFilePath(home), "utf8")).length).toBeGreaterThan(0);
    await writeFile(tokenFilePath(home), JSON.stringify({ token: { refresh_token: "late" } }));
    dying.emit("close", 0);
    expect((await out).signedIn).toBe(false);
    await expect(readFile(tokenFilePath(home), "utf8")).rejects.toThrow();
    svc.dispose();
    svc2.dispose();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const home = await tmpHome();
    const child = fakeChild();
    child.onSignal = (signal) => {
      if (signal === "SIGKILL") setTimeout(() => child.emit("close", null), 5);
    };
    const svc = new AntigravityService({
      home,
      killGraceMs: 30,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}z\n`);
    await started;
    const out = await svc.signOut();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(out.flow).toBeNull();
  });

  it("fails sign-out and restart while a child survives SIGKILL, then recovers once it exits", async () => {
    const home = await tmpHome();
    await mkdir(path.dirname(tokenFilePath(home)), { recursive: true });
    await writeFile(tokenFilePath(home), JSON.stringify({ token: { refresh_token: "keep" } }));
    const child = fakeChild();
    const spawnLogin = vi.fn(() => child);
    const svc = new AntigravityService({
      home,
      killGraceMs: 20,
      killWaitMs: 20,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}w\n`);
    await started;
    await expect(svc.signOut()).rejects.toThrow(/did not exit/u);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // The token is untouched and no second login was spawned; each retry
    // sends SIGKILL again.
    expect((await readFile(tokenFilePath(home), "utf8")).length).toBeGreaterThan(0);
    await expect(svc.signInStart()).rejects.toThrow(/did not exit/u);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
    expect(spawnLogin).toHaveBeenCalledTimes(1);

    child.emit("close", null);
    expect((await svc.signOut()).signedIn).toBe(false);
    svc.dispose();
  });

  it("a stale submit never terminates the login that replaced its flow", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const svc = new AntigravityService({
      home: await tmpHome(),
      killGraceMs: 5_000,
      submitWaitMs: 30,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => children.shift()!,
    });
    const p1 = svc.signInStart();
    first.stdout.write(`${AUTH_URL}one\n`);
    const { flow } = await p1;
    const submit = svc.signInSubmit(flow!.id, "4/0A-code");
    await tick();
    const restart = svc.signInStart();
    await tick();
    first.emit("close", null);
    second.stdout.write(`${AUTH_URL}two\n`);
    await restart;
    await submit;
    expect(second.signals).toEqual([]);
    expect((await svc.status()).flow?.authorizationUrl).toContain("state=two");
    svc.dispose();
    second.emit("close", null);
  });

  it("cancel retries a child that outlived the termination waits and rejects while it is still alive", async () => {
    const child = fakeChild();
    const svc = new AntigravityService({
      home: await tmpHome(),
      killGraceMs: 10,
      killWaitMs: 10,
      flowTimeoutMs: 20,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}c\n`);
    const { flow } = await started;
    // The flow times out and both termination waits expire; the child stays alive.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(svc.signInCancel(flow!.id)).rejects.toThrow(/did not exit/u);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
    child.emit("close", null);
    await svc.signInCancel(flow!.id);
    svc.dispose();
  });

  it("does not spawn a second login while sign-out is still deleting the token", async () => {
    const home = await tmpHome();
    await mkdir(path.dirname(tokenFilePath(home)), { recursive: true });
    await writeFile(tokenFilePath(home), JSON.stringify({ token: { refresh_token: "old" } }));
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const spawnLogin = vi.fn(() => children.shift()!);
    const svc = new AntigravityService({
      home,
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin,
    });
    const started = svc.signInStart();
    first.stdout.write(`${AUTH_URL}one\n`);
    await started;

    const out = svc.signOut();
    const restart = svc.signInStart();
    await tick();
    first.emit("close", null);
    await out;
    // The restart runs only after sign-out completed, so its token survives.
    await writeFile(tokenFilePath(home), JSON.stringify({ token: { refresh_token: "new" } }));
    second.stdout.write(`${AUTH_URL}two\n`);
    const status = await restart;
    expect(spawnLogin).toHaveBeenCalledTimes(2);
    expect(status.signedIn).toBe(true);
    svc.dispose();
    second.emit("close", null);
  });

  it("a pending signOut does not delete a replacement service's token after dispose", async () => {
    const home = await tmpHome();
    const child = fakeChild();
    const svc = new AntigravityService({
      home,
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}a\n`);
    await started;
    const out = svc.signOut().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await tick();
    svc.dispose();
    // The replacement service saves credentials before the old child exits.
    await mkdir(path.dirname(tokenFilePath(home)), { recursive: true });
    await writeFile(tokenFilePath(home), JSON.stringify({ token: { refresh_token: "new" } }));
    child.emit("close", null);
    expect(await out).toMatch(/shutting down/u);
    expect(await readFile(tokenFilePath(home), "utf8")).toContain("new");
  });

  it("does not spawn a pending restart after dispose", async () => {
    const first = fakeChild();
    const spawnLogin = vi.fn(() => first);
    const svc = new AntigravityService({
      home: await tmpHome(),
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin,
    });
    const started = svc.signInStart();
    first.stdout.write(`${AUTH_URL}a\n`);
    await started;
    const restart = svc.signInStart();
    const settled = restart.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await tick();
    svc.dispose();
    first.emit("close", null);
    expect(await settled).toMatch(/shutting down/u);
    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  it("cancel joins a shutdown already started by the flow timeout", async () => {
    const child = fakeChild();
    const svc = new AntigravityService({
      home: await tmpHome(),
      flowTimeoutMs: 20,
      killGraceMs: 5_000,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}t\n`);
    const { flow } = await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(child.signals).toEqual(["SIGTERM"]);

    let cancelled = false;
    const cancel = svc.signInCancel(flow!.id).then(() => (cancelled = true));
    await tick();
    expect(cancelled).toBe(false);
    child.emit("close", null);
    await cancel;
    expect(cancelled).toBe(true);
  });

  it("does not accept a URL cut on stdout because stderr printed a newline", async () => {
    const child = fakeChild();
    const svc = new AntigravityService({
      home: await tmpHome(),
      killGraceMs: 5,
      killWaitMs: 5,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}trunc`);
    child.stderr.write("warming up\n");
    await tick();
    child.stdout.write("ated\n");
    const status = await started;
    expect(status.flow?.authorizationUrl).toContain("state=truncated");
    svc.dispose();
    child.emit("close", null);
  });

  it("dispose terminates the child, escalates, and leaves no live timer behind", async () => {
    const child = fakeChild();
    const svc = new AntigravityService({
      home: await tmpHome(),
      killGraceMs: 20,
      resolveAgy: async () => "/usr/bin/agy",
      spawnLogin: () => child,
    });
    const started = svc.signInStart();
    child.stdout.write(`${AUTH_URL}d\n`);
    await started;
    expect(() => svc.dispose()).not.toThrow();
    expect(() => svc.dispose()).not.toThrow();
    expect(child.signals).toEqual(["SIGTERM"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect((await svc.status()).flow).toBeNull();
  });
});
