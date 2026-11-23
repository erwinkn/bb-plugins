/**
 * OptChat on ACP: the bridge asks `claude_code_turn_context` before each new turn of a thread
 * whose tools include it, and runs the turn where the answer says, against the fake ACP agent.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_JSON_RPC_ERRORS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  type DynamicTool,
} from "../bb.js";
import {
  captureBridgeJsonRpcOutput,
  createStandaloneBuiltinCompactCommandInput,
  type BridgeJsonRpcOutputMessage,
  type CapturedBridgeJsonRpcOutput,
} from "../test-support.js";
import { ANTIGRAVITY_RUNTIME_INSTRUCTIONS } from "./antigravity.js";
import { handleLine } from "./bridge.js";
import {
  TURN_CONTEXT_RESTARTING,
  TURN_CONTEXT_TOOL_NAME,
} from "./turn-context.js";

const FAKE_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fake-acp-agent.mjs",
);
const realSetTimeout = setTimeout;
const FRESH_SESSION_ID = "5a3c1c0e-8f0a-4e4b-9d61-0b8a4f1f2c3d";
// BB's client request ids: `creq_` and ten characters of its alphabet.
const TURN_REQUEST = "creq_turn222222";
const NEXT_REQUEST = "creq_next222222";
const PLAIN_REQUEST = "creq_paint22222";

const hook: DynamicTool = {
  name: TURN_CONTEXT_TOOL_NAME,
  description: "Hidden per-turn context hook.",
  inputSchema: { type: "object" },
};
const memoryRead: DynamicTool = {
  name: "memory_read",
  description: "Read the chat memory.",
  inputSchema: { type: "object" },
};
const memoryZoom: DynamicTool = {
  name: "memory_zoom",
  description: "Open a memory line.",
  inputSchema: { type: "object" },
};

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;
let requestLog: string;
let nextRequestId = 1;
let nextThread = 0;
const startedThreads: { threadId: string; providerThreadId: string }[] = [];

function sendRequest(method: string, params: object): number {
  nextRequestId += 1;
  handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: nextRequestId, method, params }),
  );
  return nextRequestId;
}

/** Polls with the real clock, so it keeps working while a test fakes the bridge's timers. */
async function waitFor<T>(
  pick: () => T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = pick();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolveTick) => realSetTimeout(resolveTick, 10));
  }
}

function findResponse(id: number): BridgeJsonRpcOutputMessage | undefined {
  return output.messages.find(
    (message) => message.id === id && message.method === undefined,
  );
}

const waitForResponse = (id: number) =>
  waitFor(() => findResponse(id), `response ${id}`);

function contextCalls(): BridgeJsonRpcOutputMessage[] {
  return output.messages.filter(
    (message) =>
      message.method === "item/tool/call" &&
      (message.params as { tool?: string } | undefined)?.tool ===
        TURN_CONTEXT_TOOL_NAME,
  );
}

const waitForContextCall = (index = 0) =>
  waitFor(() => contextCalls()[index], `turn context call ${index + 1}`);

function answerContext(
  call: BridgeJsonRpcOutputMessage,
  answer: { text: string; success?: boolean },
): void {
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        success: answer.success ?? true,
        contentItems: [{ type: "inputText", text: answer.text }],
      },
    }),
  );
}

interface LoggedAgentMessage {
  method?: string;
  params?: Record<string, unknown>;
}

function agentRequests(method: string): LoggedAgentMessage[] {
  if (!existsSync(requestLog)) return [];
  return readFileSync(requestLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedAgentMessage)
    .filter((message) => message.method === method);
}

function promptBlocks(
  index: number,
): { type: string; text?: string; uri?: string }[] {
  return (agentRequests("session/prompt")[index]?.params?.prompt ?? []) as {
    type: string;
    text?: string;
    uri?: string;
  }[];
}

function mcpToolNames(sessionNew: LoggedAgentMessage | undefined): string[] {
  const servers = (sessionNew?.params?.mcpServers ?? []) as {
    env: { name: string; value: string }[];
  }[];
  const tools = servers[0]?.env.find(
    (entry) => entry.name === "BB_ACP_DYNAMIC_TOOLS",
  );
  return tools === undefined
    ? []
    : (JSON.parse(tools.value) as { name: string }[]).map((tool) => tool.name);
}

