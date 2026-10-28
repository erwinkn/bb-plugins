import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDeltaEventCollector,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcOutputMessage,
  type BridgeJsonRpcTestHarness,
  type ThreadEvent,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, shutdown } from "../src/bridge.js";
import { FAKE_MUSE, useFakeMuse } from "./harness.js";
import { MUSE_EXECUTABLE_ENV } from "../src/vocabulary.js";

const fake = useFakeMuse();

const OPTIONS = {
  full: {
    model: "muse-wonder-1.0",
    reasoningLevel: "low",
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
    instructions: "You are working inside bb.",
    envVars: { BB_PROJECT_ID: "proj_test" },
  },
  acceptEdits: {
    model: "muse-wonder-1.0",
    reasoningLevel: "high",
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
  },
} as const;

const STAMP_TOOL = {
  name: "echo_stamp",
  description: "Stamp text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  presentation: { label: { pending: "Stamping", completed: "Stamped" }, icon: { glyph: "Stamp" } },
};

type ItemEvent = Extract<ThreadEvent, { type: "item/started" | "item/completed" }>;

let harness: BridgeJsonRpcTestHarness;
let collector: BridgeDeltaEventCollector;
let workspace: string;
let counter = 0;
let threadCounter = 0;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "bb-muse-stream-")));
  harness = createBridgeJsonRpcTestHarness(handleLine);
  collector = createBridgeDeltaEventCollector("muse");
});

afterEach(async () => {
  await shutdown();
  harness.restore();
  rmSync(workspace, { recursive: true, force: true });
});

afterAll(shutdown);

async function call(method: string, params: BridgeJsonRpcObject): Promise<BridgeJsonRpcOutputMessage> {
  counter += 1;
  const id = `t-${counter}`;
  harness.sendRequest(id, method, params);
  return harness.waitForResponse(id);
}

async function ok(method: string, params: BridgeJsonRpcObject): Promise<Record<string, unknown>> {
  const response = await call(method, params);
  expect(response.error, `${method} failed: ${JSON.stringify(response.error)}`).toBeUndefined();
  return response.result as Record<string, unknown>;
}

async function until<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function events(): ThreadEvent[] {
  return harness.messages.flatMap((message) => collector.assembleMessage(message));
}

function completedItems(all: ThreadEvent[]): ItemEvent["item"][] {
  return all
    .filter((event): event is ItemEvent => event.type === "item/completed")
    .map((event) => event.item);
}

function deltas(threadId: string): Array<Record<string, unknown>> {
  return harness.messages
    .filter((message) => message.method === "thread/delta")
    .map((message) => message.params as { threadId: string; deltas: Array<Record<string, unknown>> })
    .filter((params) => params.threadId === threadId)
    .flatMap((params) => params.deltas);
}

function turnCompleted(threadId: string, count = 1): boolean {
  return deltas(threadId).filter((delta) => delta.kind === "turn.boundary").length >= count;
}

async function start(args: {
  options?: BridgeJsonRpcObject;
  dynamicTools?: BridgeJsonRpcObject[];
}): Promise<{ threadId: string; providerThreadId: string }> {
  threadCounter += 1;
  const threadId = `thr_muse_${threadCounter}`;
  const result = await ok("thread/start", {
    threadId,
    cwd: workspace,
    instructionMode: "append",
    options: args.options ?? OPTIONS.full,
    ...(args.dynamicTools ? { dynamicTools: args.dynamicTools } : {}),
  });
  return { threadId, providerThreadId: result.providerThreadId as string };
}

async function turn(
  session: { threadId: string; providerThreadId: string },
  text: string,
  options: BridgeJsonRpcObject = OPTIONS.full,
  clientRequestId = creq(),
): Promise<BridgeJsonRpcOutputMessage> {
  return call("turn/start", {
    threadId: session.threadId,
    providerThreadId: session.providerThreadId,
    input: [{ type: "text", text, mentions: [] }],
    clientRequestId,
    options,
  });
}

function answerRuntime(method: string, answer: (params: Record<string, unknown>) => unknown): Promise<Record<string, unknown>> {
  return until(() => {
    const request = harness.messages.find((message) => message.method === method && message.id !== undefined && !answered.has(message.id));
    if (request === undefined) return undefined;
    answered.add(request.id as string | number);
    handleLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answer(request.params as Record<string, unknown>) }));
    return request.params as Record<string, unknown>;
  }, method);
}
const answered = new Set<string | number>();

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
let requestCounter = 0;
/** A bb client request id: `creq_` and ten letters of its alphabet. */
function creq(): string {
  requestCounter += 1;
  let n = requestCounter;
  let tail = "";
  for (let index = 0; index < 10; index += 1) {
    tail = ALPHABET[n % ALPHABET.length] + tail;
    n = Math.floor(n / ALPHABET.length);
  }
  return `creq_${tail}`;
}

