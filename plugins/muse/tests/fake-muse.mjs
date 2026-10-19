#!/usr/bin/env node
// A scripted stand-in for `muse serve`: speaks enough MSP for the bridge's
// tests, shaped after frames recorded from Muse Code 1.4.10. Prompt words pick
// the script:
//   "tools"    bash + read + edit + bb MCP tool call
//   "approve"  a shell approval, finished after approval/decide
//   "ask"      a question, finished after userInput/answer
//   "hang"     stays running until turn/interrupt (or a steer finishes it)
//   "fail"     a failed turn with a quota error
//   "crash"    exits mid-turn
//   "orphan"   leaves a `sleep` in its process group, then exits mid-turn
//   "batch"    writes the ack, turn/started, reply and turn/completed in one chunk
//   "steer-ends" (with "hang") a steer whose ack and turn/completed share a chunk
//   "gap-mid"  streams part of a reply, announces a view/gap, then carries on as if nothing happened
//   "view-down" like "gap-mid", with session/viewHealthChanged (unavailable) instead of the gap
//   "gap-after" a normal turn, then a view/gap once it completed
//   "strict"   (with "ask") rejects the answer as invalid
//   "late-ack" writes turn/started, the reply and turn/completed before the ack, in one chunk
//   "late-steer" (with "hang") answers a steer after the turn's completion, in one chunk
//   "pipe-orphan" leaves a `sleep` holding its stdout, then exits mid-turn
//   "stubborn"  leaves a SIGTERM-ignoring shell in its process group; the turn completes
//   "slow-steer" (with "hang") completes the turn at a steer and acks it 5.5 s later
//   "ack-exit"  acks turn/start, then exits before turn/started
//   "unqueue"   acks turn/start as queued, then reclaims it (turn/unqueued)
//   "report-on-stop" (with "hang") starts a report turn of its own when interrupted
//   "unknown-failed-report" after the turn, a report turn bb never saw start fails
//   "background" sends a bash call to the background; it fails after the turn ends
// FAKE_MUSE_START_DELAY_MS delays the session/start answer.
// FAKE_MUSE_ACCOUNT_ERROR makes account/read fail.
// FAKE_MUSE_PROBE_DELAY_MS delays model/list and account/read, with a SIGTERM-ignoring shell in the group,
//   and makes `--version` take 10 s.
// FAKE_MUSE_LOG appends every frame the fake receives, one JSON per line.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const log = process.env.FAKE_MUSE_LOG;
const sessions = new Map();
/** Sessions this host unloaded as idle ("idle" in a prompt); resume reloads them. */
const unloaded = new Set();
let activeTurn = null;
let strictAnswers = false;
const waiting = new Map();
let counter = 0;

if (log) appendFileSync(log, `${JSON.stringify({ argv, pid: process.pid, env: { BB_THREAD_ID: process.env.BB_THREAD_ID ?? null } })}\n`);

function line(message) {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}
function send(message) {
  process.stdout.write(line(message));
}
function note(method, params) {
  send({ method, params });
}
function id(prefix) {
  counter += 1;
  // Unique across hosts, as Muse's own ids are.
  return `${prefix}-${process.pid}-${counter}`;
}

if (argv.includes("--version")) {
  // The bridge must not run this: health reads the version from the handshake.
  setTimeout(() => {
    process.stdout.write("muse 9.9.9-fake\n");
    process.exit(0);
  }, process.env.FAKE_MUSE_PROBE_DELAY_MS ? 10_000 : 0);
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.on("end", () => process.exit(0));
}

let buffer = "";
function onData(chunk) {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
}

