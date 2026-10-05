import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const offline = vi.hoisted(() => ({ config: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn((file, args, options, callback) => {
    if (args[0] === "--version" || args[0] === "auth") {
      queueMicrotask(() => callback(null, "offline fixture", ""));
      return {};
    }
    // Actual installed gh/gojq, isolated config and fake credential. Every HTTP
    // request uses the local Unix socket; no real account or network is involved.
    return actual.execFile(file, args, { ...options, env: {
      PATH: process.env.PATH, HOME: offline.config, GH_CONFIG_DIR: offline.config,
      GH_TOKEN: "offline-fake-token", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1",
    } }, callback);
  }) };
});
import plugin from "./server";
const text = readFileSync(new URL("./server/fixtures/gh-scalar-text.txt", import.meta.url), "utf8");
const empty = readFileSync(new URL("./server/fixtures/gh-scalar-null.txt", import.meta.url), "utf8");
const requests: string[] = [];
let baseTip = "b";
let currentMergeBase = "b";
let headTip = "h";
let hugePatch = false;
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://offline"); requests.push(req.url!);
  res.setHeader("Content-Type", "application/json");
  let body: unknown;
  if (url.pathname.endsWith("/files")) body = [
    { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", patch: text.trimEnd() },
    { filename: "image.png", status: "added" },
    { filename: "oversized.ts", status: "added", patch: "x".repeat(hugePatch ? 20 * 1024 * 1024 : 20_001) },
    { filename: "unicode.ts", status: "added", patch: "😀".repeat(10_001) },
  ];
  else if (url.pathname.endsWith("/pulls/42")) body = { base: { sha: baseTip }, head: { sha: headTip } };
  else if (url.pathname.includes("/compare/")) body = { merge_base_commit: { sha: url.pathname.includes("/compare/b...") ? "b" : currentMergeBase } };
  else if (url.pathname.includes("/contents/")) { res.end("line\n"); return; }
  else { res.statusCode = 404; body = { message: "Unmapped offline fixture" }; }
  res.end(JSON.stringify(body));
});
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
beforeAll(async () => {
  offline.config = mkdtempSync(join(tmpdir(), "github-offline-"));
  const socket = join(offline.config, "gh.sock");
  writeFileSync(join(offline.config, "config.yml"), `http_unix_socket: ${socket}\nversion: "1"\n`);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); baseTip = "b"; currentMergeBase = "b"; headTip = "h"; hugePatch = false; requests.length = 0; });
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(offline.config, { recursive: true, force: true });
});
async function host() { const h = createFakePluginHost({ pluginId: "github-prs" }); hosts.push(h); await plugin(h.bb); return h.harness; }
describe("getPullFile through installed gh against an offline Unix socket", () => {
  it("renders A129's captured text patch through the actual RPC/projection", async () => {
    expect(text).toBe("@@ -1 +1 @@\n-old\n+new\n");
    const h = await host();
    const result = await h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: "src/old.ts", oldRef: "b", newPath: "src/new.ts", newRef: "h" });
    expect(result).toEqual({ old: { path: "src/old.ts", content: "line\n" }, new: { path: "src/new.ts", content: "line\n" }, patch: text.trimEnd() });
    expect(requests.some((url) => url.includes("per_page=20&page=1"))).toBe(true);
  });
  it("renders A129's binary/null capture as a successful null patch", async () => {
    expect(empty).toBe("\n");
    const h = await host();
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: null, oldRef: "b", newPath: "image.png", newRef: "h" })).resolves.toMatchObject({ old: null, patch: null });
  });
  it("accepts harmless base-tip motion through the real merge-base projection", async () => {
    baseTip = "advanced-tip";
    const h = await host();
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: "src/old.ts", oldRef: "b", newPath: "src/new.ts", newRef: "h" })).resolves.toMatchObject({ patch: text.trimEnd() });
    expect(requests).toContain("/repos/acme/app/compare/advanced-tip...h?per_page=1&page=1");
    expect(requests.some((url) => url.includes("contents/src/old.ts?ref=b"))).toBe(true);
    expect(requests.some((url) => url.includes("ref=advanced-tip"))).toBe(false);
  });
  it("refuses changed merge-base or head snapshots through the real projections", async () => {
    baseTip = "advanced-tip"; currentMergeBase = "different-ancestor";
    const h = await host();
    const input = { repo: "acme/app", number: 42, page: 1, oldPath: "src/old.ts", oldRef: "b", newPath: "src/new.ts", newRef: "h" };
    await expect(h.behavior.callRpc("getPullFile", input)).rejects.toThrow("Refresh");
    expect(requests.some((url) => url.includes("/contents/"))).toBe(false);
    headTip = "pushed-head";
    await expect(h.behavior.callRpc("getPullFile", input)).rejects.toThrow("Refresh");
  });
  it.each(["oversized.ts", "unicode.ts"])("preserves the 20,000 JS-character fallback for %s", async (path) => {
    hugePatch = path === "oversized.ts"; // Actual gh handles 20 MiB input with its unchanged 16 MiB stdout guard.
    const h = await host();
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: null, oldRef: "b", newPath: path, newRef: "h" })).resolves.toMatchObject({ patch: null });
  });
  it("keeps legacy content-only calls compatible", async () => {
    const h = await host();
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", oldPath: "a.ts", oldRef: "b", newPath: "a.ts", newRef: "h" })).resolves.toEqual({ old: { path: "a.ts", content: "line\n" }, new: { path: "a.ts", content: "line\n" } });
  });
});
