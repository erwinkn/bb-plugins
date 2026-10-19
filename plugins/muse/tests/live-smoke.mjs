#!/usr/bin/env node
// Live smoke test against a real `muse serve` (spends Muse quota; keep it small).
//
//   npm run build && node tests/live-smoke.mjs <scratch-dir> [approval]
//
// Runs the built bridge (dist/host.js) exactly as the bb host daemon does,
// with Muse's data and config isolated under <scratch-dir> (auth.json is
// linked from ~/.config/muse). Steps: model list, a turn with a shell command
// and a bb tool call over MCP, an interrupted turn, a bridge restart and a
// resumed turn that must remember the first one, then usage. With `approval`
// it also runs one accept-edits turn that needs the network. `sandboxed` runs
// the main steps in accept-edits (Muse's sandbox on) instead of Full.
// `approval-only`, `compact-only`, `question-only` and `background-only` run
// just that case. At the end it checks that no process using this run's Muse
// data directory is left.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  experimental_createBridgeDeltaEventCollector as createCollector,
  experimental_resolveProviderBridgeLaunch as resolveLaunch,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

const scratch = resolve(process.argv[2] ?? join(homedir(), "scratch", "muse-live"));
const withApproval = process.argv.includes("approval");
const approvalOnly = process.argv.includes("approval-only");
const compactOnly = process.argv.includes("compact-only");
const questionOnly = process.argv.includes("question-only");
const backgroundOnly = process.argv.includes("background-only");
const sandboxed = process.argv.includes("sandboxed");
const pluginDir = resolve(import.meta.dirname, "..");
const workspace = join(scratch, "workspace");
const dataHome = join(scratch, "data");
const configHome = join(scratch, "config");
mkdirSync(workspace, { recursive: true });
mkdirSync(join(configHome, "muse"), { recursive: true });
mkdirSync(dataHome, { recursive: true });
const authLink = join(configHome, "muse", "auth.json");
if (!existsSync(authLink)) symlinkSync(join(homedir(), ".config", "muse", "auth.json"), authLink);

const FULL = { model: "muse-wonder-1.0", reasoningLevel: "low", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null, instructions: "Keep every answer under 20 words." };
const ACCEPT_EDITS = { ...FULL, permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "ask" };
const BASE = sandboxed ? ACCEPT_EDITS : FULL;
const PING = { name: "bb_ping", description: "Answer pong with the text you send.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, presentation: { label: { pending: "Pinging bb", completed: "Pinged bb" }, icon: { glyph: "Zap" } } };
const threadId = `thr_live_${Date.now().toString(36)}`;
const COMPACT_INPUT = [
  {
    type: "text",
    text: "/compact",
    mentions: [
      {
        start: 0,
        end: 8,
        resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "compact", argumentHint: null },
      },
    ],
  },
];
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const creq = () => `creq_${Array.from({ length: 10 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

function startBridge() {
  const launch = resolveLaunch({ modulePath: join(pluginDir, "dist", "host.js"), pluginId: "muse", cwd: workspace, dataDir: join(scratch, "bridge-data") });
  const env = {
    ...launch.env,
    PATH: process.env.PATH,
    HOME: homedir(),
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    ...(process.env.BB_PROVIDER_BRIDGE_RECORD_DIR ? { BB_PROVIDER_BRIDGE_RECORD_DIR: process.env.BB_PROVIDER_BRIDGE_RECORD_DIR } : {}),
  };
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const collector = createCollector("muse");
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  let id = 0;
  let buffer = "";
  child.stderr.on("data", (chunk) => process.stderr.write(`  [bridge stderr] ${chunk}`));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        continue;
      }
      if (message.id !== undefined) {
        answerRuntime(message);
        continue;
      }
      if (message.method === "session/replaced" || message.method === "provider/recovery") log("notice", message.method, JSON.stringify(message.params));
      for (const event of collector.assembleMessage(message)) {
        events.push(event);
        describe(event);
        for (const listener of listeners) listener(event);
      }
    }
  });
  function send(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  function answerRuntime(message) {
    if (message.method === "item/tool/call") {
      log("runtime: item/tool/call", message.params.tool, JSON.stringify(message.params.arguments));
      send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: `pong ${message.params.arguments.text}` }] } });
    } else if (message.method === "interaction/request") {
      log("runtime: interaction/request", JSON.stringify(message.params.payload).slice(0, 400));
      const payload = message.params.payload;
      const answers = Object.fromEntries(
        (payload.questions ?? []).map((question) => [question.id, { selected: question.options?.length ? [question.options[0].value] : [], ...(question.options?.length ? {} : { freeText: "tea" }) }]),
      );
      send({ id: message.id, result: payload.kind === "approval" ? { decision: "allow_once", grantedPermissions: null } : { kind: "user_answer", answers } });
    } else {
      send({ id: message.id, error: { code: -32601, message: "not in smoke test" } });
    }
  }
  return {
    child,
    events,
    request(method, params, timeoutMs = 120_000) {
      id += 1;
      const requestId = `smoke-${id}`;
      send({ id: requestId, method, params });
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
        pending.set(requestId, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
          else resolvePromise(message.result);
        });
      });
    },
    waitFor(predicate, what, timeoutMs = 180_000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timed out waiting for ${what}`));
        }, timeoutMs);
        const listener = (event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolvePromise(event);
        };
        listeners.add(listener);
      });
    },
    close() {
      child.stdin.end();
      return new Promise((resolvePromise) => child.once("close", resolvePromise));
    },
  };
}

