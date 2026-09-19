// Executor plugin backend: proxies Erwin's Executor MCP gateway
// (https://executor.erwinkn.com/mcp, behind Cloudflare Access) into bb agent
// tools on every provider. Auth comes from the plugin's secret settings —
// an OAuth access token (optionally self-refreshing) or a CF Access service
// token pair. See skills/executor/SKILL.md for agent-facing usage.

import type { BbPluginApi, PluginAgentToolContentPart, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ExecutorAuth } from "./auth";
import { ExecutorMcpClient, McpError, type McpToolCallResult } from "./mcp";

const DEFAULT_ENDPOINT = "https://executor.erwinkn.com/mcp";
const DEFAULT_TOKEN_ENDPOINT = "https://erwinkn.cloudflareaccess.com/cdn-cgi/access/oauth/token";

// Keep results bounded: gateway calls can return large payloads, and every
// byte lands in the provider's context.
const MAX_PART_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_CODE_CHARS = 64 * 1024;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const QUICK_CALL_TIMEOUT_MS = 30_000;

const NOT_CONFIGURED =
  "Executor is not configured. Ask the user to open the Executor plugin's settings and set either accessToken (plus refreshToken, clientId and clientSecret so the short-lived token can renew itself) or cfAccessClientId + cfAccessClientSecret.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sliceBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}

/** Map an MCP CallToolResult onto the plugin tool-result shape, capped. */
export function toToolResult(result: McpToolCallResult): PluginAgentToolResult {
  const parts: PluginAgentToolContentPart[] = [];
  let total = 0;
  const pushText = (text: string) => {
    const room = Math.min(MAX_PART_BYTES, MAX_RESULT_BYTES - total);
    if (room <= 0) return;
    const slice = sliceBytes(text, room);
    total += Buffer.byteLength(slice, "utf8");
    parts.push({ type: "text", text: slice });
  };
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      pushText(part.text);
    } else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      parts.push({ type: "image", data: part.data, mimeType: part.mimeType });
    } else if (part.type === "resource_link") {
      pushText(`[resource_link] ${typeof part.name === "string" ? `${part.name}: ` : ""}${part.uri ?? ""}`);
    } else if (part.type === "resource") {
      const resource = part.resource as { uri?: string; mimeType?: string; text?: string } | undefined;
      if (typeof resource?.text === "string") pushText(resource.text);
      else pushText(`[resource] ${resource?.uri ?? ""} ${resource?.mimeType ?? ""}`.trim());
    } else {
      pushText(JSON.stringify(part));
    }
  }
  if (parts.length === 0) {
    pushText(result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "(empty result)");
  }
  if (total >= MAX_RESULT_BYTES) {
    parts.push({ type: "text", text: "[executor result truncated: exceeded 128 KiB]" });
  }
  return { content: parts, isError: result.isError === true };
}

function toolError(error: unknown): PluginAgentToolResult {
  const text =
    error instanceof McpError ? `Executor error (${error.code}): ${error.message}` : errorMessage(error);
  return { content: [{ type: "text", text }], isError: true };
}

const EXECUTE_INSTRUCTIONS = [
  "executor_execute runs TypeScript in Erwin's Executor sandbox against his connected integrations (cloudflare, github, google_calendar, google_docs, google_drive, google_gmail, linear, massive, mobbin, notion, railway_mcp, wisprflow, bb, devin, exa, and more). Prefer it over browser or ad-hoc API flows for those services.",
  "Inside code: const { items } = await tools.search({ query: \"<intent + key nouns>\", namespace?: \"<integration>\", limit: 12 }); then await tools.describe.tool({ path }) for inputTypeScript/outputTypeScript; call await tools.<integration>.<owner>.<connection>.<tool>(args) — the path from search/describe is already the full address.",
  "Calls return { ok: true, data } or { ok: false, error } — branch on result.ok. tools.executor.coreTools.connections.list({}) lists live connections. tools is a lazy proxy: never enumerate it, use tools.search.",
  "emit(value) appends user-visible output and files; return carries structured data. No fetch, Buffer, atob, or TextEncoder in the sandbox.",
  "If a run pauses for interaction it returns an executionId — continue with executor_resume. Call executor_skills({ name: \"execute\" }) once for the gateway's own full guide.",
].join(" ");

