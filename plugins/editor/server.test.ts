import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin, { findPluginRoot, rpcContract } from "./server";

const here = fileURLToPath(new URL(".", import.meta.url));

test("findPluginRoot locates the package from the source directory and from dist", () => {
  assert.equal(findPluginRoot(here), path.resolve(here));
  assert.equal(findPluginRoot(path.join(here, "dist")), path.resolve(here));
  assert.throws(() => findPluginRoot("/"), /could not locate/);
});

test("the RPC contract validates source shapes strictly", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "a.ts", source: { kind: "nope" } }));
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "", source: { kind: "workspace", threadId: null, environmentId: null, projectId: null } }));
  await assert.rejects(() => harness.behavior.callRpc("workspace", { threadId: "thr_x" }));
  await assert.rejects(() =>
    harness.behavior.callRpc("read", {
      path: "a.ts",
      source: { kind: "workspace", threadId: null, environmentId: null, projectId: null, extra: 1 },
    }),
  );
});

test("workspace without a thread or project asks for a project", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(() => harness.behavior.callRpc("workspace", { threadId: null, projectId: null }), /Select a project/);
});

test("contract exposes the methods the frontend calls", () => {
  assert.deepEqual(Object.keys(rpcContract).sort(), ["applyTheme", "assets", "create", "read", "remove", "rename", "setSetting", "theme", "tree", "workspace", "write"]);
});

test("create refuses parent traversal and setSetting refuses unknown keys", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const source = { kind: "workspace", threadId: null, environmentId: null, projectId: null };
  await assert.rejects(() => harness.behavior.callRpc("create", { path: "../x", source, kind: "file" }), /cannot contain/);
  await assert.rejects(() => harness.behavior.callRpc("rename", { path: "a.ts", source, newPath: "/etc/passwd" }), /inside the workspace/);
  await assert.rejects(() => harness.behavior.callRpc("remove", { path: "..", source, kind: "directory" }), /cannot contain/);
  await assert.rejects(() => harness.behavior.callRpc("setSetting", { key: "fontSize", value: 40 }));
  await assert.rejects(() => harness.behavior.callRpc("setSetting", { key: "wordWrap", value: "yes" }));
});

test("plugin uses only public SDK imports and declared packages", () => {
  const scan = experimental_scanPublicSdkOnly(here, {
    allow: [
      /^react(-dom)?$/,
      /^sonner$/,
      /^clsx$/,
      /^tailwind-merge$/,
      /^@hugeicons\//,
      /^monaco-editor(\/|$)/,
      /^shiki\//,
      /^@shikijs\/(langs|themes)\//,
      /^@pierre\/theme\//,
      /^esbuild$/,
      /^@\//,
    ],
  });
  assert.deepEqual(scan.privateDependencies, []);
  const dynamic = scan.violations.filter((violation) => violation.reason === "dynamic-specifier");
  // The lazily served editor bundle and the on-demand asset build are the only
  // computed import paths; anything else is a mistake.
  assert.deepEqual(
    dynamic.map((violation) => violation.file).sort(),
    ["lib/monaco-loader.ts", "server.ts"],
  );
  assert.deepEqual(scan.violations.filter((violation) => violation.reason !== "dynamic-specifier"), []);
});
