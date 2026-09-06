// Minimal ACP peer for the public bridge conformance test. No model or network.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let selected;
const configOptions = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: selected ?? "test-medium", options: [{ value: "test-medium", name: "Test Medium" }, { value: "test-high-priority", name: "Test High Fast" }] }];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method || request.id === undefined) continue;
  const reply = (result) => send({ id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { fork: {} } } }); break;
    case "session/new": reply({ sessionId: randomUUID(), configOptions: configOptions() }); break;
    case "session/fork": reply({ sessionId: randomUUID(), configOptions: configOptions() }); break;
    case "session/load": reply({ configOptions: configOptions() }); break;
    case "session/set_config_option": selected = request.params.value; reply({ configOptions: configOptions() }); break;
    case "session/prompt":
      if (selected !== "test-high-priority") { send({ id: request.id, error: { code: -32602, message: "Wrong native variant" } }); break; }
      send({ method: "session/update", params: { sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Devin bridge test OK" } } } });
      reply({ stopReason: "end_turn" }); break;
    default: send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } });
  }
}
