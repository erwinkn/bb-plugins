import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { createExecutorPlugin } from "../server";

const ALL_TOOLS = [
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

const initResult = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "executor", version: "1.0.0" },
};

function gatewayFetch(calls: Array<{ url: string; body: { method: string; id?: number } }>) {
  return (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    calls.push({ url: String(url), body });
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: initResult }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "sess" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") {
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "gateway doc" }] } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "execute" }, { name: "skills" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

async function makeHost(settings: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const h = createFakePluginHost({
    pluginId: "executor",
    settings,
    agentSkillIds: ["executor"],
  });
  await createExecutorPlugin(h.bb, fetchImpl);
  return h;
}

describe("executor plugin", () => {
  it("selects every mirror tool and the executor skill for any provider", async () => {
    const h = await makeHost();
    const resolved = await h.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    expect(resolved.tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    expect(resolved.skills).toEqual(["executor"]);
    await h.harness.lifecycle.dispose();
  });

  it("returns a configure-the-plugin error when no credential is set", async () => {
    const h = await makeHost();
    const result = await h.harness.behavior.callAgentTool("executor_skills", {});
    expect(result).toMatchObject({ isError: true });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("not configured");
    expect(text).toMatch(/accessToken|cfAccessClientId/);
    await h.harness.lifecycle.dispose();
  });

  it("round-trips executor_skills through initialize + tools/call", async () => {
    const calls: Array<{ url: string; body: { method: string } }> = [];
    const h = await makeHost({ accessToken: "tok" }, gatewayFetch(calls));
    const result = await h.harness.behavior.callAgentTool("executor_skills", { name: "execute" });
    expect(result).toMatchObject({ content: [{ type: "text", text: "gateway doc" }] });
    expect(calls.map((c) => c.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    await h.harness.lifecycle.dispose();
  });

  it("executor_tools returns the upstream tools/list", async () => {
    const calls: Array<{ url: string; body: { method: string } }> = [];
    const h = await makeHost({ accessToken: "tok" }, gatewayFetch(calls));
    const result = await h.harness.behavior.callAgentTool("executor_tools", {});
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toEqual([{ name: "execute" }, { name: "skills" }]);
    await h.harness.lifecycle.dispose();
  });

  it("bb executor status reports configured fields without secret values", async () => {
    const h = await makeHost({ accessToken: "s3cr3t-bearer-value", cfAccessClientId: "s3cr3t-cf-id" });
    const res = await h.harness.behavior.runCli(["status"]);
    expect(res.exitCode).toBe(0);
    const status = JSON.parse(res.stdout);
    expect(status.credentialFieldsSet).toEqual(["accessToken", "cfAccessClientId"]);
    expect(status.configured).toBe(true);
    expect(res.stdout).not.toContain("s3cr3t");
    await h.harness.lifecycle.dispose();
  });

  it("uses only the public BB SDK and declared packages", () => {
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)), {
      allow: [/^vitest$/],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