/** The provider errors that settled a turn of `threadId`, in order. */
function turnFailures(threadId: string): string[] {
  return output.messages.flatMap((message) => {
    const params = message.params as
      | {
          threadId?: string;
          deltas?: { kind?: string; detail?: string; settlesTurn?: boolean }[];
        }
      | undefined;
    if (message.method !== "thread/delta" || params?.threadId !== threadId) {
      return [];
    }
    return (params.deltas ?? [])
      .filter((delta) => delta.kind === "provider.error" && delta.settlesTurn)
      .map((delta) => delta.detail ?? "");
  });
}

/** Answers turn/start at once (BB waits 30 s for it), then fails the turn with its error. */
async function expectTurnFailure(
  turn: number,
  threadId: string,
): Promise<string> {
  expect((await waitForResponse(turn)).result).toEqual({ threadId });
  return waitFor(() => turnFailures(threadId)[0], "the turn's failure");
}

function identities(): Record<string, unknown>[] {
  return output.messages
    .filter((message) => message.method === "thread/identity")
    .map((message) => message.params as Record<string, unknown>);
}

async function startThread(args: {
  command?: string;
  dynamicTools?: DynamicTool[];
  envVars?: Record<string, string>;
  instructions?: string;
}): Promise<{ threadId: string; providerThreadId: string }> {
  nextThread += 1;
  const threadId = `optchat-thread-${nextThread}`;
  const id = sendRequest("thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
      ...(args.instructions ? { instructions: args.instructions } : {}),
      providerOptions: {
        acpLaunchSpec: {
          displayName: "Fake ACP",
          command: args.command ?? process.execPath,
          args: [FAKE_AGENT_PATH],
          env: { FAKE_ACP_REQUEST_LOG: requestLog, ...args.envVars },
        },
      },
    },
    ...(args.dynamicTools ? { dynamicTools: args.dynamicTools } : {}),
  });
  const response = await waitForResponse(id);
  if (response.error) throw new Error(response.error.message);
  const providerThreadId = (response.result as { providerThreadId: string })
    .providerThreadId;
  const thread = { threadId, providerThreadId };
  startedThreads.push(thread);
  return thread;
}