async function handle(message) {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
  if (message.method === undefined) return; // a response to our server request
  const reply = (result) => message.id !== undefined && send({ id: message.id, result });
  const fail = (code, text, kind) => send({ id: message.id, error: { code, message: text, data: { kind } } });
  const p = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return reply({
        serverInfo: { name: "muse", version: "9.9.9-fake" },
        grantedCapabilities: p.capabilities?.requestedCapabilities ?? [],
        schema: { version: 1, fingerprint: "fake" },
      });
    case "initialized":
      return;
    case "model/list":
      await probeDelay();
      return reply({
        providerId: "meta",
        source: "providerCatalog",
        models: [
          { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", isDefault: true, contextLimit: 1007997,
            variants: ["minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high" },
          { modelId: "muse-spark-1.2", displayLabel: "muse-spark-1.2", isDefault: false, contextLimit: 1007997,
            variants: ["low", "high"], defaultReasoningEffort: "high",
            reasoningEffortVariants: [{ tier: "high", description: "Deepest" }] },
        ],
      });
    case "account/read":
      await probeDelay();
      if (process.env.FAKE_MUSE_ACCOUNT_ERROR) return fail(-32603, "config unreadable", "configError");
      return reply({ state: "accountLogin", credentialRequired: false, label: "erwin@example.com" });
    case "usage/read":
      return reply({});
    case "session/start": {
      const delay = Number(process.env.FAKE_MUSE_START_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (sessions.has(p.sessionId)) return fail(-32030, "session id conflict", "commandRejected");
      sessions.set(p.sessionId, { modelId: p.modelId ?? "muse-wonder-1.0", config: p.config ?? null });
      return reply({ session: { sessionId: p.sessionId, modelId: p.modelId ?? "muse-wonder-1.0", providerId: "meta" }, viewCursor: "v:0" });
    }
    case "session/resume": {
      if (String(p.sessionId).startsWith("missing")) return fail(-32020, "no such session", "sessionNotFound");
      sessions.set(p.sessionId, { modelId: "muse-wonder-1.0", config: p.config ?? null });
      unloaded.delete(p.sessionId);
      return reply({ session: { sessionId: p.sessionId, modelId: "muse-wonder-1.0", providerId: "meta" }, history: { mode: "none" }, pendingRequests: [], viewCursor: "v:0" });
    }
    case "session/setApprovalMode":
    case "session/setModel":
      return reply({ commandId: p.commandId, status: "accepted" });
    case "session/compact":
      return reply({ status: "noop", reason: "nothing to compact" });
    case "turn/start":
      if (unloaded.has(p.sessionId)) return fail(-32024, "session is not loaded", "sessionNotLoaded");
      return startTurn(message, p);
    case "turn/steer": {
      if (activeTurn === null || activeTurn.turnId !== p.expectedTurnId) {
        return fail(-32030, "turn is not running", "commandRejected");
      }
      if (activeTurn.text.includes("late-steer")) {
        const { sessionId, turnId } = activeTurn;
        activeTurn = null;
        waiting.delete("hang");
        process.stdout.write(
          line({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } }) +
            line({ id: message.id, result: { commandId: p.commandId, status: "accepted", turnId, disposition: "steered" } }),
        );
        return;
      }
      if (activeTurn.text.includes("slow-steer")) {
        const { sessionId, turnId } = activeTurn;
        activeTurn = null;
        waiting.delete("hang");
        note("turn/completed", { sessionId, turnId, terminal: "completed" });
        const delay = Number(process.env.FAKE_MUSE_STEER_ACK_DELAY_MS ?? 5_500);
        setTimeout(() => reply({ commandId: p.commandId, status: "accepted", turnId }), delay);
        return;
      }
      if (activeTurn.text.includes("steer-ends")) {
        const { sessionId, turnId } = activeTurn;
        activeTurn = null;
        waiting.delete("hang");
        process.stdout.write(
          line({ id: message.id, result: { commandId: p.commandId, status: "accepted", turnId, disposition: "steered" } }) +
            line({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } }),
        );
        return;
      }
      reply({ commandId: p.commandId, status: "accepted", turnId: activeTurn.turnId, disposition: "steered" });
      const resume = waiting.get("hang");
      if (resume) resume("steered");
      return;
    }
    case "turn/interrupt": {
      reply({ commandId: p.commandId, status: "accepted" });
      const resume = waiting.get("hang");
      if (resume) resume("interrupted");
      else if (activeTurn !== null) {
        // Interrupted while waiting on an approval or a question.
        note("turn/completed", { sessionId: activeTurn.sessionId, turnId: activeTurn.turnId, terminal: "cancelled" });
        activeTurn = null;
      }
      return;
    }
    case "approval/decide": {
      reply({ commandId: p.commandId, status: "accepted", terminal: true });
      const resume = waiting.get(`approval:${p.approvalId}`);
      if (resume) resume(p.choiceId);
      return;
    }
    case "userInput/answer": {
      if (strictAnswers) return fail(-32057, "selection out of bounds", "userInputAnswerInvalid");
      reply({ commandId: p.commandId, status: "accepted" });
      const resume = waiting.get(`input:${p.userInputId}`);
      if (resume) resume(p.answers);
      return;
    }
    case "userInput/cancel":
      reply({ commandId: p.commandId, status: "accepted" });
      waiting.get(`input:${p.userInputId}`)?.(null);
      return;
    default:
      return send({ id: message.id, error: { code: -32601, message: `fake: ${message.method}`, data: { kind: "methodNotFound" } } });
  }
}