describe("a Muse turn with tools", () => {
  it("maps shell, read, edit and bb tool rows, usage and limits", async () => {
    const session = await start({ dynamicTools: [STAMP_TOOL] });
    const toolCall = answerRuntime("item/tool/call", () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "stamped: x" }],
    }));
    expect((await turn(session, "tools please")).error).toBeUndefined();
    expect(await toolCall).toMatchObject({
      providerThreadId: session.providerThreadId,
      threadId: session.threadId,
      tool: "echo_stamp",
      arguments: { text: "x" },
      providerNativeIds: true,
    });
    await until(() => turnCompleted(session.threadId), "turn end");

    const all = events();
    const types = all.map((event) => event.type);
    expect(types.filter((type) => type === "turn/started")).toHaveLength(1);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(1);
    expect(types.at(-1)).toBe("turn/completed");

    const items = completedItems(all);
    expect(items.map((item) => item.type)).toEqual([
      "commandExecution",
      "fileRead",
      "fileChange",
      "toolCall",
      "agentMessage",
    ]);
    expect(items[0]).toMatchObject({ command: "echo hi", cwd: workspace, exitCode: 0, aggregatedOutput: "hi\n", status: "completed" });
    expect(all.some((event) => event.type === "item/commandExecution/outputDelta")).toBe(true);
    expect(items[1]).toMatchObject({ path: join(workspace, "notes.txt") });
    expect(items[2]).toMatchObject({
      changes: [{ path: join(workspace, "notes.txt"), kind: "update", diff: "@@ -1,1 +1,1 @@\n-apple\n+pear\n" }],
    });
    expect(items[3]).toMatchObject({
      tool: "echo_stamp",
      server: "bb",
      result: "stamped: x",
      presentation: STAMP_TOOL.presentation,
    });
    expect(items[4]).toMatchObject({ text: "echo: tools please" });

    const usage = all.find((event) => event.type === "thread/tokenUsage/updated");
    expect(usage).toMatchObject({
      tokenUsage: {
        last: { inputTokens: 300, cachedInputTokens: 1800, cacheReadInputTokens: 1800, outputTokens: 70, totalTokens: 2170, reasoningOutputTokens: 5 },
        total: { totalTokens: 2170 },
      },
    });
    const sessionDeltas = deltas(session.threadId);
    expect(sessionDeltas).toContainEqual(
      expect.objectContaining({ kind: "contextWindow", used: 1120, size: 1007997, estimated: false }),
    );
    expect(sessionDeltas).toContainEqual(
      expect.objectContaining({
        kind: "provider.rateLimits",
        rateLimits: expect.objectContaining({ providerId: "muse", status: "allowed", kind: "subscription-window" }),
      }),
    );

    // How the session was built: sandbox off, bb's instructions, bb's tools.
    const launch = fake.frames().filter((frame) => Array.isArray(frame.argv)).at(-1) as {
      argv: string[];
      env: { BB_THREAD_ID: string };
    };
    expect(launch.argv).toEqual([
      "serve",
      "--trust-workspace",
      "--disable-sandbox",
      "-c",
      `run.developer_prompt=${JSON.stringify("You are working inside bb.")}`,
    ]);
    expect(launch.env.BB_THREAD_ID).toBe(session.threadId);
    const sessionStart = fake.frames().filter((frame) => frame.method === "session/start").at(-1) as {
      params: Record<string, unknown>;
    };
    expect(sessionStart.params).toMatchObject({
      sessionId: session.providerThreadId,
      workspaceRoot: workspace,
      modelId: "muse-wonder-1.0",
      approvalMode: "allowAll",
      permissionProfile: ":unrestricted",
      config: {
        mcpServers: {
          "bb-bridge": { transport: "streamableHttp", mode: "optional", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u) },
        },
      },
    });
    const turnStart = fake.frames().filter((frame) => frame.method === "turn/start").at(-1) as { params: Record<string, unknown> };
    expect(turnStart.params).toMatchObject({ reasoningEffort: "low", workspaceRoots: [workspace], displayText: "tools please" });
  });
});

describe("approvals and questions", () => {
  it("asks the user in accept-edits and carries the decision back", async () => {
    const session = await start({ options: OPTIONS.acceptEdits });
    const approval = answerRuntime("interaction/request", () => ({ decision: "allow_for_session", grantedPermissions: null }));
    await turn(session, "approve this", OPTIONS.acceptEdits);
    expect(await approval).toMatchObject({
      providerNativeIds: true,
      payload: {
        kind: "approval",
        subject: { kind: "command", command: "rm -rf build", cwd: workspace },
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
    await until(() => turnCompleted(session.threadId), "turn end");
    expect(completedItems(events()).find((item) => item.type === "agentMessage")).toMatchObject({ text: "choice c-session+c2-session" });
    // The row the approval belongs to is on screen before bb asks.
    const askedAt = harness.messages.findIndex((message) => message.method === "interaction/request");
    const openedAt = harness.messages.findIndex(
      (message) =>
        message.method === "thread/delta" &&
        (message.params as { deltas: Array<{ kind: string; item?: { type: string } }> }).deltas.some(
          (delta) => delta.kind === "item.open" && delta.item?.type === "command",
        ),
    );
    expect(openedAt).toBeGreaterThanOrEqual(0);
    expect(openedAt).toBeLessThan(askedAt);
    const commands = completedItems(events()).filter((item) => item.type === "commandExecution");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "rm -rf build", status: "completed", aggregatedOutput: "removed\n" });
    const sessionStart = fake.frames().filter((frame) => frame.method === "session/start").at(-1) as {
      params: Record<string, unknown>;
    };
    expect(sessionStart.params).toMatchObject({ approvalMode: "promptUnmatched", permissionProfile: ":ask-me" });
  });

  it("approves on its own in full mode", async () => {
    const session = await start({});
    await turn(session, "approve this");
    await until(() => turnCompleted(session.threadId), "turn end");
    expect(harness.messages.some((message) => message.method === "interaction/request")).toBe(false);
    expect(completedItems(events()).find((item) => item.type === "agentMessage")).toMatchObject({ text: "choice c-once+c2-once" });
  });

  it("shows a denied command as denied", async () => {
    const session = await start({ options: OPTIONS.acceptEdits });
    void answerRuntime("interaction/request", () => ({ decision: "deny" }));
    await turn(session, "approve this", OPTIONS.acceptEdits);
    await until(() => turnCompleted(session.threadId), "turn end");
    const close = deltas(session.threadId).find((delta) => delta.kind === "item.close" && (delta.item as { type: string }).type === "command");
    expect(close).toMatchObject({ status: "failed", approvalStatus: "denied" });
    expect(completedItems(events()).find((item) => item.type === "agentMessage")).toMatchObject({ text: "choice c-abort" });
  });

  it("asks Muse's question through bb and answers with the chosen label", async () => {
    const session = await start({});
    const question = answerRuntime("interaction/request", () => ({
      kind: "user_answer",
      answers: { q1: { selected: ["Blue"], freeText: "but darker" } },
    }));
    await turn(session, "ask me");
    expect(await question).toMatchObject({
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "Which color?",
            shortLabel: "Color",
            multiSelect: false,
            allowFreeText: true,
            options: [{ value: "Red", label: "Red" }, { value: "Blue", label: "Blue", description: "Calm" }],
          },
        ],
      },
    });
    await until(() => turnCompleted(session.threadId), "turn end");
    expect(completedItems(events()).find((item) => item.type === "agentMessage")).toMatchObject({
      text: `answers ${JSON.stringify([{ questionId: "q1", selectedLabel: "Blue", note: "but darker" }])}`,
    });
  });
});

