// MCP servers: connect any remote MCP server by URL and give its tools to
// every agent BB runs (Claude Code, Codex, Pi, Muse, ACP), under their own
// names, descriptions and input schemas, with the server's instructions.
//
// At activation the plugin registers the tools it last saw each enabled
// server serve (servers.json), so nothing waits on the network. Live
// connections then refresh those lists; when they change, the plugin
// reloads itself to register the new surface, which agents get when their
// provider session next starts (BB never changes a running session's tools).

import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, SERVERS_CHANGED } from "./src/contract";
import { CALLBACK_PATH } from "./src/oauth";
import { Manager, UserError } from "./src/manager";
import { Store } from "./src/store";
import { computeSurface } from "./src/surface";

export { rpcContract };
export type { ListResult, ServerView } from "./src/contract";

const FOREIGN_TOOLS_REFRESH_MS = 10 * 60_000;

// The SDK reports some OAuth and transport trouble on console.warn, and
// quotes server responses after "Cause:". Log what the SDK says, never what
// the server said, and redact even that; leave other output alone.
//
// One filter per process, handed from load to load: BB activates the
// replacement before it disposes the old load, so a load that restored
// console.warn on dispose would remove its successor's filter.
const WARN_FILTER = Symbol.for("bb-plugin-mcp-servers.warn-filter");

interface WarnFilter {
  original: typeof console.warn;
  wrapper: typeof console.warn;
  /** The live load's sink; null between loads (SDK warnings are dropped). */
  sink: ((own: string) => void) | null;
}

