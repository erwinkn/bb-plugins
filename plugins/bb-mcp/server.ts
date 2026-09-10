import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createMcpHandler, McpServer, type ServerContext, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createAdapter } from "./adapter";
import { defineSettings, ToolError } from "./config";
import { createStore, operationView, errorView, isThreadOperation } from "./store";
import { capabilities } from "./capabilities";
import { createThreadManager } from "./thread-management";

const id = z.string().regex(/^[A-Za-z0-9_-]+$/);
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).default(20) };
const thread = { threadId: id };
const key = z.string().min(1).describe("Stable key for this instruction. Reuse it on every retry; never change it after an uncertain outcome.");
const reasoningLevel = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
const execution = { model: z.string().min(1).optional(), reasoningLevel: reasoningLevel.optional(), permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(), serviceTier: z.enum(["default", "fast"]).optional() };
const visibility = z.enum(["visible", "hidden"]);
const sendAt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe("Optional future Unix timestamp in milliseconds; reuse the original value on retries.");
const createFields = { prompt: z.string().trim().min(1), title: z.string().trim().min(1).optional(), idempotencyKey: key.optional(), hostId: id.optional(), environmentId: id.optional(), baseBranch: z.string().min(1).optional(), providerId: id.optional(), parentThreadId: id.optional(), visibility: visibility.optional(), sendAt, ...execution };