async function probeDelay() {
  if (!process.env.FAKE_MUSE_PROBE_DELAY_MS) return;
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
  if (log) appendFileSync(log, `${JSON.stringify({ probeShellPid: child.pid })}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_MUSE_PROBE_DELAY_MS)));
}

function waitFor(key) {
  return new Promise((resolve) => waiting.set(key, (value) => { waiting.delete(key); resolve(value); }));
}

function item(sessionId, turnId, fields, method = "item/completed") {
  note(method, { sessionId, item: { turnId, revision: method === "item/started" ? 1 : 2, ...fields } });
}

async function startTurn(message, p) {
  const sessionId = p.sessionId;
  const turnId = p.commandId;
  const text = (p.input ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
  const ack = { id: message.id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } };
  if (text.includes("late-ack")) {
    const msg = id("msg");
    process.stdout.write(
      line({ method: "turn/started", params: { sessionId, turnId, commandId: turnId } }) +
        line({ method: "item/completed", params: { sessionId, item: { itemId: msg, kind: "agentMessage", status: "completed", turnId, revision: 1, text: "before the ack" } } }) +
        line({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } }) +
        line(ack),
    );
    return;
  }
  if (text.includes("batch")) {
    const msg = id("msg");
    process.stdout.write(
      line(ack) +
        line({ method: "turn/started", params: { sessionId, turnId, commandId: turnId } }) +
        line({ method: "item/completed", params: { sessionId, item: { itemId: msg, kind: "agentMessage", status: "completed", turnId, revision: 1, text: "all at once" } } }) +
        line({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } }),
    );
    return;
  }
  if (text.includes("unknown-failed-report")) {
    send(ack);
    note("turn/started", { sessionId, turnId, commandId: turnId });
    note("turn/completed", { sessionId, turnId, terminal: "completed" });
    note("turn/completed", { sessionId, turnId: id("report"), terminal: "failed", error: { kind: "authRequired", message: "Please log in" } });
    return;
  }
  if (text.includes("ack-exit")) {
    send(ack);
    setTimeout(() => process.exit(73), 20);
    return;
  }
  if (text.includes("unqueue")) {
    send({ ...ack, result: { ...ack.result, startedNewTurn: false, disposition: "queued" } });
    note("turn/unqueued", { sessionId, turnId, commandId: turnId, viewCursor: "u1" });
    return;
  }
  send(ack);
  activeTurn = { turnId, sessionId, text };
  strictAnswers = text.includes("strict");
  note("turn/started", { sessionId, turnId, commandId: turnId });
  item(sessionId, turnId, { itemId: id("user"), kind: "userMessage", status: "completed", text });
  let terminal = "completed";
  let error;

  if (text.includes("tools")) await toolScript(sessionId, turnId);
  if (text.includes("approve")) {
    const callId = id("call");
    const itemId = id("bash");
    // Like Muse: the approval comes before the tool's item starts.
    const approvalId = id("approval");
    send({ id: id("srv"), method: "approval/request", params: {
      approvalId, sessionId, turnId, itemId, toolName: "bash", rawArgs: JSON.stringify({ command: "rm -rf build" }),
      currentRequirementId: { approvalId, sourceIndex: 0 },
      availableChoices: [
        { choiceId: "c-once", decision: "approved", scope: "once", label: "Allow once" },
        { choiceId: "c-session", decision: "approvedForSession", scope: "session", label: "Allow for session" },
        { choiceId: "c-abort", decision: "abort", scope: "once", label: "Reject" },
      ],
      subject: { kind: "shell", command: "rm -rf build" },
    } });
    let choice = await waitFor(`approval:${approvalId}`);
    if (choice !== "c-abort") {
      // A compound command: Muse asks again for its second stage.
      const next = waitFor(`approval:${approvalId}`);
      note("approval/updated", { sessionId, approvalId, currentRequirementId: { approvalId, sourceIndex: 1 },
        availableChoices: [
          { choiceId: "c2-once", decision: "approved", scope: "once" },
          { choiceId: "c2-session", decision: "approvedForSession", scope: "session" },
          { choiceId: "c2-abort", decision: "abort", scope: "once" },
        ] });
      choice = `${choice}+${await next}`;
    }
    note("approval/resolved", { sessionId, approvalId });
    const approved = choice !== "c-abort";
    if (approved) item(sessionId, turnId, { itemId, kind: "toolCall", status: "inProgress", tool: "bash", callId, args: JSON.stringify({ command: "rm -rf build" }) }, "item/started");
    item(sessionId, turnId, { itemId, kind: "toolCall", status: approved ? "completed" : "rejected", tool: "bash", callId,
      args: JSON.stringify({ command: "rm -rf build" }),
      visibleOutput: approved ? JSON.stringify({ exit_code: 0, output: "removed\n" }) : "", revision: 3 });
    agentMessage(sessionId, turnId, `choice ${choice}`);
  }
  if (text.includes("ask")) {
    const userInputId = id("input");
    note("userInput/requested", { sessionId, turnId, userInputId, questions: [
      { id: "q1", header: "Color", question: "Which color?", options: [{ label: "Red" }, { label: "Blue", description: "Calm" }], selection: { mode: "single" } },
    ] });
    const answers = await waitFor(`input:${userInputId}`);
    note("userInput/settled", { sessionId, userInputId });
    agentMessage(sessionId, turnId, `answers ${JSON.stringify(answers)}`);
  }
  if (text.includes("hang")) {
    const outcome = await waitFor("hang");
    if (outcome === "interrupted") terminal = "cancelled";
    else agentMessage(sessionId, turnId, "steered reply");
  }
  if (text.includes("fail")) {
    terminal = "failed";
    error = { kind: "modelError", message: "429 usage limit reached", retryable: false, quota: { limitKind: "tierLimit", resetsAtMs: 1792411462000 } };
  }
  if (text.includes("gap-mid") || text.includes("view-down")) {
    const msg = id("msg");
    item(sessionId, turnId, { itemId: msg, kind: "agentMessage", status: "inProgress", text: "" }, "item/started");
    note("item/delta", { sessionId, itemId: msg, field: "text", delta: "before the hole" });
    if (text.includes("gap-mid")) note("view/gap", { sessionId, after: "c1", next: "c3" });
    else note("session/viewHealthChanged", { sessionId, health: "unavailable", noneReason: "projectionUnavailable" });
    // Muse carries on; none of this may reach bb.
    item(sessionId, turnId, { itemId: msg, kind: "agentMessage", status: "completed", text: "before the hole, after the hole" });
    activeTurn = null;
    note("turn/completed", { sessionId, turnId, terminal: "completed" });
    return;
  }
  if (text.includes("background")) {
    const bg = id("bash");
    const args = JSON.stringify({ command: "make test", background: true });
    item(sessionId, turnId, { itemId: bg, kind: "toolCall", status: "inProgress", tool: "bash", args }, "item/started");
    note("item/updated", { sessionId, item: { itemId: bg, turnId, kind: "toolCall", status: "inProgress", tool: "bash", args, background: true, revision: 2 } });
    setTimeout(() => note("item/completed", { sessionId, item: { itemId: bg, turnId, kind: "toolCall", status: "failed", tool: "bash", args,
      background: true, revision: 3, visibleOutput: JSON.stringify({ exit_code: 1, output: "1 failing\n" }) } }), 300);
  }
  if (text.includes("pipe-orphan")) {
    const child = spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] });
    if (log) appendFileSync(log, `${JSON.stringify({ pipeOrphanPid: child.pid })}\n`);
    process.exit(72);
  }
  if (text.includes("stubborn")) {
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    if (log) appendFileSync(log, `${JSON.stringify({ stubbornPid: child.pid })}\n`);
  }
  if (text.includes("orphan")) {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    if (log) appendFileSync(log, `${JSON.stringify({ orphanPid: child.pid })}\n`);
    agentMessage(sessionId, turnId, "leaving a sleeper", false);
    process.exit(71);
  }
  if (text.includes("crash")) {
    agentMessage(sessionId, turnId, "about to crash", false);
    process.stderr.write("fake muse: simulated crash\n");
    process.exit(70);
  }
  if (terminal === "completed" && !text.includes("hang") && !text.includes("approve") && !text.includes("ask")) {
    agentMessage(sessionId, turnId, `echo: ${text}`);
  }
  note("session/tokenUsage", { sessionId, turnId, modelId: "muse-wonder-1.0", promptTokens: 1000, totalTokens: 1050,
    usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 800, cacheReadTokens: 800, cacheWriteTokens: 0, reasoningTokens: 5 } });
  note("session/tokenUsage", { sessionId, turnId, modelId: "muse-wonder-1.0", promptTokens: 1100, totalTokens: 1120,
    usage: { inputTokens: 1100, outputTokens: 20, cachedTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 0 } });
  note("session/contextUsage", { sessionId, usedTokens: 1120, windowTokens: 1007997, pressure: "normal" });
  note("usage/changed", { window: { usedPercent: 41, windowDurationMins: 300, resetsAtMs: 1792411462000 }, weekly: { usedPercent: 13, resetsAtMs: 1792972800000 }, observedAtMs: 1792397099467 });
  activeTurn = null;
  note("turn/completed", { sessionId, turnId, terminal, ...(error ? { error } : {}) });
  if (text.includes("gap-after")) note("view/gap", { sessionId, after: "c1", next: "c3" });
  if (text.includes("report-on-stop") && terminal === "cancelled") {
    const report = id("report");
    activeTurn = { turnId: report, sessionId, text: "hang" };
    note("turn/started", { sessionId, turnId: report, commandId: report });
    await waitFor("hang");
    activeTurn = null;
    note("turn/completed", { sessionId, turnId: report, terminal: "cancelled" });
  }
  if (text.includes("idle")) {
    unloaded.add(sessionId);
    // "silently" skips the notification, as if the bridge missed it.
    if (!text.includes("silently")) note("session/closed", { sessionId, reason: "idle" });
  }
}

function agentMessage(sessionId, turnId, text, complete = true) {
  const itemId = id("msg");
  item(sessionId, turnId, { itemId, kind: "agentMessage", status: "inProgress", text: "" }, "item/started");
  note("item/delta", { sessionId, itemId, field: "text", delta: text.slice(0, 3) });
  note("item/delta", { sessionId, itemId, field: "text", delta: text.slice(3) });
  if (complete) item(sessionId, turnId, { itemId, kind: "agentMessage", status: "completed", text, messagePhase: "finalAnswer" });
}

async function toolScript(sessionId, turnId) {
  const bash = id("bash");
  const bashArgs = JSON.stringify({ command: "echo hi", description: "Run echo hi" });
  item(sessionId, turnId, { itemId: bash, kind: "toolCall", status: "inProgress", tool: "bash", callId: id("call"), args: bashArgs }, "item/started");
  note("item/delta", { sessionId, itemId: bash, field: "output", delta: "hi\n" });
  item(sessionId, turnId, { itemId: bash, kind: "toolCall", status: "completed", tool: "bash", args: bashArgs, revision: 3,
    visibleOutput: JSON.stringify({ command: "echo hi", exit_code: 0, output: "hi\n", truncated: false }) });

  const read = id("read");
  item(sessionId, turnId, { itemId: read, kind: "toolCall", status: "inProgress", tool: "read_file", args: '{"path":"notes.txt"}' }, "item/started");
  item(sessionId, turnId, { itemId: read, kind: "toolCall", status: "completed", tool: "read_file", args: '{"path":"notes.txt"}', visibleOutput: "1|apple" });

  const edit = id("edit");
  const dir = join(tmpdir(), `fake-muse-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const patchPath = join(dir, "patch.json");
  writeFileSync(patchPath, JSON.stringify({ files: [{ path: "notes.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-apple", "+pear"] }] }] }));
  const editArgs = JSON.stringify({ path: "notes.txt", find: "apple", replace: "pear" });
  item(sessionId, turnId, { itemId: edit, kind: "toolCall", status: "inProgress", tool: "edit_file", args: editArgs }, "item/started");
  item(sessionId, turnId, { itemId: edit, kind: "toolCall", status: "completed", tool: "edit_file", args: editArgs,
    visibleOutput: "edited", patchRef: { path: patchPath, byteLen: 100 }, patchSummary: { files: 1, added: 1, removed: 1 } });

  const server = sessions.get(sessionId)?.config?.mcpServers?.["bb-bridge"];
  if (server) {
    const callId = id("mcpcall");
    const mcpItem = id("mcp");
    const args = { text: "x" };
    item(sessionId, turnId, { itemId: mcpItem, kind: "toolCall", status: "inProgress", tool: "mcp__bb_bridge__echo_stamp", callId, args: JSON.stringify(args) }, "item/started");
    const result = await mcpCall(server, callId, args);
    item(sessionId, turnId, { itemId: mcpItem, kind: "toolCall", status: "completed", tool: "mcp__bb_bridge__echo_stamp", callId, args: JSON.stringify(args), visibleOutput: result });
  }
}

async function mcpCall(server, callId, args) {
  const post = async (body) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    const textBody = await response.text();
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = textBody.split("\n").find((line) => line.startsWith("data: "));
      return data ? JSON.parse(data.slice(6)) : null;
    }
    return textBody ? JSON.parse(textBody) : null;
  };
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const name = list?.result?.tools?.[0]?.name ?? "echo_stamp";
  const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args, _meta: { callId } } });
  return (call?.result?.content ?? []).map((part) => part.text ?? "").join("");
}
