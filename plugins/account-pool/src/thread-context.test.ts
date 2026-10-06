import { describe, expect, it } from "vitest";
import {
  createInitiativesContextReader,
  initiativesPluginId,
  warmingWindow,
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
    token?: (pluginId: string) => Promise<string>;
    pluginId?: () => Promise<string | null>;
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
    pluginId: options.pluginId ?? (async () => "initiatives"),
    token: options.token ?? (async () => "projects-token"),
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
    expect(token).toBe("projects-token");
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

describe("T117 the Initiatives plugin's move from the projects ID", () => {
  it("resolves the running plugin, else the installed one, else none, rechecking every 5 s", async () => {
    let plugins: { id: string; enabled?: boolean; status?: string }[] = [
      { id: "projects", enabled: true, status: "running" },
    ];
    let now = 0;
    const resolve = initiativesPluginId(async () => ({ plugins }), () => now);
    expect(await resolve()).toBe("projects");
    plugins = [
      { id: "projects", enabled: false, status: "disabled" },
      { id: "initiatives", enabled: true, status: "running" },
    ];
    now = 4_999;
    expect(await resolve()).toBe("projects");
    now = 5_000;
    expect(await resolve()).toBe("initiatives");
    plugins = [
      { id: "projects", enabled: false, status: "disabled" },
      { id: "initiatives", enabled: false, status: "disabled" },
    ];
    now = 10_000;
    expect(await resolve()).toBe("initiatives");
    plugins = [{ id: "account-pool-local", enabled: true, status: "running" }];
    now = 15_000;
    expect(await resolve()).toBeNull();
  });

  it("follows a switch from projects to initiatives: route, token and a cleared membership cache", async () => {
    let provider: string | null = "projects";
    const tokens: string[] = [];
    const { instance, calls } = reader(
      (url) => ok("thr_c", url.includes("/plugins/projects/") ? member({ state: "retired" }) : member()),
      { pluginId: async () => provider, token: async (id) => (tokens.push(id), `${id}-token`) },
    );
    expect(await instance.read("thr_c", signal())).toMatchObject({ state: "retired" });
    provider = "initiatives";
    // The cached membership came from the former plugin: read again, not served from cache.
    expect(await instance.read("thr_c", signal())).toMatchObject({ state: "active" });
    expect(calls).toEqual([
      "http://127.0.0.1:38886/api/v1/plugins/projects/http/context/v1/thread?threadId=thr_c",
      `${ROUTE}?threadId=thr_c`,
    ]);
    expect(tokens).toEqual(["projects", "initiatives"]);
    provider = null;
    expect(await instance.read("thr_c", signal())).toEqual({ kind: "unknown", reason: "no Initiatives plugin is installed" });
    expect(instance.peek("thr_c")).toBeNull();
  });

  it("reads Initiatives' 503 while it is paused for its move as unknown, never as no record", async () => {
    const { instance } = reader(() =>
      Response.json(
        { error: "initiatives-paused", message: "Initiatives is waiting for its one-time import from the former Projects plugin." },
        { status: 503 },
      ),
    );
    expect(await instance.read("thr_x", signal())).toEqual({
      kind: "unknown",
      reason: "Initiatives context read returned HTTP 503 without a v1 body",
    });
  });
});

describe("warming windows (contract v1)", () => {
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
    ["active coordinator", ctx({ memberKind: "coordinator", role: "coordinator", assignment: null }), 20, "coordinator"],
    ["worker mid-assignment", ctx(), 15, "worker mid-assignment"],
    ["reported worker", ctx({ assignment: { ref: "A1", phase: "reported" } }), 10, "worker reported"],
    ["reviewer mid-assignment", ctx({ role: "review" }), 0, "reviewer mid-assignment"],
    ["reported reviewer", ctx({ role: "review", assignment: { ref: "A1", phase: "reported" } }), 0, "reviewer reported"],
    ["accepted reviewer", ctx({ role: "review", assignment: { ref: "A1", phase: "accepted" } }), 0, "reviewer accepted"],
    ["retired reviewer", ctx({ role: "review", state: "retired" }), 0, "review retired"],
    ["paused Initiative coordinator", ctx({ memberKind: "coordinator", role: "coordinator", paused: true }), 0, "paused Initiative"],
    ["paused Initiative worker", ctx({ paused: true }), 0, "paused Initiative"],
    ["accepted worker", ctx({ assignment: { ref: "A1", phase: "accepted" } }), 0, "worker accepted"],
    ["retired worker", ctx({ state: "retired" }), 0, "work retired"],
    ["stopped worker", ctx({ state: "stopped" }), 0, "work stopped"],
    ["former (replaced) coordinator", ctx({ memberKind: "coordinator", role: "coordinator", state: "former" }), 0, "coordinator former"],
    ["rejected assignment", ctx({ assignment: { ref: "A1", phase: "rejected" } }), 0, "assignment rejected"],
    ["worker between assignments", ctx({ assignment: null }), 0, "worker without assignment"],
    ["delivered assignment still pending", ctx({ assignment: { ref: "A2", phase: "pending" } }), 0, "assignment A2 pending delivery"],
    ["reported worker with an undelivered next assignment", ctx({ assignment: { ref: "A1", phase: "reported" }, next: { ref: "A2", phase: "pending" } }), 0, "next assignment A2 not delivered yet"],
    ["adhoc thread", ctx({ memberKind: "adhoc", role: "adhoc", assignment: null }), 0, "adhoc Initiative thread"],
    ["archived Initiative coordinator", ctx({ memberKind: "coordinator", role: "coordinator", archived: true }), 0, "archived Initiative"],
  ])("a %s gets %d minutes", (_name, context, minutes, label) => {
    expect(warmingWindow(context, config)).toEqual({ ok: true, minutes, label });
  });

  it("follows the configured supported windows", () => {
    const custom = warmingConfigSchema.parse({ coordinatorMinutes: 30, workerAcceptedMinutes: 5, workerEndedMinutes: 2 });
    expect(warmingWindow(ctx({ memberKind: "coordinator", role: "coordinator" }), custom)).toMatchObject({ minutes: 30 });
    expect(warmingWindow(ctx({ assignment: { ref: "A1", phase: "accepted" } }), custom)).toMatchObject({ minutes: 5 });
    expect(warmingWindow(ctx({ state: "retired" }), custom)).toMatchObject({ minutes: 2 });
    // Adhoc, archived and pending stay zero whatever the settings say.
    expect(warmingWindow(ctx({ memberKind: "adhoc", role: "adhoc" }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ archived: true }), custom)).toMatchObject({ minutes: 0 });
  });

  it("gives reviewers reviewerMinutes and leaves the worker windows alone", () => {
    const custom = warmingConfigSchema.parse({ reviewerMinutes: 7 });
    expect(warmingWindow(ctx({ role: "review" }), custom)).toEqual({ ok: true, minutes: 7, label: "reviewer mid-assignment" });
    expect(warmingWindow(ctx({ role: "review", assignment: { ref: "A1", phase: "reported" } }), custom)).toMatchObject({ minutes: 7 });
    expect(warmingWindow(ctx(), custom)).toMatchObject({ minutes: 15 });
    expect(warmingWindow(ctx({ assignment: { ref: "A1", phase: "reported" } }), custom)).toMatchObject({ minutes: 10 });
    // Pending, next and ended stay as they are for reviewers too.
    expect(warmingWindow(ctx({ role: "review", assignment: { ref: "A1", phase: "pending" } }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ role: "review", next: { ref: "A2", phase: "pending" } }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ role: "review", state: "stopped" }), custom)).toMatchObject({ minutes: 0 });
  });

  it("pauseStopsWarming off keeps the role windows through a pause", () => {
    const keep = warmingConfigSchema.parse({ pauseStopsWarming: false });
    expect(warmingWindow(ctx({ memberKind: "coordinator", role: "coordinator", paused: true }), keep)).toMatchObject({ minutes: 20 });
    expect(warmingWindow(ctx({ paused: true }), keep)).toMatchObject({ minutes: 15 });
    // Archived and adhoc still win over a pause.
    expect(warmingWindow(ctx({ paused: true, archived: true }), keep)).toMatchObject({ minutes: 0, label: "archived Initiative" });
  });

  it("never warms on no record, even with a positive standalone window", () => {
    const standalone = warmingConfigSchema.parse({ standaloneMinutes: 30 });
    expect(warmingWindow({ kind: "none" }, standalone)).toEqual({
      ok: false,
      reason:
        "Initiatives has no record of this thread; a standalone thread cannot be told from an unknown or unlinked one",
    });
    expect(warmingWindow({ kind: "unknown", reason: "x" }, standalone)).toEqual({ ok: false, reason: "x" });
  });
});

