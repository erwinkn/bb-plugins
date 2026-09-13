import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createStore } from "./store";
import { documentSchema, emptyDocument, type Note, type Scope, type WriteResult } from "./model";

const scope: Scope = { environmentId: "env_one", projectId: "proj_one", projectName: "Project", environmentName: "Worktree", path: "/tmp/worktree", branch: "feature" };
const document = (text: string) => { const blocks = emptyDocument("env_one"); blocks[0].content = [{ type: "text", text, styles: {} }]; return blocks; };
function host() {
  let moved = false;
  const fake = createFakePluginHost({ pluginId: "scratchpad", sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: scope.projectId, environmentId: moved || threadId === "thr_other" ? "env_other" : scope.environmentId }) },
    projects: { get: async () => ({ id: scope.projectId, name: "Project" } as never) },
    environments: { get: async ({ environmentId }) => ({ id: environmentId, path: "/tmp/worktree", branchName: "feature" } as never) },
  }});
  plugin(fake.bb);
  return { ...fake, move: () => { moved = true; } };
}
const target = { threadId: "thr_one", environmentId: "env_one" };

test("threads sharing an environment see the same JSON, another environment is isolated", async () => {
  const { harness } = host();
  try {
    await harness.callRpc("open", { threadId: "thr_one" });
    const result = await harness.callRpc("save", { ...target, expectedRevision: 0, document: document("A finding") }) as WriteResult;
    assert.equal(result.ok, true);
    const shared = await harness.callRpc("open", { threadId: "thr_shared" }) as { note: Note };
    assert.deepEqual(shared.note.document, result.note.document);
    const other = await harness.callRpc("open", { threadId: "thr_other" }) as { note: Note };
    assert.equal(other.note.revision, 0);
    assert.notDeepEqual(other.note.document, result.note.document);
    await assert.rejects(harness.callRpc("save", { threadId: "thr_other", environmentId: "env_one", expectedRevision: 1, document: document("bad") }), /moved/);
  } finally { await harness.dispose(); }
});

test("stale writes fail, revisions restore without destroying the intervening version", async () => {
  const { harness } = host();
  try {
    await harness.callRpc("open", { threadId: "thr_one" });
    await harness.callRpc("save", { ...target, expectedRevision: 0, document: document("First") });
    const conflict = await harness.callRpc("save", { ...target, expectedRevision: 0, document: document("Stale") }) as WriteResult;
    assert.equal(conflict.ok, false); assert.deepEqual(conflict.note.document, document("First"));
    await harness.callRpc("save", { ...target, expectedRevision: 1, document: document("Second") });
    const restored = await harness.callRpc("restore", { ...target, expectedRevision: 2, revision: 1 }) as WriteResult;
    assert.equal(restored.note.revision, 3); assert.deepEqual(restored.note.document, document("First"));
    const old = await harness.callRpc("version", { ...target, revision: 2 }) as Note;
    assert.deepEqual(old.document, document("Second"));
  } finally { await harness.dispose(); }
});

test("moving a thread refuses its old panel's writes", async () => {
  const { harness, move } = host();
  try {
    await harness.callRpc("open", { threadId: "thr_one" }); move();
    await assert.rejects(harness.callRpc("save", { ...target, expectedRevision: 0, document: document("old context") }), /moved/);
  } finally { await harness.dispose(); }
});

test("agent Markdown conversion handles tables, tasks, nested lists and code; targeted edit preserves peers", async () => {
  const { harness } = host();
  const context = { threadId: "thr_one", projectId: "proj_one", signal: new AbortController().signal };
  const tool = async (name: string, input: unknown) => {
    const registered = harness.registrations.agentTools.find((tool) => tool.name === name)!;
    const parsed = registered.parse(input); assert.equal(parsed.ok, true);
    return JSON.parse(await registered.execute(parsed.ok ? parsed.value : input, context) as string);
  };
  try {
    await tool("scratchpad_append", { expectedRevision: 0, markdown: "## Findings\n\n- [ ] Verify behavior\n- A list\n  - A child\n\n| One | Two |\n| --- | --- |\n| A | B |\n\n```ts\nconst value = 1;\n```" });
    const result = await tool("scratchpad_read", {});
    assert.ok(result.blocks.some((block: { type: string }) => block.type === "table"));
    assert.match(result.markdown, /const value = 1/);
    const before = structuredClone(result.blocks.slice(1));
    const saved = await tool("scratchpad_edit", { expectedRevision: 1, blockId: result.blocks[0].id, markdown: "## Updated findings" });
    assert.equal(saved.ok, true);
    const latest = await tool("scratchpad_read", {});
    assert.deepEqual(latest.blocks.slice(1), before);
    const stale = await tool("scratchpad_append", { expectedRevision: 1, markdown: "stale write" });
    assert.equal(stale.ok, false);
    const cli = await harness.runCli(["get", "--json"], { threadId: "thr_one" });
    assert.equal(cli.exitCode, 0); assert.equal(JSON.parse(cli.stdout).revision, 2);
  } finally { await harness.dispose(); }
});

test("JSON validation rejects duplicate IDs, unsafe links and malformed content", () => {
  const blocks = document("Hello");
  assert.equal(documentSchema.safeParse([...blocks, ...blocks]).success, false);
  blocks[0].content = [{ type: "link", href: "java\nscript:alert(1)", content: [{ type: "text", text: "bad", styles: {} }] }];
  assert.equal(documentSchema.safeParse(blocks).success, false);
});

test("database survives reload and retains a bounded history", async () => {
  const fake = createFakePluginHost({ pluginId: "scratchpad" });
  const store = createStore(fake.bb); store.open(scope);
  for (let n = 0; n < 105; n++) store.save(scope.environmentId, n, document(`Revision ${n + 1}`), "Test");
  assert.equal(store.history(scope.environmentId).length, 100);
  let restored: ReturnType<typeof createStore> | undefined;
  const reloaded = await fake.harness.reload((bb) => { restored = createStore(bb); });
  assert.equal(restored!.get(scope.environmentId).revision, 105);
  assert.equal(restored!.list().length, 1);
  await reloaded.harness.dispose();
});
