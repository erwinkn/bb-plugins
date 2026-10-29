// The agent-tool surface the plugin registers: one BB tool per upstream tool
// of each enabled server, computed from the cached tool lists alone so it is
// known at activation, before any network.
//
// BB registers tools once per plugin load and cannot remove or redescribe
// one, so the surface has a signature: when what the servers serve no longer
// matches what was registered, the plugin reloads itself (manager.ts).
//
// A server's `instructions` (from initialize / server/discover) travel as
// the static instructions of its tools. BB takes up to 4,096 characters per
// tool and sets each under its own header, without a cap on the total, so a
// long text is split across the server's tools in order; only when it needs
// more pieces than the server has tools does the rest go into the last
// tool's description.

import { createHash } from "node:crypto";
import { bbToolNames } from "./names";
import { normalizeInputSchema } from "./schema";
import type { ServerConfig } from "./store";

export const MAX_TOOL_INSTRUCTIONS = 4096;

export interface SurfaceTool {
  /** The BB tool name, `<prefix>_<tool>`. */
  name: string;
  serverId: string;
  upstreamName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  instructions?: string;
}

export interface Surface {
  tools: SurfaceTool[];
  /** Per server: what the schema normalizer changed, by upstream tool. */
  schemaChanges: Map<string, Map<string, string[]>>;
  signature: string;
}

/**
 * Split `text` into pieces of at most `max` characters, at the last blank
 * line, line break or space before the limit when there is one. Only the
 * separator at a cut is consumed; everything else, indentation included,
 * stays as written.
 */
export function splitText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    let skip = 2;
    if (cut < max / 2) {
      cut = window.lastIndexOf("\n");
      skip = 1;
    }
    if (cut < max / 2) {
      cut = window.lastIndexOf(" ");
      skip = 1;
    }
    if (cut < max / 2) {
      cut = max;
      skip = 0;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

function instructionPieces(server: ServerConfig, instructions: string): string[] {
  const heading = `Instructions from the MCP server "${server.name}" (its tools are named ${server.prefix}_*):`;
  const continued = `Instructions from the MCP server "${server.name}", continued:`;
  // Leave room for the longer heading and its blank line on every piece.
  const body = splitText(instructions.trim(), MAX_TOOL_INSTRUCTIONS - Math.max(heading.length, continued.length) - 2);
  return body.map((piece, index) => `${index === 0 ? heading : continued}\n\n${piece}`);
}

export function computeSurface(servers: readonly ServerConfig[]): Surface {
  const tools: SurfaceTool[] = [];
  const schemaChanges = new Map<string, Map<string, string[]>>();
  for (const server of servers) {
    if (!server.enabled || !server.cache) continue;
    // By name, so a server that reorders its list does not change the surface.
    const upstream = [...server.cache.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = bbToolNames(
      server.prefix,
      upstream.map((tool) => tool.name),
    );
    const changes = new Map<string, string[]>();
    const serverTools: SurfaceTool[] = upstream.map((tool) => {
      const normalized = normalizeInputSchema(tool.inputSchema);
      if (normalized.changes.length > 0) changes.set(tool.name, normalized.changes);
      // BB refuses an empty description; a blank title is no title.
      const description = tool.description?.trim() ? tool.description : tool.title?.trim() || `${tool.name} (${server.name})`;
      return {
        name: names.get(tool.name)!,
        serverId: server.id,
        upstreamName: tool.name,
        description,
        inputSchema: normalized.schema,
      };
    });
    const instructions = server.cache.instructions?.trim();
    if (instructions && serverTools.length > 0) {
      const pieces = instructionPieces(server, instructions);
      serverTools.forEach((tool, index) => {
        if (index < pieces.length) tool.instructions = pieces[index];
      });
      if (pieces.length > serverTools.length) {
        const last = serverTools[serverTools.length - 1]!;
        const overflow = pieces
          .slice(serverTools.length)
          .map((piece) => piece.slice(piece.indexOf("\n\n") + 2))
          .join("\n\n");
        last.description = `${last.description}\n\nInstructions from the MCP server "${server.name}", continued:\n\n${overflow}`;
      }
    }
    if (changes.size > 0) schemaChanges.set(server.id, changes);
    tools.push(...serverTools);
  }
  const signature = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
  return { tools, schemaChanges, signature };
}
