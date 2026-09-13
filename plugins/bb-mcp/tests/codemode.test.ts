import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isReadPath, makeDispatch, runCode, sdkCall, SDK_PATHS } from "../codemode";
import { ToolError } from "../config";
import { SDK_VERSION, SIGNAL_PATHS } from "../sdk-api";
import { parseSdk, render } from "../scripts/generate-sdk-api.mjs";
import type { Store } from "../store";

const paths = ["projects.list", "threads.get", "threads.interactions.list", "missing.method", "threads.list", "threads.spawn", "ops.run", "ops.get"];

const sdk = {
  projects: { list: async () => [{ id: "a" }, { id: "b" }] },
  threads: { get: async (args: { threadId?: string }) => ({ id: args.threadId }), interactions: { list: async () => [1, 2] } },
};

const storeStub = {
  get: () => undefined,
  run: async (input: { kind: string; threadId?: string | null }, _k: unknown, _p: unknown, dispatch: (op: { id: string }) => Promise<Record<string, unknown>>) => {
    const response = await dispatch({ id: "op_1" });
    return { id: "op_1", kind: input.kind, call: (input as { call?: string }).call, projectId: null, hostId: null, threadId: typeof response.threadId === "string" ? response.threadId : input.threadId ?? null, state: "accepted" as const, createdAt: 1, updatedAt: 1, response };
  },
} as unknown as Store;

const dispatch = makeDispatch(sdk, storeStub, () => {});

