import { afterEach, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { brief } from "./helpers";
import { DEFAULT_PROFILES, reportSchema } from "../lib/schema";
import { clearCatalogCache, type ThreadDto } from "../lib/bb";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  clearCatalogCache();
});
export const report = () =>
  reportSchema.parse({
    outcome: "succeeded",
    summary:
      "Search now includes archived records; the integration checks pass.",
    evidence: [{ kind: "check", label: "npm test", result: "passed" }],
    handoff: {
      summary: "Implemented search",
      workspaceRevision: "baseline + working changes",
      files: ["src/search.ts"],
    },
  });

/**
 * Observes or holds a stubbed SDK call. `path` is the dotted SDK method
 * ("threads.queuedMessages.delete"); `call` runs the fixture's stub.
 */
export type Intercept = (path: string, args: any, call: () => unknown) => unknown;

/** Route every stubbed SDK function through the fixture's current intercept. */
function interceptable(
  node: unknown,
  path: string,
  current: () => Intercept | undefined,
): unknown {
  if (typeof node === "function")
    return (...args: unknown[]) => {
      const intercept = current();
      return intercept
        ? intercept(path, args[0], () => node(...args))
        : node(...args);
    };
  if (node && typeof node === "object" && !Array.isArray(node))
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [
        key,
        interceptable(child, path ? `${path}.${key}` : key, current),
      ]),
    );
  return node;
}

function createInterceptableHost(
  options: NonNullable<Parameters<typeof createFakePluginHost>[0]>,
  current: () => Intercept | undefined,
) {
  return createFakePluginHost({
    ...options,
    sdk: interceptable(options.sdk, "", current) as typeof options.sdk,
  });
}

export interface QueuedRow {
  id: string;
  content: unknown;
}

