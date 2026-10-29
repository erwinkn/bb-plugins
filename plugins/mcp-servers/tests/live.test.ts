// Live smoke against public servers, BB-less. Opt in: MCP_LIVE=1 npm test -- live
//   DeepWiki  no auth: connect, list, call.
//   Linear    OAuth: discovery and dynamic registration up to the
//             authorization URL (a person has to approve it).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Manager } from "../src/manager";
import { Store } from "../src/store";
import { computeSurface } from "../src/surface";

const dir = mkdtempSync(join(tmpdir(), "mcp-servers-live-"));
const manager = new Manager({
  store: new Store(dir),
  pluginId: "mcp-servers",
  fetchImpl: fetch,
  log: (message) => console.log(message),
  publish: () => {},
  requestReload: () => {},
  registered: { surface: computeSurface([]), names: new Set() },
});
afterAll(async () => {
  await manager.close();
  rmSync(dir, { recursive: true, force: true });
});

async function settled(id: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const view = manager.list().servers.find((server) => server.id === id)!;
    if (view.state !== "connecting" && view.state !== "idle") return view;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!process.env.MCP_LIVE)("live", () => {
  it("DeepWiki: connects, lists and calls", async () => {
    const { id } = manager.add({ name: "DeepWiki", prefix: "deepwiki", url: "https://mcp.deepwiki.com/mcp", auth: { kind: "none" } });
    const view = await settled(id);
    console.log(JSON.stringify({ state: view.state, error: view.error, server: view.server, tools: view.tools.map((t) => t.name) }, null, 2));
    expect(view.state).toBe("connected");
    expect(view.tools.length).toBeGreaterThan(0);
    const result = await manager.callTool(id, "read_wiki_structure", { repoName: "modelcontextprotocol/typescript-sdk" }, AbortSignal.timeout(60_000));
    const text = typeof result === "string" ? result : result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    console.log(text.slice(0, 600));
    expect(typeof result === "string" || !result.isError).toBe(true);
  }, 120_000);

  it("Linear: reaches the authorization URL", async () => {
    const { id } = manager.add({ name: "Linear", prefix: "linear", url: "https://mcp.linear.app/mcp", auth: { kind: "oauth" } });
    const view = await settled(id);
    console.log(JSON.stringify({ state: view.state, error: view.error }));
    expect(view.state).toBe("needs-auth");
    const { authorizationUrl, redirectUri } = await manager.startAuth(id, "https://erwin.getbb.app");
    const url = new URL(authorizationUrl!);
    console.log(JSON.stringify({ redirectUri, authorize: `${url.origin}${url.pathname}`, params: [...url.searchParams.keys()] }));
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  }, 120_000);
});