describe("runCode", () => {
  it("composes nested SDK calls and returns only the final result", async () => {
    const seen: string[] = [];
    const out = await runCode({
      code: `async () => {
        const p = await bb.projects.list();
        const t = await bb.threads.get({ threadId: "thr_x" });
        const i = await bb.threads.interactions.list({ threadId: t.id });
        return p.length + i.length;
      }`,
      paths,
      dispatch: async (n, a) => { seen.push(n); return dispatch(n, a); },
    });
    expect(out.result).toBe(4);
    expect(seen).toEqual(["projects.list", "threads.get", "threads.interactions.list"]);
  });
  it("accepts a bare function body", async () => {
    const out = await runCode({ code: `const p = await bb.projects.list();\nreturn p.map(x => x.id);`, paths, dispatch });
    expect(out.result).toEqual(["a", "b"]);
  });
  it("propagates call error codes into the sandbox", async () => {
    const out = await runCode({
      code: `async () => { try { await bb.missing.method(); } catch (e) { return e.code + ":" + e.message; } }`,
      paths, dispatch,
    });
    expect(out.result).toBe("not_found:Unknown BB method \"missing.method\".");
  });
  it("rejects sandboxed errors as execution failures", async () => {
    await expect(runCode({ code: `async () => { await bb.threads.nope({}); }`, paths, dispatch }))
      .rejects.toMatchObject({ code: "execution_failed" });
  });
  it("returns the value of expression-shaped code", async () => {
    const out = await runCode({ code: `42`, paths, dispatch });
    expect(out.result).toBe(42);
  });
  it("recognizes functions behind comments, directives and bare arrows", async () => {
    for (const [code, want] of [
      [`// explain\nasync () => 7`, 7],
      [`/* doc */\nasync () => 8`, 8],
      [`"use strict";\nasync () => 9`, 9],
      [`  \n\nasync () => 10`, 10],
      [`x => 11`, 11],
    ] as const) {
      const out = await runCode({ code, paths, dispatch });
      expect(out.result).toBe(want);
    }
  });
  it("accepts an async IIFE and awaits its value", async () => {
    const out = await runCode({ code: `(async () => 12)()`, paths, dispatch });
    expect(out.result).toBe(12);
  });
  it("runs a synchronous IIFE exactly once", async () => {
    const d = vi.fn(async () => ({}));
    const out = await runCode({ code: `(() => { bb.projects.list(); })()`, paths, dispatch: d });
    expect(out.result).toBeNull();
    expect(d).toHaveBeenCalledTimes(1);
  });
  it("runs a bare call expression exactly once and returns its value", async () => {
    const d = vi.fn(async (n: string, a: unknown) => dispatch(n, a));
    const out = await runCode({ code: `bb.projects.list()`, paths, dispatch: d });
    expect(out.result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(d).toHaveBeenCalledTimes(1);
  });
  it("terminates the worker when the request aborts", async () => {
    const ac = new AbortController();
    const started = runCode({ code: `async () => { await new Promise(r => setTimeout(r, 60000)); }`, paths, dispatch, signal: ac.signal });
    ac.abort();
    await expect(started).rejects.toMatchObject({ code: "execution_aborted" });
  });
  it("rejects a request cancelled while it waits for a worker slot", async () => {
    const slow = { code: `async () => { await new Promise(r => setTimeout(r, 400)); return 1; }`, paths, dispatch };
    const running = Array.from({ length: 8 }, () => runCode(slow));
    const ac = new AbortController();
    const queued = runCode({ ...slow, signal: ac.signal });
    ac.abort();
    await expect(queued).rejects.toMatchObject({ code: "execution_aborted" });
    await Promise.all(running);
  });
  it("rejects an already-aborted request without waiting for a slot", async () => {
    const slow = { code: `async () => { await new Promise(r => setTimeout(r, 400)); return 1; }`, paths, dispatch };
    const running = Array.from({ length: 8 }, () => runCode(slow));
    const ac = new AbortController(); ac.abort();
    const queued = runCode({ ...slow, signal: ac.signal });
    const verdict = await Promise.race([queued.then(() => "resolved", () => "aborted"), new Promise(r => setTimeout(() => r("still waiting"), 250))]);
    expect(verdict).toBe("aborted");
    await Promise.all(running);
  });
  it("kills runaway code at the timeout", async () => {
    await expect(runCode({ code: `async () => { while (true) {} }`, paths, dispatch, timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "execution_timeout" });
  });
  it("captures console output and provides setTimeout", async () => {
    const out = await runCode({
      code: `async () => { console.log("hello", { a: 1 }); await new Promise(r => setTimeout(r, 10)); return "done"; }`,
      paths, dispatch,
    });
    expect(out.result).toBe("done");
    expect(out.logs).toEqual(['hello {"a":1}']);
  });
});

describe("sdkCall", () => {
  it("resolves nested paths and injects signal only where the SDK declares it", async () => {
    const signal = new AbortController().signal;
    const wait = vi.fn(async (args: unknown) => args);
    const write = vi.fn(async (args: unknown) => args);
    const s = { threads: { wait }, files: { write } };
    await sdkCall(s, "threads.wait", { threadId: "t" }, signal);
    expect(wait).toHaveBeenCalledWith({ threadId: "t", signal });
    await sdkCall(s, "files.write", { path: "/x", content: "y" }, signal);
    expect(write).toHaveBeenCalledWith({ path: "/x", content: "y" });
  });
  it("rejects unknown paths", async () => {
    await expect(sdkCall(sdk, "threads.bogus", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(sdkCall(sdk, "nope.x.y", {})).rejects.toMatchObject({ code: "not_found" });
  });
  it("rejects paths outside the declared SDK surface, including prototype walks", async () => {
    await expect(sdkCall(sdk, "threads.get.constructor", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(sdkCall(sdk, "threads.toString", {})).rejects.toMatchObject({ code: "not_found" });
    await expect(sdkCall({ threads: { get: Object.assign(async () => ({}), { sneaky: async () => "x" }) } }, "threads.get.sneaky", {}))
      .rejects.toMatchObject({ code: "not_found" });
  });
});

// Catches drift between the advertised/exposed surface and the bundled SDK
// types — a missing method or a renamed signal declaration shows up here.
describe("SDK surface coverage", () => {
  const sdkDir = new URL("../node_modules/@get-bb/plugin-sdk/", import.meta.url);
  const dts = readFileSync(new URL("bundled-types/bb-plugin-sdk.d.ts", sdkDir), "utf8");
  const parsed = parseSdk(dts);
  it("exposes every declared SDK method", () => {
    const exposed = SDK_PATHS.filter(p => !p.startsWith("ops.") && p !== "approve").sort();
    expect(exposed).toEqual([...parsed.paths].sort());
    expect(exposed).not.toContain("subscribe");
    expect(exposed).not.toContain("experimental_desktopBrowsers.subscribe");
  });
  it("covers the 0.43.x additions", () => {
    for (const p of ["threads.getPluginMetadata", "threads.updatePluginMetadata", "threads.context", "system.uiPreferences.list", "system.uiPreferences.set", "system.uiPreferences.reset",
      "environments.list", "environments.delete", "hosts.experimental_create", "hosts.experimental_suspend", "hosts.experimental_resume", "hosts.experimental_retryCleanup", "hosts.experimental_listProviders", "hosts.experimental_getEnrollmentCommand"])
      expect(SDK_PATHS).toContain(p);
    expect(SDK_PATHS.filter(p => p === "theme.set")).toHaveLength(1);
  });
  it("injects signal exactly where the SDK declares it", () => {
    expect([...SIGNAL_PATHS]).toEqual(parsed.signalPaths);
    expect(SIGNAL_PATHS).toContain("threads.getPluginMetadata");
    expect(SIGNAL_PATHS).not.toContain("threads.updatePluginMetadata".replace("update", "files.write"));
    expect(SIGNAL_PATHS).not.toContain("files.write");
    expect(SIGNAL_PATHS).not.toContain("environments.delete");
  });
  it("sdk-api.ts matches the installed SDK (run `npm run sdk-api` after `bb plugin types`)", () => {
    expect(SDK_VERSION).toBe(JSON.parse(readFileSync(new URL("package.json", sdkDir), "utf8")).version);
    expect(readFileSync(new URL("../sdk-api.ts", import.meta.url), "utf8")).toBe(render());
  });
});

describe("ops dispatch", () => {
  it("ops.run records the call result", async () => {
    const d = makeDispatch(sdk, storeStub, () => {});
    const out = await d("ops.run", { kind: "create", call: "threads.get", args: { threadId: "thr_1" } }) as Record<string, unknown>;
    expect(out.state).toBe("accepted");
    expect((out.response as Record<string, unknown>).id).toBe("thr_1");
    expect(out.threadId).toBe("thr_1");
  });
  it("ops.run only promotes thread-returning call ids to threadId", async () => {
    const projectsCreate = { projects: { create: async () => ({ id: "proj_new" }) } };
    const d = makeDispatch(projectsCreate, storeStub, () => {});
    const out = await d("ops.run", { call: "projects.create", args: {} }) as Record<string, unknown>;
    expect(out.state).toBe("accepted");
    expect(out.threadId).toBeNull();
  });
  it("ops.run inner calls are logged for audit", async () => {
    const seen: string[] = [];
    const d = makeDispatch(sdk, storeStub, (n) => seen.push(n));
    await d("ops.run", { call: "threads.get", args: { threadId: "thr_1" } });
    expect(seen).toContain("ops.run");
    expect(seen).toContain("threads.get");
  });
  it("ops.get rejects missing operations", async () => {
    await expect(dispatch("ops.get", { operationId: "op_none" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("makeDispatch validation", () => {
  it("surfaces ToolError codes for bad ops.run input", async () => {
    await expect(dispatch("ops.run", {})).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(dispatch("ops.run", { call: "nope.x" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("read-only verbs", () => {
  it("covers the read-shaped members that were missed", () => {
    expect(isReadPath("threads.listRunning")).toBe(true);
    expect(isReadPath("hosts.cloneDefaultPath")).toBe(true);
    expect(isReadPath("plugins.catalog.installPlan")).toBe(true);
  });
  it("classifies the 0.43.x surfaces", () => {
    for (const p of ["threads.context", "threads.getPluginMetadata", "system.uiPreferences.list", "environments.list", "environments.listProviders",
      "hosts.experimental_listProviders", "system.machineEnvironment", "theme.resolve", "experimental_desktopBrowsers.listTabs", "experimental_desktopBrowsers.captureTab"])
      expect(isReadPath(p), p).toBe(true);
    for (const p of ["threads.updatePluginMetadata", "system.uiPreferences.set", "system.uiPreferences.reset", "environments.delete", "hosts.experimental_create",
      "hosts.experimental_suspend", "hosts.experimental_resume", "hosts.experimental_retryCleanup", "hosts.experimental_getEnrollmentCommand", "system.replaceMachineEnvironment",
      "threads.interactions.resolve", "experimental_desktopBrowsers.acquireControl", "experimental_desktopBrowsers.importCookies"])
      expect(isReadPath(p), p).toBe(false);
  });
});

describe("read-only ops.get", () => {
  it("redacts responses recorded by execute-only calls", async () => {
    const store = {
      get: (id: string) => id === "op_secret"
        ? { id, kind: "plugins.token", call: "plugins.token", projectId: null, hostId: null, threadId: null, state: "accepted" as const, createdAt: 1, updatedAt: 1, response: { token: "secret" } }
        : { id, kind: "create", call: "threads.spawn", projectId: null, hostId: null, threadId: "thr_1", state: "accepted" as const, createdAt: 1, updatedAt: 1, response: { threadId: "thr_1" } },
    } as unknown as Store;
    const ro = makeDispatch(sdk, store, () => {}, undefined, true);
    const secret = await ro("ops.get", { operationId: "op_secret" }) as Record<string, unknown>;
    expect(secret.response).toBeNull();
    expect(secret.responseRedacted).toBeTruthy();
    const plain = await ro("ops.get", { operationId: "op_plain" }) as Record<string, unknown>;
    expect(plain.response).toEqual({ threadId: "thr_1" });
    const full = makeDispatch(sdk, store, () => {});
    const visible = await full("ops.get", { operationId: "op_secret" }) as Record<string, unknown>;
    expect(visible.response).toEqual({ token: "secret" });
  });
});

describe("read-only dispatch", () => {
  const roDispatch = makeDispatch(sdk, storeStub, () => {}, undefined, true);
  it("serves reads and blocks mutations with a clear error", async () => {
    const out = await runCode({ code: `async () => { const p = await bb.projects.list(); return p.length; }`, paths, dispatch: roDispatch });
    expect(out.result).toBe(2);
    await expect(runCode({ code: `async () => bb.threads.spawn({})`, paths, dispatch: roDispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringContaining("read methods") });
  });
  it("blocks durable dispatch and approvals, but allows ops.get", async () => {
    await expect(roDispatch("ops.run", { call: "threads.get", args: {} })).rejects.toMatchObject({ code: "not_read_method" });
    await expect(roDispatch("approve", { threadId: "t", interactionId: "i", decision: "deny" })).rejects.toMatchObject({ code: "not_read_method" });
    await expect(roDispatch("ops.get", { operationId: "op_x" })).rejects.toMatchObject({ code: "not_found" });
    // end to end through the sandbox: the ledgered write never reaches the SDK
    const write = vi.fn(async () => ({}));
    const guarded = makeDispatch({ ...sdk, files: { write } }, storeStub, () => {}, undefined, true);
    await expect(runCode({ code: `async () => bb.ops.run({ call: "files.write", args: { path: "/x", content: "y" } })`, paths: [...paths, "files.write"], dispatch: guarded }))
      .rejects.toMatchObject({ code: "execution_failed" });
    expect(write).not.toHaveBeenCalled();
  });
  it("keeps credential-bearing reads execute-only", () => {
    expect(isReadPath("plugins.token")).toBe(false);
    expect(isReadPath("system.config")).toBe(false);
    expect(isReadPath("threads.wait")).toBe(true);
  });
});

describe("result limits", () => {
  it("rejects oversized returned values with guidance", async () => {
    await expect(runCode({ code: `async () => "x".repeat(400000)`, paths, dispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringContaining("Filter") });
  });
  it("measures the cap in UTF-8 bytes, not UTF-16 length", async () => {
    // 100k astral chars ≈ 400 KB UTF-8 — under the old char-count check, over the byte cap.
    await expect(runCode({ code: `async () => "\\u{1f600}".repeat(100000)`, paths, dispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringContaining("Filter") });
  });
  it("returns null for undefined results instead of dropping the key", async () => {
    const out = await runCode({ code: `async () => { await bb.projects.list(); }`, paths, dispatch });
    expect(out.result).toBeNull();
    expect("result" in out).toBe(true);
  });
  it("rejects results JSON cannot represent, inside the sandbox", async () => {
    await expect(runCode({ code: `async () => 10n`, paths, dispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringMatching(/serializ/i) });
    await expect(runCode({ code: `async () => { const o = {}; o.self = o; return o; }`, paths, dispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringMatching(/serializ/i) });
  });
  it("lets large intermediate results stay inside the sandbox", async () => {
    const big = { threads: { list: async () => "x".repeat(400000) } };
    const d = makeDispatch(big, storeStub, () => {});
    const out = await runCode({ code: `async () => (await bb.threads.list()).length`, paths, dispatch: d });
    expect(out.result).toBe(400000);
  });
});

describe("permissionMode defaulting", () => {
  const spySdk = (defaults: { thread?: unknown; project?: unknown; ceiling?: unknown }) => ({
    threads: { spawn: vi.fn(async (a: unknown) => a), send: vi.fn(async (a: unknown) => a), defaultExecutionOptions: async () => defaults.thread },
    projects: { defaultExecutionOptions: vi.fn(async () => defaults.project) },
    system: { executionOptions: vi.fn(async () => defaults.ceiling === undefined ? undefined : { permissionCeiling: defaults.ceiling }) },
  });
  it("uses the project's configured default when present", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [] });
    expect(s.threads.spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto", executionInputSources: { permissionMode: "client-preference" } }));
  });
  it("defaults to full when nothing is configured", async () => {
    const s = spySdk({ project: null, ceiling: "full" });
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [] });
    expect(s.threads.spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "full" }));
  });
  it("clamps the full fallback to the system ceiling", async () => {
    const s = spySdk({ project: null, ceiling: "auto" });
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [] });
    expect(s.threads.spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto" }));
  });
  it("leaves send to inherit the thread's stored options", async () => {
    const s = spySdk({ thread: { permissionMode: "full" }, ceiling: "full" });
    await sdkCall(s, "threads.send", { threadId: "t1", input: [], mode: "steer" });
    expect(s.threads.send).toHaveBeenCalledWith(expect.not.objectContaining({ permissionMode: expect.anything() }));
  });
  it("leaves an explicit permissionMode alone and marks it explicit", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [], permissionMode: "auto" });
    expect(s.threads.spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto", executionInputSources: { permissionMode: "explicit" } }));
    expect(s.projects.defaultExecutionOptions).not.toHaveBeenCalled();
  });
  it("marks every caller-supplied execution field explicit, not just permissionMode", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [], providerId: "codex", model: "gpt-6-astra", reasoningLevel: "xhigh", serviceTier: "fast" });
    expect(s.threads.spawn).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "codex", model: "gpt-6-astra", reasoningLevel: "xhigh", serviceTier: "fast",
      permissionMode: "auto",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit", permissionMode: "client-preference" },
    }));
  });
  it("merges with caller-provided executionInputSources without overriding them", async () => {
    const s = spySdk({ project: null, ceiling: "full" });
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [], model: "m", executionInputSources: { model: "client-preference" } });
    expect(s.threads.spawn).toHaveBeenCalledWith(expect.objectContaining({
      executionInputSources: { model: "client-preference", permissionMode: "client-preference" },
    }));
  });
  it("marks explicit execution fields on send and queued message creation", async () => {
    const s = { threads: { send: vi.fn(async (a: unknown) => a), queuedMessages: { create: vi.fn(async (a: unknown) => a) } } };
    await sdkCall(s, "threads.send", { threadId: "t", input: [], mode: "steer", model: "m" });
    expect(s.threads.send).toHaveBeenCalledWith(expect.objectContaining({ executionInputSources: { model: "explicit" } }));
    await sdkCall(s, "threads.queuedMessages.create", { threadId: "t", input: [], permissionMode: "full" });
    expect(s.threads.queuedMessages.create).toHaveBeenCalledWith(expect.objectContaining({ executionInputSources: { permissionMode: "explicit" } }));
  });
  it("does not add executionInputSources to fork — its schema is strict and lacks the field", async () => {
    const s = { threads: { fork: vi.fn(async (a: unknown) => a) } };
    await sdkCall(s, "threads.fork", { sourceThreadId: "t", permissionMode: "auto" });
    expect(s.threads.fork).toHaveBeenCalledWith(expect.not.objectContaining({ executionInputSources: expect.anything() }));
  });
  it("does not touch non-dispatch paths", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    const read = await sdkCall(s, "projects.defaultExecutionOptions", { projectId: "p1" });
    expect(read).toEqual({ permissionMode: "auto" });
    expect(s.threads.spawn).not.toHaveBeenCalled();
  });
  it("surfaces a failed default lookup as precondition_failed", async () => {
    const s = spySdk({ project: null, ceiling: "full" });
    s.projects.defaultExecutionOptions = vi.fn(async () => { throw new Error("socket hangup"); });
    await expect(sdkCall(s, "threads.spawn", { projectId: "p1", input: [] }))
      .rejects.toMatchObject({ code: "precondition_failed" });
    expect(s.threads.spawn).not.toHaveBeenCalled();
  });
  it("passes the request signal to the default lookups", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    const ctrl = new AbortController();
    await sdkCall(s, "threads.spawn", { projectId: "p1", input: [] }, ctrl.signal);
    const ceilingArgs = (s.system.executionOptions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ceilingArgs.signal).toBe(ctrl.signal);
    const projectArgs = (s.projects.defaultExecutionOptions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(projectArgs.signal).toBe(ctrl.signal);
  });
  it("does not dispatch once the signal aborts mid-lookup", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    const ctrl = new AbortController();
    let release!: () => void;
    s.projects.defaultExecutionOptions = vi.fn(() => new Promise<{ permissionMode: string }>(r => { release = () => r({ permissionMode: "auto" }); }));
    const pendingCall = sdkCall(s, "threads.spawn", { projectId: "p1", input: [] }, ctrl.signal);
    ctrl.abort(); release();
    await expect(pendingCall).rejects.toMatchObject({ code: "execution_aborted" });
    expect(s.threads.spawn).not.toHaveBeenCalled();
  });
});

describe("bb.approve", () => {
  const approval = (extra: Record<string, unknown> = {}) => ({
    id: "int_1", status: "pending", payload: { kind: "approval", availableDecisions: ["allow_once", "allow_for_session", "deny"], subject: { kind: "command", sessionGrant: { network: { enabled: true } } }, ...extra },
  });
  const approvalSdk = (interaction: unknown) => ({
    threads: { interactions: { get: vi.fn(async () => interaction), resolve: vi.fn(async (a: unknown) => a) } },
  });
  const dispatchFor = (s: unknown) => makeDispatch(s, storeStub, () => {});
  it("resolves allow_once with the required grantedPermissions key", async () => {
    const s = approvalSdk(approval());
    const out = await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_once" }) as Record<string, unknown>;
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "allow_once", grantedPermissions: null } });
    expect(out).toBeTruthy();
  });
  it("defaults session approvals to the request's sessionGrant", async () => {
    const s = approvalSdk(approval());
    await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_for_session" });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "allow_for_session", grantedPermissions: { network: { enabled: true } } } });
  });
  it("deny sends no grantedPermissions", async () => {
    const s = approvalSdk(approval());
    await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "deny" });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "deny" } });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0].resolution).not.toHaveProperty("grantedPermissions");
  });
  it("honors an explicit null grantedPermissions on allow_for_session", async () => {
    const s = approvalSdk(approval());
    await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_for_session", grantedPermissions: null });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "allow_for_session", grantedPermissions: null } });
  });
  it("defaults permission_grant session approvals to the subject's permissions", async () => {
    const s = approvalSdk(approval({ subject: { kind: "permission_grant", permissions: { fileSystem: { read: ["."], write: [] }, network: null } } }));
    await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_for_session" });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "allow_for_session", grantedPermissions: { fileSystem: { read: ["."], write: [] }, network: null } } });
  });
  it("defaults permission_grant allow_once to the subject's requested permissions", async () => {
    const s = approvalSdk(approval({ subject: { kind: "permission_grant", permissions: { fileSystem: { read: ["."], write: [] }, network: null } } }));
    await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_once" });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "allow_once", grantedPermissions: { fileSystem: { read: ["."], write: [] }, network: null } } });
  });
  it("normalizes a partial grant object to the SDK's required-nullable keys", async () => {
    const s = approvalSdk(approval());
    await dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_for_session", grantedPermissions: { network: { enabled: false } } });
    expect((s.threads.interactions.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ resolution: { decision: "allow_for_session", grantedPermissions: { network: { enabled: false }, fileSystem: null } } });
  });
  it("rejects approvals that are no longer pending or are expired", async () => {
    const s = approvalSdk({ ...approval(), status: "resolved" });
    await expect(dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "deny" })).rejects.toMatchObject({ code: "conflict" });
    const expired = approvalSdk({ ...approval(), payload: { ...approval().payload, expiresAt: Date.now() - 1000 } });
    await expect(dispatchFor(expired)("approve", { threadId: "t", interactionId: "int_1", decision: "deny" })).rejects.toMatchObject({ code: "conflict" });
  });
  it("surfaces a failed interaction lookup as precondition_failed, not outcome_unknown", async () => {
    const s = { threads: { interactions: { get: vi.fn(async () => { throw new Error("socket hangup"); }), resolve: vi.fn() } } };
    await expect(dispatchFor(s)("approve", { threadId: "t", interactionId: "i", decision: "deny" }))
      .rejects.toMatchObject({ code: "precondition_failed" });
  });
  it("a ledgered approve stays durable under an aborted request signal", async () => {
    const s = approvalSdk(approval());
    const ac = new AbortController(); ac.abort();
    const d = makeDispatch(s, storeStub, () => {}, ac.signal);
    const out = await d("ops.run", { call: "approve", args: { threadId: "t", interactionId: "int_1", decision: "deny" } }) as Record<string, unknown>;
    expect(out.state).toBe("accepted");
    expect(s.threads.interactions.resolve).toHaveBeenCalledTimes(1);
    // The same call unledgered aborts with the request.
    await expect(d("approve", { threadId: "t", interactionId: "int_1", decision: "deny" })).rejects.toMatchObject({ code: "execution_aborted" });
  });
  it("rejects decisions the interaction does not offer and non-approvals", async () => {
    const s = approvalSdk(approval({ availableDecisions: ["deny"] }));
    await expect(dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_once" })).rejects.toMatchObject({ code: "conflict" });
    const q = approvalSdk({ id: "int_2", status: "pending", payload: { kind: "user_question" } });
    await expect(dispatchFor(q)("approve", { threadId: "t", interactionId: "int_2", decision: "deny" })).rejects.toMatchObject({ code: "conflict" });
    await expect(dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "maybe" })).rejects.toMatchObject({ code: "invalid_arguments" });
  });
});
