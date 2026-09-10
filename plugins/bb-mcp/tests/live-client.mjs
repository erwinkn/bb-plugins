// Run on the BB server host. The token stays in memory and out of arguments/logs.
// node tests/live-client.mjs [--legacy] [--url https://host/mcp] [tool] ['{"arguments":"here"}']
import { execFileSync } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const args = process.argv.slice(2);
const legacy = args.includes("--legacy"); if (legacy) args.splice(args.indexOf("--legacy"), 1);
let endpoint = "http://127.0.0.1:38886/api/v1/plugins/bb-mcp/http/mcp";
const urlAt = args.indexOf("--url"); if (urlAt !== -1) { endpoint = args[urlAt + 1]; args.splice(urlAt, 2); }
const token = JSON.parse(execFileSync("bb", ["plugin", "token", "bb-mcp", "--json"], { encoding: "utf8" })).token;
const client = new Client({ name: "bb-mcp-live-verification", version: "0.1.0" }, { versionNegotiation: { mode: legacy ? "legacy" : "auto" } });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { "x-bb-plugin-token": token } } });
try {
  await client.connect(transport);
  if (!args[0]) {
    const result = await client.listTools();
    console.log(JSON.stringify({ server: client.getServerVersion(), tools: result.tools.map(t => t.name) }, null, 2));
  } else {
    const result = await client.callTool({ name: args[0], arguments: JSON.parse(args[1] ?? "{}") });
    console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
    if (result.isError) process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error).replaceAll(token, "[redacted]")); process.exitCode = 1;
} finally { await client.close(); }
