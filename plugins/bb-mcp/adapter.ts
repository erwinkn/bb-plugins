import type { BbPluginApi } from "@get-bb/plugin-sdk";
type ThreadResponse = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>;
import { assertScope, executionPermission, ids, requireConfigured, threadUrl, ToolError, type Config, type Settings } from "./config";
import { clip, eventView, type ThreadEventRow } from "./presentation";
import { operationView, type Store, type Operation } from "./store";

export type CreateInput = { projectId: string; prompt: string; idempotencyKey: string; title?: string; hostId?: string; environmentId?: string; baseBranch?: string; providerId?: string; model?: string; reasoningLevel?: string };
export type SendInput = { threadId: string; message: string; idempotencyKey: string; mode: "queue" | "steer" };
export function createAdapter(bb: BbPluginApi, settings: Settings, store: Store) {
  const config = async () => { const c = await settings.get(); requireConfigured(c); return c; };
  const unwrap = (t: Awaited<ReturnType<typeof bb.sdk.threads.get>>): ThreadResponse => t;
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
    return { threadId: t.id, projectId: t.projectId, environmentId: t.environmentId, hostId, title: clip(t.title ?? t.titleFallback ?? "", 500).text, providerId: t.providerId, status: t.status, runtime: t.runtime, queuedMessageCount: t.queuedMessageCount, archived: t.archivedAt !== null, updatedAt: t.updatedAt, url: threadUrl(c, t.projectId, t.id) };
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
  function checkOperation(op: Operation, c: Config) { assertScope(c, op.projectId, op.hostId); return operationView(op); }
  async function runtime(projectId: string, hostId: string, providerId: string | undefined, model: string | undefined, reasoningLevel: string | undefined, environmentId: string | undefined, c: Config) {
    assertScope(c, projectId, hostId);
    const hosts = await bb.sdk.hosts.list();
    if (hosts.find(h => h.id === hostId)?.status !== "connected") throw new ToolError("host_offline", "The selected execution host is offline.");
    const routing = environmentId ? { environmentId } : { hostId };
    const providers = (await bb.sdk.providers.list(routing)).filter(p => p.available && (!ids(c.providerIds).length || ids(c.providerIds).includes(p.id)));
    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId });
    const provider = providers.find(p => p.id === (providerId ?? defaults?.providerId)) ?? (!providerId ? providers[0] : undefined);
    if (!provider) throw new ToolError("invalid_provider", "Choose an available provider from bb_list_runtimes.");
    const catalog = await bb.sdk.providers.models({ ...routing, providerId: provider.id });
    if (catalog.modelLoadError) throw new ToolError("catalog_unavailable", `Model catalog unavailable (${catalog.modelLoadError.code}).`);
    const selected = model ?? (defaults?.providerId === provider.id ? defaults.model : undefined);
    const entry = catalog.models.find(m => m.model === selected || m.id === selected) ?? (!model ? catalog.models.find(m => m.isDefault) ?? catalog.models[0] : undefined);
    if (!entry) throw new ToolError("invalid_model", "Choose a model from bb_list_runtimes.");
    if (reasoningLevel && !entry.supportedReasoningEfforts.some(e => e.reasoningEffort === reasoningLevel)) throw new ToolError("invalid_reasoning", "The selected model does not support this reasoning level.");
    const permissionMode = executionPermission(provider.capabilities.permissionModes, c.permissionMode, hosts.find(h => h.id === hostId)?.maxPermissionMode);
    return { providerId: provider.id, model: entry.model, reasoningLevel: (reasoningLevel ?? entry.defaultReasoningEffort) as typeof entry.defaultReasoningEffort, permissionMode };
  }
  return {
    async listProjects() {
      const c = await config();
      const projects = await bb.sdk.projects.list();
      return { projects: projects.filter(p => ids(c.projectIds).includes(p.id)).map(p => ({ id: p.id, name: p.name })), defaultHostId: c.defaultHostId };
    },
    async listRuntimes(args: { projectId: string; hostId?: string; environmentId?: string; providerId?: string; offset: number; limit: number }) {
      const c = await config();
      assertScope(c, args.projectId);
      const env = args.environmentId ? await bb.sdk.environments.get({ environmentId: args.environmentId }) : null;
      if (env && env.projectId !== args.projectId) throw new ToolError("not_found", "Environment unavailable in this project.");
      const hostId = env?.hostId ?? args.hostId ?? c.defaultHostId;
      assertScope(c, args.projectId, hostId);
      const routing = env ? { environmentId: env.id } : { hostId };
      const [hosts, providers] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.providers.list(routing)]);
      const allowed = providers.filter(p => !ids(c.providerIds).length || ids(c.providerIds).includes(p.id));
      if (args.providerId && !allowed.some(p => p.id === args.providerId)) throw new ToolError("invalid_provider", "Provider unavailable in this connection.");
      const catalog = args.providerId ? await bb.sdk.providers.models({ ...routing, providerId: args.providerId }) : null;
      return { hostId, hosts: hosts.filter(h => ids(c.hostIds).includes(h.id)).map(h => ({ id: h.id, name: h.name, status: h.status })),
        providers: allowed.map(p => ({ id: p.id, name: p.displayName, available: p.available, permissions: p.capabilities.permissionModes })),
        permissionMode: c.permissionMode, models: catalog?.models.slice(args.offset, args.offset + args.limit).map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, reasoningLevels: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })) ?? [],
        modelLoadError: catalog?.modelLoadError ?? null, nextOffset: catalog && args.offset + args.limit < catalog.models.length ? args.offset + args.limit : null };
    },
    async listThreads(args: { projectId: string; query?: string; offset: number; limit: number }) {
      const c = await config(); assertScope(c, args.projectId);
      // Offset advances through scanned BB rows, including rows excluded by host/title.
      const rows = await bb.sdk.threads.list({ projectId: args.projectId, offset: args.offset, limit: args.limit });
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
    async createThread(args: CreateInput) {
      const c = await config(); assertScope(c, args.projectId);
      const old = store.find(args.idempotencyKey, "create", args); if (old) return checkOperation(old, c);
      const env = args.environmentId ? await bb.sdk.environments.get({ environmentId: args.environmentId }) : null;
      if (env && env.projectId !== args.projectId) throw new ToolError("not_found", "Environment unavailable in this project.");
      const hostId = env?.hostId ?? args.hostId ?? c.defaultHostId;
      if (env && args.hostId && args.hostId !== env.hostId) throw new ToolError("invalid_host", "The environment belongs to a different host.");
      if (env && args.baseBranch) throw new ToolError("invalid_arguments", "baseBranch cannot be combined with environment reuse.");
      const execution = await runtime(args.projectId, hostId, args.providerId, args.model, args.reasoningLevel, env?.id, c);
      const op = await store.run({ kind: "create", projectId: args.projectId, hostId, threadId: null }, args.idempotencyKey, args, c.maxPendingOperations, c.createsPerHour, async () => {
        assertScope(await config(), args.projectId, hostId);
        const t = await bb.sdk.threads.spawn({ projectId: args.projectId, prompt: args.prompt, title: args.title, ...execution, visibility: "visible",
          environment: env ? { type: "reuse", environmentId: env.id } : { type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: args.baseBranch ? { kind: "named", name: args.baseBranch } : { kind: "default" } } } });
        // Record the acceptance before any follow-up reads can fail.
        return { ...summary(t, hostId, c), requestedExecution: execution, accepted: true, suggestedPollSeconds: 15 };
      });
      return checkOperation(op, c);
    },
    async sendMessage(args: SendInput) {
      const c = await config(); const { t, hostId } = await context(args.threadId, c);
      const old = store.find(args.idempotencyKey, "send", args); if (old) return checkOperation(old, c);
      const providers = await bb.sdk.providers.list(t.environmentId ? { environmentId: t.environmentId } : { hostId });
      const provider = providers.find(p => p.id === t.providerId && (!ids(c.providerIds).length || ids(c.providerIds).includes(p.id)));
      if (!provider) throw new ToolError("invalid_provider", "This thread's provider is outside the configured execution scope.");
      const permissionMode = executionPermission(provider.capabilities.permissionModes, c.permissionMode);
      const before = await bb.sdk.threads.events.list({ threadId: t.id, order: "desc", limit: "1" });
      const op = await store.run({ kind: "send", projectId: t.projectId, hostId, threadId: t.id }, args.idempotencyKey, args, c.maxPendingOperations, c.createsPerHour, async () => {
        await context(t.id, await config());
        const sent = await bb.sdk.threads.send({ threadId: t.id, mode: args.mode === "queue" ? "queue-if-active" : "steer-if-active", input: [{ type: "text", text: args.message, mentions: [] }], permissionMode });
        return { threadId: t.id, delivery: sent.delivery, afterSeq: before[0]?.seq ?? 0, ...(sent.delivery === "queued" ? { queuedMessage: { id: sent.queuedMessage.id, waitingOn: sent.queuedMessage.waitingOn, sendAt: sent.queuedMessage.sendAt } } : {}), url: threadUrl(c, t.projectId, t.id) };
      });
      return checkOperation(op, c);
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
