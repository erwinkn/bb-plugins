import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { ReviewerFallback, classifyReviewerFailure, fallbackFlag } from "../lib/reviewer-fallback";
import { projectFixture } from "./fake-native";

// W545 (Erwin, 2026-10-28): when Muse is out of credits the plugin itself reruns the round on the
// fallback reviewer; the worker no longer has to notice, clear the retry and respawn by hand.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId })) as string);
const muse = { providerId: "muse", model: "muse-wonder-1.0", reasoningLevel: "xhigh" } as const;
// What Muse wrote on 2026-10-27 (thr_h8qxbgnehz): no errorInfo reached BB, only the text.
const MUSE_QUOTA =
  "Muse usage limit reached: API error 429 [request_id=86273443]: Subscription quota exhausted. Your usage window resets at 2026-11-02T00:00:00Z. (rate_limit_error). It resets at 2026-11-02T00:00:00.000Z.";
const PROMPT = [{ type: "text", text: "You are the code reviewer (round 2). Review PR 389.", mentions: [] }];

/** A worker W1 (Claude, so Muse reviews it) and its reviewer child, failed with `error`. */
async function setup(options: {
  providerId?: string;
  model?: string;
  title?: string;
  error?: { message: string; detail?: string; errorInfo?: Record<string, unknown> } | null;
  finishedTurn?: boolean;
  parent?: "worker" | "coordinator";
} = {}) {
  const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: muse }) });
  const [w] = await tool(f, "initiative_spawn", { label: "Retention", purpose: "retention", text: "Build it." });
  // Each test owns its reviewer's history; the fixture's shared finished turn would read as R8.
  f.history.splice(0);
  const id = "thr_review";
  f.threads.set(id, {
    ...makeThreadResponse({
      id,
      projectId: "proj_a",
      environmentId: "env_w",
      parentThreadId: options.parent === "coordinator" ? "coordinator" : w.threadId,
      providerId: options.providerId ?? muse.providerId,
      status: "error",
      title: options.title ?? "Review r2 #389",
    }),
  });
  f.execution.set(id, { model: options.model ?? muse.model, reasoningLevel: "xhigh", permissionMode: "full" });
  let seq = 100;
  const row = (type: string, data: Record<string, unknown>) => f.history.push({ type, seq: seq++, threadId: id, createdAt: seq, data });
  row("client/turn/requested", { source: "spawn", input: PROMPT });
  if (options.finishedTurn) {
    row("turn/completed", { status: "completed" });
    row("client/turn/requested", { source: "user", input: [{ type: "text", text: "Check the fix.", mentions: [] }] });
  }
  if (options.error !== null) row("provider/error", options.error ?? { message: MUSE_QUOTA });
  row("turn/completed", { status: "failed" });
  // BB's provider-retry queued the turn again for after the window.
  f.queued.set(id, [{ id: "retry_1", content: PROMPT }]);
  const spawns = f.spawn.mock.calls.length;
  const sends = f.send.mock.calls.length;
  const fail = (error: string | null = options.error === null ? null : (options.error?.message ?? MUSE_QUOTA)) =>
    f.harness.emitThreadEvent("thread.failed", { thread: f.threads.get(id)!, error });
  return {
    f, project, w, id, fail,
    turnFailed: (errorInfo: Record<string, unknown> | null, blocked = false) =>
      f.harness.emitThreadEvent("turn.failed", {
        threadId: id, requestId: "creq_1", turnId: null, errorInfo: errorInfo as never, inputAccepted: true, attemptNumber: 1,
        rateLimits: blocked ? { providerId: "muse", kind: "subscription-window", status: "blocked", windows: [], reachedReason: null, overageStatus: null, overageReason: null } : null,
      }),
    newSpawns: () => f.spawn.mock.calls.slice(spawns).map((call) => call[0] as Record<string, any>),
    notes: () => f.send.mock.calls.slice(sends).map((call) => call[0] as { threadId: string; mode: string; input: { text: string }[] }),
  };
}