describe("turn control", () => {
  it("interrupts a running turn and settles it before answering the stop", async () => {
    const session = await start({});
    await turn(session, "hang on");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    const stop = await ok("thread/stop", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    expect(stop).toEqual({});
    const completed = events().filter((event) => event.type === "turn/completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "interrupted" });
    expect(fake.frames().some((frame) => frame.method === "turn/interrupt")).toBe(true);
  });

  it("steers the live turn", async () => {
    const session = await start({});
    await turn(session, "hang on");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    const steer = await call("turn/steer", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      input: [{ type: "text", text: "go on", mentions: [] }],
      clientRequestId: creq(),
      expectedTurnId: "bb-turn",
      options: OPTIONS.full,
    });
    expect(steer.error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const all = events();
    expect(all.filter((event) => event.type === "turn/input/accepted")).toHaveLength(2);
    expect(completedItems(all).find((item) => item.type === "agentMessage")).toMatchObject({ text: "steered reply" });
  });

  it("refuses a steer with no running turn as stale", async () => {
    const session = await start({});
    const steer = await call("turn/steer", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      input: [{ type: "text", text: "late", mentions: [] }],
      clientRequestId: creq(),
      expectedTurnId: "bb-turn",
      options: OPTIONS.full,
    });
    expect(steer.error).toMatchObject({ data: { recovery: { kind: "staleTurn" } } });
  });
});

describe("failures", () => {
  it("shows a usage limit and hints the runtime", async () => {
    const session = await start({});
    await turn(session, "fail now");
    await until(() => turnCompleted(session.threadId), "turn end");
    const all = events();
    expect(all.find((event) => event.type === "turn/completed")).toMatchObject({ status: "failed" });
    expect(deltas(session.threadId)).toContainEqual(
      expect.objectContaining({ kind: "provider.error", errorInfo: expect.objectContaining({ category: "rate-limit" }), message: expect.stringContaining("usage limit") }),
    );
    // W545: bb stores the classification with the error, where turn.failed listeners read it.
    expect(all.find((event) => event.type === "provider/error")).toMatchObject({
      errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
    });
    expect(harness.messages.find((message) => message.method === "provider/recovery")?.params).toMatchObject({
      threadId: session.threadId,
      kind: "rateLimited",
      retryable: false,
    });
  });

  it("fails the turn when Muse dies and restarts it on the next turn", async () => {
    const session = await start({});
    await turn(session, "crash now");
    await until(() => turnCompleted(session.threadId), "turn end");
    expect(events().find((event) => event.type === "turn/completed")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("Muse exited unexpectedly (code 70: fake muse: simulated crash)") },
    });
    // What streamed before the crash survives the forced settle.
    expect(completedItems(events()).find((item) => item.type === "agentMessage")).toMatchObject({ text: "about to crash" });
    expect((await turn(session, "hello again")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId, 2), "second turn end");
    expect(harness.messages.find((message) => message.method === "session/replaced")?.params).toMatchObject({
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      contextLost: false,
    });
    expect(fake.frames().some((frame) => frame.method === "session/resume")).toBe(true);
  });

  it("rebuilds the host when the permission mode changes", async () => {
    const session = await start({});
    await turn(session, "one", OPTIONS.acceptEdits);
    await until(() => turnCompleted(session.threadId), "turn end");
    const launches = fake.frames().filter((frame) => Array.isArray(frame.argv)) as Array<{ argv: string[] }>;
    expect(launches.at(-1)?.argv).not.toContain("--disable-sandbox");
    const resume = fake.frames().filter((frame) => frame.method === "session/resume").at(-1) as { params: Record<string, unknown> };
    expect(resume.params).toMatchObject({ sessionId: session.providerThreadId, permissionProfile: ":ask-me" });
    expect(fake.frames().filter((frame) => frame.method === "session/setApprovalMode").at(-1)).toMatchObject({
      params: { mode: "promptUnmatched" },
    });
  });

  it.each(["go idle", "go idle silently"])("reattaches a session Muse unloaded (%s)", async (prompt) => {
    const session = await start({});
    await turn(session, prompt);
    await until(() => turnCompleted(session.threadId), "turn end");
    expect((await turn(session, "hello again")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId, 2), "second turn end");
    const resumes = fake.frames().filter(
      (frame) => frame.method === "session/resume" && (frame.params as { sessionId: string }).sessionId === session.providerThreadId,
    );
    expect(resumes).toHaveLength(1);
    expect(harness.messages.some((message) => message.method === "session/replaced")).toBe(false);
  });

  it("reports a session Muse no longer has as not restorable", async () => {
    const response = await call("thread/resume", {
      threadId: "thr_missing",
      providerThreadId: "missing-session",
      cwd: workspace,
      instructionMode: "append",
      options: OPTIONS.full,
    });
    expect(response.error).toMatchObject({ code: -32002 });
  });
});

