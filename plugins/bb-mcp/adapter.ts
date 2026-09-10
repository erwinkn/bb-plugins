import type { BbPluginApi } from "@get-bb/plugin-sdk";
type ThreadResponse = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>;
import { assertScope, executionPermission, isInScope, requireConfigured, threadUrl, ToolError, type Config, type Settings } from "./config";
import { clip, eventView, type ThreadEventRow } from "./presentation";
import { operationView, type Store, type Operation } from "./store";
import { selectExecution, selectInheritedSend, type ExecutionInput } from "./execution";

export type CreateInput = ExecutionInput & { projectId: string; prompt: string; idempotencyKey: string; title?: string; hostId?: string; environmentId?: string; baseBranch?: string; providerId?: string; parentThreadId?: string; visibility?: "visible" | "hidden"; sendAt?: number };
export type HandoffInput = Omit<CreateInput, "projectId"> & { sourceThreadId: string; projectId?: string; reuseSourceEnvironment?: boolean };
export type SendInput = ExecutionInput & { threadId: string; message: string; idempotencyKey: string; mode: "queue" | "steer"; sendAt?: number };
export type UpdateInput = { threadId: string; title?: string; model?: string; reasoningLevel?: ExecutionInput["reasoningLevel"]; parentThreadId?: string | null; visibility?: "visible" | "hidden" };
export function createAdapter(bb: BbPluginApi, settings: Settings, store: Store) {
  const config = async () => { const c = await settings.get(); requireConfigured(c); return c; };
  const unwrap = (t: Awaited<ReturnType<typeof bb.sdk.threads.get>>): ThreadResponse => t;
  async function resolveDefaultHost(c: Config, projectId?: string, required?: true): Promise<string>;
  async function resolveDefaultHost(c: Config, projectId: string | undefined, required: false): Promise<string | null>;
  async function resolveDefaultHost(c: Config, projectId?: string, required = true): Promise<string | null> {
    if (c.defaultHostId) return c.defaultHostId;
    const hosts = await bb.sdk.hosts.list();
    const candidates = hosts.filter(h => isInScope(c.hostIds, h.id) && h.status === "connected");
    let sourceHostIds = new Set<string>();
    if (projectId) {
      const project = (await bb.sdk.projects.list({ includePersonal: true })).find(p => p.id === projectId);
      sourceHostIds = new Set(project?.sources?.map(source => source.hostId) ?? []);
    }
    const selected = candidates.find(h => sourceHostIds.has(h.id)) ?? candidates[0];
    if (!selected && required) throw new ToolError("no_host_available", "No connected execution host is available in this connection's scope.");
    return selected?.id ?? null;
  }
  async function context(threadId: string, c: Config) {
    const t = unwrap(await bb.sdk.threads.get({ threadId }));
    assertScope(c, t.projectId);
    const env = t.environmentId ? await bb.sdk.environments.get({ environmentId: t.environmentId }) : null;
    const hostId = env?.hostId ?? store.forThread(threadId)?.hostId;
    if (!hostId || (env && env.projectId !== t.projectId) || t.deletedAt) throw new ToolError("not_found", "Thread unavailable in this connection's scope.");
    assertScope(c, t.projectId, hostId);
    return { t, env, hostId };
  }
  function summary(t: ThreadResponse, hostId: string, c: Config) {
    return { threadId: t.id, projectId: t.projectId, environmentId: t.environmentId, hostId, parentThreadId: t.parentThreadId, sourceThreadId: t.sourceThreadId, originKind: t.originKind, visibility: t.visibility, title: clip(t.title ?? t.titleFallback ?? "", 500).text, providerId: t.providerId, status: t.status, runtime: t.runtime, queuedMessageCount: t.queuedMessageCount, archived: t.archivedAt !== null, updatedAt: t.updatedAt, url: threadUrl(c, t.projectId, t.id) };
  }
  async function state(threadId: string, c: Config) {
    const { t, env, hostId } = await context(threadId, c);
    const [interactions, queue, execution, terminal] = await Promise.all([
      bb.sdk.threads.interactions.list({ threadId }), bb.sdk.threads.queuedMessages.list({ threadId }),
      bb.sdk.threads.defaultExecutionOptions({ threadId }),
      bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["turn/completed"] }),
    ]);
    const pendingInteractions = interactions.slice(0, 20).map(i => ({ id: i.id, createdAt: i.createdAt, kind: i.payload.kind }));
    const queued = queue.slice(0, 20).map(q => ({ id: q.id, sendAt: q.sendAt, waitingOn: q.waitingOn }));
    const terminalStatus = terminal[0]?.type === "turn/completed" ? terminal[0].data.status : undefined;
    const activity = interactions.length ? "waiting_for_input" : ["active", "starting", "stopping"].includes(t.status) ? t.status
      : queue.length ? "queued" : t.runtime.displayStatus === "provisioning" || t.status === "pending" ? "provisioning"
      : t.status === "error" || terminalStatus === "failed" ? "failed"
      : terminalStatus === "interrupted" ? "interrupted" : "idle";
    return { ...summary(t, hostId, c), activity, environmentStatus: env?.status ?? null, execution,
      pendingInteractions, interactionCount: interactions.length, queued, queueCount: queue.length,
      lastTurn: terminal[0] ? eventView(terminal[0]) : null, observedAt: Date.now(), taskCompletion: "not_inferred", suggestedPollSeconds: 15 };
  }
  function checkOperation(op: Operation, c: Config) {
    assertScope(c, op.projectId, op.hostId);
    for (const related of op.related ?? []) assertScope(c, related.projectId, related.hostId);
    return operationView(op);
  }
  const reference = (ctx: Awaited<ReturnType<typeof context>>) => ({ threadId: ctx.t.id, projectId: ctx.t.projectId, hostId: ctx.hostId });
  function checkSendAt(sendAt: number | undefined) {
    if (sendAt !== undefined && sendAt <= Date.now()) throw new ToolError("invalid_schedule", "sendAt must be a future Unix timestamp in milliseconds.");
  }
  async function parentContext(parentThreadId: string | null | undefined, c: Config) {
    if (!parentThreadId) return null;
    const ctx = await context(parentThreadId, c);
    const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: parentThreadId });
    return { ...ctx, execution };
  }
  async function create(args: CreateInput | HandoffInput, kind: "create" | "handoff") {
    const c = await config();
    const old = store.find(args.idempotencyKey, kind, args);
    if (old) return checkOperation(old, c);
    const source = "sourceThreadId" in args ? await context(args.sourceThreadId, c) : null;
    const projectId = args.projectId ?? source!.t.projectId;
    assertScope(c, projectId);
    const parent = await parentContext(args.parentThreadId, c);
    const reuseSource = source && "sourceThreadId" in args && args.reuseSourceEnvironment !== false && !args.environmentId;
    if (reuseSource && !source.env) throw new ToolError("not_ready", "The source environment is still provisioning; wait or set reuseSourceEnvironment to false.");
    const environmentId = args.environmentId ?? (reuseSource ? source!.env!.id : undefined);
    const env = environmentId ? await bb.sdk.environments.get({ environmentId }) : null;
    if (env && env.projectId !== projectId) throw new ToolError("not_found", "Environment unavailable in the target project. Choose an allowed environment or a new worktree.");
    const hostId = env?.hostId ?? args.hostId ?? await resolveDefaultHost(c, projectId);
    if (env && args.hostId && args.hostId !== env.hostId) throw new ToolError("invalid_host", "The environment belongs to a different host.");
    if (env && args.baseBranch) throw new ToolError("invalid_arguments", "baseBranch cannot be combined with environment reuse.");
    checkSendAt(args.sendAt);
    const execution = await selectExecution(bb, c, { ...args, projectId, hostId, environmentId, defaults: parent?.execution ? { ...parent.execution, providerId: parent.t.providerId } : undefined, parentCeiling: parent?.execution?.permissionMode });
    const related = [parent, source].filter((x): x is NonNullable<typeof x> => !!x).map(reference);
    const input = source ? handoffInput(source.t, args.prompt) : [{ type: "text" as const, text: args.prompt, mentions: [] }];
    const op = await store.run({ kind, projectId, hostId, threadId: null, ...(related.length ? { related } : {}) }, args.idempotencyKey, args, c.maxPendingOperations, c.createsPerHour, async () => {
      const current = await config(); assertScope(current, projectId, hostId);
      executionPermission([execution.permissionMode], current.permissionMode);
      for (const ref of related) await context(ref.threadId, current);
      const t = await bb.sdk.threads.spawn({ projectId, input, title: args.title, ...execution, parentThreadId: args.parentThreadId,
        visibility: args.visibility ?? parent?.t.visibility ?? "visible", sendAt: args.sendAt,
        environment: env ? { type: "reuse", environmentId: env.id } : { type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: args.baseBranch ? { kind: "named", name: args.baseBranch } : { kind: "default" } } } });
      return { ...summary(t, hostId, c), requestedExecution: execution, accepted: true, suggestedPollSeconds: 15,
        ...(source ? { handoff: { sourceThreadId: source.t.id, contextTransfer: "bb_thread_mention", reusedSourceEnvironment: env?.id === source.env?.id } } : {}) };
    });
    return checkOperation(op, await config());
  }
  return {
    async listProjects() {
      const c = await config();
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return { projects: projects.filter(p => isInScope(c.projectIds, p.id)).map(p => ({ id: p.id, name: p.name })), defaultHostId: await resolveDefaultHost(c, undefined, false) };
    },
    async listRuntimes(args: { projectId: string; hostId?: string; environmentId?: string; providerId?: string; offset: number; limit: number }) {
      const c = await config();
      assertScope(c, args.projectId);
      const env = args.environmentId ? await bb.sdk.environments.get({ environmentId: args.environmentId }) : null;
      if (env && env.projectId !== args.projectId) throw new ToolError("not_found", "Environment unavailable in this project.");
      const hostId = env?.hostId ?? args.hostId ?? await resolveDefaultHost(c, args.projectId);
      assertScope(c, args.projectId, hostId);
      const routing = env ? { environmentId: env.id } : { hostId };
      const [hosts, providers] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.providers.list(routing)]);
      const allowed = providers.filter(p => isInScope(c.providerIds, p.id));
      if (args.providerId && !allowed.some(p => p.id === args.providerId)) throw new ToolError("invalid_provider", "Provider unavailable in this connection.");
      const catalog = args.providerId ? await bb.sdk.providers.models({ ...routing, providerId: args.providerId }) : null;
      return { hostId, hosts: hosts.filter(h => isInScope(c.hostIds, h.id)).map(h => ({ id: h.id, name: h.name, status: h.status, maxPermissionMode: h.maxPermissionMode })),
        providers: allowed.map(p => ({ id: p.id, name: p.displayName, available: p.available, permissions: p.capabilities.permissionModes, serviceTiers: p.serviceTiers ?? [], capabilities: p.capabilities, composerActions: p.composerActions })),
        permissionMode: c.permissionMode, models: catalog?.models.slice(args.offset, args.offset + args.limit).map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, defaultReasoningLevel: m.defaultReasoningEffort, reasoningLevels: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })) ?? [],
        modelLoadError: catalog?.modelLoadError ?? null, nextOffset: catalog && args.offset + args.limit < catalog.models.length ? args.offset + args.limit : null };
    },
    async listThreads(args: { projectId: string; query?: string; parentThreadId?: string; sourceThreadId?: string; hasParent?: boolean; archived?: boolean; includeHidden?: boolean; offset: number; limit: number }) {
      const c = await config(); assertScope(c, args.projectId);
      if (args.parentThreadId) await context(args.parentThreadId, c);
      if (args.sourceThreadId) await context(args.sourceThreadId, c);
      // Offset advances through scanned BB rows, including rows excluded by host/title.
      const { query: _query, ...filters } = args;
      const rows = await bb.sdk.threads.list({ ...filters, includeHidden: args.includeHidden ?? true });
      const results = [];
      for (const t of rows) {
        if (args.query && !(t.title ?? t.titleFallback ?? "").toLowerCase().includes(args.query.toLowerCase())) continue;
        try { const ctx = await context(t.id, c); results.push(summary(ctx.t, ctx.hostId, c)); }
        catch (e) { if (!(e instanceof ToolError && e.code === "not_found")) throw e; }
      }
      return { threads: results, nextOffset: rows.length === args.limit ? args.offset + rows.length : null };
    },
    async getThread({ threadId }: { threadId: string }) { return state(threadId, await config()); },
    async getEvents(args: { threadId: string; afterSeq: number; limit: number }) {
      const c = await config(); await context(args.threadId, c);
      const rows = await bb.sdk.threads.events.list({ threadId: args.threadId, afterSeq: String(args.afterSeq), limit: String(args.limit), order: "asc" });
      const events = []; let size = 0;
      for (const row of rows) { const view = eventView(row); const bytes = Buffer.byteLength(JSON.stringify(view)); if (size + bytes > 40000 && events.length) break; events.push(view); size += bytes; }
      return { events, nextAfterSeq: events.at(-1)?.seq ?? args.afterSeq, mayHaveMore: events.length < rows.length || rows.length === args.limit };
    },
    async createThread(args: CreateInput) { return create(args, "create"); },
    async handoffThread(args: HandoffInput) { return create(args, "handoff"); },
    async sendMessage(args: SendInput) {
      const c = await config(); const { t, hostId } = await context(args.threadId, c);
      const old = store.find(args.idempotencyKey, "send", args); if (old) return checkOperation(old, c);
      checkSendAt(args.sendAt);
      const defaults = await bb.sdk.threads.defaultExecutionOptions({ threadId: t.id });
      const parent = await parentContext(t.parentThreadId, c);
      const select = args.model !== undefined || args.reasoningLevel !== undefined || args.serviceTier !== undefined ? selectExecution : selectInheritedSend;
      const execution = await select(bb, c, { ...args, projectId: t.projectId, hostId, environmentId: t.environmentId ?? undefined,
        providerId: t.providerId, defaults: defaults ? { ...defaults, providerId: t.providerId } : undefined, parentCeiling: parent?.execution?.permissionMode });
      const before = await bb.sdk.threads.events.list({ threadId: t.id, order: "desc", limit: "1" });
      const op = await store.run({ kind: "send", projectId: t.projectId, hostId, threadId: t.id, ...(parent ? { related: [reference(parent)] } : {}) }, args.idempotencyKey, args, c.maxPendingOperations, c.createsPerHour, async () => {
        const current = await config(); await context(t.id, current);
        executionPermission([execution.permissionMode], current.permissionMode);
        const { providerId: _provider, ...options } = execution;
        const sent = await bb.sdk.threads.send({ threadId: t.id, mode: args.mode === "queue" ? "queue-if-active" : "steer-if-active", input: [{ type: "text", text: args.message, mentions: [] }], ...options, sendAt: args.sendAt });
        return { threadId: t.id, delivery: sent.delivery, requestedExecution: execution, afterSeq: before[0]?.seq ?? 0,
          ...(sent.delivery === "queued" ? { queuedMessage: { id: sent.queuedMessage.id, waitingOn: sent.queuedMessage.waitingOn, sendAt: sent.queuedMessage.sendAt } } : {}), url: threadUrl(c, t.projectId, t.id) };
      });
      return checkOperation(op, await config());
    },
    async updateThread(args: UpdateInput) {
      const c = await config(); const { t, hostId } = await context(args.threadId, c);
      if (Object.keys(args).every(k => k === "threadId")) throw new ToolError("invalid_arguments", "Provide at least one field to update.");
      if (args.parentThreadId === t.id) throw new ToolError("invalid_parent", "A thread cannot be its own parent.");
      if (args.parentThreadId) await context(args.parentThreadId, c);
      if (args.model !== undefined || args.reasoningLevel !== undefined) {
        const defaults = await bb.sdk.threads.defaultExecutionOptions({ threadId: t.id });
        await selectExecution(bb, c, { ...args, projectId: t.projectId, hostId, environmentId: t.environmentId ?? undefined,
          providerId: t.providerId, defaults: defaults ? { ...defaults, providerId: t.providerId } : undefined });
      }
      const updated = await bb.sdk.threads.update(args);
      const { threadId: _id, ...requestedChanges } = args;
      return { ...summary(updated, hostId, c), updatedFields: Object.keys(requestedChanges), requestedChanges, executionApplies: "next_and_later_turns", activeTurnRestarted: false };
    },
    async stopThread({ threadId }: { threadId: string }) {
      const c = await config(); await context(threadId, c); await bb.sdk.threads.stop({ threadId });
      return { threadId, stopRequested: true, note: "Stop releases the current runtime. Queued instructions are separate; inspect bb_get_thread." };
    },
    async renameThread({ threadId, title }: { threadId: string; title: string }) {
      const c = await config(); await context(threadId, c); await bb.sdk.threads.update({ threadId, title }); return { threadId, title };
    },
    async getResult({ threadId, afterSeq }: { threadId: string; afterSeq: number }) {
      const c = await config(); const snapshot = await state(threadId, c);
      const rows = await bb.sdk.threads.events.list({ threadId, order: "desc", afterSeq: String(afterSeq), limit: "100", types: ["item/completed", "client/turn/requested"] });
      const lastRequest = rows.find(r => r.type === "client/turn/requested");
      const assistant = rows.find(r => r.type === "item/completed" && r.data.item.type === "agentMessage" && !r.data.item.parentToolCallId) as ThreadEventRow | undefined;
      const result = assistant ? eventView(assistant) : null;
      return { ...snapshot, result, lastRequestSeq: lastRequest?.seq ?? null,
        resultPredatesLatestRequest: !!(assistant && lastRequest && assistant.seq < lastRequest.seq),
        isCurrentTurnResult: !!(assistant && snapshot.queueCount === 0 && snapshot.interactionCount === 0 && snapshot.status === "idle" && snapshot.lastTurn?.status === "completed" && snapshot.lastTurn.scope.kind === "turn" && assistant.scope.kind === "turn" && snapshot.lastTurn.scope.turnId === assistant.scope.turnId && (!lastRequest || assistant.seq > lastRequest.seq)),
        historyWindowExhausted: !assistant && rows.length === 100,
        nextBeforeSeq: rows.length === 100 ? rows.at(-1)?.seq : null };
    },
    async getChanges(args: { threadId: string; target: "uncommitted" | "all"; paths?: string[]; offset: number; limit: number }) {
      const c = await config(); const { env } = await context(args.threadId, c);
      if (!env) throw new ToolError("not_ready", "The thread's environment is still provisioning.");
      const branch = env.mergeBaseBranch ?? env.baseBranch;
      if (args.target === "all" && !branch) throw new ToolError("missing_base", "This environment has no base branch; use target uncommitted.");
      const target = args.target === "all" ? { target: "all" as const, mergeBaseBranch: branch! } : { target: "uncommitted" as const };
      const [files, pr] = await Promise.all([bb.sdk.environments.diffFiles({ environmentId: env.id, ...target }), bb.sdk.environments.pullRequest({ environmentId: env.id })]);
      const patches = args.paths?.length ? await bb.sdk.environments.diffPatch({ environmentId: env.id, paths: args.paths, target: args.target === "all" ? { type: "all", mergeBaseBranch: branch! } : { type: "uncommitted" } }) : null;
      const fileView = files.outcome === "available" ? {
        outcome: files.outcome, files: files.files.slice(args.offset, args.offset + args.limit), shortstat: clip(files.shortstat, 1000).text,
        mergeBaseRef: files.mergeBaseRef, truncated: files.truncated, nextOffset: args.offset + args.limit < files.files.length ? args.offset + args.limit : null,
      } : files.outcome === "unavailable" ? { outcome: files.outcome, reason: files.failure.code } : files;
      const patchView = patches?.outcome === "available" ? { outcome: patches.outcome, patches: patches.patches.slice(0, 3).map(p => ({ path: p.path, ...clip(p.patch, 10000), sourceTruncated: p.truncated })) } : patches?.outcome === "unavailable" ? { outcome: patches.outcome, reason: patches.failure.code } : patches;
      return { environmentId: env.id, target: args.target, changes: fileView, pullRequest: pr, patches: patchView };
    },
    async getOperation({ operationId }: { operationId: string }) {
      const c = await config(); const op = store.get(operationId);
      if (!op) throw new ToolError("not_found", "Operation unavailable.");
      return checkOperation(op, c);
    },
    async reconcileOperation(operationId: string, threadId: string) {
      const c = await config(); const op = store.get(operationId);
      if (!op) throw new ToolError("not_found", "Operation unavailable.");
      checkOperation(op, c); const { t, hostId } = await context(threadId, c);
      if (t.projectId !== op.projectId || hostId !== op.hostId || (op.threadId && op.threadId !== threadId)) throw new ToolError("conflict", "The thread does not match the operation's recorded scope.");
      return operationView(store.reconcile(operationId, threadId));
    },
  };
}

// This is BB's UI handoff contract: reuse the workspace and create a fresh
// conversation with a rich source-thread mention. BB owns context resolution.
function handoffInput(source: ThreadResponse, prompt: string) {
  const mention = `@thread:${source.id}`;
  const text = `Continue from ${mention}\n\n${prompt}`;
  const start = text.indexOf(mention);
  return [{ type: "text" as const, text, mentions: [{
    start, end: start + mention.length,
    resource: { kind: "thread" as const, projectId: source.projectId, threadId: source.id, label: source.title ?? source.titleFallback ?? source.id },
  }] }];
}