function describe(event) {
  switch (event.type) {
    case "turn/started":
    case "turn/input/accepted":
      return log(event.type);
    case "turn/completed":
      return log(event.type, event.status, event.error ? JSON.stringify(event.error) : "");
    case "item/started":
    case "item/completed": {
      const item = event.item;
      const summary = item.command ?? item.path ?? item.query ?? item.tool ?? (item.text ? JSON.stringify(item.text.slice(0, 120)) : "");
      const extra = event.type === "item/completed" ? ` status=${item.status}${item.exitCode !== undefined ? ` exit=${item.exitCode}` : ""}${item.result !== undefined ? ` result=${JSON.stringify(item.result).slice(0, 80)}` : ""}${item.aggregatedOutput ? ` out=${JSON.stringify(item.aggregatedOutput.slice(0, 80))}` : ""}${item.server ? ` server=${item.server}` : ""}` : "";
      return log(event.type, item.type, summary, extra);
    }
    case "thread/tokenUsage/updated":
      return log("usage", JSON.stringify(event.tokenUsage.last));
    case "thread/contextWindowUsage/updated":
      return;
    case "item/backgroundTask/completed":
      return log(event.type, event.item.description, `status=${event.item.status} task=${event.item.taskStatus}`);
    default:
      if (!event.type.includes("Delta")) log(event.type);
  }
}

const turnEnd = (bridge, count) => bridge.waitFor(
  () => bridge.events.filter((event) => event.type === "turn/completed").length >= count,
  `turn ${count} end`,
);

async function turn(bridge, providerThreadId, text, options = BASE) {
  log(">> turn:", text);
  await bridge.request("turn/start", { threadId, providerThreadId, input: [{ type: "text", text, mentions: [] }], clientRequestId: creq(), options });
}

const started = Date.now();
let bridge = startBridge();
await bridge.request("initialize", { protocolVersion: 2, client: { name: "muse-live-smoke", version: "0" }, grammarVersions: [3, 3] });
log("health", JSON.stringify(await bridge.request("provider/health", { providerId: "muse" })));
const models = await bridge.request("model/list", { cwd: workspace });
log("models", models.models.map((model) => `${model.id}${model.isDefault ? "*" : ""} [${model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).join(",")}]`).join("  "));

const { providerThreadId } = await bridge.request("thread/start", { threadId, cwd: workspace, instructionMode: "append", options: approvalOnly ? ACCEPT_EDITS : BASE, dynamicTools: [PING] });
log("thread started", providerThreadId);

