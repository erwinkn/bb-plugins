// Opt-in integration exercise. Creates only labeled test threads, cancels their
// remaining queue entries, and archives/stops them in finally. Keeps history.
// node tests/live-thread-management.mjs --project <id> [--url https://host/mcp] [--approval]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const projectId = option("--project");
if (!projectId) throw new Error("Pass --project explicitly; this exercise creates and archives test threads.");
const endpoint = option("--url", "http://127.0.0.1:38886/api/v1/plugins/bb-mcp/http/mcp");
const token = JSON.parse(execFileSync("bb", ["plugin", "token", "bb-mcp", "--json"], { encoding: "utf8" })).token;
const client = new Client({ name: "bb-mcp-thread-integration", version: "0.3.1" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { "x-bb-plugin-token": token } } });
const created = [];
const runId = randomUUID();
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
  if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  const data = response.structuredContent.data;
  if (data.state && data.state !== "accepted") throw new Error(`${name}: ${JSON.stringify(data)}`);
  return data;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert.equal(tools.length, 35);
  for (const name of ["bb_call_api", "bb_cli", "bb_delete_thread"]) {
    assert(!tools.includes(name));
    await assert.rejects(client.callTool({ name, arguments: {} }), /not found/);
  }
  const projects = (await call("bb_list_projects")).projects;
  assert(projects.some(p => p.id === projectId));
  assert(projects.some(p => p.kind === "personal" || p.id === "proj_personal"));
  const runtimes = await call("bb_list_runtimes", { projectId, providerId: "codex", limit: 200 });
  const model = runtimes.models.find(m => /mini/.test(m.id))?.id ?? runtimes.models.find(m => m.isDefault)?.id;
  const approval = argv.includes("--approval");
  const prompt = approval
    ? "This is a BB MCP permission-approval integration test. Use your shell execution tool to run exactly /usr/bin/true with sandbox_permissions=require_escalated and justification 'MCP integration test: allow the harmless true command?'. Do not run it without the requested approval. Do not change files, make network calls or run repository tests. After it is approved and completes, reply exactly MCP_THREAD_TEST_OK."
    : "This is a BB MCP integration test. Do not use tools or change files. Reply exactly MCP_THREAD_TEST_OK.";
  const receipt = await call("bb_create_thread", { projectId, providerId: "codex", ...(model ? { model } : {}), permissionMode: "accept-edits", title: "MCP thread-management verification", visibility: "hidden", prompt, sendAt: Date.now() + 86400000, idempotencyKey: `${runId}-create` });
  const threadId = receipt.response.threadId;
  created.push(threadId);
  console.log(JSON.stringify({ stage: "created", threadId, projectId, model, receiptId: receipt.id }));
  const initial = await call("bb_get_thread", { threadId });
  assert.equal(initial.projectId, projectId);
  assert.equal(initial.visibility, "hidden");
  const firstQueue = (await call("bb_list_queued_messages", { threadId })).queuedMessages;
  assert.equal(firstQueue.length, 1);
  // BB 0.42.1 has no stored model until the first turn starts. Supply the
  // creation model explicitly for a follow-up queued before that first turn.
  await call("bb_send_message", { threadId, ...(model ? { model } : {}), message: "Temporary queued test instruction. Do not execute.", sendAt: Date.now() + 86400000, idempotencyKey: `${runId}-queue` });
  const second = (await call("bb_list_queued_messages", { threadId })).queuedMessages.find(q => q.id !== firstQueue[0].id);
  assert(second);
  await call("bb_update_queued_message", { threadId, queuedMessageId: second.id, expectedUpdatedAt: second.updatedAt, message: "Revised temporary queued test instruction. Do not execute." });
  const stale = await client.callTool({ name: "bb_update_queued_message", arguments: { threadId, queuedMessageId: second.id, expectedUpdatedAt: 0, message: "Must fail" } });
  assert(stale.isError);
  await call("bb_reorder_queued_message", { threadId, queuedMessageId: second.id, previousQueuedMessageId: null, nextQueuedMessageId: firstQueue[0].id });
  await call("bb_cancel_queued_message", { threadId, queuedMessageId: second.id });
  await call("bb_rename_thread", { threadId, title: "MCP thread-management verification (running)" });
  await call("bb_set_thread_pinned", { threadId, pinned: true });
  await call("bb_set_thread_pinned", { threadId, pinned: false });
  await call("bb_set_thread_read", { threadId, read: false });
  await call("bb_set_thread_read", { threadId, read: true });
  await call("bb_list_thread_sections");
  await call("bb_send_queued_message", { threadId, queuedMessageId: firstQueue[0].id, idempotencyKey: `${runId}-dispatch` });
  console.log(JSON.stringify({ stage: "queue-and-organization-verified", threadId }));
  if (approval) {
    await call("bb_wait_for_thread", { threadId, event: "system/interaction/lifecycle", timeoutMs: 120000 });
    const requests = (await call("bb_list_interactions", { threadId })).interactions;
    const request = requests.find(i => i.status === "pending" && i.payload.kind === "approval");
    assert(request, "The test provider did not create a pending approval");
    const details = (await call("bb_get_interaction", { threadId, interactionId: request.id })).interaction;
    assert.equal(details.payload.subject.kind, "command");
    assert(["true", "/usr/bin/true", "/bin/bash -lc /usr/bin/true", "/bin/bash -c /usr/bin/true"].includes(details.payload.subject.command.trim()), "Refusing to approve anything other than the test's exact harmless command");
    const args = { threadId, interactionId: request.id, decision: "allow_once", idempotencyKey: `${runId}-approve` };
    const approved = await call("bb_approve_permission", args);
    assert.equal((await call("bb_approve_permission", args)).id, approved.id);
    console.log(JSON.stringify({ stage: "permission-approval-verified", threadId, interactionId: request.id }));
  }
  await call("bb_wait_for_thread", { threadId, event: "turn/completed", timeoutMs: 120000 });
  const result = await call("bb_get_result", { threadId });
  assert(result.result?.item?.content?.text.includes("MCP_THREAD_TEST_OK"), "Expected final test response");
  await call("bb_get_events", { threadId, limit: 1000 });
  await call("bb_get_changes", { threadId, target: "uncommitted" });
  const fork = await call("bb_fork_thread", { sourceThreadId: threadId, title: "MCP native fork verification", visibility: "hidden", idempotencyKey: `${runId}-fork` });
  const forkId = fork.response.threadId;
  assert.notEqual(forkId, threadId);
  created.push(forkId);
  assert.equal((await call("bb_get_thread", { threadId: forkId })).sourceThreadId, threadId);
  await call("bb_archive_thread", { threadId: forkId });
  await call("bb_unarchive_thread", { threadId: forkId });
  await call("bb_update_thread", { threadId: forkId, parentThreadId: threadId, sectionId: null });
  console.log(JSON.stringify({ stage: "passed", threadId, forkId, toolCount: tools.length, projectCount: projects.length, permissionApproval: approval }));
} catch (error) {
  console.error(String(error).replaceAll(token, "[redacted]"));
  process.exitCode = 1;
} finally {
  for (const threadId of created.reverse()) {
    try {
      const queued = (await call("bb_list_queued_messages", { threadId })).queuedMessages;
      for (const row of queued) await call("bb_cancel_queued_message", { threadId, queuedMessageId: row.id });
      await call("bb_archive_thread", { threadId });
      await call("bb_stop_thread", { threadId });
      console.log(JSON.stringify({ stage: "cleaned-up", threadId, archived: true, historyRetained: true }));
    } catch (error) { console.error(`Cleanup ${threadId}: ${String(error).replaceAll(token, "[redacted]")}`); process.exitCode = 1; }
  }
  await client.close();
}