describe("W545 classifying a reviewer's failure", () => {
  it("quota and an unavailable model switch; transient failures wait for BB's retry", () => {
    expect(classifyReviewerFailure(null, MUSE_QUOTA)).toMatchObject({ reason: "quota" });
    // A rate limit is a quota only when its window is blocked or the text says so (R1 P3).
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, null, true)).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, MUSE_QUOTA)).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, null)).toBeNull();
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit")).toBeNull();
    expect(classifyReviewerFailure({ category: "billing", providerCode: null }, "Credit balance is too low")).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "budget-exceeded", providerCode: null }, null)).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "unknown", providerCode: null }, "You've hit your usage limit.")).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure(null, "Claude AI usage limit reached|1793577600")).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "bad-request", providerCode: "model_not_found" }, "x")).toMatchObject({ reason: "unavailable" });
    expect(classifyReviewerFailure({ category: "bad-request", providerCode: null }, "The model `muse-wonder-1.0` does not exist")).toMatchObject({ reason: "unavailable" });
    expect(classifyReviewerFailure(null, "Error: model_not_found")).toMatchObject({ reason: "unavailable" });
    // The provider's own transient category wins over a text that mentions a quota.
    expect(classifyReviewerFailure({ category: "overloaded", providerCode: null }, "Muse is retrying: quota service busy (HTTP 529)")).toBeNull();
    expect(classifyReviewerFailure({ category: "connection-failed", providerCode: null }, "usage limit")).toBeNull();
    expect(classifyReviewerFailure({ category: "stream-disconnected", providerCode: null }, null)).toBeNull();
    expect(classifyReviewerFailure(null, "Provider error: socket hang up")).toBeNull();
    expect(classifyReviewerFailure(null, "429 Too Many Requests: rate limit exceeded, retry in 20s")).toBeNull();
    expect(classifyReviewerFailure(null, null)).toBeNull();
    // Not a provider's quota or model: a tool's own errors.
    expect(classifyReviewerFailure(null, "bash: write failed: Disk quota exceeded")).toBeNull();
    // R2 P2: Claude Code's server throttle says it is not the usage limit.
    for (const info of [{ category: "rate-limit", providerCode: null }, { category: "unknown", providerCode: null }, null])
      expect(classifyReviewerFailure(info, "API Error: Server is temporarily limiting requests (not your usage limit)")).toBeNull();
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, "You've hit your usage limit. Upgrade to Pro")).toMatchObject({ reason: "quota" });
    // R4 P3: a passing throttle in quota words, and Codex refusing a model.
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, "You've hit your rate limit. Please slow down.")).toBeNull();
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, "429 RESOURCE_EXHAUSTED: Quota exceeded for 'Requests per minute'. You exceeded your current quota")).toBeNull();
    expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, "You exceeded your current quota, please check your plan and billing details.")).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "bad-request", providerCode: null }, "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.")).toMatchObject({ reason: "unavailable" });
    // R3 P2: Claude's session and weekly limits.
    for (const text of ["You've hit your session limit · resets 1:50pm", "You've hit your weekly limit · resets Nov 2"])
      expect(classifyReviewerFailure({ category: "rate-limit", providerCode: null }, text)).toMatchObject({ reason: "quota" });
    expect(classifyReviewerFailure({ category: "bad-request", providerCode: null }, "the model is not available for this request size")).toBeNull();
  });
});