describe("sessionless requests", () => {
  it("lists models with their reasoning levels", async () => {
    const result = await ok("model/list", { cwd: workspace });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: "muse-wonder-1.0",
        displayName: "Muse Wonder 1.0",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((level) =>
          expect.objectContaining({ reasoningEffort: level }),
        ),
      }),
      expect.objectContaining({
        id: "muse-spark-1.2",
        isDefault: false,
        supportedReasoningEfforts: [
          expect.objectContaining({ reasoningEffort: "low" }),
          { reasoningEffort: "high", description: "Deepest" },
        ],
      }),
    ]);
  });

  it("reports health from the probe's handshake and the account", async () => {
    const result = await ok("provider/health", { providerId: "muse" });
    expect(result).toMatchObject({
      supported: true,
      health: { status: "ready", installedVersion: "9.9.9-fake", accountEmail: "erwin@example.com", loginCommand: "muse login" },
    });
    // The version comes from the probe host, not a `muse --version` of its own.
    const launches = fake.frames().filter((frame) => Array.isArray(frame.argv)) as Array<{ argv: string[] }>;
    expect(launches.every((launch) => launch.argv[0] === "serve")).toBe(true);
  });

  it("finds Muse on PATH past a directory of the same name", async () => {
    const shadow = join(workspace, "shadow");
    const bin = join(workspace, "bin");
    mkdirSync(join(shadow, "muse"), { recursive: true });
    mkdirSync(bin);
    symlinkSync(FAKE_MUSE, join(bin, "muse"));
    const saved = { executable: process.env[MUSE_EXECUTABLE_ENV], path: process.env.PATH };
    delete process.env[MUSE_EXECUTABLE_ENV];
    process.env.PATH = [shadow, bin, dirname(process.execPath)].join(delimiter);
    try {
      const result = await ok("provider/health", { providerId: "muse" });
      expect(result).toMatchObject({ health: { status: "ready", installedVersion: "9.9.9-fake" } });
      const launches = fake.frames().filter((frame) => Array.isArray(frame.argv)) as Array<{ argv: string[] }>;
      expect(launches.at(-1)?.argv[0]).toBe("serve");
    } finally {
      process.env[MUSE_EXECUTABLE_ENV] = saved.executable;
      process.env.PATH = saved.path;
    }
  });

  it("reports the subscription windows Muse last observed", async () => {
    const session = await start({});
    await turn(session, "hi");
    await until(() => turnCompleted(session.threadId), "turn end");
    const result = await ok("provider/usage", { providerId: "muse" });
    expect(result).toEqual({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: [
          { label: "5-hour window", usedPercent: 41, resetsAt: new Date(1792411462000).toISOString() },
          { label: "Weekly", usedPercent: 13, resetsAt: new Date(1792972800000).toISOString() },
        ],
      },
    });
  });
});

describe("compaction", () => {
  it("turns bb's /compact into session/compact and settles a no-op", async () => {
    const { COMPACT_INPUT } = await import("./harness.js");
    const session = await start({});
    const response = await call("turn/start", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      input: COMPACT_INPUT,
      clientRequestId: creq(),
      options: OPTIONS.full,
    });
    expect(response.error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const mine = fake.frames().filter(
      (frame) => (frame.params as { sessionId?: string } | undefined)?.sessionId === session.providerThreadId,
    );
    expect(mine.some((frame) => frame.method === "session/compact")).toBe(true);
    expect(mine.some((frame) => frame.method === "turn/start")).toBe(false);
    const types = events().map((event) => event.type);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(1);
    expect(events().find((event) => event.type === "turn/completed")).toMatchObject({ status: "completed" });
    expect(deltas(session.threadId)).toContainEqual(expect.objectContaining({ kind: "provider.warning" }));
  });
});

