import { describe, expect, it } from "vitest";
import {
  createInitiativesContextReader,
  warmingRole,
  type ThreadContext,
} from "./thread-context.js";
import { warmingConfigSchema } from "./warming-config.js";

// Initiatives context contract v1.1, thread route (unchanged from v1; plugins/initiatives/README.md,
// "Read-only context for other plugins").
const ROUTE =
  "http://127.0.0.1:38886/api/v1/plugins/initiatives/http/context/v1/thread";

function assignment(phase: string, ref = "A1") {
  return {
    ref,
    tasks: ["T1"],
    role: "work",
    access: "write",
    route: "fresh",
    phase,
    state: phase,
    cancelRequested: false,
    outcome: null,
    reportVersion: phase === "reported" ? "0123456789abcdef" : null,
    reportedAt: null,
    updatedAt: 1791189116571,
    briefChars: 10,
    handoff: false,
  };
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    initiativeId: "prj_1",
    initiativeName: "bb-plugins",
    archived: false,
    paused: false,
    coordinator: { threadId: "thr_c", generation: 3 },
    kind: "worker",
    role: "work",
    worker: "W1",
    generation: 1,
    currentGeneration: 1,
    state: "active",
    former: false,
    retired: false,
    stopped: false,
    parent: { forkedFrom: null, nativeParent: true },
    assignment: assignment("active"),
    next: null,
    ...overrides,
  };
}