function filterSdkWarnings(sink: (own: string) => void): () => void {
  const global = globalThis as { [WARN_FILTER]?: WarnFilter };
  let filter = global[WARN_FILTER];
  if (!filter) {
    const original = console.warn;
    const created: WarnFilter = {
      original,
      sink: null,
      wrapper: (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("[mcp-sdk]")) {
          created.sink?.(args[0].split(/\s*Cause:/)[0]!);
          return;
        }
        original.apply(console, args as []);
      },
    };
    console.warn = created.wrapper;
    filter = global[WARN_FILTER] = created;
  }
  const installed = filter;
  installed.sink = sink;
  return () => {
    if (installed.sink !== sink) return;
    installed.sink = null;
    // Unwrap only when nothing has wrapped console.warn since.
    if (console.warn === installed.wrapper) {
      console.warn = installed.original;
      delete global[WARN_FILTER];
    }
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function callbackPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#222}main{max-width:28rem;padding:2rem}h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#555}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}p{color:#aaa}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

export async function createPlugin(bb: BbPluginApi, fetchImpl: typeof fetch = fetch) {
  // An unreadable store stops the load (the error says which file) rather
  // than start empty and overwrite it on the first write.
  const store = new Store(join(bb.server.experimental_dataDir, "plugins", bb.pluginId));

  // Register what the servers served last time; manager.ts reloads the
  // plugin when that stops being true.
  const surface = computeSurface(store.list());
  const names = new Set<string>();
  // The manager holds `names` by reference; registration fills it below.
  const m = new Manager({
    store,
    pluginId: bb.pluginId,
    fetchImpl,
    log: (message) => bb.log.info(message),
    publish: (list) => bb.realtime.publish(SERVERS_CHANGED, list),
    requestReload: () => {
      // Fire and forget: the reload disposes this load, which waits for
      // the handler that asked.
      setTimeout(() => {
        void bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch((error: unknown) => {
          bb.log.warn(`self-reload failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 0);
    },
    registered: { surface, names },
  });
  for (const tool of surface.tools) {
    try {
      bb.agents.registerTool({
        name: tool.name,
        description: tool.description,
        ...(tool.instructions ? { instructions: tool.instructions } : {}),
        parameters: tool.inputSchema,
        execute: (params, ctx) => m.callTool(tool.serverId, tool.upstreamName, params, ctx.signal),
      });
      names.add(tool.name);
    } catch (error) {
      bb.log.warn(`could not register ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  bb.onDispose(filterSdkWarnings((own) => bb.log.warn(m.safe(own))));

  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof UserError) throw new Error(error.message);
        throw error;
      }
    };

  bb.rpc.register(rpcContract, {
    list: () => m.list(),
    add: wrap((input) => m.add(input)),
    update: wrap(({ id, ...input }) => {
      m.update(id, input);
      return { ok: true as const };
    }),
    remove: wrap(({ id }) => {
      m.remove(id);
      return { ok: true as const };
    }),
    setEnabled: wrap(({ id, enabled }) => {
      m.setEnabled(id, enabled);
      return { ok: true as const };
    }),
    reconnect: wrap(({ id }) => {
      m.reconnect(id);
      return { ok: true as const };
    }),
    startAuth: wrap(({ id, origin }) => m.startAuth(id, origin)),
    completeAuth: wrap(async ({ id, redirectedUrl }) => {
      await m.completeAuth(id, redirectedUrl);
      return { ok: true as const };
    }),
    disconnect: wrap(({ id }) => {
      m.disconnect(id);
      return { ok: true as const };
    }),
  });

  // The OAuth redirect. A top-level GET from the authorization server: BB's
  // "local" mode accepts it (no Origin header), and through BB Connect it
  // carries the owner's session. The one-time state ties it to a flow.
  bb.http.route("GET", CALLBACK_PATH, async (ctx) => {
    const params = new URL(ctx.req.url).searchParams;
    try {
      const name = await m.finishAuth(params);
      return ctx.html(callbackPage(`Connected to ${name}`, "Its tools reach agents in their next session. You can close this tab."));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ctx.html(callbackPage("Authorization failed", message), 400);
    }
  });

  // Tool names other plugins own, so a prefix that would collide is refused
  // and an existing collision shows on the server.
  bb.background.service("connections", {
    async start(signal) {
      m.start();
      while (!signal.aborted) {
        try {
          const { plugins } = await bb.sdk.plugins.list();
          const foreign = new Map<string, string>();
          for (const plugin of plugins) {
            if (plugin.id === bb.pluginId) continue;
            for (const capability of plugin.capabilities ?? [])
              if (capability.kind === "agent-tool") foreign.set(capability.id, plugin.id);
          }
          m.setForeignToolNames(foreign);
        } catch (error) {
          bb.log.warn(`could not list other plugins' tools: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, FOREIGN_TOOLS_REFRESH_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  });
  bb.onDispose(() => m.close());

  bb.cli.register({
    name: "mcp-servers",
    summary: "List connected MCP servers and their tools, or call one",
    commands: [
      { name: "list", summary: "Servers, their state and tool counts (no secrets)", usage: "bb mcp-servers list" },
      { name: "tools", summary: "The BB tool names a server's tools register as", usage: "bb mcp-servers tools <prefix>" },
      { name: "call", summary: "Call a tool by its BB name with JSON arguments", usage: "bb mcp-servers call <tool> [json-args]" },
    ],
    async run(argv, ctx) {
      const [sub = "list", ...rest] = argv;
      const list = m.list();
      if (sub === "list") {
        const rows = list.servers.map((server) => ({
          name: server.name,
          prefix: server.prefix,
          url: server.url,
          enabled: server.enabled,
          auth: server.auth.kind,
          state: server.state,
          error: server.error,
          tools: server.tools.length,
          liveTools: server.liveToolCount,
          protocolVersion: server.server?.protocolVersion ?? null,
          transport: server.server?.transport ?? null,
        }));
        return { exitCode: 0, stdout: `${JSON.stringify({ reloadPending: list.reloadPending, servers: rows }, null, 2)}\n` };
      }
      if (sub === "tools" && rest[0]) {
        const server = list.servers.find((entry) => entry.prefix === rest[0] || entry.id === rest[0]);
        if (!server) return { exitCode: 1, stderr: `No server with prefix ${rest[0]}.\n` };
        return { exitCode: 0, stdout: `${JSON.stringify(server.tools, null, 2)}\n` };
      }
      if (sub === "call" && rest[0]) {
        const tool = computeSurface(store.list()).tools.find((entry) => entry.name === rest[0]);
        if (!tool) return { exitCode: 1, stderr: `No tool named ${rest[0]}.\n` };
        let args: unknown = {};
        if (rest[1] !== undefined) {
          try {
            args = JSON.parse(rest[1]);
          } catch {
            return { exitCode: 1, stderr: "Arguments must be a JSON object.\n" };
          }
        }
        const result = await m.callTool(tool.serverId, tool.upstreamName, args, ctx.signal ?? AbortSignal.timeout(10 * 60_000));
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { exitCode: typeof result !== "string" && result.isError ? 1 : 0, stdout: `${text.slice(0, 900_000)}\n` };
      }
      return { exitCode: 1, stderr: "Usage: bb mcp-servers list | tools <prefix> | call <tool> [json-args]\n" };
    },
  });
}

export default async function plugin(bb: BbPluginApi) {
  return createPlugin(bb);
}