if (questionOnly) {
  await turn(bridge, providerThreadId, "Use your request_user_input tool to ask me one question: tea or coffee (two options). Then reply with just my choice.");
  await turnEnd(bridge, 1);
  await bridge.request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  await bridge.close();
  process.exit(0);
}

if (backgroundOnly) {
  await turn(bridge, providerThreadId, "Start `sleep 3; echo bg-done` as a background shell task (do not wait for it), then reply with just: started.");
  // Muse holds the turn open until the task ends, then reports it in a turn of its own.
  await turnEnd(bridge, 2);
  await bridge.request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  await bridge.close();
  process.exit(0);
}

if (compactOnly) {
  await turn(bridge, providerThreadId, "Say hello in three words.");
  await turnEnd(bridge, 1);
  log(">> turn: /compact");
  await bridge.request("turn/start", { threadId, providerThreadId, input: COMPACT_INPUT, clientRequestId: creq(), options: FULL });
  await turnEnd(bridge, 2);
  await turn(bridge, providerThreadId, "What did I ask you to do first? Answer in five words.");
  await turnEnd(bridge, 3);
  await bridge.request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  await bridge.close();
  process.exit(0);
}

if (approvalOnly) {
  await turn(bridge, providerThreadId, "Run `curl -sI https://example.com | head -1` in the shell and reply with its output.", ACCEPT_EDITS);
  await turnEnd(bridge, 1);
  await bridge.request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  await bridge.close();
  process.exit(0);
}

await turn(bridge, providerThreadId, "Run `echo $BB_THREAD_ID` in the shell, then call the bb_ping tool with text \"kiwi\". Reply with the shell output and the tool result, nothing else.");
await turnEnd(bridge, 1);

await turn(bridge, providerThreadId, "Run `sleep 60` in the shell and wait for it.");
await bridge.waitFor((event) => event.type === "item/started" && event.item.type === "commandExecution" && event.item.command.includes("sleep"), "sleep command");
const stopAt = Date.now();
await bridge.request("thread/stop", { threadId, providerThreadId, intent: "interrupt", activeTurnId: null });
log(`interrupt answered in ${Date.now() - stopAt} ms; last turn:`, bridge.events.filter((event) => event.type === "turn/completed").at(-1)?.status);

log("restarting the bridge process");
await bridge.close();
bridge = startBridge();
await bridge.request("initialize", { protocolVersion: 2, client: { name: "muse-live-smoke", version: "0" }, grammarVersions: [3, 3] });
await bridge.request("thread/resume", { threadId, providerThreadId, cwd: workspace, instructionMode: "append", options: BASE, dynamicTools: [PING] });
await turn(bridge, providerThreadId, "What text did you send to bb_ping earlier in this conversation? Reply with just that word.");
await turnEnd(bridge, 1);
const answer = bridge.events.filter((event) => event.type === "item/completed" && event.item.type === "agentMessage").at(-1)?.item.text;
log("resume remembered:", JSON.stringify(answer), /kiwi/iu.test(answer ?? "") ? "OK" : "MISMATCH");

if (withApproval) {
  await turn(bridge, providerThreadId, "Run `curl -sI https://example.com | head -1` in the shell and reply with its output.", ACCEPT_EDITS);
  await turnEnd(bridge, 2);
}

log("usage", JSON.stringify(await bridge.request("provider/usage", { providerId: "muse" })));
await bridge.request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
await bridge.close();
log("processes left using this run's Muse data:", JSON.stringify(leftovers()));
log(`done in ${Math.round((Date.now() - started) / 1000)} s`);

function leftovers() {
  const mark = `XDG_DATA_HOME=${dataHome}\0`;
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry) && Number(entry) !== process.pid)
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "latin1").includes(mark);
      } catch {
        return false;
      }
    })
    .map((pid) => readFileSync(`/proc/${pid}/cmdline`, "latin1").replaceAll("\0", " ").trim());
}
