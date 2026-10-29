// The plugin through BB's fake host: registration passes BB's own checks
// (names, recursive $ref, instruction caps), tools call through, the
// callback route and CLI answer, and a changed surface reloads the plugin.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server";
import { MAX_TOOL_INSTRUCTIONS } from "../src/surface";
import type { ServerConfig } from "../src/store";
import { modernServer, type FixtureTool } from "./fixtures";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const recursive: FixtureTool = {
  name: "tree.walk",
  description: "Walk a tree.",
  inputSchema: {
    type: "object",
    properties: { root: { $ref: "#/$defs/node" } },
    $defs: { node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
  },
};
const plain: FixtureTool = { name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } };

function seed(dataDir: string, servers: ServerConfig[]) {
  const dir = join(dataDir, "plugins", "mcp-servers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "servers.json"), JSON.stringify({ version: 1, servers }));
}

function server(url: string, tools: FixtureTool[], instructions?: string): ServerConfig {
  return {
    id: "srv1",
    name: "Fixture",
    prefix: "fx",
    url,
    enabled: true,
    auth: { kind: "none" },
    createdAt: 1,
    cache: { transport: "streamable-http", tools, fetchedAt: 1, ...(instructions ? { instructions } : {}) },
  };
}

async function start(servers: ServerConfig[]) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp-servers-plugin-"));
  seed(dataDir, servers);
  const reloads: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "mcp-servers",
    dataDir,
    sdk: {
      plugins: {
        list: async () => ({ plugins: [] }) as never,
        reload: async (args: unknown) => {
          reloads.push(args);
          return {} as never;
        },
      },
    },
  });
  await createPlugin(bb);
  cleanups.push(() => harness.lifecycle.dispose(), () => rmSync(dataDir, { recursive: true, force: true }));
  return { bb, harness, reloads, dataDir };
}

describe("plugin", () => {
  it("registers cached tools at activation, with recursion broken and instructions split", async () => {
    const instructions = `${"Use the tree tools carefully. ".repeat(200)}\n\nEnd.`;
    const { harness } = await start([server("http://127.0.0.1:9/mcp", [recursive, plain], instructions)]);
    const tools = harness.inspection.registrations.agentTools;
    // Sorted by upstream name.
    expect(tools.map((tool) => tool.name)).toEqual(["fx_ping", "fx_tree_walk"]);
    const walk = tools[1]!;
    expect(walk.description).toBe("Walk a tree.");
    expect(JSON.stringify(walk.inputSchema)).toContain("Recursive: same shape as #/$defs/node");
    const pieces = tools.map((tool) => tool.instructions ?? "");
    expect(pieces.every((piece) => piece.length <= MAX_TOOL_INSTRUCTIONS)).toBe(true);
    expect(pieces[0]).toMatch(/^Instructions from the MCP server "Fixture" \(its tools are named fx_\*\):/);
    expect(pieces[1]).toMatch(/^Instructions from the MCP server "Fixture", continued:/);
    // Nothing lost: the pieces put back together are the instructions.
    const body = pieces.map((piece) => piece.slice(piece.indexOf("\n\n") + 2)).join(" ");
    expect(body.replace(/\s+/g, " ")).toBe(instructions.trim().replace(/\s+/g, " "));
  });

  it("calls through to the live server", async () => {
    const live = await modernServer({ tools: [plain] });
    cleanups.push(() => live.close());
    const { harness } = await start([server(live.url, [plain])]);
    const service = harness.behavior.runService("connections");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
    });
    const result = await harness.behavior.callAgentTool("fx_ping", {});
    expect(result).toEqual({ content: [{ type: "text", text: "ping:{}" }], isError: false });
  });

  it("reloads itself once the live tool list differs from the registered one", async () => {
    const live = await modernServer({ tools: [plain, recursive] });
    cleanups.push(() => live.close());
    const { harness, reloads } = await start([server(live.url, [plain])]);
    const service = harness.behavior.runService("connections");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
    });
    const deadline = Date.now() + 10_000;
    while (reloads.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reloads).toEqual([{ pluginId: "mcp-servers" }]);
  });

  it("answers the OAuth callback route without a valid flow with a 400 page", async () => {
    const { harness } = await start([]);
    const response = await harness.behavior.fetchHttp("GET", "/oauth/callback?code=x&state=nope");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Authorization failed");
  });

  it("keeps filtering SDK warnings after a reload", async () => {
    const unfiltered = console.warn;
    const secret = "hdr-secret-1234";
    const { harness, dataDir } = await start([{ ...server("http://127.0.0.1:9/mcp", [plain]), auth: { kind: "header", headerName: "X-Key" } }]);
    writeFileSync(
      join(dataDir, "plugins", "mcp-servers", "secrets.json"),
      JSON.stringify({ version: 1, servers: { srv1: { headerValue: secret } } }),
    );
    // BB activates the replacement before it disposes this load.
    const next = await harness.lifecycle.reload(createPlugin);
    console.warn(`[mcp-sdk] refresh failed for ${secret} Cause: {"echo":"${secret}"}`);
    const messages = next.harness.inspection.logEntries.map((entry) => entry.message);
    expect(messages).toContain("[mcp-sdk] refresh failed for [redacted]");
    expect(messages.join("\n")).not.toContain(secret);
    // The last load out puts console.warn back.
    await next.harness.lifecycle.dispose();
    expect(console.warn).toBe(unfiltered);
  });

  it("lists servers on the CLI without secrets", async () => {
    const { harness } = await start([server("http://127.0.0.1:9/mcp", [plain])]);
    const { exitCode, stdout } = await harness.behavior.runCli(["list"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).servers[0]).toMatchObject({ prefix: "fx", tools: 1, liveTools: 1 });
  });
});
