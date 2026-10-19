// bb's injected tools (initiative_*, memory_*, …) served to Muse as one
// streamable-HTTP MCP server per session, inside the bridge process.
//
// Muse's `sessionMcp` capability accepts `{ transport: "streamableHttp",
// url, headers }`, so no helper process is needed: the bridge listens on
// 127.0.0.1 and tells each session its own bearer token. A call becomes an
// `item/tool/call` request to the runtime; the answer goes back to Muse.
// `tools/call` answers as an event stream with comment pings, so a tool that
// waits on a person (questions_ask) never looks like an idle connection.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import { BB_MCP_SERVER_NAME } from "./vocabulary.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PING_INTERVAL_MS = 15_000;

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCallOutcome {
  content: ToolContent[];
  isError: boolean;
}

export interface ToolRoute {
  tools: readonly DynamicTool[];
  /** `callId` is Muse's tool-call id when it sends one (`_meta.callId`). */
  call(name: string, args: Record<string, unknown>, callId: string | null): Promise<ToolCallOutcome>;
}

export interface RegisteredRoute {
  /** The `config.mcpServers` entry for `session/start` and `session/resume`. */
  mcpServers: Record<string, unknown>;
  dispose(): void;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function objectSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>;
    if (record.type === "object") return record;
    return { ...record, type: "object", properties: record.properties ?? {} };
  }
  return { type: "object", properties: {} };
}

export class BbToolServer {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly routes = new Map<string, ToolRoute>();

  constructor(private readonly pingIntervalMs = PING_INTERVAL_MS) {}

  async register(route: ToolRoute): Promise<RegisteredRoute> {
    const port = await this.listen();
    const token = randomBytes(32).toString("hex");
    this.routes.set(token, route);
    return {
      mcpServers: {
        [BB_MCP_SERVER_NAME]: {
          transport: "streamableHttp",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
          // Muse's default "required" fails the whole run when a server
          // cannot be reached; bb's tools are an addition, not a dependency.
          mode: "optional",
        },
      },
      dispose: () => {
        this.routes.delete(token);
      },
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.routes.clear();
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private listen(): Promise<number> {
    if (this.listening !== null) return this.listening;
    this.listening = new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            response.writeHead(500, { "content-type": "text/plain" });
          }
          response.end(error instanceof Error ? error.message : String(error));
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("bb tool server did not bind a TCP port"));
          return;
        }
        server.unref();
        this.server = server;
        resolve(address.port);
      });
    });
    return this.listening;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const route = this.routes.get(token);
    if (route === undefined) {
      response.writeHead(401, { "content-type": "text/plain" }).end("Unknown session token");
      return;
    }
    if (request.method !== "POST") {
      // No server-initiated stream: every answer rides its own POST.
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body = await readBody(request);
    // The session may have ended while the body was arriving.
    if (this.routes.get(token) !== route) {
      response.writeHead(410, { "content-type": "text/plain" }).end("Session ended");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(response, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const requests = messages.filter(
      (message): message is JsonRpcRequest =>
        typeof message === "object" && message !== null && "id" in message && "method" in message,
    );
    if (requests.length === 0) {
      // Notifications (`notifications/initialized`) and stray responses.
      response.writeHead(202).end();
      return;
    }
    const call = requests.find((message) => message.method === "tools/call");
    if (call !== undefined && requests.length === 1) {
      await this.streamToolCall(route, call, response);
      return;
    }
    const answers = await Promise.all(requests.map((message) => this.answer(route, message)));
    sendJson(response, Array.isArray(parsed) ? answers : answers[0]);
  }

  private async answer(route: ToolRoute, message: JsonRpcRequest): Promise<Record<string, unknown>> {
    const id = message.id as string | number;
    const params = (typeof message.params === "object" && message.params !== null
      ? message.params
      : {}) as Record<string, unknown>;
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: BB_MCP_SERVER_NAME, version: "1.0.0" },
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: route.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: objectSchema(tool.inputSchema),
            })),
          },
        };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await callTool(route, params) };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${String(message.method)}` },
        };
    }
  }

  private async streamToolCall(
    route: ToolRoute,
    message: JsonRpcRequest,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const ping = setInterval(() => response.write(": ping\n\n"), this.pingIntervalMs);
    // Muse may hang up while the tool still waits (on a person, say).
    response.once("close", () => clearInterval(ping));
    try {
      const answer = await this.answer(route, message);
      response.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    } finally {
      clearInterval(ping);
    }
  }
}

async function callTool(route: ToolRoute, params: Record<string, unknown>): Promise<ToolCallOutcome> {
  const name = typeof params.name === "string" ? params.name : "";
  if (!route.tools.some((tool) => tool.name === name)) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  const args =
    typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
  const meta = (typeof params._meta === "object" && params._meta !== null ? params._meta : {}) as {
    callId?: unknown;
  };
  try {
    return await route.call(name, args, typeof meta.callId === "string" ? meta.callId : null);
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("MCP request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}