export async function createExecutorPlugin(bb: BbPluginApi, fetchImpl: typeof fetch = fetch) {
  const urlSetting = (label: string, description: string, def: string) => ({
    type: "string" as const,
    label,
    description,
    default: def,
    experimental_schema: z
      .string()
      .refine((v) => !v || validUrl(v), "Use an https:// URL without credentials, query, or fragment."),
  });
  const secret = (label: string, description: string) => ({
    type: "string" as const,
    label,
    description,
    secret: true as const,
  });
  const settings = bb.settings.define({
    endpointUrl: urlSetting("Executor MCP endpoint", "Streamable-HTTP MCP endpoint of the Executor gateway.", DEFAULT_ENDPOINT),
    tokenEndpoint: urlSetting("OAuth token endpoint", "Cloudflare Access token endpoint used to renew accessToken.", DEFAULT_TOKEN_ENDPOINT),
    accessToken: secret("Access token", "OAuth access_token sent as Authorization: Bearer on every request. Short-lived (~15 min); pair with refreshToken + client credentials."),
    refreshToken: secret("Refresh token", "OAuth refresh_token used with the client credentials to rotate the access token."),
    clientId: secret("OAuth client ID", "Dynamically registered OAuth client ID (token_endpoint_auth_method=client_secret_basic)."),
    clientSecret: secret("OAuth client secret", "OAuth client secret; sent as HTTP Basic on the token endpoint during refresh."),
    cfAccessClientId: secret("CF Access client ID", "Service-token alternative to OAuth: sent as the CF-Access-Client-Id header."),
    cfAccessClientSecret: secret("CF Access client secret", "Sent as the CF-Access-Client-Secret header."),
  });

  const auth = new ExecutorAuth(
    () => settings.get(),
    async (patch) => {
      await settings.experimental_set(patch);
    },
    bb.storage.kv,
    fetchImpl,
    (message) => bb.log.info(message),
  );

  let client: ExecutorMcpClient | null = null;
  async function getClient(): Promise<ExecutorMcpClient> {
    const creds = await settings.get();
    if (!auth.configured(creds)) throw new McpError("not_configured", NOT_CONFIGURED);
    if (!client || client.endpoint !== creds.endpointUrl) {
      const stale = client;
      client = null;
      await stale?.close();
      client = new ExecutorMcpClient({
        endpoint: creds.endpointUrl,
        auth,
        fetchImpl,
        clientName: "bb-plugin-executor",
        clientVersion: "0.1.0",
        log: (message) => bb.log.info(message),
      });
    }
    return client;
  }
  // No settings.onChange reset: auth.headers() re-reads credentials on every
  // request and getClient recreates the client on endpoint change, so a token
  // rotation must not tear down a healthy MCP session.
  bb.onDispose(() => {
    void client?.close();
  });

  async function callUpstream(
    tool: string,
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal },
    timeoutMs: number,
  ): Promise<PluginAgentToolResult> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    try {
      const mcp = await getClient();
      if (tool === "__list__") {
        const { tools } = await mcp.listTools(signal);
        return toToolResult({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                (tools ?? []).map((t) => ({ name: t.name, description: t.description })),
                null,
                2,
              ),
            },
          ],
        });
      }
      const result =
        tool === "__call__"
          ? await mcp.callTool(
              String(args.tool),
              (args.arguments as Record<string, unknown> | undefined) ?? {},
              signal,
            )
          : await mcp.callTool(tool, args, signal);
      return toToolResult(result);
    } catch (error) {
      if (timeout.aborted && !ctx.signal.aborted) {
        return toolError(new McpError("timeout", `Executor call exceeded ${Math.round(timeoutMs / 1000)}s.`));
      }
      return toolError(error);
    }
  }

  interface ProxyTool<S extends z.ZodType> {
    name: string;
    description: string;
    parameters: S;
    upstream: string;
    map: (params: z.output<S>) => Record<string, unknown>;
    instructions?: string;
    timeoutMs?: number;
    labels: { pending: string; completed: string };
    suppress?: boolean;
  }
  function registerProxy<S extends z.ZodType>(tool: ProxyTool<S>) {
    bb.agents.registerTool({
      name: tool.name,
      description: tool.description,
      instructions: tool.instructions,
      parameters: tool.parameters,
      presentation: {
        label: tool.labels,
        suppress: tool.suppress,
      },
      execute: (params, ctx) =>
        callUpstream(tool.upstream, tool.map(params as z.output<S>), ctx, tool.timeoutMs ?? QUICK_CALL_TIMEOUT_MS),
    });
  }

  const connections = z
    .record(z.string(), z.string())
    .optional()
    .describe('Connection for each integration role used, as "<integration>.<user|org>.<connection>". Optional with one connection per integration; required with several.');

  registerProxy({
    name: "executor_execute",
    description:
      "Execute TypeScript in Erwin's Executor sandbox with a `tools` proxy to his connected integrations and `emit` for user-visible output. Call executor_skills({ name: \"execute\" }) for the full guide before writing non-trivial code.",
    instructions: EXECUTE_INSTRUCTIONS,
    parameters: z.object({
      code: z.string().min(1).max(MAX_CODE_CHARS).describe("TypeScript source. Top-level await is available; type syntax is stripped before execution."),
      timeoutMs: z.number().int().min(1_000).max(300_000).optional().describe("How long to wait for the gateway, in ms (default 120000)."),
    }),
    upstream: "execute",
    map: ({ code }) => ({ code }),
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    labels: { pending: "Running code on Executor", completed: "Ran code on Executor" },
  });

  registerProxy({
    name: "executor_skills",
    description:
      "Read the Executor gateway's own how-to docs for its tools (e.g. \"execute\", \"create-artifact\", \"artifact-style\"). Omit name to list the catalog.",
    parameters: z.object({
      name: z.string().min(1).optional().describe("A doc from the gateway's catalog, e.g. \"execute\". Omit to list it."),
    }),
    upstream: "skills",
    map: ({ name }) => (name === undefined ? {} : { name }),
    labels: { pending: "Reading Executor docs", completed: "Read Executor docs" },
    suppress: true,
  });

  registerProxy({
    name: "executor_resume",
    description: "Resume a paused Executor run with the executionId returned by executor_execute.",
    parameters: z.object({
      executionId: z.string().min(1).describe("The execution ID from the paused result."),
      action: z.enum(["accept", "decline", "cancel"]).describe("How to respond to the interaction."),
      content: z.string().optional().describe("Optional JSON-encoded response content for form elicitations."),
    }),
    upstream: "resume",
    map: ({ executionId, action, content }) => ({ executionId, action, ...(content !== undefined ? { content } : {}) }),
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    labels: { pending: "Resuming Executor run", completed: "Resumed Executor run" },
  });

  registerProxy({
    name: "executor_create_artifact",
    description:
      "Render an interactive React UI component as an Executor artifact. Call executor_skills({ name: \"create-artifact\" }) for the required patterns first. Clients that cannot display it get a link to pass to the user.",
    parameters: z.object({
      code: z.string().min(1).describe("React component source exporting App; reads data via useQuery(tools.<integration>.<tool>.queryOptions(args))."),
      artifactId: z.string().min(1).optional().describe("Rewrite this existing artifact in place (full replacement). Omit to create new; prefer executor_edit_artifact for tweaks."),
      connections,
      title: z.string().optional().describe("Short human-readable name. Required when creating."),
      description: z.string().optional().describe("What this UI shows, in a sentence."),
    }),
    upstream: "create-artifact",
    map: (params) => stripUndefined(params),
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    labels: { pending: "Creating Executor artifact", completed: "Created Executor artifact" },
  });

  registerProxy({
    name: "executor_edit_artifact",
    description:
      "Patch an existing Executor artifact with exact find-and-replace edits (applied in order, all-or-nothing). Prefer this over executor_create_artifact for tweaks.",
    parameters: z.object({
      artifactId: z.string().min(1).describe("The artifact to edit, from executor_list_artifacts or a previous create."),
      edits: z
        .array(
          z.object({
            oldText: z.string().min(1).describe("Exact text to find; must match exactly once unless replaceAll is true."),
            newText: z.string().describe("The replacement text."),
            replaceAll: z.boolean().optional().describe("Replace every occurrence."),
          }),
        )
        .min(1),
      connections,
      title: z.string().optional(),
      description: z.string().optional(),
    }),
    upstream: "edit-artifact",
    map: (params) => stripUndefined(params),
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    labels: { pending: "Editing Executor artifact", completed: "Edited Executor artifact" },
  });

  registerProxy({
    name: "executor_list_artifacts",
    description: "List the saved Executor UI artifacts, newest first.",
    parameters: z.object({}),
    upstream: "list-artifacts",
    map: () => ({}),
    labels: { pending: "Listing Executor artifacts", completed: "Listed Executor artifacts" },
    suppress: true,
  });

  registerProxy({
    name: "executor_show_artifact",
    description: "Re-render a saved Executor artifact by id; use executor_list_artifacts to find it. Pass the returned link to the user when the client cannot display it.",
    parameters: z.object({
      id: z.string().min(1).describe("The artifact id from executor_list_artifacts."),
    }),
    upstream: "show-artifact",
    map: ({ id }) => ({ id }),
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    labels: { pending: "Showing Executor artifact", completed: "Showed Executor artifact" },
  });

  registerProxy({
    name: "executor_tools",
    description: "List the live tools the Executor gateway currently exposes (tools/list), for discovering surface not mirrored by the executor_* tools.",
    parameters: z.object({}),
    upstream: "__list__",
    map: () => ({}),
    labels: { pending: "Listing Executor tools", completed: "Listed Executor tools" },
    suppress: true,
  });

  registerProxy({
    name: "executor_call",
    description:
      "Call any Executor gateway tool by its upstream name (as reported by executor_tools), with a JSON argument object. Escape hatch for gateway tools not mirrored as executor_* tools.",
    parameters: z.object({
      tool: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).describe("Upstream tool name, e.g. \"create-artifact\"."),
      arguments: z.record(z.string(), z.unknown()).optional().describe("Argument object passed through verbatim."),
    }),
    upstream: "__call__",
    map: (params) => params as Record<string, unknown>,
    timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    labels: { pending: "Calling Executor tool", completed: "Called Executor tool" },
  });

  const TOOL_NAMES = [
    "executor_execute",
    "executor_skills",
    "executor_resume",
    "executor_create_artifact",
    "executor_edit_artifact",
    "executor_list_artifacts",
    "executor_show_artifact",
    "executor_tools",
    "executor_call",
  ];

  // Select every mirror tool and the executor skill for every provider — the
  // gateway is meant to be reachable from any bb thread on any machine.
  bb.agents.configure(() => ({ tools: TOOL_NAMES, skills: ["executor"] }));

  bb.cli.register({
    name: "executor",
    summary: "Inspect the Executor MCP gateway connection and live tool surface",
    commands: [
      { name: "status", summary: "Show endpoint, configured credential fields, and session state (never secret values)", usage: "bb executor status" },
      { name: "tools", summary: "List the gateway's tools via tools/list", usage: "bb executor tools" },
      { name: "call", summary: "Call a gateway tool with a JSON argument object", usage: "bb executor call <tool> [json-args]" },
    ],
    async run(argv, ctx) {
      const sub = argv[0] ?? "status";
      if (sub === "status") {
        const creds = await settings.get();
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            {
              endpoint: creds.endpointUrl,
              tokenEndpoint: creds.tokenEndpoint,
              credentialFieldsSet: auth.describe(creds),
              configured: auth.configured(creds),
              sessionActive: client?.sessionActive ?? false,
            },
            null,
            2,
          ),
        };
      }
      if (sub === "tools") {
        try {
          const mcp = await getClient();
          const { tools } = await mcp.listTools(ctx.signal);
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              (tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
              null,
              2,
            ),
          };
        } catch (error) {
          return { exitCode: 1, stderr: errorMessage(error) };
        }
      }
      if (sub === "call" && argv.length >= 2) {
        let args: Record<string, unknown> = {};
        if (argv[2] !== undefined) {
          try {
            const parsed = JSON.parse(argv[2]);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              return { exitCode: 1, stderr: "Arguments must be a JSON object." };
            }
            args = parsed as Record<string, unknown>;
          } catch {
            return { exitCode: 1, stderr: "Arguments must be a JSON object." };
          }
        }
        try {
          const mcp = await getClient();
          const result = await mcp.callTool(argv[1], args, ctx.signal);
          const text = JSON.stringify(result);
          return { exitCode: 0, stdout: sliceBytes(text, 900_000) };
        } catch (error) {
          return { exitCode: 1, stderr: errorMessage(error) };
        }
      }
      return { exitCode: 1, stderr: "Usage: bb executor status | tools | call <tool> [json-args]" };
    },
  });
}

function stripUndefined(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
  return out;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export default async function plugin(bb: BbPluginApi) {
  return createExecutorPlugin(bb);
}
