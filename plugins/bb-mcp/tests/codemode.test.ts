import { describe, expect, it, vi } from "vitest";
import { isReadPath, makeDispatch, runCode, sdkCall } from "../codemode";
import { ToolError } from "../config";
import type { Store } from "../store";

const paths = ["projects.list", "threads.get", "threads.interactions.list", "missing.method", "threads.list", "threads.spawn", "ops.run", "ops.get"];

const sdk = {
  projects: { list: async () => [{ id: "a" }, { id: "b" }] },
  threads: { get: async (args: { threadId?: string }) => ({ id: args.threadId }), interactions: { list: async () => [1, 2] } },
};

const storeStub = {
  find: () => undefined,
  get: () => undefined,
  run: async (input: { kind: string; threadId?: string | null }, _k: unknown, _p: unknown, dispatch: () => Promise<Record<string, unknown>>) =>
    ({ id: "op_1", kind: input.kind, projectId: null, hostId: null, threadId: input.threadId ?? null, state: "accepted" as const, createdAt: 1, updatedAt: 1, response: await dispatch() }),
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
  it("rejects non-function code", async () => {
    await expect(runCode({ code: `42`, paths, dispatch })).rejects.toMatchObject({ code: "execution_failed" });
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
});

describe("ops dispatch", () => {
  it("ops.run records the call result and normalizes threadId", async () => {
    const d = makeDispatch(sdk, storeStub, () => {});
    const out = await d("ops.run", { kind: "create", call: "threads.get", args: { threadId: "thr_1" } }) as Record<string, unknown>;
    expect(out.state).toBe("accepted");
    expect((out.response as Record<string, unknown>).threadId).toBe("thr_1");
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

describe("read-only dispatch", () => {
  const roDispatch = makeDispatch(sdk, storeStub, () => {}, undefined, true);
  it("serves reads and blocks mutations with a clear error", async () => {
    const out = await runCode({ code: `async () => { const p = await bb.projects.list(); return p.length; }`, paths, dispatch: roDispatch });
    expect(out.result).toBe(2);
    await expect(runCode({ code: `async () => bb.threads.spawn({})`, paths, dispatch: roDispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringContaining("read methods") });
  });
  it("keeps credential-bearing reads execute-only", () => {
    expect(isReadPath("plugins.token")).toBe(false);
    expect(isReadPath("system.config")).toBe(false);
    expect(isReadPath("threads.wait")).toBe(true);
    expect(isReadPath("ops.get")).toBe(true);
    expect(isReadPath("ops.run")).toBe(false);
  });
});

describe("result limits", () => {
  it("rejects oversized returned values with guidance", async () => {
    await expect(runCode({ code: `async () => "x".repeat(400000)`, paths, dispatch }))
      .rejects.toMatchObject({ code: "execution_failed", message: expect.stringContaining("Filter") });
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
    system: { executionOptions: async () => defaults.ceiling === undefined ? undefined : { permissionCeiling: defaults.ceiling } },
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
  it("does not touch non-dispatch paths", async () => {
    const s = spySdk({ project: { permissionMode: "auto" }, ceiling: "full" });
    const read = await sdkCall(s, "projects.defaultExecutionOptions", { projectId: "p1" });
    expect(read).toEqual({ permissionMode: "auto" });
    expect(s.threads.spawn).not.toHaveBeenCalled();
  });
});

describe("bb.approve", () => {
  const approval = (extra: Record<string, unknown> = {}) => ({
    id: "int_1", payload: { kind: "approval", availableDecisions: ["allow_once", "allow_for_session", "deny"], subject: { sessionGrant: { network: { enabled: true } } }, ...extra },
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
  it("rejects decisions the interaction does not offer and non-approvals", async () => {
    const s = approvalSdk(approval({ availableDecisions: ["deny"] }));
    await expect(dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "allow_once" })).rejects.toMatchObject({ code: "conflict" });
    const q = approvalSdk({ id: "int_2", payload: { kind: "user_question" } });
    await expect(dispatchFor(q)("approve", { threadId: "t", interactionId: "int_2", decision: "deny" })).rejects.toMatchObject({ code: "conflict" });
    await expect(dispatchFor(s)("approve", { threadId: "t", interactionId: "int_1", decision: "maybe" })).rejects.toMatchObject({ code: "invalid_arguments" });
  });
});