describe("D362: accepted reviewers have their own window", () => {
  const ctx = (overrides: Partial<Extract<ThreadContext, { kind: "member" }>> = {}): ThreadContext => ({
    kind: "member",
    memberKind: "worker",
    role: "review",
    state: "active",
    archived: false,
    paused: false,
    assignment: { ref: "A1", phase: "accepted" },
    next: null,
    ...overrides,
  });

  it("raising the worker accepted grace leaves accepted reviewers at 0", () => {
    const grace = warmingConfigSchema.parse({ workerAcceptedMinutes: 10 });
    expect(warmingWindow(ctx(), grace)).toEqual({ ok: true, minutes: 0, label: "reviewer accepted" });
    expect(warmingWindow(ctx({ role: "work" }), grace)).toEqual({ ok: true, minutes: 10, label: "worker accepted" });
  });

  it("reviewerAcceptedMinutes sets only the accepted reviewer window", () => {
    const custom = warmingConfigSchema.parse({ reviewerAcceptedMinutes: 6 });
    expect(warmingWindow(ctx(), custom)).toEqual({ ok: true, minutes: 6, label: "reviewer accepted" });
    expect(warmingWindow(ctx({ role: "work" }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ assignment: { ref: "A1", phase: "reported" } }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ state: "retired" }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ next: { ref: "A2", phase: "pending" } }), custom)).toMatchObject({ minutes: 0 });
    expect(warmingWindow(ctx({ paused: true }), custom)).toMatchObject({ minutes: 0 });
  });
});