describe("W545 the plugin reruns a round its reviewer can't run", () => {
  it("Muse out of quota: retry deleted, reviewer archived, same prompt on the fallback, worker told", async () => {
    const { f, project, w, id, fail, turnFailed, newSpawns, notes } = await setup();
    await fail();
    // Both failure events arrive; the round switches once.
    await turnFailed(null);
    await fail();
    expect(f.stop).toHaveBeenCalledWith({ threadId: id });
    expect(f.queued.get(id)).toEqual([]);
    expect(f.archive).toHaveBeenCalledWith({ threadId: id });
    expect(f.threads.get(id)!.archivedAt).not.toBeNull();
    const spawned = newSpawns();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "proj_a",
      environment: { type: "reuse", environmentId: "env_w" },
      parentThreadId: w.threadId,
      lifecycleOwnerThreadId: w.threadId,
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
      permissionMode: "full",
      title: "Review r2 #389 (fallback)",
      input: PROMPT,
      pluginMetadata: { role: "fallback-reviewer", projectId: project.id, replaces: id },
    });
    const fallbackId = ((await f.spawn.mock.results.at(-1)!.value) as { id: string }).id;
    // T160: one note per switch, once the fallback has started; no "will tell you" note before it,
    // which only woke an idle worker to wait (the brief already says to wait for the plugin).
    const [note] = notes();
    expect(notes()).toHaveLength(1);
    expect(note).toMatchObject({ threadId: w.threadId, mode: "steer-if-active" });
    const text = note!.input.map((part) => part.text).join("");
    expect(text).toContain("muse-wonder-1.0 xhigh is out of quota (usage limit) → round 2 rerun on claude-opus-5-5 high.");
    expect(text).toContain(`@thread:${fallbackId}`);
    expect(text).toContain("Subscription quota exhausted");
    expect(text).toContain("don't start another reviewer for this round");
    expect(f.store.hasFlag(fallbackFlag(id))).toBe(true);
    expect(f.store.db.prepare("SELECT summary FROM activity WHERE project_id=? ORDER BY id DESC LIMIT 1").pluck().get(project.id))
      .toBe(`W1's reviewer ${id} (muse-wonder-1.0 xhigh) is out of quota (usage limit): round 2 rerun on claude-opus-5-5 high in ${fallbackId}.`);
  });

  it("a structured rate limit with no stored error (refused at the door) switches too", async () => {
    const { turnFailed, newSpawns } = await setup({ error: null });
    await turnFailed({ category: "rate-limit", httpStatusCode: null, providerCode: null });
    // A rate limit alone may be a passing 429: a blocked window makes it a quota.
    expect(newSpawns()).toHaveLength(0);
    await turnFailed({ category: "rate-limit", httpStatusCode: null, providerCode: null }, true);
    expect(newSpawns()).toHaveLength(1);
  });

  it("an unavailable model switches; an Adventure's own fallback profile is used", async () => {
    const { f, project, fail, newSpawns, notes } = await setup({ error: { message: "Muse modelError: model_not_found: muse-wonder-1.0" } });
    f.store.updateProject(project.id, { policy: { profiles: { reviewFallback: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" } } } });
    await fail();
    expect(newSpawns()[0]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" });
    expect(notes().at(-1)!.input[0]!.text).toContain("its model is unavailable → round 2 rerun on gpt-6.1-sol high");
  });

  it("a transient failure waits for BB's own retry", async () => {
    const { f, id, fail, turnFailed, newSpawns, notes } = await setup({ error: { message: "Muse is retrying (attempt 2 of 5): overloaded (HTTP 529)", errorInfo: { category: "overloaded", httpStatusCode: 529, providerCode: null } } });
    await fail();
    await turnFailed({ category: "overloaded", httpStatusCode: 529, providerCode: null });
    expect(newSpawns()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    expect(f.archive).not.toHaveBeenCalledWith({ threadId: id });
    expect(f.queued.get(id)).toHaveLength(1);
    expect(f.store.hasFlag(fallbackFlag(id))).toBe(false);
  });

  it("R8: a reviewer that finished a turn is left alone and the worker is told", async () => {
    const { f, w, id, fail, newSpawns, notes } = await setup({ finishedTurn: true });
    await fail();
    expect(newSpawns()).toHaveLength(0);
    expect(f.archive).not.toHaveBeenCalledWith({ threadId: id });
    const text = notes()[0]!.input[0]!.text;
    expect(notes()[0]!.threadId).toBe(w.threadId);
    expect(text).toContain("It had already finished a turn, so the plugin left it: a round that gave a verdict or findings stands.");
  });

  it("only a worker's reviewer: a worker's own helper and a coordinator's Muse child are left alone", async () => {
    const helper = await setup({ providerId: "claude-code", model: "claude-sonnet-5-5", error: { message: "Claude AI usage limit reached|1793577600" } });
    await helper.fail();
    expect(helper.newSpawns()).toHaveLength(0);
    expect(helper.notes()).toHaveLength(0);

    const otherModel = await setup({ model: "muse-sketch-1.0" });
    await otherModel.fail();
    expect(otherModel.newSpawns()).toHaveLength(0);

    const coordinatorChild = await setup({ parent: "coordinator" });
    await coordinatorChild.fail();
    expect(coordinatorChild.newSpawns()).toHaveLength(0);
  });

  it("the fallback is never switched in turn; one on the reviewer's model switches nothing", async () => {
    const first = await setup();
    await first.fail();
    const fallback = (await first.f.spawn.mock.results.at(-1)!.value) as { id: string };
    first.f.threads.set(fallback.id, { ...first.f.threads.get(fallback.id)!, status: "error" });
    first.f.history.push({ type: "provider/error", seq: 500, threadId: fallback.id, createdAt: 500, data: { message: "Claude AI usage limit reached|1793577600" } });
    await first.f.harness.emitThreadEvent("thread.failed", { thread: first.f.threads.get(fallback.id)!, error: "Claude AI usage limit reached" });
    expect(first.newSpawns()).toHaveLength(1);

    const same = await setup();
    same.f.store.updateProject(same.project.id, { policy: { profiles: { reviewFallback: { ...muse, reasoningLevel: "high" } } } });
    await same.fail();
    expect(same.newSpawns()).toHaveLength(0);
  });

  it("a fallback that can't start: the worker is told to run it, and the plugin does not try again", async () => {
    const { f, id, fail, notes } = await setup();
    f.intercept((path, _args, call) => {
      if (path === "threads.spawn") throw Object.assign(new Error("claude-code is not available"), { status: 400 });
      return call();
    });
    await fail();
    f.intercept();
    expect(f.archive).toHaveBeenCalledWith({ threadId: id });
    expect(notes().at(-1)!.input[0]!.text).toContain("The plugin could not rerun it on the fallback reviewer (claude-opus-5-5 high): claude-code is not available. Run the round again with the fallback reviewer command from your brief; if it can't run either, report blocked.");
    const before = f.spawn.mock.calls.length;
    f.threads.set(id, { ...f.threads.get(id)!, archivedAt: null });
    await fail();
    expect(f.spawn.mock.calls.length).toBe(before);
  });
});

describe("W545 a reviewer running again", () => {
  it("is left to that run; a reviewer whose retry is only queued is switched", async () => {
    const running = await setup();
    running.f.threads.set(running.id, { ...running.f.threads.get(running.id)!, status: "active" });
    await running.fail();
    expect(running.newSpawns()).toHaveLength(0);
    expect(running.f.store.hasFlag(fallbackFlag(running.id))).toBe(false);

    const queued = await setup();
    queued.f.threads.set(queued.id, { ...queued.f.threads.get(queued.id)!, status: "pending" });
    await queued.fail();
    expect(queued.newSpawns()).toHaveLength(1);
    expect(queued.f.queued.get(queued.id)).toEqual([]);
  });
});

describe("W545 review round 1 fixes", () => {
  it("any failure after the claim still reaches the worker", async () => {
    const { f, id, fail, notes, newSpawns } = await setup();
    f.intercept((path, _args, call) => {
      if (path === "threads.archive") throw Object.assign(new Error("archive refused"), { status: 409 });
      return call();
    });
    await fail();
    f.intercept();
    expect(newSpawns()).toHaveLength(0);
    expect(f.store.hasFlag(fallbackFlag(id))).toBe(true);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.input[0]!.text).toContain("The plugin could not rerun it on the fallback reviewer (claude-opus-5-5 high): archive refused. Run the round again with the fallback reviewer command from your brief");
  });

  it("reads only the failed turn's own error, not a retry notice or an earlier turn's", async () => {
    // An earlier attempt's quota error, then the failed turn's request, a retry notice and a plain crash.
    const { f, id, fail, newSpawns } = await setup({ error: { message: "Muse crashed: socket hang up" } });
    const requested = f.history.find((row) => row.threadId === id && row.type === "client/turn/requested")!;
    f.history.push({ type: "provider/error", seq: requested.seq - 1, threadId: id, createdAt: 1, data: { message: MUSE_QUOTA } });
    f.history.push({ type: "provider/error", seq: requested.seq + 1, threadId: id, createdAt: 1, data: { message: "Muse is retrying (attempt 2 of 5): rate limited (HTTP 429)", willRetry: true, errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } } });
    await fail("Muse crashed: socket hang up");
    expect(newSpawns()).toHaveLength(0);
    expect(f.store.hasFlag(fallbackFlag(id))).toBe(false);
  });

  it("a reviewer whose execution can't be read is left alone", async () => {
    const { f, fail, newSpawns, notes } = await setup();
    f.intercept((path, _args, call) => {
      if (path === "threads.defaultExecutionOptions") throw Object.assign(new Error("unavailable"), { status: 503 });
      return call();
    });
    await fail();
    f.intercept();
    expect(newSpawns()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });

  it("the brief shows a fallback command exactly when the plugin can switch to it", async () => {
    const { f, project } = await projectFixture({ executionProfiles: JSON.stringify({ reviewOfClaude: muse, reviewFallback: { ...muse, reasoningLevel: "high" } }) });
    void project;
    await tool(f, "initiative_spawn", { label: "Fix", purpose: "fix", text: "Fix it." });
    expect(f.spawn.mock.calls.at(-1)![0].prompt as string).not.toContain("Fallback reviewer command:");
  });
});

describe("W545 review round 2 fixes", () => {
  it("a worker that already started a fallback for the round keeps it; the plugin starts none", async () => {
    const { f, w, id, fail, newSpawns, notes } = await setup();
    f.threads.set("thr_own", { ...makeThreadResponse({ id: "thr_own", projectId: "proj_a", parentThreadId: w.threadId, providerId: "claude-code", status: "active", title: "Review r2 #389 (fallback)" }), createdAt: Date.now() + 1 });
    f.execution.set("thr_own", { model: "claude-opus-5-5", reasoningLevel: "high" });
    await fail();
    expect(newSpawns()).toHaveLength(0);
    expect(f.archive).toHaveBeenCalledWith({ threadId: id });
    expect(notes().at(-1)!.input[0]!.text).toContain("You already started thr_own on the fallback, so the plugin started none: that is this round's reviewer.");
  });

  it("a worker's own Muse helper (not titled as a review) is left alone", async () => {
    const helper = await setup({ title: "Investigate the lock waits" });
    await helper.fail();
    expect(helper.newSpawns()).toHaveLength(0);
    expect(helper.notes()).toHaveLength(0);
  });

  it("the failed turn's own stored classification wins over turn.failed's", async () => {
    const { turnFailed, newSpawns } = await setup({ error: { message: "Muse crashed", errorInfo: { category: "internal", httpStatusCode: null, providerCode: null } } });
    await turnFailed({ category: "rate-limit", httpStatusCode: 429, providerCode: null }, true);
    expect(newSpawns()).toHaveLength(0);
  });

  it("a stop or queue cleanup that fails is recorded and named to the worker", async () => {
    const { f, id, fail, newSpawns, notes } = await setup();
    f.intercept((path, _args, call) => {
      if (path === "threads.queuedMessages.delete") throw Object.assign(new Error("busy"), { status: 409 });
      return call();
    });
    await fail();
    f.intercept();
    expect(newSpawns()).toHaveLength(1);
    expect(notes().at(-1)!.input[0]!.text).toContain("It is archived, but deleting queued retry_1 (busy) failed: don't unarchive it, or a queued retry would run it again.");
    expect(f.store.db.prepare("SELECT summary FROM activity WHERE summary LIKE ?").pluck().all(`%${id}: archived, but%`)).toHaveLength(1);
  });
});

describe("W545 review round 3 fixes", () => {
  it("Claude Code and Codex keep the provider's words in detail: those are classified", async () => {
    // As BB's Claude Code bridge stores a session limit: a generic message, the text in detail.
    const claude = await setup({ error: { message: "Provider error", detail: "You've hit your session limit · resets 1:50pm", errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } } });
    await claude.fail("Provider error");
    expect(claude.newSpawns()).toHaveLength(1);
    expect(claude.notes()[0]!.input[0]!.text).toContain("is out of quota (usage limit): You've hit your session limit · resets 1:50pm");

    const transient = await setup({ error: { message: "Provider error", detail: "API Error: Server is temporarily limiting requests (not your usage limit)", errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } } });
    await transient.fail("Provider error");
    expect(transient.newSpawns()).toHaveLength(0);
  });

  it("an unreadable child listing hands the round to the worker rather than risk a second reviewer", async () => {
    const { f, fail, newSpawns, notes } = await setup();
    f.intercept((path, args, call) => {
      if (path === "threads.list" && args?.parentThreadId) throw Object.assign(new Error("list timed out"), { status: 503 });
      return call();
    });
    await fail();
    f.intercept();
    expect(newSpawns()).toHaveLength(0);
    expect(notes().at(-1)!.input[0]!.text).toContain("The plugin could not rerun it on the fallback reviewer (claude-opus-5-5 high): list timed out. Run the round again with the fallback reviewer command from your brief");
  });

  it("a claim a reload cut short goes back to the worker once; a finished one does not", async () => {
    const { f, w, id, notes } = await setup();
    // As a reload between the claim and the spawn leaves it: claimed, never done.
    f.store.setFlag(fallbackFlag(id));
    f.store.setFlag(fallbackFlag("thr_finished"));
    f.store.setFlag("reviewer-fallback-done:thr_finished");
    const recovering = new ReviewerFallback({ sdk: f.service.sdk, store: f.store, policy: async () => ({ profiles: {} }), warn: () => {} });
    await recovering.recover();
    await recovering.recover();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ threadId: w.threadId, mode: "steer-if-active" });
    expect(notes()[0]!.input[0]!.text).toContain(`The plugin restarted while rerunning your reviewer ${id} (Review r2 #389) on the fallback reviewer. If no fallback reviewer for that round is running among your child threads, run the round again with the fallback reviewer command from your brief.`);
  });
});

