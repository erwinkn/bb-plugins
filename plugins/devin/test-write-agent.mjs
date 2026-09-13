// Fixture ACP peer for the write-shim test: announces two fs requests and some
// noise, then echoes every bridge-to-agent line it receives so the test can see
// exactly what the shim forwarded.
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
send({ id: 7, method: "fs/write_text_file", params: { path: "/tmp/bb-shim-fixture", content: "hello" } });
send({ id: 8, method: "fs/write_text_file", params: { path: "/tmp/bb-shim-fixture", content: "again" } });
send({ id: "nine", method: "fs/read_text_file", params: { path: "/tmp/bb-shim-fixture" } });
send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "noise" } } } });
process.stdout.write("not json from agent\n");
for await (const line of createInterface({ input: process.stdin })) {
  send({ method: "test/echo", params: { received: line } });
}
process.exit(0);
