// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { resetQueryClient } from "../lib/query";
import type { ListResult, ServerView } from "../src/schemas";

const view = (overrides: Partial<ServerView> = {}): ServerView => ({
  id: "s1",
  name: "DeepWiki",
  prefix: "deepwiki",
  url: "https://mcp.deepwiki.com/mcp",
  enabled: true,
  auth: {
    kind: "none",
    headerName: null,
    headerValueSet: false,
    clientId: null,
    clientSecretSet: false,
    scope: null,
    clientMetadataUrl: null,
    authorized: false,
    pending: false,
  },
  state: "connected",
  error: null,
  server: { name: "DeepWiki", version: "2.14.3", protocolVersion: "2025-11-25", transport: "streamable-http", instructionsChars: 3752, fetchedAt: 1 },
  tools: [{ name: "deepwiki_ask_question", upstreamName: "ask_question", title: null, description: "Ask a question.", schemaChanges: [] }],
  liveToolCount: 1,
  conflicts: [],
  ...overrides,
});

const list = (servers: ServerView[], revision = 1): ListResult => ({ revision, reloadPending: false, servers });

beforeEach(() => {
  window.localStorage.clear();
  resetQueryClient();
});
const mounted: Array<{ lifecycle: { unmount(): void } }> = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  resetQueryClient();
});

async function render(rpc: Record<string, (input: unknown) => unknown>) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc });
  mounted.push(slot);
  return slot;
}

describe("settings section", () => {
  it("shows each server's state, prefix and tools", async () => {
    const slot = await render({ list: () => list([view(), view({ id: "s2", name: "Linear", prefix: "linear", state: "needs-auth", auth: { ...view().auth, kind: "oauth" }, tools: [], liveToolCount: 0, server: null })]) });
    await slot.findByText("DeepWiki");
    expect(slot.getByText("deepwiki_*")).toBeTruthy();
    expect(slot.getByText("Connected")).toBeTruthy();
    expect(slot.getByText("Needs authorization")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Connect" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "1 tool" }));
    expect(slot.getByText("deepwiki_ask_question")).toBeTruthy();
  });

  it("adds a server with a prefix suggested from its name", async () => {
    let servers: ServerView[] = [];
    const slot = await render({
      list: () => list(servers),
      add: (input) => {
        servers = [view({ name: (input as { name: string }).name, prefix: (input as { prefix: string }).prefix })];
        return { id: "s1" };
      },
    });
    await slot.findByText("No MCP servers yet.");
    fireEvent.click(slot.getByRole("button", { name: "Add server" }));
    fireEvent.change(slot.getByPlaceholderText("Linear"), { target: { value: "Docs (work)" } });
    fireEvent.change(slot.getByPlaceholderText("https://mcp.example.com/mcp"), { target: { value: "https://docs.example.com/mcp" } });
    fireEvent.click(slot.getByRole("radio", { name: "Header" }));
    fireEvent.change(slot.getByPlaceholderText("Bearer …"), { target: { value: "Bearer secret" } });
    fireEvent.click(slot.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "add")).toBe(true));
    const add = slot.inspection.rpcCalls.find((call) => call.method === "add")!;
    expect(add.input).toEqual({
      name: "Docs (work)",
      url: "https://docs.example.com/mcp",
      prefix: "docs-work",
      auth: { kind: "header", headerName: "Authorization", headerValue: "Bearer secret" },
    });
    await slot.findByText("Docs (work)");
  });

  it("drops the link and paste form once the tab's login ends the flow", async () => {
    const oauth = (pending: boolean, authorized: boolean) =>
      view({ state: authorized ? "connected" : "needs-auth", auth: { ...view().auth, kind: "oauth", pending, authorized } });
    window.open = (() => null) as typeof window.open;
    let current = list([oauth(false, false)]);
    const slot = await render({
      list: () => current,
      startAuth: () => {
        current = list([oauth(true, false)], 2);
        return { authorizationUrl: "https://auth.example.com/authorize?x=1", redirectUri: "https://bb/cb" };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Connect" }));
    // No push: the read after startAuth shows the flow.
    await slot.findByText("Open the authorization page");
    await slot.behavior.emitRealtime("servers-changed", list([oauth(false, true)], 3));
    await slot.findByRole("button", { name: "Re-authorize" });
    expect(slot.queryByText("Open the authorization page")).toBeNull();
    expect(slot.queryByPlaceholderText("https://…/oauth/callback?code=…")).toBeNull();
  });

  it("shows the server's error message", async () => {
    const slot = await render({ list: () => list([view({ state: "error", error: "HTTP 502: Bad gateway" })]) });
    await slot.findByText("HTTP 502: Bad gateway");
    expect(slot.getByText("Unreachable")).toBeTruthy();
  });
});