describe("races and cleanup", () => {
  it("survives a Muse that cannot start", async () => {
    const saved = process.env.BB_MUSE_EXECUTABLE;
    process.env.BB_MUSE_EXECUTABLE = "/nonexistent/muse";
    try {
      const response = await call("thread/start", {
        threadId: "thr_no_muse",
        cwd: workspace,
        instructionMode: "append",
        options: OPTIONS.full,
      });
      expect(response.error?.message).toMatch(/Muse/u);
    } finally {
      process.env.BB_MUSE_EXECUTABLE = saved;
    }
    // The bridge is still alive and serves the next thread.
    const session = await start({});
    await turn(session, "hi");
    await until(() => turnCompleted(session.threadId), "turn end");
  });

  it("stops a thread that is still being constructed", async () => {
    process.env.FAKE_MUSE_START_DELAY_MS = "400";
    try {
      counter += 1;
      const startId = `t-${counter}`;
      harness.sendRequest(startId, "thread/start", {
        threadId: "thr_slow",
        cwd: workspace,
        instructionMode: "append",
        options: OPTIONS.full,
      });
      await until(() => fake.frames().some((frame) => frame.method === "session/start" && JSON.stringify(frame).includes(workspace)), "session/start sent");
      const stop = await call("thread/stop", { threadId: "thr_slow", providerThreadId: "unknown", intent: "release", activeTurnId: null });
      expect(stop.error, JSON.stringify(stop.error)).toBeUndefined();
      const stoppedAt = harness.messages.length;
      const started = await harness.waitForResponse(startId);
      expect(started.error).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const late = harness.messages.slice(stoppedAt).filter(
        (message) => (message.params as { threadId?: string } | undefined)?.threadId === "thr_slow",
      );
      expect(late).toEqual([]);
    } finally {
      delete process.env.FAKE_MUSE_START_DELAY_MS;
    }
  });

  it("accepts the input of a turn whose whole life arrives in one chunk", async () => {
    const session = await start({});
    await turn(session, "batch please");
    await until(() => turnCompleted(session.threadId), "turn end");
    const types = events().map((event) => event.type);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(1);
    expect(types.indexOf("turn/input/accepted")).toBeLessThan(types.indexOf("turn/completed"));
    expect(completedItems(events()).find((item) => item.type === "agentMessage")).toMatchObject({ text: "all at once" });
  });

  it("accepts a steer whose ack and the turn's end arrive together", async () => {
    const session = await start({});
    await turn(session, "hang steer-ends");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    const steer = await call("turn/steer", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      input: [{ type: "text", text: "and then", mentions: [] }],
      clientRequestId: creq(),
      expectedTurnId: "bb-turn",
      options: OPTIONS.full,
    });
    expect(steer.error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const types = events().map((event) => event.type);
    const accepted = types.flatMap((type, index) => (type === "turn/input/accepted" ? [index] : []));
    expect(accepted).toHaveLength(2);
    expect(Math.max(...accepted)).toBeLessThan(types.indexOf("turn/completed"));
  });

  it("kills what Muse leaves in its process group when it dies", async () => {
    const session = await start({});
    await turn(session, "orphan now");
    await until(() => turnCompleted(session.threadId), "turn end");
    const pid = (fake.frames().find((frame) => typeof frame.orphanPid === "number") as { orphanPid: number }).orphanPid;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the orphan to die");
  });

  it("cancels Muse's question when it refuses the answer", async () => {
    const session = await start({});
    void answerRuntime("interaction/request", () => ({ kind: "user_answer", answers: { q1: { selected: ["Red"] } } }));
    await turn(session, "ask strict");
    await until(() => fake.frames().some((frame) => frame.method === "userInput/cancel"), "userInput/cancel");
    await until(() => turnCompleted(session.threadId), "turn end");
  });

  it("sends nothing for a thread once its stop is answered", async () => {
    const session = await start({ options: OPTIONS.acceptEdits });
    await turn(session, "approve this", OPTIONS.acceptEdits);
    const request = await until(
      () => harness.messages.find((message) => message.method === "interaction/request" && message.id !== undefined),
      "the approval",
    );
    const stop = await call("thread/stop", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    expect(stop.error).toBeUndefined();
    const stoppedAt = harness.messages.length;
    handleLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "too late" } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const late = harness.messages.slice(stoppedAt).filter(
      (message) => (message.params as { threadId?: string } | undefined)?.threadId === session.threadId,
    );
    expect(late).toEqual([]);
    expect(events().filter((event) => event.type === "turn/completed")).toHaveLength(1);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("round 2 races", () => {
  it("cancels a construction stopped before it awaited anything", async () => {
    counter += 2;
    const startId = `t-${counter - 1}`;
    const stopId = `t-${counter}`;
    harness.sendRequest(startId, "thread/start", { threadId: "thr_instant", cwd: workspace, instructionMode: "append", options: OPTIONS.full });
    harness.sendRequest(stopId, "thread/stop", { threadId: "thr_instant", providerThreadId: "unknown", intent: "release", activeTurnId: null });
    const stop = await harness.waitForResponse(stopId);
    expect(stop.error).toBeUndefined();
    const stoppedAt = harness.messages.length;
    expect((await harness.waitForResponse(startId)).error).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const late = harness.messages.slice(stoppedAt).filter(
      (message) => (message.params as { threadId?: string } | undefined)?.threadId === "thr_instant",
    );
    expect(late).toEqual([]);
  });

  it("accepts a turn's input when Muse acks only after the turn ended", async () => {
    const session = await start({});
    expect((await turn(session, "late-ack please")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const types = events().map((event) => event.type);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(1);
    expect(types.indexOf("turn/input/accepted")).toBeLessThan(types.indexOf("turn/completed"));
  });

  it("holds the turn's end until Muse answers a steer into it", async () => {
    const session = await start({});
    await turn(session, "hang late-steer");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    const steer = await call("turn/steer", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      input: [{ type: "text", text: "and then", mentions: [] }],
      clientRequestId: creq(),
      expectedTurnId: "bb-turn",
      options: OPTIONS.full,
    });
    expect(steer.error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const types = events().map((event) => event.type);
    const accepted = types.flatMap((type, index) => (type === "turn/input/accepted" ? [index] : []));
    expect(accepted).toHaveLength(2);
    expect(Math.max(...accepted)).toBeLessThan(types.indexOf("turn/completed"));
  });

  it("settles when Muse exits while a descendant holds its pipes", async () => {
    const session = await start({});
    await turn(session, "pipe-orphan now");
    await until(() => turnCompleted(session.threadId), "turn end", 6_000);
    expect(events().find((event) => event.type === "turn/completed")).toMatchObject({ status: "failed" });
    const pid = (fake.frames().find((frame) => typeof frame.pipeOrphanPid === "number") as { pipeOrphanPid: number }).pipeOrphanPid;
    await until(() => !alive(pid), "the pipe holder to die");
  });

  it("kills a SIGTERM-proof shell before the bridge shuts down", async () => {
    const session = await start({});
    await turn(session, "stubborn shell");
    await until(() => turnCompleted(session.threadId), "turn end");
    const pid = (fake.frames().find((frame) => typeof frame.stubbornPid === "number") as { stubbornPid: number }).stubbornPid;
    expect(alive(pid)).toBe(true);
    await shutdown();
    await until(() => !alive(pid), "the stubborn shell to die", 1_000);
  });

  it("reports health as unknown when Muse cannot say who is signed in", async () => {
    process.env.FAKE_MUSE_ACCOUNT_ERROR = "1";
    try {
      const result = await ok("provider/health", { providerId: "muse" });
      expect(result).toMatchObject({ health: { status: "unknown", statusMessage: expect.stringContaining("config unreadable") } });
    } finally {
      delete process.env.FAKE_MUSE_ACCOUNT_ERROR;
    }
  });
});

// W524's last open review findings; each is a case the ordered session rules out.
describe("the ordered session", () => {
  function messagesFor(threadId: string, from: number) {
    return harness.messages.slice(from).filter(
      (message) => (message.params as { threadId?: string } | undefined)?.threadId === threadId,
    );
  }

  it("answers a stop only once a SIGTERM-proof shell is dead", async () => {
    const session = await start({});
    await turn(session, "stubborn shell");
    await until(() => turnCompleted(session.threadId), "turn end");
    const pid = (fake.frames().filter((frame) => typeof frame.stubbornPid === "number").at(-1) as { stubbornPid: number }).stubbornPid;
    expect(alive(pid)).toBe(true);
    await ok("thread/stop", { threadId: session.threadId, providerThreadId: session.providerThreadId, intent: "release", activeTurnId: null });
    expect(alive(pid)).toBe(false);
  });

  it("accepts a steer Muse acks seconds after the turn completed", async () => {
    const session = await start({});
    await turn(session, "hang slow-steer");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    const steer = await call("turn/steer", {
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      input: [{ type: "text", text: "and then", mentions: [] }],
      clientRequestId: creq(),
      expectedTurnId: "bb-turn",
      options: OPTIONS.full,
    });
    expect(steer.error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const types = events().map((event) => event.type);
    const accepted = types.flatMap((type, index) => (type === "turn/input/accepted" ? [index] : []));
    expect(accepted).toHaveLength(2);
    expect(Math.max(...accepted)).toBeLessThan(types.indexOf("turn/completed"));
  }, 15_000);

  it("settles an acknowledged input when Muse exits before starting its turn", async () => {
    const session = await start({});
    expect((await turn(session, "ack-exit now")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const all = events();
    const types = all.map((event) => event.type);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(1);
    expect(types.indexOf("turn/input/accepted")).toBeLessThan(types.indexOf("turn/completed"));
    expect(all.find((event) => event.type === "turn/completed")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("Muse exited unexpectedly (code 73") },
    });
  });

  it("settles an acknowledged input when Muse reclaims its queued turn", async () => {
    const session = await start({});
    expect((await turn(session, "unqueue me")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const types = events().map((event) => event.type);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(1);
    expect(events().find((event) => event.type === "turn/completed")).toMatchObject({ status: "interrupted" });
  });

  it("keeps a backgrounded shell open past its turn and shows how it ended", async () => {
    const session = await start({});
    await turn(session, "background build");
    await until(() => turnCompleted(session.threadId), "turn end");
    const background = (delta: Record<string, unknown>) => (delta.item as { type?: string } | undefined)?.type === "backgroundTask";
    const atBoundary = deltas(session.threadId);
    expect(atBoundary.some((delta) => delta.kind === "item.open" && background(delta))).toBe(true);
    expect(atBoundary.some((delta) => delta.kind === "item.close" && background(delta))).toBe(false);
    const close = await until(
      () => deltas(session.threadId).find((delta) => delta.kind === "item.close" && background(delta)),
      "the background shell to settle",
    );
    expect(close).toMatchObject({
      status: "failed",
      item: { type: "backgroundTask", taskType: "local_bash", description: "make test", taskStatus: "failed", summary: "1 failing\n" },
    });
    // bb settles it at thread scope, after the turn.
    const all = events();
    const settled = all.filter((event) => event.type === "item/backgroundTask/completed");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ item: { status: "failed", taskStatus: "failed" } });
    expect(all.indexOf(settled[0] as ThreadEvent)).toBeGreaterThan(all.findIndex((event) => event.type === "turn/completed"));
  });

  it("ends a report turn Muse starts while a stop is under way", async () => {
    const session = await start({});
    await turn(session, "hang report-on-stop");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    const stopAt = Date.now();
    await ok("thread/stop", { threadId: session.threadId, providerThreadId: session.providerThreadId, intent: "interrupt", activeTurnId: null });
    expect(Date.now() - stopAt).toBeLessThan(2_000);
    // Whether the report reaches bb before the release depends on timing; either way every turn closes.
    const all = deltas(session.threadId);
    expect(all.filter((delta) => delta.kind === "turn.open").length).toBe(all.filter((delta) => delta.kind === "turn.boundary").length);
    expect(events().filter((event) => event.type === "turn/completed").every((event) => (event as { status: string }).status === "interrupted")).toBe(true);
  });

  it("sends nothing after a stop that beats the first turn of thread/start", async () => {
    counter += 2;
    const startId = `t-${counter - 1}`;
    const stopId = `t-${counter}`;
    harness.sendRequest(startId, "thread/start", {
      threadId: "thr_first_turn",
      cwd: workspace,
      instructionMode: "append",
      options: OPTIONS.full,
      input: [{ type: "text", text: "hang on", mentions: [] }],
    });
    expect((await harness.waitForResponse(startId)).error).toBeUndefined();
    harness.sendRequest(stopId, "thread/stop", { threadId: "thr_first_turn", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    expect((await harness.waitForResponse(stopId)).error).toBeUndefined();
    const stoppedAt = harness.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(messagesFor("thr_first_turn", stoppedAt)).toEqual([]);
  });
});

// Review r1 of the ordered session: a host's work ends with the host.
describe("a host's work ends with it", () => {
  const stopParams = (session: { threadId: string; providerThreadId: string }) => ({
    threadId: session.threadId,
    providerThreadId: session.providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  const latestStubborn = () =>
    (fake.frames().filter((frame) => typeof frame.stubbornPid === "number").at(-1) as { stubbornPid: number }).stubbornPid;

  it("ends a running turn before replacing Muse for a new permission mode", async () => {
    const session = await start({});
    await turn(session, "hang forever");
    await until(() => events().some((event) => event.type === "turn/started"), "turn start");
    expect((await turn(session, "next ordinary reply", OPTIONS.acceptEdits)).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId, 2), "both turns end");
    const all = events();
    expect(all.filter((event) => event.type === "turn/completed").map((event) => (event as { status: string }).status)).toEqual([
      "interrupted",
      "completed",
    ]);
    expect(all.filter((event) => event.type === "turn/input/accepted")).toHaveLength(2);
    expect(completedItems(all).find((item) => item.type === "agentMessage")).toMatchObject({ text: "echo: next ordinary reply" });
  });

  it("makes a second stop wait for the first one's cleanup", async () => {
    const session = await start({});
    await turn(session, "stubborn shell");
    await until(() => turnCompleted(session.threadId), "turn end");
    const pid = latestStubborn();
    const first = call("thread/stop", stopParams(session));
    await ok("thread/stop", stopParams(session));
    expect(alive(pid)).toBe(false);
    expect((await first).error).toBeUndefined();
  });

  it("makes shutdown wait for a stop under way", async () => {
    const session = await start({});
    await turn(session, "stubborn shell");
    await until(() => turnCompleted(session.threadId), "turn end");
    const pid = latestStubborn();
    const stopping = call("thread/stop", stopParams(session));
    await shutdown();
    expect(alive(pid)).toBe(false);
    expect((await stopping).error).toBeUndefined();
  });

});

// Review r2 of the ordered session.
describe("ownership", () => {
  it("shows the failure of a turn bb never saw start", async () => {
    const session = await start({});
    await turn(session, "unknown-failed-report now");
    await until(() => harness.messages.some((message) => message.method === "provider/recovery"), "the recovery hint");
    const boundaries = deltas(session.threadId).filter((delta) => delta.kind === "turn.boundary");
    expect(boundaries.map((delta) => delta.status)).toEqual(["completed"]);
    expect(deltas(session.threadId).filter((delta) => delta.kind === "provider.error")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Please log in"), threadScoped: true }),
    ]);
    expect(harness.messages.find((message) => message.method === "provider/recovery")?.params).toMatchObject({ kind: "authRequired" });
  });
  it("leaves a new session's requests alone when the thread's previous session finishes stopping", async () => {
    const session = await start({});
    await turn(session, "stubborn shell");
    await until(() => turnCompleted(session.threadId), "turn end");
    const stopping = call("thread/stop", { threadId: session.threadId, providerThreadId: session.providerThreadId, intent: "release", activeTurnId: null });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const restarted = await ok("thread/start", { threadId: session.threadId, cwd: workspace, instructionMode: "append", options: OPTIONS.full });
    const again = { threadId: session.threadId, providerThreadId: restarted.providerThreadId as string };
    await turn(again, "ask me");
    await until(() => harness.messages.some((message) => message.method === "interaction/request"), "the question");
    expect((await stopping).error).toBeUndefined();
    void answerRuntime("interaction/request", () => ({ kind: "user_answer", answers: { q1: { selected: ["Red"] } } }));
    await until(() => turnCompleted(session.threadId, 2), "the question turn");
    const cancels = fake.frames().filter(
      (frame) => frame.method === "userInput/cancel" && (frame.params as { sessionId?: string }).sessionId === again.providerThreadId,
    );
    expect(cancels).toEqual([]);
  });

  it("stops a model-list probe host before shutdown returns", async () => {
    process.env.FAKE_MUSE_PROBE_DELAY_MS = "1500";
    try {
      const listing = call("model/list", { cwd: workspace });
      const pid = await until(
        () => (fake.frames().filter((frame) => typeof frame.probeShellPid === "number").at(-1) as { probeShellPid: number } | undefined)?.probeShellPid,
        "the probe's shell",
      );
      await shutdown();
      expect(alive(pid)).toBe(false);
      expect((await listing).error).toBeDefined();
    } finally {
      delete process.env.FAKE_MUSE_PROBE_DELAY_MS;
    }
  });
});

// Option 1 for a stream Muse cannot keep whole: fail the turn, resume next turn.
describe("a live stream with a hole", () => {
  function launches(): Array<{ argv: string[]; pid: number }> {
    return fake.frames().filter((frame) => Array.isArray(frame.argv)) as Array<{ argv: string[]; pid: number }>;
  }

  it.each([
    ["a view/gap", "gap-mid now", "dropped events from"],
    ["an unavailable view", "view-down now", "live stream for this thread went down"],
  ])("fails the turn on %s, then resumes the session from Muse's record on the next turn", async (_, prompt, said) => {
    const session = await start({});
    const clientRequestId = creq();
    expect((await turn(session, prompt, OPTIONS.full, clientRequestId)).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId), "turn end");
    const first = launches().at(-1)!;
    await until(() => !alive(first.pid), "the old Muse to exit");

    const all = events();
    expect(all.filter((event) => event.type === "turn/input/accepted")).toHaveLength(1);
    expect(all.find((event) => event.type === "turn/completed")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining(said) },
    });
    expect(deltas(session.threadId).find((delta) => delta.kind === "provider.error")).toMatchObject({
      message: expect.stringContaining("Send a message to continue"),
    });
    // What streamed before the hole stays; nothing Muse sent after it is shown.
    expect(completedItems(all).find((item) => item.type === "agentMessage")).toMatchObject({ text: "before the hole" });
    expect(JSON.stringify(harness.messages)).not.toContain("after the hole");
    expect(fake.frames().some((frame) => frame.method === "view/page")).toBe(false);

    expect((await turn(session, "hello again")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId, 2), "second turn end");
    expect(launches().at(-1)!.pid).not.toBe(first.pid);
    const resumed = fake.frames().filter(
      (frame) => frame.method === "session/resume" && (frame.params as { sessionId?: string }).sessionId === session.providerThreadId,
    );
    expect(resumed).toHaveLength(1);
    expect(events().filter((event) => event.type === "turn/completed").at(-1)).toMatchObject({ status: "completed" });
    expect(completedItems(events()).some((item) => item.type === "agentMessage" && item.text === "echo: hello again")).toBe(true);
  });

  it("shows a hole between turns on the thread and resumes on the next turn", async () => {
    const session = await start({});
    await turn(session, "gap-after now");
    await until(
      () => deltas(session.threadId).some((delta) => delta.kind === "provider.error"),
      "the thread-level error",
    );
    expect(deltas(session.threadId).filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(deltas(session.threadId).find((delta) => delta.kind === "provider.error")).toMatchObject({ threadScoped: true });
    expect((await turn(session, "hello again")).error).toBeUndefined();
    await until(() => turnCompleted(session.threadId, 2), "second turn end");
    expect(deltas(session.threadId).filter((delta) => delta.kind === "turn.boundary").at(-1)).toMatchObject({ status: "completed" });
  });
});

describe("nothing outlives shutdown", () => {
  /** Live processes, reparented ones included, whose environment carries `marker`. */
  function marked(marker: string): number[] {
    const found: number[] = [];
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try {
        if (!readFileSync(`/proc/${pid}/environ`, "latin1").includes(marker)) continue;
        // The state follows the command name in parentheses; Z is a zombie.
        const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
        if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z") found.push(pid);
      } catch {
        // Gone, or another user's.
      }
    }
    return found;
  }

  it.skipIf(process.platform !== "linux")(
    "leaves no process behind when the bridge shuts down mid-turn, mid-health-check and mid-model-list",
    async () => {
      const marker = `MUSE_TEST_MARK=${process.pid}-${Date.now()}`;
      const [key, value] = marker.split("=") as [string, string];
      process.env[key] = value;
      process.env.FAKE_MUSE_PROBE_DELAY_MS = "1500";
      try {
        const shells = fake.frames().filter((frame) => typeof frame.stubbornPid === "number").length;
        await turn(await start({}), "stubborn shell");
        await until(() => fake.frames().filter((frame) => typeof frame.stubbornPid === "number").length > shells, "the stubborn shell");
        await turn(await start({}), "hang on");
        const launched = fake.frames().filter((frame) => Array.isArray(frame.argv)).length;
        const probeShells = fake.frames().filter((frame) => typeof frame.probeShellPid === "number").length;
        const listing = call("model/list", { cwd: workspace });
        await until(
          () => fake.frames().filter((frame) => typeof frame.probeShellPid === "number").length > probeShells,
          "the model-list probe's shell",
        );
        const health = call("provider/health", { providerId: "muse" });
        // Whatever health launches first, a probe host or anything else.
        await until(() => fake.frames().filter((frame) => Array.isArray(frame.argv)).length > launched + 1, "health's launch");
        // The check sees both Muse hosts, their shells and the probes before shutdown.
        expect(marked(marker).length).toBeGreaterThanOrEqual(5);
        await shutdown();
        expect(marked(marker)).toEqual([]);
        await Promise.all([health, listing]);
      } finally {
        delete process.env[key];
        delete process.env.FAKE_MUSE_PROBE_DELAY_MS;
      }
    },
  );

  it.skipIf(process.platform !== "linux")("launches nothing for a health check under way when shutdown begins", async () => {
    const marker = `MUSE_TEST_MARK=${process.pid}-${Date.now()}`;
    const [key, value] = marker.split("=") as [string, string];
    process.env[key] = value;
    try {
      const launched = fake.frames().filter((frame) => Array.isArray(frame.argv)).length;
      const health = call("provider/health", { providerId: "muse" });
      await shutdown();
      expect(marked(marker)).toEqual([]);
      await health;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fake.frames().filter((frame) => Array.isArray(frame.argv)).length).toBe(launched);
    } finally {
      delete process.env[key];
    }
  });
});
