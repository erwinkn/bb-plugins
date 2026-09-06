#!/usr/bin/env node
// Headless text-only test harness for the Voice Mode voice agent.
//
// Opens a WebSocket session to the OpenAI Realtime API (no audio, text out),
// loads the live prompt + tool schemas from the running voice-mode plugin, and
// wires tool calls back into the plugin's runTool RPC — so you can test the
// full agent loop from a terminal:
//
//   node scripts/text-session.mjs "what's running right now?"
//   node scripts/text-session.mjs --model gpt-realtime-2.1-mini "list my projects"
//   node scripts/text-session.mjs --no-tools "say hello"      # raw model, no bb
//   node scripts/text-session.mjs --bb-url http://127.0.0.1:38886 "..."
//
// Auth: OPENAI_API_KEY, else the Codex CLI token in ~/.codex/auth.json.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flags = { model: "gpt-realtime-2.1", bbUrl: "http://127.0.0.1:38886", tools: true, debug: false };
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model") flags.model = args[++i];
  else if (args[i] === "--bb-url") flags.bbUrl = args[++i];
  else if (args[i] === "--no-tools") flags.tools = false;
  else if (args[i] === "--debug") flags.debug = true;
  else words.push(args[i]);
}
const message = words.join(" ").trim();
if (!message) {
  console.error('Usage: node scripts/text-session.mjs [--model m] [--no-tools] [--debug] "your message"');
  process.exit(1);
}

function jwtExp(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp ?? 0;
  } catch {
    return 0;
  }
}

function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    const access = auth.tokens?.access_token;
    if (access && jwtExp(access) - 60 > Date.now() / 1000) return access;
    if (access) console.error("Codex token expired — start a voice session once (it refreshes it) or set OPENAI_API_KEY.");
  } catch {
    /* no codex auth */
  }
  console.error("No credentials. Set OPENAI_API_KEY or `codex login`.");
  process.exit(1);
}

async function rpc(method, input) {
  const response = await fetch(`${flags.bbUrl}/api/v1/plugins/voice-mode/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${body.error ?? "rpc failed"}`);
  return body.result;
}

// Pull the live prompt + tools from the running plugin; degrade gracefully.
let instructions = "You are a concise assistant. Reply in text.";
let tools = [];
if (flags.tools) {
  try {
    const [prompt, toolList] = await Promise.all([rpc("getPrompt", null), rpc("getTools", null)]);
    instructions = `${prompt.content}\n\nCurrent context: threadId=none, projectId=none. This is a TEXT test session; reply in text.`;
    tools = toolList.tools
      .filter((tool) => !tool.local) // composer tools live in the app frontend
      .map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        ...(tool.parameters ? { parameters: JSON.parse(tool.parameters) } : {}),
      }));
    console.error(`[loaded live prompt + ${tools.length} tools from ${flags.bbUrl}]`);
  } catch (error) {
    console.error(`[plugin unreachable (${error.message}); running without bb tools]`);
  }
}

const key = apiKey();
const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(flags.model)}`;
let ws;
try {
  ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
} catch {
  ws = new WebSocket(url, ["realtime", `openai-insecure-api-key.${key}`, "openai-beta.realtime-v1"]);
}

const send = (event) => ws.send(JSON.stringify(event));
const pendingCalls = [];
let done = false;

ws.addEventListener("open", () => {
  send({
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["text"],
      instructions,
      tools,
    },
  });
  send({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: message }] },
  });
  send({ type: "response.create" });
  console.error(`[user] ${message}`);
});

ws.addEventListener("message", (event) => {
  const data = JSON.parse(event.data);
  if (flags.debug) console.error(`  · ${data.type}`);
  switch (data.type) {
    case "error":
      console.error(`[error] ${JSON.stringify(data.error ?? data)}`);
      process.exit(1);
      break;
    case "response.output_text.delta":
    case "response.text.delta":
      process.stdout.write(data.delta);
      break;
    case "response.output_text.done":
    case "response.text.done":
      process.stdout.write("\n");
      break;
    case "response.output_item.done":
      if (data.item?.type === "function_call") {
        pendingCalls.push(data.item);
        console.error(`[tool call] ${data.item.name}(${data.item.arguments})`);
      }
      break;
    case "response.done": {
      const usage = data.response?.usage;
      if (pendingCalls.length > 0) {
        void runPendingCalls();
      } else {
        if (usage) console.error(`[usage] in ${usage.input_tokens} / out ${usage.output_tokens}`);
        done = true;
        ws.close();
      }
      break;
    }
    default:
      break;
  }
});

async function runPendingCalls() {
  const calls = pendingCalls.splice(0);
  for (const call of calls) {
    let output;
    try {
      const parsed = JSON.parse(call.arguments || "{}");
      const result = await rpc("runTool", { name: call.name, args: parsed, threadId: null, projectId: null });
      output = result.output;
    } catch (error) {
      output = `Error: ${error.message}`;
    }
    console.error(`[tool result] ${output.length > 300 ? `${output.slice(0, 300)}…` : output}`);
    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output },
    });
  }
  send({ type: "response.create" });
}

ws.addEventListener("close", (event) => {
  if (!done) console.error(`[closed] code ${event.code} ${event.reason || ""}`);
  process.exit(done ? 0 : 1);
});
ws.addEventListener("error", () => {
  console.error("[websocket error] check credentials/model name");
});
setTimeout(() => {
  console.error("[timeout] no completion after 60s");
  process.exit(1);
}, 60_000);