function startTurn(
  thread: { threadId: string; providerThreadId: string },
  args: {
    text?: string;
    clientRequestId?: string;
    dynamicTools?: DynamicTool[];
    input?: unknown[];
  } = {},
): number {
  return sendRequest("turn/start", {
    threadId: thread.threadId,
    providerThreadId: thread.providerThreadId,
    clientRequestId: args.clientRequestId ?? TURN_REQUEST,
    input: args.input ?? [{ type: "text", text: args.text ?? "hello" }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    ...(args.dynamicTools ? { dynamicTools: args.dynamicTools } : {}),
  });
}

let nextSteer = 0;
function steer(
  thread: { threadId: string; providerThreadId: string },
  text: string,
): number {
  nextSteer += 1;
  return sendRequest("turn/steer", {
    threadId: thread.threadId,
    providerThreadId: thread.providerThreadId,
    clientRequestId: `creq_steer${"abcdefghjk"[nextSteer % 10]}2222`,
    expectedTurnId: "turn-1",
    input: [{ type: "text", text }],
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
  });
}

function freshAnswer(
  input = "MEMORY TAIL\n\nhello",
  systemPrompt = "MEMORY VIEW",
) {
  return JSON.stringify({
    session: "fresh",
    sessionId: FRESH_SESSION_ID,
    systemPrompt,
    input,
  });
}

async function waitForTurnCompleted(threadId: string): Promise<void> {
  await waitFor(
    () =>
      output.messages.some((message) => {
        const params = message.params as
          | { threadId?: string; deltas?: { kind?: string; status?: string }[] }
          | undefined;
        return (
          message.method === "thread/delta" &&
          params?.threadId === threadId &&
          (params.deltas ?? []).some(
            (delta) =>
              delta.kind === "turn.boundary" && delta.status === "completed",
          )
        );
      })
        ? true
        : undefined,
    "turn completion",
  );
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-acp-optchat-test-"));
  requestLog = join(workspaceDir, "agent-requests.jsonl");
  output = captureBridgeJsonRpcOutput();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const thread of startedThreads.splice(0)) {
    await waitForResponse(
      sendRequest("thread/stop", {
        threadId: thread.threadId,
        providerThreadId: thread.providerThreadId,
        intent: "interrupt",
        activeTurnId: null,
      }),
    );
  }
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("OptChat turn context on ACP", () => {
  it("advertises turnContext and never shows the hook to the agent", async () => {
    const init = await waitForResponse(
      sendRequest("initialize", {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        client: { name: "bb", version: "1.0.0" },
      }),
    );
    expect(init.result).toMatchObject({ capabilities: { turnContext: true } });

    await startThread({ dynamicTools: [memoryRead, hook] });
    expect(mcpToolNames(agentRequests("session/new")[0])).toEqual([
      "memory_read",
    ]);
  });

  it("runs a `{}` answer's turn in the resident session with its own text", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    expect(call.params).toMatchObject({
      providerThreadId: thread.providerThreadId,
      threadId: thread.threadId,
      turnId: null,
      tool: TURN_CONTEXT_TOOL_NAME,
      arguments: {
        protocol: 4,
        input: "hello",
        requestId: TURN_REQUEST,
        sessionId: thread.providerThreadId,
      },
    });
    expect(call.params).toHaveProperty("callId");
    expect((call.params as { arguments: object }).arguments).not.toHaveProperty(
      "elapsedMs",
    );
    // The input is the thread's, and turn/start answered, before the context arrives: BB waits
    // 30 s for that answer, the context up to 120 s.
    expect(JSON.stringify(output.messages)).toContain('"input.accepted"');
    expect(findResponse(turn)?.result).toEqual({ threadId: thread.threadId });

    answerContext(call, { text: "{}" });
    await waitForTurnCompleted(thread.threadId);
    expect(agentRequests("session/new")).toHaveLength(1);
    expect(agentRequests("session/prompt")[0]?.params?.sessionId).toBe(
      thread.providerThreadId,
    );
    expect(promptBlocks(0)).toEqual([{ type: "text", text: "hello" }]);
    expect(identities()).toHaveLength(1);
  });

  it("moves a fresh answer's turn to a new session with the turn's tools and <system_instructions>", async () => {
    const thread = await startThread({
      dynamicTools: [hook],
      instructions: "BASE INSTRUCTIONS",
    });
    const attachment = join(workspaceDir, "notes.md");
    const turn = startTurn(thread, {
      dynamicTools: [memoryRead, memoryZoom, hook],
      input: [
        { type: "text", text: "hello" },
        { type: "localFile", path: attachment, name: "notes.md" },
      ],
    });
    answerContext(await waitForContextCall(), { text: freshAnswer() });
    expect((await waitForResponse(turn)).error).toBeUndefined();
    await waitForTurnCompleted(thread.threadId);

    const sessionNews = agentRequests("session/new");
    expect(sessionNews).toHaveLength(2);
    expect(mcpToolNames(sessionNews[0])).toEqual([]);
    expect(mcpToolNames(sessionNews[1])).toEqual([
      "memory_read",
      "memory_zoom",
    ]);
    expect(sessionNews[1]?.params).not.toHaveProperty("_meta");

    const fresh = identities().at(-1);
    expect(fresh).toMatchObject({ threadId: thread.threadId });
    expect(fresh?.providerThreadId).not.toBe(thread.providerThreadId);
    expect(agentRequests("session/prompt")[0]?.params?.sessionId).toBe(
      fresh?.providerThreadId,
    );
    expect(promptBlocks(0)).toEqual([
      {
        type: "text",
        text: "<system_instructions>\nBASE INSTRUCTIONS\n\nMEMORY VIEW\n</system_instructions>",
      },
      { type: "text", text: "MEMORY TAIL\n\nhello" },
      { type: "resource_link", uri: `file://${attachment}`, name: "notes.md" },
    ]);
    // The fake agent advertises no session/close: the old session is left alone.
    expect(agentRequests("session/close")).toEqual([]);
  });

  it("gives Antigravity the system prompt on session/new and closes the session it leaves", async () => {
    const thread = await startThread({
      dynamicTools: [hook],
      instructions: "BASE INSTRUCTIONS",
      envVars: {
        FAKE_ACP_SYSTEM_PROMPT_APPEND: "1",
        FAKE_ACP_CLOSE_SESSION: "1",
      },
    });
    const turn = startTurn(thread, { dynamicTools: [memoryRead, hook] });
    answerContext(await waitForContextCall(), { text: freshAnswer() });
    expect((await waitForResponse(turn)).error).toBeUndefined();
    await waitForTurnCompleted(thread.threadId);

    expect(agentRequests("session/new")[1]?.params?._meta).toEqual({
      antigravity: {
        systemPrompt: {
          append: `BASE INSTRUCTIONS\n\n${ANTIGRAVITY_RUNTIME_INSTRUCTIONS}\n\nMEMORY VIEW`,
        },
      },
    });
    expect(promptBlocks(0)).toEqual([
      { type: "text", text: "MEMORY TAIL\n\nhello" },
    ]);
    await waitFor(
      () => (agentRequests("session/close").length > 0 ? true : undefined),
      "session/close",
    );
    expect(agentRequests("session/close")[0]?.params).toEqual({
      sessionId: thread.providerThreadId,
    });

    // The next turn asks with the session the thread runs in now.
    const fresh = identities().at(-1)?.providerThreadId;
    const next = startTurn(thread, {
      clientRequestId: NEXT_REQUEST,
      dynamicTools: [memoryRead, hook],
    });
    const call = await waitForContextCall(1);
    expect(call.params).toMatchObject({
      providerThreadId: fresh,
      arguments: { sessionId: fresh, requestId: NEXT_REQUEST },
    });
    answerContext(call, { text: "{}" });
    expect((await waitForResponse(next)).error).toBeUndefined();
  });

  it("keeps the previous session and fails the turn when session/new fails", async () => {
    const thread = await startThread({
      dynamicTools: [hook],
      envVars: { FAKE_ACP_SESSION_NEW_ERROR_AFTER: "1" },
    });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    answerContext(await waitForContextCall(), { text: freshAnswer() });
    expect(await expectTurnFailure(turn, thread.threadId)).toContain(
      "could not start the turn's fresh session",
    );
    expect(agentRequests("session/prompt")).toEqual([]);
    expect(identities()).toHaveLength(1);

    const next = startTurn(thread, {
      clientRequestId: NEXT_REQUEST,
      dynamicTools: [hook],
    });
    const call = await waitForContextCall(1);
    expect(call.params).toMatchObject({
      providerThreadId: thread.providerThreadId,
      arguments: { sessionId: thread.providerThreadId },
    });
    answerContext(call, { text: "{}" });
    expect((await waitForResponse(next)).error).toBeUndefined();
    await waitForTurnCompleted(thread.threadId);
    expect(agentRequests("session/prompt")[0]?.params?.sessionId).toBe(
      thread.providerThreadId,
    );
  });

  it.each([
    ["a malformed answer", { text: '{"ack":1}' }, "the answer is malformed"],
    [
      "a malformed fresh answer",
      { text: '{"session":"fresh"}' },
      "the fresh session answer is malformed",
    ],
    ["text that is not JSON", { text: "nope" }, "the answer is not JSON"],
    ["a tool error", { text: "memory broke", success: false }, "memory broke"],
  ])(
    "fails the turn on %s and never prompts the agent",
    async (_, answer, reason) => {
      const thread = await startThread({ dynamicTools: [hook] });
      const turn = startTurn(thread, { dynamicTools: [hook] });
      answerContext(await waitForContextCall(), answer);
      const failure = await expectTurnFailure(turn, thread.threadId);
      expect(failure).toBe(
        `The ACP agent could not get the turn's memory context: ${reason}`,
      );
      expect(turnFailures(thread.threadId)).toHaveLength(1);
      expect(contextCalls()).toHaveLength(1);
      expect(agentRequests("session/prompt")).toEqual([]);
      expect(
        output.messages.some(
          (message) =>
            message.method === "error" &&
            (message.params as { message?: string }).message === failure,
        ),
      ).toBe(true);

      // A steer that arrives after the failure gets the same error, until the next turn.
      const late = await waitForResponse(steer(thread, "late"));
      expect(late.error?.message).toBe(failure);
    },
  );

  it("answers a steer at once while a slow context is fetched and runs it after the turn's input", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    const held = steer(thread, "and also this");
    // BB gives a steer 30 s: its answer cannot wait for a context that takes 60.
    expect((await waitForResponse(held)).result).toEqual({
      threadId: thread.threadId,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agentRequests("session/prompt")).toEqual([]);
    vi.useRealTimers();

    answerContext(call, { text: "{}" });
    expect((await waitForResponse(turn)).error).toBeUndefined();
    await waitFor(
      () => (agentRequests("session/prompt").length >= 2 ? true : undefined),
      "the steer's prompt",
    );
    expect(promptBlocks(0)).toEqual([{ type: "text", text: "hello" }]);
    expect(promptBlocks(1)).toEqual([{ type: "text", text: "and also this" }]);
  });

  it("drops held steers with the turn when its preparation fails", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    const held = steer(thread, "held");
    expect((await waitForResponse(held)).error).toBeUndefined();
    answerContext(call, { text: "not json" });
    await expectTurnFailure(turn, thread.threadId);
    expect(agentRequests("session/prompt")).toEqual([]);
  });

  it("settles a turn stopped during preparation at once and cancels its context call", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    expect((await waitForResponse(turn)).result).toEqual({
      threadId: thread.threadId,
    });
    const held = steer(thread, "held");
    const startedAt = Date.now();
    startedThreads.splice(0);
    const stop = sendRequest("thread/stop", {
      threadId: thread.threadId,
      providerThreadId: thread.providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    expect((await waitForResponse(stop)).result).toEqual({ ok: true });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect((await waitForResponse(held)).error).toBeUndefined();
    expect(turnFailures(thread.threadId)).toEqual([]);
    expect(
      output.messages.some(
        (message) =>
          message.method === "notifications/cancelled" &&
          (message.params as { requestId?: unknown }).requestId === call.id,
      ),
    ).toBe(true);
    expect(agentRequests("session/prompt")).toEqual([]);
  });

  it("asks nothing for a /compact or for a turn whose tools no longer hold the hook", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    const compact = startTurn(thread, {
      input: createStandaloneBuiltinCompactCommandInput(),
    });
    expect((await waitForResponse(compact)).error).toBeUndefined();
    // The compaction's turn closes before the next turn may start.
    await waitFor(
      () =>
        output.messages.some(
          (message) =>
            message.method === "thread/delta" &&
            JSON.stringify(message.params).includes('"turn.boundary"'),
        )
          ? true
          : undefined,
      "the compaction's end",
    );
    expect(promptBlocks(0)).toEqual([{ type: "text", text: "/compact" }]);
    const plain = startTurn(thread, {
      clientRequestId: PLAIN_REQUEST,
      dynamicTools: [memoryRead],
    });
    expect((await waitForResponse(plain)).error).toBeUndefined();
    expect(contextCalls()).toEqual([]);
  });

  it("fails a turn whose context never comes within 120 s", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await expectTurnFailure(turn, thread.threadId)).toBe(
      "The ACP agent could not get the turn's memory context: no answer within 120 s",
    );
    expect(
      output.messages.some(
        (message) =>
          message.method === "notifications/cancelled" &&
          (message.params as { requestId?: unknown }).requestId === call.id,
      ),
    ).toBe(true);
    // A late answer changes nothing.
    answerContext(call, { text: "{}" });
    vi.useRealTimers();
    await new Promise((resolveTick) => realSetTimeout(resolveTick, 100));
    expect(agentRequests("session/prompt")).toEqual([]);
  });

  it.each([
    ["the plugin's restarting error", TURN_CONTEXT_RESTARTING],
    ["BB's unsupported tool", `Unsupported tool: ${TURN_CONTEXT_TOOL_NAME}`],
  ])("asks again after %s, with elapsedMs", async (_, restartError) => {
    const thread = await startThread({ dynamicTools: [hook] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    answerContext(await waitForContextCall(), {
      text: restartError,
      success: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const again = await waitForContextCall(1);
    expect(
      (again.params as { arguments: { elapsedMs?: number } }).arguments
        .elapsedMs,
    ).toBeGreaterThanOrEqual(1_000);
    answerContext(again, { text: "{}" });
    vi.useRealTimers();
    expect((await waitForResponse(turn)).error).toBeUndefined();
  });

  it("fails with the restarting error when a retry stays unanswered past the plugin's 90 s", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    answerContext(await waitForContextCall(), {
      text: TURN_CONTEXT_RESTARTING,
      success: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForContextCall(1);
    await vi.advanceTimersByTimeAsync(91_500);
    expect(await expectTurnFailure(turn, thread.threadId)).toBe(
      `The ACP agent could not get the turn's memory context: ${TURN_CONTEXT_RESTARTING}`,
    );
    expect(contextCalls()).toHaveLength(2);
  });

  it("settles the turn once when the agent exits while starting the fresh session", async () => {
    const thread = await startThread({
      dynamicTools: [hook],
      envVars: { FAKE_ACP_EXIT_ON_SESSION_NEW_AFTER: "1" },
    });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    const held = steer(thread, "held");
    answerContext(call, { text: freshAnswer() });
    expect(await expectTurnFailure(turn, thread.threadId)).toContain(
      "could not start the turn's fresh session",
    );
    expect((await waitForResponse(held)).error).toBeUndefined();
    // The exit report follows as a warning; it settles nothing more.
    await waitFor(
      () =>
        output.messages.some(
          (message) =>
            message.method === "error" &&
            String((message.params as { message?: string }).message).includes(
              "exited unexpectedly",
            ),
        )
          ? true
          : undefined,
      "the exit report",
    );
    expect(turnFailures(thread.threadId)).toHaveLength(1);
    expect(agentRequests("session/prompt")).toEqual([]);
  });

  it("fails a fresh session that takes over 30 s, keeps the previous one and closes the late one", async () => {
    const thread = await startThread({
      dynamicTools: [hook],
      envVars: {
        FAKE_ACP_LATER_SESSION_NEW_DELAY_MS: "300",
        FAKE_ACP_CLOSE_SESSION: "1",
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const turn = startTurn(thread, { dynamicTools: [hook] });
    const call = await waitForContextCall();
    const held = steer(thread, "held");
    answerContext(call, { text: freshAnswer() });
    await waitFor(
      () => (agentRequests("session/new").length >= 2 ? true : undefined),
      "the fresh session/new",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await expectTurnFailure(turn, thread.threadId)).toBe(
      "The ACP agent could not start the turn's fresh session: no session within 30 s",
    );
    expect((await waitForResponse(held)).error).toBeUndefined();
    vi.useRealTimers();
    // The agent's late session is closed, never adopted.
    const closed = await waitFor(
      () => agentRequests("session/close")[0],
      "the late session's close",
    );
    expect(closed.params?.sessionId).toBe(`${thread.providerThreadId}-2`);
    expect(identities()).toHaveLength(1);

    const next = startTurn(thread, {
      clientRequestId: NEXT_REQUEST,
      dynamicTools: [hook],
    });
    const again = await waitForContextCall(1);
    expect(again.params).toMatchObject({
      providerThreadId: thread.providerThreadId,
    });
    answerContext(again, { text: "{}" });
    expect((await waitForResponse(next)).error).toBeUndefined();
    await waitForTurnCompleted(thread.threadId);
    expect(agentRequests("session/prompt")[0]?.params?.sessionId).toBe(
      thread.providerThreadId,
    );
  });

  it("revokes a Cursor approval that lands after its turn stopped", async () => {
    const cursorAgent = join(workspaceDir, "cursor-agent");
    const cursorDataDir = join(workspaceDir, "cursor-data");
    symlinkSync(process.execPath, cursorAgent);
    const thread = await startThread({
      command: cursorAgent,
      dynamicTools: [hook],
      envVars: { CURSOR_DATA_DIR: cursorDataDir },
    });
    const slug = workspaceDir
      .replace(/[^a-zA-Z0-9]/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const approvalPath = join(
      cursorDataDir,
      "projects",
      slug,
      "mcp-approvals.json",
    );
    const approvals = () =>
      existsSync(approvalPath)
        ? (JSON.parse(readFileSync(approvalPath, "utf8")) as string[])
        : [];
    // The thread starts with no tool the agent sees, so with no MCP server to approve.
    expect(approvals()).toEqual([]);

    // The turn's new tool needs an approval, which waits on the file's lock.
    const lock = `${approvalPath}.bb-lock`;
    mkdirSync(lock, { recursive: true });
    const turn = startTurn(thread, { dynamicTools: [memoryRead, hook] });
    answerContext(await waitForContextCall(), { text: freshAnswer() });
    expect((await waitForResponse(turn)).error).toBeUndefined();
    await new Promise((resolveTick) => realSetTimeout(resolveTick, 100));
    startedThreads.splice(0);
    const stop = sendRequest("thread/stop", {
      threadId: thread.threadId,
      providerThreadId: thread.providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    await new Promise((resolveTick) => realSetTimeout(resolveTick, 200));
    rmSync(lock, { recursive: true, force: true });
    expect((await waitForResponse(stop)).result).toEqual({ ok: true });
    // The approval lands once the lock is free, and is revoked then.
    await waitFor(
      () =>
        existsSync(approvalPath) && approvals().length === 0 ? true : undefined,
      "the late approval's revocation",
    );
    expect(agentRequests("session/new")).toHaveLength(1);
  });

  it("refuses a steer outside a turn as stale", async () => {
    const thread = await startThread({ dynamicTools: [hook] });
    const stale = await waitForResponse(steer(thread, "orphan"));
    expect(stale.error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      data: { recovery: { kind: "staleTurn" } },
    });
  });
});
