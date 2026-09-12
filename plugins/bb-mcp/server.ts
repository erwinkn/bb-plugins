import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createMcpHandler, McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineSettings, ToolError } from "./config";
import { createStore, errorView, operationView } from "./store";
import { EXECUTE_DESCRIPTION, EXECUTE_TOOL, makeDispatch, READ_DESCRIPTION, READ_TOOL, runCode, sdkCall, SDK_PATHS } from "./codemode";
import { reconcileOp } from "./ops";

const inputSchema = z.object({ code: z.string().min(1).max(32768), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict();

export default function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  const store = createStore(bb);
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "bb-mcp", version: "0.4.0" }, {
      capabilities: { tools: {} },
      instructions: "Code-mode remote control of BB for a trusted orchestrator. bb_execute runs JavaScript in an isolated worker whose `bb` global mirrors the complete BB SDK (threads, threadSections, projects, environments, files, terminals, hosts, providers, plugins, system, skills, status, theme, guide) plus bb.ops for durable, deduplicated dispatch receipts. Compose calls, loop, wait and filter inside the worker; only the returned value crosses the wire. BB enforces its own validation and native limits; there is no plugin-side permission layer.",
    });
    const codeTool = (name: string, description: string, readOnly: boolean) =>
      server.registerTool(name, {
        description,
        inputSchema,
        outputSchema: z.object({ data: z.record(z.string(), z.unknown()) }),
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
      }, async (input: unknown, ctx: ServerContext): Promise<CallToolResult> => {
        try {
          const args = inputSchema.parse(input);
          const data = await runCode({
            code: args.code, timeoutMs: args.timeoutMs, paths: SDK_PATHS, signal: ctx.mcpReq.signal,
            dispatch: makeDispatch(bb.sdk, store, path => bb.log.info(`MCP exec ${path}`), ctx.mcpReq.signal, readOnly),
          });
          bb.log.info(`MCP ${name}: ok`);
          return { content: [{ type: "text" as const, text: JSON.stringify({ data }) }], structuredContent: { data } };
        } catch (error) {
          const { code, message } = error instanceof z.ZodError
            ? { code: "invalid_arguments", message: error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") }
            : errorView(error);
          bb.log.warn(`MCP ${name}: ${code}`);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }] };
        }
      });
    codeTool(EXECUTE_TOOL, EXECUTE_DESCRIPTION, false);
    codeTool(READ_TOOL, READ_DESCRIPTION, true);
    return server;
  }, { responseMode: "json", legacy: "stateless", maxSubscriptions: 0 });
  bb.onDispose(() => handler.close());

  for (const method of ["POST", "GET", "DELETE", "OPTIONS"]) {
    bb.http.route(method, "/mcp", async ctx => {
      const req = ctx.req.raw, url = new URL(req.url);
      // BB enforces token equality. Refuse its query-token alternative here.
      if (!req.headers.get("x-bb-plugin-token") || url.searchParams.has("token")) return ctx.json({ error: "Use x-bb-plugin-token authentication." }, 401);
      const c = await settings.get();
      const origins = [bb.server.loopbackBaseUrl, c.appUrl, c.endpointUrl].filter(Boolean).map(v => new URL(v).origin);
      const host = req.headers.get("host") ?? url.host;
      if (!origins.some(o => new URL(o).host === host)) return ctx.json({ error: "Host not allowed." }, 403);
      const origin = req.headers.get("origin");
      if (origin && !origins.includes(origin)) return ctx.json({ error: "Origin not allowed." }, 403);
      const response = await handler.fetch(req);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }, { auth: "token" });
  }
  bb.cli.register({ name: "mcp", summary: "Inspect the BB MCP endpoint, access and request outcomes", commands: [
    { name: "status", summary: "Show endpoint, settings and surface without credentials", usage: "bb mcp status" },
    { name: "operations", summary: "Show the recorded durable-dispatch outcomes without prompts", usage: "bb mcp operations" },
    { name: "reconcile", summary: "Record a manually verified unknown request as accepted", usage: "bb mcp reconcile <operation-id> <thread-id> --confirmed" },
  ], async run(argv) {
    if (argv[0] === "reconcile" && argv.length === 4 && argv[3] === "--confirmed") {
      try {
        return { exitCode: 0, stdout: JSON.stringify(await reconcileOp(store, (p, a) => sdkCall(bb.sdk, p, a), argv[1], argv[2]), null, 2) };
      } catch (e) { return { exitCode: 1, stderr: e instanceof ToolError ? e.message : "BB could not reconcile the operation." }; }
    }
    if (argv[0] === "operations") return { exitCode: 0, stdout: JSON.stringify(store.list().map(operationView), null, 2) };
    if (!argv.length || ["status", "--help"].includes(argv[0])) return { exitCode: 0, stdout: JSON.stringify({ endpointPath: "/api/v1/plugins/bb-mcp/http/mcp", authentication: "x-bb-plugin-token", version: "0.4.0", surface: "code-mode full bb.sdk plus bb.ops", methodCount: SDK_PATHS.length, settings: await settings.get() }, null, 2) };
    return { exitCode: 1, stderr: "Usage: bb mcp status | operations | reconcile <operation-id> <thread-id> --confirmed" };
  } });
}
