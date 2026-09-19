// Minimal MCP "streamable HTTP" client for the Executor gateway. One POST per
// JSON-RPC message to the endpoint; the server answers either
// `application/json` or `text/event-stream` (one or more SSE `data:` events,
// each holding a JSON-RPC message). The `mcp-session-id` response header from
// `initialize` is echoed on every later request; a 404 means the session
// expired and the client re-initializes once.

import type { ExecutorAuth } from "./auth";

export const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

class SessionExpiredError extends Error {
  constructor() {
    super("MCP session expired");
    this.name = "SessionExpiredError";
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ExecutorMcpClientOptions {
  endpoint: string;
  auth: ExecutorAuth;
  fetchImpl?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
  log?: (message: string) => void;
}

export class ExecutorMcpClient {
  private sessionId: string | null = null;
  private ready = false;
  private initializing: Promise<void> | null = null;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: ExecutorMcpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  get endpoint(): string {
    return this.opts.endpoint;
  }

  get sessionActive(): boolean {
    return this.ready;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    return (await this.request("tools/call", { name, arguments: args }, signal)) as McpToolCallResult;
  }

  async listTools(signal?: AbortSignal): Promise<{ tools?: Array<{ name?: string; description?: string }> }> {
    return (await this.request("tools/list", {}, signal)) as {
      tools?: Array<{ name?: string; description?: string }>;
    };
  }

  /** Best-effort session teardown (DELETE with the session id). */
  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.ready = false;
    if (!sessionId) return;
    try {
      const auth = await this.opts.auth.headers();
      await this.fetchImpl(this.opts.endpoint, {
        method: "DELETE",
        headers: { ...auth, "mcp-session-id": sessionId },
      });
    } catch {}
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.ready) return;
    this.initializing ??= this.initialize(signal).finally(() => {
      this.initializing = null;
    });
    await this.initializing;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const id = this.nextId++;
    const res = await this.send(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: this.opts.clientName ?? "bb-executor",
            version: this.opts.clientVersion ?? "0.1.0",
          },
        },
      },
      signal,
    );
    const sessionId = res.headers.get("mcp-session-id");
    await readJsonRpcResult(res, id);
    this.sessionId = sessionId;
    this.ready = true;
    try {
      await this.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    } catch (error) {
      this.log(`executor initialized notification failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    retry = true,
  ): Promise<unknown> {
    await this.ensureSession(signal);
    const id = this.nextId++;
    try {
      const res = await this.send({ jsonrpc: "2.0", id, method, params }, signal);
      return await readJsonRpcResult(res, id);
    } catch (error) {
      if (error instanceof SessionExpiredError && retry) {
        this.log("executor MCP session expired; re-initializing");
        this.sessionId = null;
        this.ready = false;
        await this.ensureSession(signal);
        return this.request(method, params, signal, false);
      }
      throw error;
    }
  }

  private async notify(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    const res = await this.send(message, signal);
    await res.body?.cancel().catch(() => {});
    if (res.status >= 400) {
      throw new McpError(`http_${res.status}`, `Executor gateway returned HTTP ${res.status} for a notification`, res.status);
    }
  }

  private async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<Response> {
    const post = async (): Promise<Response> => {
      const auth = await this.opts.auth.headers(signal);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...auth,
      };
      if (this.sessionId) {
        headers["mcp-session-id"] = this.sessionId;
        headers["mcp-protocol-version"] = PROTOCOL_VERSION;
      }
      return this.fetchImpl(this.opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: signal ?? null,
      });
    };
    let res = await post();
    if (res.status === 401) {
      const refreshed = await this.opts.auth.refresh(signal).catch(() => false);
      if (refreshed) res = await post();
    }
    if (res.status === 401) {
      throw new McpError(
        "unauthorized",
        "Executor gateway rejected the configured credentials (HTTP 401). Ask the user to check the Executor plugin's auth settings — the access token may be expired with no working refresh, or the CF Access service token may be wrong.",
        401,
      );
    }
    if (res.status === 404) {
      if (this.sessionId) throw new SessionExpiredError();
      throw new McpError("http_404", "Executor gateway returned HTTP 404.", 404);
    }
    return res;
  }
}

function unwrap(message: JsonRpcMessage, id: number): unknown {
  if (message.error) {
    throw new McpError(`rpc_${message.error.code}`, message.error.message);
  }
  if (!("result" in message)) {
    throw new McpError("bad_response", "Executor gateway returned a JSON-RPC message that is not a response.");
  }
  return message.result;
}

async function readJsonRpcResult(res: Response, id: number): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && type.includes("text/event-stream")) {
    const message = await readSseResponse(res, id);
    return unwrap(message, id);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    throw new McpError(`http_${res.status}`, `Executor gateway returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`, res.status);
  }
  const text = await res.text();
  if (!text.trim()) throw new McpError("bad_response", "Executor gateway returned an empty response.");
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(text) as JsonRpcMessage;
  } catch {
    throw new McpError("bad_response", `Executor gateway returned non-JSON (${type || "unknown content-type"}): ${text.slice(0, 200)}`);
  }
  return unwrap(message, id);
}

function parseSseEvent(block: string): JsonRpcMessage | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  try {
    return JSON.parse(data.join("\n")) as JsonRpcMessage;
  } catch {
    return null;
  }
}

async function readSseResponse(res: Response, id: number): Promise<JsonRpcMessage> {
  const reader = res.body?.getReader();
  if (!reader) throw new McpError("bad_response", "Executor gateway SSE response has no body.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/)) !== null) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index! + match[0].length);
        const message = parseSseEvent(block);
        if (message && message.id === id) return message;
      }
    }
    throw new McpError("bad_response", "Executor gateway SSE stream ended without a response.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