export function fixture(settings?: Record<string, string | number | boolean>, options: { dataDir?: string } = {}) {
  // Durable native history shared by every events.list call; handover drains
  // require positive completion evidence, so the default is one finished turn.
  const history: {
    type: string;
    seq: number;
    createdAt: number;
    data?: Record<string, unknown>;
  }[] = [
    {
      type: "turn/completed",
      seq: 1,
      createdAt: 1,
      data: { status: "completed" },
    },
  ];
  const threads = new Map<string, ThreadDto>([
    [
      "coordinator",
      makeThreadResponse({
        id: "coordinator",
        projectId: "proj_a",
        environmentId: "env_a",
        title: "Coordinator",
      }),
    ],
  ]);
  const metadata = new Map<string, Record<string, unknown>>();
  const execution = new Map<
    string,
    {
      model: string;
      reasoningLevel: string;
      permissionMode?: string;
      serviceTier?: string;
    }
  >();
  // Native queues live in BB, not the plugin. Tests queue via send's
  // {delivery:'queued'} receipt and clear rows to simulate BB dispatching them.
  const queued = new Map<string, QueuedRow[]>();
  const spawn = vi.fn(async (args: Record<string, any>) => {
    // BB 0.43.1 thread-create cross-field validation, absent from the SDK
    // harness's structural spawn checks. Reject before creating any fixture
    // thread or metadata, just as the native HTTP boundary does.
    const originKind = args.originKind ?? null;
    const sourceThreadId = args.sourceThreadId ??
      (originKind !== null ? args.parentThreadId : undefined) ?? null;
    const invalid = (message: string): never => {
      throw Object.assign(new Error(message), { status: 400, code: "invalid_request" });
    };
    if (originKind === null && sourceThreadId !== null)
      invalid("sourceThreadId requires an originKind");
    if (originKind !== null && sourceThreadId === null)
      invalid("originKind requires a sourceThreadId");
    if (args.startedOnBehalfOf != null) {
      const senderId = sourceThreadId ?? args.parentThreadId ?? null;
      if (senderId === null)
        invalid("startedOnBehalfOf requires a sourceThreadId or parentThreadId");
      if (args.startedOnBehalfOf.senderThreadId !== senderId)
        invalid(sourceThreadId === null
          ? "startedOnBehalfOf.senderThreadId must match parentThreadId"
          : "startedOnBehalfOf.senderThreadId must match sourceThreadId");
      if (originKind === null)
        invalid("startedOnBehalfOf requires an originKind");
    }
    const id = `native-${threads.size}`;
    const t = makeThreadResponse({
      id,
      createdAt: Date.now(),
      projectId: args.projectId,
      environmentId: args.environment?.environmentId ?? "env_a",
      providerId: args.providerId,
      parentThreadId: args.parentThreadId ?? null,
      status: "active",
      originPluginId: "initiatives",
    });
    threads.set(id, t);
    metadata.set(id, args.pluginMetadata ?? {});
    execution.set(id, {
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      permissionMode: args.permissionMode,
      serviceTier: args.serviceTier,
    });
    return t;
  });
  // A native fork carries no parent argument: the new thread keeps the source
  // thread's project but lands unparented, like BB's own fork semantics.
  const fork = vi.fn(async (args: Record<string, any>) => {
    const source = threads.get(args.sourceThreadId);
    const id = `native-${threads.size}`;
    const t = makeThreadResponse({
      id,
      createdAt: Date.now(),
      projectId: source?.projectId ?? "proj_a",
      environmentId: args.environment?.environmentId ?? source?.environmentId ?? "env_a",
      providerId: source?.providerId,
      originKind: "fork",
      parentThreadId: null,
      status: "active",
      originPluginId: "initiatives",
    });
    threads.set(id, t);
    metadata.set(id, args.pluginMetadata ?? {});
    execution.set(id, {
      // BB thread-fork.ts inherits the source's last native execution. Its
      // request has no model/effort/tier override fields.
      model: execution.get(args.sourceThreadId)?.model ?? "claude-opus-5-5",
      reasoningLevel: execution.get(args.sourceThreadId)?.reasoningLevel ?? "high",
      permissionMode: args.permissionMode ?? execution.get(args.sourceThreadId)?.permissionMode,
      serviceTier: execution.get(args.sourceThreadId)?.serviceTier,
    });
    return t;
  });
  // Environment registry: env_a is proj_a's default non-worktree checkout.
  // Unknown ids resolve to a ready non-worktree env of proj_a so reuse checks
  // exercise the real DTO shape; tests override entries for mismatch cases.
  const envs = new Map<string, Record<string, any>>([
    [
      "env_a",
      {
        id: "env_a",
        projectId: "proj_a",
        path: "/code/repo",
        hostId: "host_a",
        name: null,
        isWorktree: false,
        status: "ready",
        lifecycle: { phase: "active", retireAt: null, teardown: null },
      },
    ],
  ]);
  const envFor = (environmentId: string) => {
    const known = envs.get(environmentId);
    if (known) return known;
    return {
      id: environmentId,
      projectId: "proj_a",
      path: `/code/${environmentId}`,
      hostId: "host_a",
      name: null,
      isWorktree: false,
      status: "ready",
      lifecycle: { phase: "active", retireAt: null, teardown: null },
    };
  };
  const envUpdate = vi.fn(
    async ({ environmentId, ...patch }: Record<string, any>) => {
      const e = envFor(environmentId);
      envs.set(environmentId, { ...e, ...patch });
      return envs.get(environmentId);
    },
  );
  // The Threads sidebar's change bump (initiativesChanged) and any other plugin RPC.
  const pluginRpc = vi.fn(async (_args: { pluginId: string; method: string; input?: unknown }) => ({ ok: true }));
  const send = vi.fn<(...args: any[]) => Promise<any>>(
    async (args: Record<string, any>) => {
      const previous = execution.get(args.threadId);
      if (previous)
        execution.set(args.threadId, {
          ...previous,
          ...Object.fromEntries(
            ["model", "reasoningLevel", "permissionMode", "serviceTier"]
              .filter((field) => args[field] !== undefined)
              .map((field) => [field, args[field]]),
          ),
        });
      return { delivery: "sent", thread: threads.get(args.threadId) };
    },
  );
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => {
    const t = threads.get(threadId)!;
    threads.set(threadId, { ...t, archivedAt: Date.now() });
    return threads.get(threadId);
  });
  const update = vi.fn(
    async ({ threadId, ...patch }: Record<string, any>) => {
      const t = threads.get(threadId)!;
      threads.set(threadId, { ...t, ...patch });
      return threads.get(threadId);
    },
  );
  const stop = vi.fn(async () => ({}));
  let intercept: Intercept | undefined;
  const host = createInterceptableHost({
    pluginId: "initiatives",
    settings,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    agentSkillIds: ["initiative-coordinator", "initiative-worker"],
    sdk: {
      plugins: { callRpc: pluginRpc },
      projects: {
        get: async () => ({
          id: "proj_a",
          name: "Repository",
          // env_a at /code/repo is this project's default checkout — its
          // coordinator home.
          sources: [{ hostId: "host_a", isDefault: true, path: "/code/repo" }],
        }),
        list: async () => [{ id: "proj_a", name: "Repository" }],
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) =>
          envFor(environmentId),
        list: async ({ projectId }: { projectId?: string } = {}) =>
          [...envs.values()].filter(
            (e) => !projectId || e.projectId === projectId,
          ),
        update: envUpdate,
      },
      providers: {
        models: async () => ({
          providers: [
            ...["claude-code", "codex"].map((id) => ({
              id,
              available: true,
              capabilities: { supportsFork: true, supportsServiceTier: id === "codex" },
            })),
            // Threads recorded with a different provider still check against
            // it; preserved incumbent providers stay spawnable.
            ...[
              ...new Set(
                [...threads.values()]
                  .map((t) => t.providerId)
                  .filter(Boolean),
              ),
            ]
              .filter((id) => !["claude-code", "codex"].includes(id!))
              .map((id) => ({
                id: id!,
                available: true,
                capabilities: { supportsFork: true },
              })),
          ],
          models: [
            ...Object.values(DEFAULT_PROFILES).map((p) => ({
              id: p.model,
              model: p.model,
              supportedReasoningEfforts: [
                { reasoningEffort: "high" },
                { reasoningEffort: "xhigh" },
              ],
            })),
            // Models BB recorded as a thread's effective choice stay in the
            // catalog so preserved incumbent settings keep spawning.
            ...[
              ...new Set(
                [...execution.values()].map((options) => options.model),
              ),
            ]
              .filter(
                (model) =>
                  model !== undefined &&
                  !Object.values(DEFAULT_PROFILES).some(
                    (p) => p.model === model,
                  ),
              )
              .map((model) => ({
                id: model!,
                model: model!,
                supportedReasoningEfforts: [
                  "none",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                  "ultra",
                  "ultracode",
                ].map((reasoningEffort) => ({ reasoningEffort })),
              })),
          ],
        }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (!threads.has(threadId))
            throw Object.assign(new Error("Deleted"), { status: 404 });
          return threads.get(threadId);
        },
        spawn,
        fork,
        send,
        archive,
        stop,
        update,
        list: async (
          args: {
            parentThreadId?: string;
            originPluginId?: string;
            archived?: boolean;
            offset?: number;
            limit?: number;
          } = {},
        ) =>
          [...threads.values()]
            .filter((t) =>
              args.parentThreadId
                ? t.parentThreadId === args.parentThreadId &&
                  // Simplification: BB's real route hides only deleted children and
                  // returns archived ones unless `archived` is passed. t87 routes
                  // discovery listings through that real behaviour.
                  t.archivedAt === null
                : !args.originPluginId ||
                  t.originPluginId === args.originPluginId,
            )
            .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200))
            // The list DTO carries full native activity and queue evidence
            // the GET DTO omits; derive the same fields the real route sends.
            .map((t: any) => ({
              ...t,
              activity: t.activity ?? {
                activeBackgroundAgentCount: t.activeBackgroundAgentCount ?? 0,
                activeBackgroundCommandCount: 0,
                activeGoalCount: 0,
                activePlanModeCount: 0,
                activeWorkflowCount: 0,
              },
              environmentBranchName: null,
              environmentHostId: null,
              environmentIsWorktree: t.environmentIsWorktree ?? null,
              environmentName: null,
              environmentPath: null,
              environmentProviderId: null,
              environmentWorkspaceDisplayKind: "unmanaged-worktree",
              hasPendingInteraction: t.hasPendingInteraction ?? false,
              pinSortKey: null,
              queuedWork: t.queuedMessageCount ? "waiting" : "none",
            })),
        getPluginMetadata: async ({ threadId }: { threadId: string }) =>
          metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          metadata.set(threadId, { ...metadata.get(threadId), ...set });
          return metadata.get(threadId);
        },
        defaultExecutionOptions: async ({ threadId }: { threadId: string }) =>
          execution.get(threadId) ?? {
            model: "claude-opus-5-5",
            reasoningLevel: "high",
          },
        promptHistory: async () => [],
        events: {
          list: async (args: {
            types?: readonly string[];
            order?: string;
            limit?: string;
          }) =>
            history
              .filter((row) => !args.types || args.types.includes(row.type))
              .sort((a, b) =>
                args.order === "desc" ? b.seq - a.seq : a.seq - b.seq,
              )
              .slice(0, Number(args.limit ?? history.length)),
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) =>
            queued.get(threadId) ?? [],
          delete: async ({ threadId, queuedMessageId }: any) => {
            queued.set(
              threadId,
              (queued.get(threadId) ?? []).filter(
                (row) => row.id !== queuedMessageId,
              ),
            );
            return {};
          },
        },
      },
    },
  }, () => intercept);
  const p = plugin(host.bb);
  closers.push(async () => {
    p.runtime.dispose();
    await host.harness.dispose();
  });
  const create = () =>
    p.service.createProject({
      name: "Search",
      objective: "Make historical search useful",
      memberProjectIds: ["proj_a"],
      coordinator: { kind: "adopt", threadId: "coordinator" },
    });
  const task = (id: string, title = "Historical search") =>
    p.service.createTask(
      id,
      {
        title,
        summary: "Include archived records and explain the matches.",
        brief: brief(),
      },
      "coordinator",
    );
  const idle = (id: string) => {
    const t = { ...threads.get(id)!, status: "idle" as const };
    threads.set(id, t);
    return t;
  };
  /** Queue a native send result for the next continue dispatch. */
  const queueSend = (id = "qm1") =>
    send.mockImplementationOnce(async () => ({
      delivery: "queued",
      queuedMessage: { id, content: [{ type: "text", text: "brief" }] },
    }));
  return {
    ...p,
    ...host,
    threads,
    metadata,
    execution,
    history,
    queued,
    envs,
    envUpdate,
    spawn,
    fork,
    send,
    pluginRpc,
    archive,
    update,
    stop,
    create,
    task,
    idle,
    queueSend,
    /** Observe or hold every later stubbed SDK call; undefined restores. */
    intercept: (next?: Intercept) => {
      intercept = next;
    },
  };
}

/** Adopted coordinator + project, the common starting point. */
export async function projectFixture(settings?: Record<string, string | number | boolean>) {
  const f = fixture(settings);
  const { project } = await f.create();
  return { f, project };
}
