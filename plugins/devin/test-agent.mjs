// Minimal ACP peer for the public bridge conformance test. No model or network.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method || request.id === undefined) continue;
  const reply = (result) => send({ id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { fork: {} } } }); break;
    case "session/new": reply({ sessionId: randomUUID() }); break;
    case "session/fork": reply({ sessionId: randomUUID() }); break;
    case "session/load": reply({}); break;
    case "session/prompt":
      send({ method: "session/update", params: { sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Devin bridge test OK" } } } });
      reply({ stopReason: "end_turn" }); break;
    default: send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } });
  }
}