function reader(
  respond: (url: string, headers: Headers, signal: AbortSignal) => Response | Promise<Response>,
  options: {
    token?: () => Promise<string>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const instance = createInitiativesContextReader({
    fetch: async (input, init) => {
      calls.push(String(input));
      return respond(String(input), new Headers(init?.headers), init?.signal as AbortSignal);
    },
    baseUrl: () => "http://127.0.0.1:38886",
    token: options.token ?? (async () => "initiatives-token"),
    now: options.now ?? (() => 0),
    timeoutMs: options.timeoutMs,
  });
  return { instance, calls };
}

const signal = () => new AbortController().signal;
const ok = (threadId: string, membership: unknown) =>
  Response.json({ version: 1, threadId, observedAt: 1, membership });

describe("Initiatives context reader (contract v1)", () => {
  it("calls the exact query route with the plugin token and reads a member", async () => {
    let token: string | null = null;
    const { instance, calls } = reader((_url, headers) => {
      token = headers.get("x-bb-plugin-token");
      return ok("thr_a/b", member({ assignment: assignment("reported", "A7"), next: assignment("pending", "A8") }));
    });
    expect(await instance.read("thr_a/b", signal())).toEqual({
      kind: "member",
      memberKind: "worker",
      role: "work",
      state: "active",
      archived: false,
      paused: false,
      assignment: { ref: "A7", phase: "reported" },
      next: { ref: "A8", phase: "pending" },
    });
    expect(calls).toEqual([`${ROUTE}?threadId=thr_a%2Fb`]);
    expect(token).toBe("initiatives-token");
  });

  it("reads membership null as no Initiatives record, not as a standalone thread", async () => {
    const { instance } = reader(() => ok("thr_s", null));
    expect(await instance.read("thr_s", signal())).toEqual({ kind: "none" });
  });

  it.each([
    ["a v1 error body", () => Response.json({ version: 1, observedAt: 1, error: { code: "store-unreadable", message: "x" } }, { status: 500 }), "Initiatives context error store-unreadable (HTTP 500)"],
    ["BB's own 404 for a missing route", () => Response.json({ ok: false, error: "plugin \"projects\" has no GET route" }, { status: 404 }), "Initiatives context read returned HTTP 404 without a v1 body"],
    ["BB's own 401", () => new Response("unauthorized", { status: 401 }), "Initiatives context read returned HTTP 401 without a v1 body"],
    ["another schema version", () => Response.json({ version: 2, threadId: "thr_x", membership: null }), "Initiatives context response does not match contract v1"],
    ["another thread", () => ok("thr_y", null), "Initiatives context response does not match contract v1"],
    ["an unknown state", () => ok("thr_x", member({ state: "paused" })), "Initiatives context response does not match contract v1"],
    ["an unknown phase", () => ok("thr_x", member({ assignment: assignment("paused") })), "Initiatives context response does not match contract v1"],
    ["a missing paused flag", () => ok("thr_x", member({ paused: undefined })), "Initiatives context response does not match contract v1"],
    ["a non-boolean paused flag", () => ok("thr_x", member({ paused: "yes" })), "Initiatives context response does not match contract v1"],
    ["a missing next field", () => ok("thr_x", { ...member(), next: undefined }), "Initiatives context response does not match contract v1"],
    ["an oversized body", () => new Response(JSON.stringify({ version: 1, threadId: "thr_x", membership: null, pad: "x".repeat(70_000) })), "Initiatives context response too large"],
    ["non-JSON", () => new Response("<html>"), "Initiatives context read returned HTTP 200 without a v1 body"],
    ["a network error", () => Promise.reject(new Error("ECONNREFUSED")), "Initiatives context read failed or timed out"],
  ] as const)("treats %s as unknown context", async (_name, respond, reason) => {
    const { instance } = reader(respond as () => Response | Promise<Response>);
    expect(await instance.read("thr_x", signal())).toEqual({ kind: "unknown", reason });
  });

  it("times out as unknown context, never as no record", async () => {
    const { instance } = reader(
      (_url, _headers, abort) =>
        new Promise((_resolve, reject) => {
          abort.addEventListener("abort", () => reject(abort.reason));
        }),
      { timeoutMs: 20 },
    );
    expect(await instance.read("thr_x", signal())).toEqual({
      kind: "unknown",
      reason: "Initiatives context read failed or timed out",
    });
  });

  it("treats a missing Initiatives plugin token as unknown context", async () => {
    const { instance, calls } = reader(() => ok("thr_x", null), {
      token: async () => {
        throw new Error("404 unknown plugin");
      },
    });
    expect(await instance.read("thr_x", signal())).toEqual({
      kind: "unknown",
      reason: "Initiatives plugin token unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("caches a membership for 30 seconds unless the read is fresh, and never caches null", async () => {
    let now = 0;
    let membership: unknown = member({ assignment: assignment("reported") });
    const { instance, calls } = reader(() => ok("thr_c", membership), { now: () => now });
    await instance.read("thr_c", signal());
    membership = member({ state: "retired" });
    now = 29_999;
    expect(await instance.read("thr_c", signal())).toMatchObject({ state: "active" });
    expect(await instance.read("thr_c", signal(), { fresh: true })).toMatchObject({ state: "retired" });
    expect(calls).toHaveLength(2);
    membership = null;
    await instance.read("thr_c", signal(), { fresh: true });
    membership = member();
    // A null read is not cached: a just-spawned worker becomes linked on the next read.
    expect(await instance.read("thr_c", signal())).toMatchObject({ kind: "member" });
    expect(calls).toHaveLength(4);
  });
});

describe("T120 the Initiatives plugin under one ID", () => {
  it("reads only the initiatives route; a 503 without a v1 body is unknown, never no record", async () => {
    const { instance, calls } = reader(() =>
      Response.json({ ok: false, error: 'plugin "initiatives" is not running (status: disabled)' }, { status: 503 }),
    );
    expect(await instance.read("thr_x", signal())).toEqual({
      kind: "unknown",
      reason: "Initiatives context read returned HTTP 503 without a v1 body",
    });
    expect(calls).toEqual([`${ROUTE}?threadId=thr_x`]);
  });
});

describe("warming roles (contract v1)", () => {
  const config = warmingConfigSchema.parse({});
  const ctx = (overrides: Partial<Extract<ThreadContext, { kind: "member" }>> = {}): ThreadContext => ({
    kind: "member",
    memberKind: "worker",
    role: "work",
    state: "active",
    archived: false,
    paused: false,
    assignment: { ref: "A1", phase: "active" },
    next: null,
    ...overrides,
  });

  it.each([
    ["active coordinator", ctx({ memberKind: "coordinator", role: "coordinator", assignment: null }), "coordinator", "coordinator"],
    ["worker mid-assignment", ctx(), "worker", "worker, A1 active"],
    ["reported worker", ctx({ assignment: { ref: "A1", phase: "reported" } }), "worker", "worker, A1 reported"],
    ["accepted worker", ctx({ assignment: { ref: "A1", phase: "accepted" } }), "worker", "worker, A1 accepted"],
    ["rejected assignment", ctx({ assignment: { ref: "A1", phase: "rejected" } }), "worker", "worker, A1 rejected"],
    ["worker between assignments", ctx({ assignment: null }), "worker", "worker between assignments"],
    ["delivered assignment still pending", ctx({ assignment: { ref: "A2", phase: "pending" } }), "worker", "worker, A2 pending"],
    ["reported worker with an undelivered next assignment", ctx({ assignment: { ref: "A1", phase: "reported" }, next: { ref: "A2", phase: "pending" } }), "worker", "worker, A2 pending"],
    ["reviewer mid-assignment", ctx({ role: "review" }), "reviewer", "reviewer, A1 active"],
    ["accepted reviewer", ctx({ role: "review", assignment: { ref: "A1", phase: "accepted" } }), "reviewer", "reviewer, A1 accepted"],
    ["adhoc thread", ctx({ memberKind: "adhoc", role: "adhoc", assignment: null }), "standalone", "adhoc Initiative thread"],
    ["thread outside any Initiative", { kind: "none" } as ThreadContext, "standalone", "no Initiative"],
  ])("a %s is warmed as %s", (_name, context, role, label) => {
    expect(warmingRole(context, config)).toEqual({ ok: true, role, label });
  });

  it.each([
    ["retired reviewer", ctx({ role: "review", state: "retired" }), "reviewer retired"],
    ["retired worker", ctx({ state: "retired" }), "worker retired"],
    ["stopped worker", ctx({ state: "stopped" }), "worker stopped"],
    ["former (replaced) coordinator", ctx({ memberKind: "coordinator", role: "coordinator", state: "former" }), "coordinator former"],
    ["paused Initiative coordinator", ctx({ memberKind: "coordinator", role: "coordinator", paused: true }), "paused Initiative"],
    ["paused Initiative worker", ctx({ paused: true }), "paused Initiative"],
    ["archived Initiative coordinator", ctx({ memberKind: "coordinator", role: "coordinator", archived: true }), "archived Initiative"],
  ])("a %s is not warmed", (_name, context, reason) => {
    expect(warmingRole(context, config)).toEqual({ ok: false, reason, kind: "end" });
  });

  it("pauseStopsWarming off keeps warming through a pause, not through an archive", () => {
    const keep = warmingConfigSchema.parse({ pauseStopsWarming: false });
    expect(warmingRole(ctx({ paused: true }), keep)).toMatchObject({ ok: true, role: "worker" });
    expect(warmingRole(ctx({ paused: true, archived: true }), keep)).toMatchObject({ ok: false, reason: "archived Initiative" });
  });

  it("a role left out of the settings is not warmed; unknown context is skipped with its reason", () => {
    const some = warmingConfigSchema.parse({ roles: ["coordinator"] });
    expect(warmingRole(ctx(), some)).toEqual({
      ok: false,
      reason: "role worker is not enabled for warming (worker, A1 active)",
      kind: "end",
    });
    expect(warmingRole({ kind: "unknown", reason: "x" }, config)).toEqual({ ok: false, reason: "skipped: x", kind: "skip" });
  });
});