describe("W545 review round 4 fixes", () => {
  it("a review child on the fallback's provider but another model doesn't count as the worker's fallback", async () => {
    const { f, w, fail, newSpawns } = await setup();
    f.threads.set("thr_fable", { ...makeThreadResponse({ id: "thr_fable", projectId: "proj_a", parentThreadId: w.threadId, providerId: "claude-code", status: "active", title: "Review r2 #389" }), createdAt: Date.now() + 1 });
    f.execution.set("thr_fable", { model: "claude-fable-5-1", reasoningLevel: "xhigh" });
    await fail();
    expect(newSpawns()).toHaveLength(1);
  });
});

describe("W545 Fable review fixes", () => {
  it("a stop that fails on a thread that is not running is no warning; one still running is", async () => {
    const quiet = await setup();
    quiet.f.intercept((path, _args, call) => {
      if (path === "threads.stop") throw Object.assign(new Error("no runtime"), { status: 409 });
      return call();
    });
    await quiet.fail();
    quiet.f.intercept();
    expect(quiet.newSpawns()).toHaveLength(1);
    expect(quiet.notes().at(-1)!.input[0]!.text).not.toContain("stopping it");

    const running = await setup();
    running.f.intercept((path, _args, call) => {
      if (path === "threads.stop") {
        running.f.threads.set(running.id, { ...running.f.threads.get(running.id)!, status: "active" });
        throw Object.assign(new Error("daemon refused"), { status: 409 });
      }
      return call();
    });
    await running.fail();
    running.f.intercept();
    expect(running.notes().at(-1)!.input[0]!.text).toContain("It is archived, but stopping it (daemon refused) failed");
  });

  it("recover() reads unfinished claims in one query", async () => {
    const { f } = await setup();
    f.store.setFlag(fallbackFlag("a"));
    f.store.setFlag(fallbackFlag("b"));
    f.store.setFlag("reviewer-fallback-done:b");
    expect(f.store.unfinishedClaims(fallbackFlag(""), "reviewer-fallback-done:")).toEqual(["a"]);
  });

  it("a failed thread whose parent is no worker costs no BB call", async () => {
    const { f } = await setup();
    const calls: string[] = [];
    f.intercept((path, _args, call) => (calls.push(path), call()));
    const stranger = makeThreadResponse({ id: "thr_stranger", projectId: "proj_a", parentThreadId: "thr_unknown", providerId: "muse", status: "error", title: "Review r1" });
    await f.harness.emitThreadEvent("thread.failed", { thread: stranger, error: MUSE_QUOTA });
    f.intercept();
    expect(calls.filter((path) => path.startsWith("threads."))).toEqual([]);
  });
});