export default function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  const store = createStore(bb);
  const adapter = createAdapter(bb, settings, store);
  const manager = createThreadManager(bb, store);
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "bb-mcp", version: "0.3.1" }, {
      capabilities: { tools: {} },
      instructions: "Manage BB threads across every project, including Personal and hidden threads. Discover projects/runtimes, create or fork/handoff work, send/steer messages, organize/archive threads, inspect/edit/cancel queues, read results/changes and wait for progress. Read pending interactions before answering questions/forms or granting a specific permission approval. Available approval decisions are enforced by BB. No general SDK/CLI access, permanent deletion, filesystem/terminal control, Git/PR writes or BB administration. Thread agents can still execute tasks under their native permissions; this is not an execution sandbox. There are no plugin project allowlists, quotas or output-clipping caps. Native BB/provider limits and pagination still apply. Idempotency keys are optional; preserve keys after timeouts and never automatically redispatch outcome_unknown. Acceptance/idle is not proof of task success.",
    });
    function tool<S extends z.ZodObject>(name: string, description: string, schema: S, mutate: boolean, run: (args: z.output<S>, signal: AbortSignal) => Promise<Record<string, unknown>>) {
      server.registerTool(name, {
        description, inputSchema: schema as z.ZodObject,
        outputSchema: z.object({ data: z.record(z.string(), z.unknown()) }),
        annotations: { readOnlyHint: !mutate, destructiveHint: mutate, openWorldHint: true },
      }, async (input: unknown, ctx: ServerContext): Promise<CallToolResult> => {
        try {
          const data = await run(input as z.output<S>, ctx.mcpReq.signal);
          const text = JSON.stringify({ data });
          bb.log.info(`MCP ${name}: ok`);
          return { content: [{ type: "text" as const, text }], structuredContent: { data } };
        } catch (error) {
          const { code, message } = errorView(error);
          bb.log.warn(`MCP ${name}: ${code}`);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }] };
        }
      });
    }
    tool("bb_list_projects", "List all ordinary and personal projects.", z.object({}).strict(), false, adapter.listProjects);
    tool("bb_get_capabilities", "Thread-management capabilities, explicit exclusions and native BB boundaries.", z.object({}).strict(), false, async () => capabilities);
    tool("bb_list_runtimes", "List all hosts and installed harnesses. Pass providerId to page models; environmentId resolves workspace-specific catalogs.", z.object({ projectId: id, hostId: id.optional(), environmentId: id.optional(), providerId: id.optional(), ...page }).strict(), false, adapter.listRuntimes);
    tool("bb_list_threads", "List threads across all projects by default, including hidden threads. Pass projectId to narrow. Optionally filter parent/source, roots vs children, archived state, or visibility. Title filters apply to scanned pages; follow nextOffset even if no rows match.", z.object({ projectId: id.optional(), query: z.string().optional(), parentThreadId: id.optional(), sourceThreadId: id.optional(), sectionId: id.optional(), unsectioned: z.boolean().optional(), hasParent: z.boolean().optional(), archived: z.boolean().optional(), includeHidden: z.boolean().default(true), ...page }).strict(), false, adapter.listThreads);
    tool("bb_get_thread", "Get runtime state, execution options, pending interactions and queued work. Idle does not establish task completion.", z.object(thread).strict(), false, adapter.getThread);
    tool("bb_get_events", "Read full incremental conversation events, including tool payloads and reasoning. Follow nextAfterSeq. No plugin truncation.", z.object({ ...thread, afterSeq: z.number().int().min(0).default(0), limit: page.limit }).strict(), false, adapter.getEvents);
    tool("bb_create_thread", "Start coding work in a fresh managed worktree, or reuse an environment. parentThreadId creates a real child, independently of workspace choice. Pass explicit execution options to BB; BB resolves defaults and enforces native policy. Visibility inherits the parent, otherwise visible. Return acceptance and an operation ID; reuse the key after a timeout.", z.object({ projectId: id, ...createFields }).strict(), true, adapter.createThread);
    tool("bb_handoff_thread", "Continue work in a new conversation using BB's native structured source-thread mention. Reuse the source environment by default; set reuseSourceEnvironment false for a fresh worktree or choose environmentId. This carries a context reference, not a cloned provider session. Reuse the key after a timeout.", z.object({ sourceThreadId: id, projectId: id.optional(), reuseSourceEnvironment: z.boolean().optional(), ...createFields }).strict(), true, adapter.handoffThread);
    tool("bb_send_message", "Send a follow-up with optional model, reasoning, permissions, service tier or schedule. Before a scheduled thread's first run, explicitly pass its creation model (BB has no stored model yet). queue lets active work finish; steer attempts active-turn delivery. BB may queue execution changes. Return actual delivery and a history cursor. Reuse the key after a timeout.", z.object({ ...thread, message: z.string().trim().min(1), idempotencyKey: key.optional(), mode: z.enum(["queue", "steer"]).default("queue"), sendAt, ...execution }).strict(), true, adapter.sendMessage);
    tool("bb_stop_thread", "Stop the thread's current runtime. This does not promise cancellation of queued instructions; inspect its queue afterwards.", z.object(thread).strict(), true, adapter.stopThread);
    tool("bb_rename_thread", "Set a thread's title without altering its instructions.", z.object({ ...thread, title: z.string().trim().min(1) }).strict(), true, adapter.renameThread);
    tool("bb_update_thread", "Update title, parent/section (null clears either), visibility, or sticky model/reasoning within the existing provider. Execution changes apply on next/later turns and do not dispatch or restart work. BB's standalone update API cannot set permissionMode or serviceTier; pass those with bb_send_message instead.", z.object({ ...thread, title: z.string().trim().min(1).optional(), model: execution.model, reasoningLevel: execution.reasoningLevel, parentThreadId: id.nullable().optional(), sectionId: id.nullable().optional(), visibility: visibility.optional() }).strict(), true, adapter.updateThread);
    tool("bb_get_result", "Read the latest assistant message with event/turn provenance and freshness flags. afterSeq excludes output from before a follow-up. This does not certify the coding task succeeded.", z.object({ ...thread, afterSeq: z.number().int().min(0).default(0) }).strict(), false, adapter.getResult);
    tool("bb_get_changes", "Page changed files and PR metadata. Optionally request relative file patches, without a count or output cap. all includes branch commits and uncommitted work; uncommitted includes staged and unstaged work.", z.object({ ...thread, target: z.enum(["all", "uncommitted"]).default("all"), paths: z.array(z.string().min(1).refine(p => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), "Use relative paths without parent traversal.")).optional(), ...page }).strict(), false, adapter.getChanges);
    tool("bb_get_operation", "Recover a create/send request after timeout or reconnect. outcome_unknown means BB may have accepted it; inspect BB before trying a new key.", z.object({ operationId: id }).strict(), false, adapter.getOperation);
    tool("bb_fork_thread", "Fork an existing provider session at its tip or sourceSeqEnd. Native provider fork support is required; use handoff for cross-provider work. Optionally reuse an environment. Returns a new thread, not proof of task completion.", z.object({ sourceThreadId: id, sourceSeqEnd: z.number().int().nonnegative().optional(), title: z.string().min(1).optional(), environmentId: id.optional(), permissionMode: execution.permissionMode, visibility: visibility.optional(), idempotencyKey: key.optional() }).strict(), true, manager.fork);
    tool("bb_retry_thread", "Retry the failed turn, optionally asserting its turnRequestId and scheduling sendAt. BB prevents duplicate live retries; preserve the optional idempotency key after timeouts.", z.object({ ...thread, turnRequestId: id.optional(), reason: z.string().optional(), sendAt, idempotencyKey: key.optional() }).strict(), true, manager.retry);
    tool("bb_archive_thread", "Archive a thread. BB also archives descendants and may clean up managed workspaces under its native lifecycle rules. Conversation history is retained; this is not permanent thread deletion.", z.object(thread).strict(), true, manager.archive);
    tool("bb_unarchive_thread", "Restore an archived thread to the active list, subject to BB's native workspace lifecycle.", z.object(thread).strict(), true, manager.unarchive);
    tool("bb_set_thread_pinned", "Pin or unpin a thread.", z.object({ ...thread, pinned: z.boolean() }).strict(), true, manager.setPinned);
    tool("bb_set_thread_read", "Mark a thread read or unread.", z.object({ ...thread, read: z.boolean() }).strict(), true, manager.setRead);
    tool("bb_reorder_pinned_thread", "Move a pinned thread between its previous and next neighbors. Use null at the ends.", z.object({ ...thread, previousThreadId: id.nullable(), nextThreadId: id.nullable() }).strict(), true, manager.reorderPinned);
    tool("bb_list_thread_sections", "List available thread-organization sections.", z.object({}).strict(), false, manager.listSections);
    tool("bb_create_thread_section", "Create a named thread-organization section. Assign threads using bb_update_thread.sectionId.", z.object({ name: z.string().trim().min(1) }).strict(), true, manager.createSection);
    tool("bb_rename_thread_section", "Rename an existing thread-organization section.", z.object({ sectionId: id, name: z.string().trim().min(1) }).strict(), true, manager.renameSection);
    tool("bb_wait_for_thread", "Wait for a native thread status or event (default: idle). Set timeoutMs as needed for your client. Cancellation/reload stops waiting, not the thread. Idle is not a task-success assertion.", z.object({ ...thread, status: z.enum(["pending", "idle", "starting", "active", "stopping", "error"]).optional(), event: z.string().min(1).optional(), timeoutMs: z.number().int().positive().optional(), pollIntervalMs: z.number().int().positive().optional() }).strict().refine(a => !(a.status && a.event), "Choose status or event, not both."), false, manager.wait);
    tool("bb_list_queued_messages", "Read complete queued messages across all threads, or one threadId. Includes scheduling/wait reasons and updatedAt for safe edits.", z.object({ threadId: id.optional() }).strict(), false, manager.listQueue);
    tool("bb_update_queued_message", "Replace a queued message's content with text. Pass its latest updatedAt as expectedUpdatedAt to reject stale edits. Existing attachments are replaced too; schedules and execution settings stay native.", z.object({ ...thread, queuedMessageId: id, expectedUpdatedAt: z.number().int().nonnegative(), message: z.string().min(1) }).strict(), true, manager.updateQueued);
    tool("bb_cancel_queued_message", "Discard one queued instruction without deleting the thread or its conversation.", z.object({ ...thread, queuedMessageId: id }).strict(), true, manager.cancelQueued);
    tool("bb_reorder_queued_message", "Move a queued instruction between named neighbors; null marks an end. Optional groupBoundaryQueuedMessageId follows BB's grouping contract.", z.object({ ...thread, queuedMessageId: id, previousQueuedMessageId: id.nullable(), nextQueuedMessageId: id.nullable(), groupBoundaryQueuedMessageId: id.optional() }).strict(), true, manager.reorderQueued);
    tool("bb_send_queued_message", "Explicitly send a queued instruction now, optionally as a steer. This bypasses its schedule and plugin waits; native provisioning/runtime waits still apply.", z.object({ ...thread, queuedMessageId: id, mode: z.enum(["auto", "steer"]).default("auto"), idempotencyKey: key.optional() }).strict(), true, manager.sendQueued);
    const interaction = { ...thread, interactionId: id };
    tool("bb_list_interactions", "List pending questions, forms and permission approvals with full payloads.", z.object(thread).strict(), false, manager.listInteractions);
    tool("bb_get_interaction", "Read one interaction's status, request details, question/form contract or available permission decisions before responding.", z.object(interaction).strict(), false, manager.getInteraction);
    tool("bb_answer_question", "Answer a pending thread question or form. For user_question pass answers keyed by question ID, with selected option values and optional freeText. For a native/plugin form pass value matching its response contract. Cannot approve permissions; use bb_approve_permission.", z.object({ ...interaction, answers: z.record(z.string(), z.object({ selected: z.array(z.string()), freeText: z.string().optional() }).strict()).optional(), value: z.json().optional(), idempotencyKey: key.optional() }).strict().refine(a => (a.answers !== undefined) !== (a.value !== undefined), "Provide exactly one of answers or value."), true, manager.answer);
    const grants = z.object({ fileSystem: z.object({ read: z.array(z.string()), write: z.array(z.string()) }).strict().nullable(), network: z.object({ enabled: z.boolean().nullable() }).strict().nullable() }).strict().nullable();
    tool("bb_approve_permission", "Resolve ONE pending thread approval: allow_once, allow_for_session or deny, only if that decision is offered. Read the interaction first. Omitted grantedPermissions uses the requested permission grant (or session grant when applicable). Does not change global BB/host settings. Approving can let the agent execute commands or modify files.", z.object({ ...interaction, decision: z.enum(["allow_once", "allow_for_session", "deny"]), grantedPermissions: grants.optional(), idempotencyKey: key.optional() }).strict().refine(a => a.decision !== "deny" || a.grantedPermissions === undefined, "Do not supply grantedPermissions for deny."), true, manager.approve);
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
  bb.cli.register({ name: "mcp", summary: "Inspect the BB MCP endpoint, thread capabilities and request outcomes", commands: [
    { name: "status", summary: "Show endpoint and thread-management access without credentials", usage: "bb mcp status" },
    { name: "operations", summary: "Show the recorded request outcomes without prompts", usage: "bb mcp operations" },
    { name: "reconcile", summary: "Record a manually verified unknown request as accepted", usage: "bb mcp reconcile <operation-id> <thread-id> --confirmed" },
  ], async run(argv) {
    if (argv[0] === "reconcile" && argv.length === 4 && argv[3] === "--confirmed") {
      try { return { exitCode: 0, stdout: JSON.stringify(await adapter.reconcileOperation(argv[1], argv[2]), null, 2) }; }
      catch (e) { return { exitCode: 1, stderr: e instanceof ToolError ? e.message : "BB could not reconcile the operation." }; }
    }
    if (argv[0] === "operations") return { exitCode: 0, stdout: JSON.stringify(store.list().filter(isThreadOperation).map(operationView), null, 2) };
    if (!argv.length || ["status", "--help"].includes(argv[0])) return { exitCode: 0, stdout: JSON.stringify({ endpointPath: "/api/v1/plugins/bb-mcp/http/mcp", authentication: "x-bb-plugin-token", ...capabilities, settings: await settings.get() }, null, 2) };
    return { exitCode: 1, stderr: "Usage: bb mcp status | operations | reconcile <operation-id> <thread-id> --confirmed" };
  } });
}
