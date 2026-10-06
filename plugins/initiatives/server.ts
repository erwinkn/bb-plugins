import type {
  BbPluginApi,
  PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  projectsContract,
  type ProjectSummary,
  type ProjectTree,
} from "./lib/contract";
import {
  createSchema,
  delegateSchema,
  taskCommands,
  workerCommands,
  parseCommandInput,
  parseDecisionCommand,
  manageCommands,
  updateSchema,
  runCommand,
  type Command,
} from "./lib/commands";
import { legacyReportSchema, LEGACY_TOOL_NAMES } from "./lib/legacy";
import { reportSchema } from "./lib/schema";
import { definePreferences } from "./lib/settings";
import { Store, MIGRATIONS } from "./lib/store";
import { ProjectsService } from "./lib/service";
import { Runtime, SWEEP_INTERVAL_MS } from "./lib/runtime";
import {
  buildOverview,
  buildSummary,
  threadsToWatch,
  type CoordinatorHome,
  type LiveThread,
  type OverviewDetail,
} from "./lib/overview";
import { LiveThreads, Recent } from "./lib/live-threads";
import { notDeliveredMessages, queueTargets } from "./lib/not-delivered";
import { COMMAND_EXAMPLES, READ_EXAMPLES } from "./lib/examples";
import { decisionToolJsonSchema } from "./lib/decision-input";
import { objectRootSchema } from "./lib/tool-schema";
import { ProjectError, errorMessage } from "./lib/bb";
import { isOwnOrigin } from "./lib/identity";
import { scopedNativeEvent } from "./lib/native-events";
import { initiativesContext, membersContext, recordText, threadContext } from "./lib/context";
import { messageSchema, currentIdentity, workerWork } from "./lib/messaging";
import {
  readCollection, readRefs, readRows, compactOverview, agentReadSchema, validateSelection,
  readOptionsSchema,
  READ_VIEWS,
  type ReadOptions,
  type ReadView,
} from "./lib/read";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const preferences = definePreferences(bb);
  const service = new ProjectsService(bb, store, preferences);
  const runtime = new Runtime(service);
  bb.onDispose(() => runtime.dispose());
  const changed = (projectId?: string) => {
    const payload: Record<string, string> = projectId ? { projectId } : {};
    bb.realtime.publish("initiatives-changed", payload);
    // A plugin app only hears its own realtime signals: the Threads sidebar
    // republishes this bump on its own channel and refetches the tree.
    try {
      void bb.sdk.plugins
        .callRpc({
          pluginId: "sidebar",
          method: "initiativesChanged",
          input: payload,
          outputSchema: z.object({ ok: z.literal(true) }),
        })
        .catch(() => {});
    } catch {
      /* sidebar absent */
    }
  };
  // Every ledger write goes through this one connection, so its change
  // counter versions the ledger: the tree and list are rebuilt only after a
  // write, and a sweep that wrote nothing announces nothing.
  const ledgerVersion = () =>
    (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  // Every entry point that can write (RPC command, agent tool, CLI, sweep)
  // runs in one announcing scope: a write announces itself once, also when
  // the work throws after saving, and work that wrote nothing announces nothing.
  const announcing = async <T,>(work: () => T | Promise<T>, scope?: () => string | undefined): Promise<T> => {
    const before = ledgerVersion();
    try {
      return await work();
    } finally {
      if (ledgerVersion() !== before) changed(scope?.());
    }
  };
  const projectOf = (threadId?: string) =>
    threadId ? store.membership(threadId, true)?.project.id : undefined;
  // Native calls yield. Serialize mutations so concurrent requests cannot both
  // decide that a worker or shared workspace is available.
  let writes: Promise<unknown> = Promise.resolve();
  const perform = (
    id: string | undefined,
    command: Command,
    author: "user" | "coordinator",
    threadId: string | null,
  ) => {
    const run = () => runCommand(service, id, command, author, threadId);
    if (
      ["answer", "blocker-answer", "blocker-dismiss", "pause", "assignment-stop", "stop-work"].includes(
        command.action,
      )
    )
      return run();
    const next = writes.then(run, run);
    writes = next.catch(() => undefined);
    return next;
  };
  // Dashboard reads share native facts: lifecycle events keep them current,
  // and a stale fact is answered at once, then re-read in the background; a
  // change found that way announces the Initiative. Agent and CLI reads stay fresh.
  const liveThreads = new LiveThreads((threadId) => bb.sdk.threads.get({ threadId }));
  const nativeContext = new Recent<unknown>(10_000);
  const instanceEpoch = Math.random().toString(36).slice(2, 10);
  const overview = async (
    projectId: string,
    detail: OverviewDetail = "full",
    { fresh = true }: { fresh?: boolean } = {},
  ) => {
    service.requireProject(projectId);
    const recent = <T,>(key: string, load: () => Promise<T>) =>
      fresh ? load() : (nativeContext.get(key, load) as Promise<T>);
    const live = await liveThreads.get(threadsToWatch(store, projectId), {
      fresh,
      revalidated: () => changed(projectId),
    });
    const profileDefaults = (await preferences.read()).profiles;
    const result = buildOverview(
      store,
      projectId,
      live,
      Date.now(),
      await coordinatorHome(projectId, live, recent),
      detail,
    );
    result.project.profileDefaults = profileDefaults;
    result.revision = { epoch: instanceEpoch, version: ledgerVersion() };
    // One workspace-wide queue read, shared by every Initiative's refresh. A
    // failed read shows nothing rather than guessing (T133).
    try {
      const queue = await recent("queue", () => bb.sdk.threads.queue.list());
      result.notDelivered = notDeliveredMessages(queue, queueTargets(store, projectId), live, Date.now());
    } catch {
      result.notDelivered = [];
    }
    if (result.project.coordinatorThreadId) {
      const threadId = result.project.coordinatorThreadId;
      try {
        const options = await recent(`options:${threadId}`, () => bb.sdk.threads.defaultExecutionOptions({ threadId }));
        result.project.coordinatorProfile = options ? [options.model, options.reasoningLevel, options.serviceTier].filter(Boolean).join(" · ") : null;
      } catch { result.project.coordinatorProfile = null; }
    }
    return result;
  };
  /**
   * The Initiative's coordinator home: the primary member's default source
   * checkout — its host plus the ready non-worktree environment at that
   * source's path. `mismatch` names, in plain terms, how the live
   * coordinator differs from that home; it never silently moves it.
   */
  const coordinatorHome = async (
    projectId: string,
    live: Map<string, LiveThread>,
    recent: <T>(key: string, load: () => Promise<T>) => Promise<T>,
  ): Promise<CoordinatorHome | null> => {
    const project = store.project(projectId);
    const bbProjectId = project?.memberProjectIds[0];
    if (!project || !bbProjectId) return null;
    try {
      const bbProject = (await recent(`project:${bbProjectId}`, () => bb.sdk.projects.get({
        projectId: bbProjectId,
      }))) as {
        name?: string;
        sources?: { hostId: string; isDefault: boolean; path?: string }[];
      };
      // Only an explicit default source proves a home; a missing or
      // incomplete source surfaces in `mismatch` rather than guessing at
      // sources[0].
      const source =
        (bbProject.sources ?? []).find((s) => s.isDefault === true) ?? null;
      const envs = await recent(`environments:${bbProjectId}`, () => bb.sdk.environments.list({ projectId: bbProjectId }));
      const checkout =
        source?.hostId && source?.path
          ? (envs.find(
              (e) =>
                e.isWorktree !== true &&
                e.status === "ready" &&
                e.hostId === source.hostId &&
                e.path === source.path,
            ) ?? null)
          : null;
      const coordinator = project.coordinatorThreadId
        ? live.get(project.coordinatorThreadId)
        : undefined;
      const coordinatorEnv = coordinator?.environmentId
        ? envs.find((e) => e.id === coordinator.environmentId)
        : undefined;
      const mismatch = !coordinator
        ? null
        : coordinator.projectId && coordinator.projectId !== bbProjectId
          ? `runs in ${coordinator.projectId}, not the primary repository ${bbProjectId}`
          : coordinatorEnv?.isWorktree === true
            ? "runs on a worktree, not the default checkout"
            : !source
              ? "the primary repository declares no default source, so the coordinator's home cannot be proven"
              : !source.hostId || !source.path
                ? "the primary repository's default source lacks host or path, so the coordinator's home cannot be proven"
                : checkout && coordinator.environmentId !== checkout.id
                  ? `runs on a different checkout than ${checkout.name ?? checkout.path ?? checkout.id}`
                  : !checkout && coordinator.environmentId
                    ? "no ready non-worktree checkout matches the default source host and path"
                    : null;
      return {
        bbProjectId,
        hostId: source?.hostId ?? null,
        environmentId: checkout?.id ?? null,
        name: bbProject.name ?? bbProjectId,
        path: checkout?.path ?? source?.path ?? null,
        mismatch,
      };
    } catch {
      return null;
    }
  };
  const summary = (id: string): ProjectSummary => buildSummary(store, id);
  const orderedWorkers = (id: string) => {
    const workers = store.workers(id).filter((w) => w.state !== "retired");
    const seen = new Set<number>();
    const ordered: typeof workers = [];
    const visit = (w: (typeof workers)[number]) => {
      if (seen.has(w.num)) return;
      seen.add(w.num);
      ordered.push(w);
      workers.filter((child) => child.forkedFrom === w.num).forEach(visit);
    };
    workers
      .filter(
        (w) => !w.forkedFrom || !workers.some((p) => p.num === w.forkedFrom),
      )
      .forEach(visit);
    workers.forEach(visit);
    return ordered;
  };
  const memo = <T,>(build: () => T) => {
    let cached: { version: number; value: T } | null = null;
    return (): T => {
      const version = ledgerVersion();
      if (cached?.version !== version) cached = { version, value: build() };
      return cached.value;
    };
  };
  const buildTree = (): ProjectTree => ({
    version: 1,
    projects: store.projects().map((p) => ({
      ...summary(p.id),
      retired: store.workers(p.id).filter((w) => w.state === "retired").length,
      nodes: [
        {
          threadId: p.coordinatorThreadId,
          label: "Coordinator",
          role: "coordinator" as const,
          worker: null,
          parentWorker: null,
          state: p.paused ? "paused" : "coordinating",
          bbProjectId: p.memberProjectIds[0]!,
        },
        ...orderedWorkers(p.id).map((w) => ({
          threadId: w.threadId,
          label: w.label,
          role: w.role,
          worker: w.ref,
          parentWorker: w.forkedFrom ? `W${w.forkedFrom}` : null,
          state: w.state,
          bbProjectId: w.bbProjectId,
        })),
        ...store
          .projectThreads(p.id)
          .filter(
            (t) =>
              t.state !== "failed" &&
              // Explicit membership wins: a thread later adopted as a worker
              // or coordinator is emitted under that role, not twice.
              (!t.threadId ||
                store.membership(t.threadId, true)?.kind === "adhoc"),
          )
          .map((t) => ({
            threadId: t.threadId,
            label: t.label,
            role: "adhoc" as const,
            worker: null,
            parentWorker: null,
            // An associated thread carries no execution evidence of its own;
            // the sidebar reads live native status for liveness, and a
            // vanished native thread must never read as working.
            state: t.state === "active" ? "member" : t.state,
            bbProjectId: t.bbProjectId ?? p.memberProjectIds[0]!,
          })),
        ...store
          .nestedProjectThreads(p.id)
          // Nested associations follow the same precedence: an explicit
          // membership always wins over the lightweight lineage claim.
          .filter((t) => store.membership(t.threadId, true)?.kind === "adhoc")
          .map((t) => ({
            threadId: t.threadId,
            label: t.label ?? "Thread",
            role: "adhoc" as const,
            worker: null,
            parentWorker: null,
            state: "member",
            bbProjectId: t.bbProjectId ?? p.memberProjectIds[0]!,
          })),
      ],
    })),
  });
  const tree = memo(buildTree);
  const list = memo(() => store.projects().map((p) => summary(p.id)));
  const read = (
    projectId: string,
    view: ReadView,
    options: ReadOptions = readOptionsSchema.parse({}),
  ) => {
    service.requireProject(projectId);
    return readCollection(store, projectId, view, options);
  };
  const readThreads = async (projectId: string, options: ReadOptions) => {
    validateSelection("threads", options);
    return readRows((await overview(projectId)).memberThreads.map(row => ({ view: "threads", row })), options);
  };
  const membershipOf = (threadId: string) => {
    const m = store.membership(threadId);
    return m && m.project.archivedAt === null
      ? {
          projectId: m.project.id,
          name: m.project.name,
          role:
            m.kind === "adhoc"
              ? ("adhoc" as const)
              : m.workerNum === 0
                ? ("coordinator" as const)
                : m.worker!.role,
          former: m.former,
        }
      : null;
  };
  bb.rpc.register(projectsContract, {
    resetSetting: async ({ field }) => {
      await preferences.handle.experimental_set({ [field]: null });
      return { ok: true as const };
    },
    list,
    tree,
    overview: ({ projectId, detailed, detail }) =>
      overview(projectId, detail ?? (detailed === false ? "summary" : "full"), { fresh: false }),
    membership: ({ threadId }) => membershipOf(threadId),
    panel: async ({ threadId }) => {
      const membership = membershipOf(threadId);
      return {
        membership,
        summary: membership ? await overview(membership.projectId, "summary", { fresh: false }) : null,
      };
    },
    read: async ({ projectId, view, ...options }) => view === "threads" ? readThreads(projectId, options) : read(projectId, view, options),
    command: ({ projectId, command }) => {
      if (command.action === "thread-create" && "prompt" in command) {
        if (!projectId) throw new ProjectError("Pass an Initiative ID.");
        const run = () => service.createLegacyUserThread(projectId, command);
        const next = writes.then(run, run);
        writes = next.catch(() => undefined);
        return announcing(() => next, () => projectId);
      }
      return announcing(() => perform(projectId, command, "user", null), () => projectId);
    },
    inventory: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: false });
      return Promise.all(
        projects.map(async (p) => {
          // The default source identifies which environment is the provable
          // coordinator home — the create form offers only that one.
          const detail = (await bb.sdk.projects
            .get({ projectId: p.id })
            .catch(() => null)) as {
            sources?: { hostId: string; isDefault: boolean; path?: string }[];
          } | null;
          const source =
            (detail?.sources ?? []).find((s) => s.isDefault === true) ?? null;
          const home = source?.hostId && source?.path ? source : null;
          return {
            id: p.id,
            name: p.name,
            environments: (
              await bb.sdk.environments.list({ projectId: p.id })
            ).map((e) => ({
              id: e.id,
              path: e.path,
              hostId: e.hostId,
              name: e.name ?? null,
              isWorktree: e.isWorktree === true,
              status: e.status ?? "unknown",
              isDefaultHome:
                home !== null &&
                e.isWorktree !== true &&
                e.status === "ready" &&
                e.hostId === home.hostId &&
                e.path === home.path,
            })),
          };
        }),
      );
    },
  });

  // T96: read-only lifecycle and brief/handoff context for other local plugins
  // (Pooler warming, Advisor). Token auth; own store only; reads never write or wake.
  for (const [path, read] of [["/context/v1/thread", threadContext], ["/context/v1/record", recordText], ["/context/v1/initiatives", initiativesContext], ["/context/v1/members", membersContext]] as const)
    bb.http.route("GET", path, (c) => {
      const { status, body } = read(store, new URL(c.req.url).searchParams);
      return c.json(body, status);
    }, { auth: "token" });

  // Metadata is a receipt pointer, never authority by itself. The assignment
  // was recorded before spawn, and its immutable role comes from the store.
  const pendingMember = (ctx: PluginAgentConfigurationContext) => {
    const meta = ctx.pluginMetadata;
    if (!isOwnOrigin(bb.pluginId, ctx.origin.pluginId) || typeof meta.op !== "string")
      return null;
    const a = store.assignmentByOp(meta.op);
    if (
      !a ||
      a.projectId !== meta.projectId ||
      a.workerNum !== meta.worker ||
      (a.threadId !== null && a.threadId !== ctx.thread.id)
    )
      return null;
    const project = store.project(a.projectId);
    const worker = store.worker(a.projectId, a.workerNum);
    return project && worker && project.archivedAt === null
      ? { project, worker, assignment: a }
      : null;
  };
  // Erwin often answers an open question directly in an agent's chat. The
  // current coordinator or a current managed worker may record that explicit
  // answer on the existing question; it stays his choice, with the recording
  // agent kept as provenance. Former, retired, ad-hoc and foreign threads
  // cannot, and nothing here infers an answer.
  const chatAnswerRecorder = (threadId: string, projectId?: string) => {
    const m = store.membership(threadId);
    const current =
      m && !m.former && m.project.archivedAt === null &&
      (m.kind === "coordinator" ||
        (m.kind === "worker" && m.worker?.state !== "retired" && m.worker?.threadId === threadId));
    if (!current)
      throw new ProjectError("Only the current coordinator or a current worker records the user's chat answer.");
    if (projectId && projectId !== m.project.id)
      throw new ProjectError("Record answers only for questions in your own Initiative.");
    return {
      projectId: m.project.id,
      recordedBy: {
        author: m.kind === "coordinator" ? ("coordinator" as const) : ("worker" as const),
        threadId,
        assignment: m.kind === "coordinator" ? null : (store.openAssignment(m.project.id, m.workerNum)?.num ?? null),
      },
    };
  };
  const ensureMember = async (threadId: string) => {
    if (store.membership(threadId)) return;
    const meta = await bb.sdk.threads.getPluginMetadata({
      threadId,
      pluginId: bb.pluginId,
    });
    if (typeof meta.op !== "string") return;
    const a = store.assignmentByOp(meta.op);
    const thread = await bb.sdk.threads.get({ threadId });
    if (
      a &&
      a.projectId === meta.projectId &&
      a.workerNum === meta.worker &&
      isOwnOrigin(bb.pluginId, thread.originPluginId) &&
      (a.threadId === null || a.threadId === threadId)
    )
      await service.confirmCreated(a.projectId, a.num, thread);
  };
  const coordinatorTools = [
    "initiative_read",
    "initiative_message",
    "initiative_manage",
    "initiative_task",
    "initiative_delegate",
    "initiative_worker",
    "initiative_decision",
    "initiative_update",
  ];
  bb.agents.configure((ctx) => {
    const guidance = () => preferences.configuration();
    const meta = ctx.pluginMetadata;
    // A coordinator configures before its spawn response and home validation
    // land. The durable start receipt supplies its first-turn context — never
    // authority: only the validated spawn/settle/reconcile paths confirm a
    // coordinator, and mutating tools re-check confirmed membership per call.
    // A pending or unconfirmed coordinator keeps its receipt and tools but is
    // not membership, so it can never be misclaimed as a worker either.
    if (
      isOwnOrigin(bb.pluginId, ctx.origin.pluginId) &&
      meta.role === "coordinator" &&
      typeof meta.projectId === "string" &&
      typeof meta.op === "string" &&
      store.project(meta.projectId)?.coordinatorThreadId !== ctx.thread.id
    ) {
      const start = store.db
        .prepare(
          "SELECT state FROM coordinator_starts WHERE project_id=? AND op_id=?",
        )
        .get(meta.projectId, meta.op) as { state: string } | undefined;
      // Configure observed this native candidate for a live receipt: retain
      // its thread id as positive evidence so a later "never sent" settlement
      // cannot contradict it. This is not authority — the state stays pending
      // or uncertain and no membership or coordinator pointer is written.
      if (start && ["pending", "uncertain"].includes(start.state))
        store.db
          .prepare(
            "UPDATE coordinator_starts SET thread_id=? WHERE project_id=? AND op_id=? AND state IN ('pending','uncertain') AND (thread_id IS NULL OR thread_id=?)",
          )
          .run(ctx.thread.id, meta.projectId, meta.op, ctx.thread.id);
      return {
        tools: coordinatorTools,
        skills: ["initiative-coordinator"],
        instructions: guidance().coordinatorInstructions + "\n\n" + (
          start && ["pending", "uncertain"].includes(start.state)
            ? `You are the pending coordinator of this initiative. Your start receipt is recorded but this thread's checkout is still being proven against the primary repository's default source. Read initiative state once this thread is confirmed; until then, Initiative reads and mutations require confirmed membership. If membership is unavailable, leave confirmation and settlement to the operator. Do not retry the start.`
            : `Your coordinator start did not confirm (state ${start?.state ?? "unknown"}). Initiative reads and mutations require confirmed membership. Leave settlement to the operator. Do not retry the start.`),
      };
    }
    // A user thread can configure before the create RPC's own confirm lands.
    if (
      isOwnOrigin(bb.pluginId, ctx.origin.pluginId) &&
      meta.role === "adhoc" &&
      typeof meta.projectId === "string" &&
      typeof meta.op === "string"
    ) {
      const record = store.projectThreadByOp(meta.op);
      if (record && record.projectId === meta.projectId)
        store.confirmProjectThread(meta.op, ctx.thread.id);
    }
    const m = store.membership(ctx.thread.id);
    if (m?.kind === "adhoc")
      // The user's own thread: project read access on its first turn, and an
      // explicit update only when they ask. Never a managed role or workflow.
      return m.project.archivedAt === null
        ? {
            tools: ["initiative_read", "initiative_update"],
            skills: [],
            instructions: `This is the user's own thread in the "${m.project.name}" initiative, not a managed worker. Read its state with initiative_read. Record an initiative_update only when the user asks you to share an outcome. You have no assignment, report or coordinator duties.`,
          }
        : {
            tools: ["initiative_read"],
            skills: [],
            instructions: `This thread belongs to the archived "${m.project.name}" initiative. You may read its state with initiative_read; there is nothing to update.`,
          };
    if (m?.project.archivedAt !== null && m)
      return { tools: ["initiative_create"], skills: [] };
    if (m?.former)
      return {
        tools: ["initiative_read"],
        skills: [],
        instructions:
          "This is a former context. Read initiative state, but leave coordination and reporting to the current threads.",
      };
    if (m?.workerNum === 0)
      return { tools: coordinatorTools, skills: ["initiative-coordinator"], instructions: guidance().coordinatorInstructions + "\n\n" + `Current Initiative membership: ${JSON.stringify(currentIdentity(store, m))}` };
    const worker = m?.worker ?? pendingMember(ctx)?.worker;
    const work = m?.worker ? workerWork(store, m.project.id, m.worker.num, m.worker.generation).assignments[0] : null;
    if (worker)
      return {
        tools: ["initiative_read", "initiative_report", "initiative_progress", "initiative_decision", "initiative_message"],
        skills: ["initiative-worker"],
        instructions: guidance().workerInstructions + "\n\n" + (m && !m.former ? `Current membership: ${worker.ref}, generation ${worker.generation}, role ${worker.role}, assignment ${work?.ref ?? "none unfinished"}${work ? `, tasks ${work.tasks.join(", ") || "review"}` : ""}. Trust this membership over inherited fork headers; reads do not grant messaging authority.\n` : `Pending worker ${worker.ref}; confirmed membership is required for messaging.\n`) + `Your immutable role is ${worker.role}. ${worker.role === "review" ? "Review and report findings. Delegate implementation fixes back to the coordinator." : "Follow your assignment's declared access and report its verification."}`,
      };
    return { tools: ["initiative_create"], skills: [] };
  });
  // New configurations advertise canonical names only. Retained native sessions
  // may still call their already-constructed old allowlist; no runtime restart.
  const registerTool: typeof bb.agents.registerTool = (tool: Parameters<typeof bb.agents.registerTool>[0]) => {
    const definition: typeof tool = {
      ...tool,
      execute: (input, context) => announcing(() => tool.execute(input, context), () => projectOf(context.threadId)),
    };
    bb.agents.registerTool(definition);
    const suffix = definition.name.replace(/^initiative_/, "");
    if (!LEGACY_TOOL_NAMES.includes(suffix as typeof LEGACY_TOOL_NAMES[number])) return;
    bb.agents.registerTool({
      ...definition,
      name: `project_${suffix}`,
      description: `Retained-session compatibility only. Use initiative_${suffix} after natural session construction.`,
      ...(suffix === "report" ? {
        parameters: legacyReportSchema.safeExtend({ assignment: z.string().optional() }),
        execute: async (input: any, context: any) => {
          const { proposedKnowledge, ...current } = input;
          const result = await definition.execute(current, context);
          if (proposedKnowledge?.length) store.archiveLegacyPayload(context.threadId, input);
          return result;
        },
      } : suffix === "read" ? {
        parameters: agentReadSchema.extend({ view: z.enum(["overview", "records", ...READ_VIEWS, "knowledge"]).optional() }).strict(),
        execute: async (input: any, context: any) => {
          const current = { ...input, view: input.view === "knowledge" ? "decisions" : input.view };
          // Older constructed schemas inserted overview and no-op defaults.
          // Normalize only this known legacy shape; real conflicts still fail.
          if (current.view === "overview" && current.refs) current.view = undefined;
          else if (current.view === "overview") {
            if (current.offset === 0) delete current.offset;
            if (current.limit === 20) delete current.limit;
            if (current.detailed === false) delete current.detailed;
          }
          return definition.execute(current, context);
        },
      } : {}),
    } as Parameters<typeof bb.agents.registerTool>[0]);
  };
  // A cached obsolete publisher must fail visibly; it cannot write legacy rows.
  bb.agents.registerTool({
    name: "project_knowledge",
    description: "Removed publisher. Use initiative_decision for lightweight user and agent choices.",
    parameters: z.record(z.string(), z.unknown()),
    execute: async () => { throw new ProjectError("This publisher was removed. Use initiative_decision for lightweight user and agent choices. Retained sessions can use bb initiative command without restarting."); },
  });
  const registerCommands = (
    name: string,
    parameters: z.ZodType<Command>,
    description: string,
  ) => {
    // Published as plain JSON with an object root (Claude blanks union roots); the strict
    // command schema still parses every call first, as the host parsed it before.
    const options = "options" in parameters ? (parameters as unknown as { options: readonly z.ZodType[] }).options : null;
    registerTool({
      name,
      parameters: options ? objectRootSchema(options) : z.toJSONSchema(parameters, { io: "input" }) as Record<string, unknown>,
      description,
      async execute(raw, { threadId }) {
        const parsed = parameters.safeParse(raw);
        if (!parsed.success) throw new ProjectError(`Invalid arguments for ${name}: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ")}`);
        const input = parsed.data;
        if (!threadId)
          throw new ProjectError("Use Initiative tools from a BB thread.");
        await ensureMember(threadId);
        const p = service.coordinatorOf(threadId);
        return JSON.stringify(
          await perform(p.id, input, "coordinator", threadId),
        );
      },
    });
  };
  registerTool({
    name: "initiative_create",
    description:
      "Start a durable initiative across BB repositories. Create an Opus coordinator or adopt this thread. Existing native tools remain available.",
    parameters: createSchema,
    execute: async (input, { threadId }) =>
      JSON.stringify(await perform(undefined, input, "user", threadId ?? null)),
  });
  registerCommands(
    "initiative_manage",
    z.discriminatedUnion("action", [...manageCommands]),
    "Manage the initiative, pause new work, stop workers, or replace the coordinator using its checkpoint. To hand over to a fresh coordinator at the end of your own turn, use coordinator-handover with a checkpoint; the request is durable and the replacement starts once you go idle. Pausing leaves running work alone.",
  );
  registerCommands(
    "initiative_task",
    z.discriminatedUnion("action", [...taskCommands]),
    "Create/brief actual tasks. task-checkpoint takes task, worker, optional matching assignment and a complete report with checked handoff revision; record external/native work without waking the worker or accepting it. Use bb initiative describe task-checkpoint for a valid example. Reviews bind actual task/assignment/revision; never borrow an unrelated task. task-accept remains explicit. Stop/uncertain receipts still need native inspection; retire separately once idle. assignment-scope-release frees a write scope held only by a report's listed, unverified background work, after you checked it and BB shows the thread ended; echo the reportVersion you read (initiative_read shows it); it keeps the report and is not evidence the jobs finished.",
  );
  registerCommands(
    "initiative_delegate",
    delegateSchema,
    "Delegate fresh, continue or fork with complete scoped tasks, logical label/purpose and execution settings. Fresh creates one native child and assignment; existing native children remain valid visible members. Reviews bind reviewTargets [{task,assignment,revision}] to the successful final report/checkpoint and actual implementer; reviewOf must agree. Tasks/status alone cannot invent implemented work. Continue delivery steer is for urgent correction/blocker, queue (default) is future work; BB owns any native queueing. Native sender provenance is recorded where the SDK supports it. profile.serviceTier accepts default|fast; fresh and continue pass it natively, fork inherits its source's last model/reasoning/tier and rejects incompatible overrides. Pass permissionMode accept-edits|auto|full explicitly where instructed. Declare access read-only for each audit, including continue/fork; omitted work may write and reviewers stay read-only. Readers may overlap readers/writers, overlapping writers remain blocked. This is coordination, not a filesystem sandbox: full permissions still forbid source/install writes for audits, which must identify actual source state checked amid live edits. Explicit user/task and Initiative profiles win over plugin Settings defaults. handoffs:[\"A#\"] (max 3) embeds prior reports' standard handoffs in a work brief, bounded, with provenance and evidence pointers; each must cover the tasks, their dependsOn or contextRefs, and transfers no authority, acceptance, receipts, permissions or write scope. Follow the configured coordinator guidance for communication, handoffs, retirement, scoped context and milestone reviews.",
  );
  registerCommands(
    "initiative_worker",
    z.discriminatedUnion("action", [...workerCommands]),
    "Adopt an existing thread or retire a worker. Retirement is explicit and guarded: the thread must be idle with no queued work, background agents or live descendants, and the worker's assignments must all be settled. Its reports stay readable as standard handoffs for later fresh work (initiative_delegate handoffs).",
  );
  registerTool({
    name: "initiative_decision",
    // Plain JSON Schema with an object root: Claude's bridge blanks union roots. Validation is
    // parseDecisionCommand, shared with the CLI, so every refusal carries a valid example.
    parameters: decisionToolJsonSchema as Record<string, unknown>,
    description: "Record Initiative choices and questions with flat fields. The log is the user's steering record: record significant choices for the user; never consult it for your own work. decision: {action:\"decision\",madeBy:\"user\"|\"agent\",description,supersedes?:\"D7\"}. Choose madeBy explicitly; it is never defaulted: user for the user's explicit choice (the recorder is only provenance; leave out agent-added defaults), agent only for independently chosen, non-obvious significant design forks, not normal steps, checks, restatements, mandated work, routine reporting, audit/review setup and requested clean SHA/execution settings. One or two sentences, no quotes. Agent choices already reach the user's Inbox for Okay/Not okay. question (coordinators only, for a choice work waits on): {action:\"question\",question,context,options?:[\"label\" or {label,consequences}],recommendation?,blocksTaskIds?}; never infer questions from transcript prose. answer, only for the user's explicit answer to an open question: {action:\"answer\",ref:\"D12\",choice,note?}; never infer one. Worker answers notify the coordinator unless notify:false; coordinator answers stay quiet. cleanup, only for the current coordinator on the user's explicit request: {action:\"cleanup\",ref:\"D13\",operation:\"accept\"|\"veto\"|\"remove\",reason}; user choices and questions are protected, removal keeps history, never silence Inbox. withdraw, only for the current coordinator's own open question that no longer needs the user: {action:\"withdraw\",ref:\"D12\",reason}; it records no answer, keeps history and releases only that question's tasks. Older nested decision:{...}/question:{...} payloads still work. Examples: bb initiative describe <action>.",
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Record decisions from an Initiative thread.");
      await ensureMember(threadId);
      const input = parseDecisionCommand(raw);
      if (input.action === "answer") {
        const { projectId, recordedBy } = chatAnswerRecorder(threadId);
        const answered = await service.answerOpinion(projectId, input.decision, input, recordedBy);
        return JSON.stringify({ ref: answered.ref, description: answered.description, madeBy: answered.madeBy, status: answered.status, recordedBy, notification: answered.notification });
      }
      const { projectId, recordedBy: provenance } = chatAnswerRecorder(threadId);
      let result;
      if (input.action === "question") {
        if (provenance.author !== "coordinator") throw new ProjectError("Ask blocking user questions through the coordinator.");
        result = service.recordQuestion(projectId, input.question, provenance);
      } else if (input.action === "decision-cleanup") {
        if (provenance.author !== "coordinator") throw new ProjectError("Only the current coordinator may clean up agent decisions on an explicit user request.");
        result = await service.cleanupDecision(projectId, input.decision, input.operation, input.reason, threadId);
      } else if (input.action === "question-withdraw") {
        const withdrawn = service.withdrawQuestion(projectId, input.decision, input.reason, provenance);
        const body = withdrawn.body as { question?: string };
        return JSON.stringify({ ref: withdrawn.ref, status: withdrawn.status, madeBy: withdrawn.madeBy, question: body.question ?? withdrawn.title,
          resolution: withdrawn.body.resolution, recordedBy: withdrawn.provenance, notification: withdrawn.notification,
          tasks: withdrawn.blocks.map(num => store.task(projectId, num)).filter(task => task !== null).map(task => ({ ref: task.ref, status: task.status, progress: task.progress })) });
      } else result = service.recordDecision(projectId, input, provenance);
      return JSON.stringify({ ref: result.ref, description: result.description, madeBy: result.madeBy, status: result.status, review: result.review, cleanupHistory: result.body.cleanupHistory, recordedBy: result.provenance });
    },
  });
  registerTool({
    name: "initiative_update",
    description:
      "Publish a concise, self-contained update: what changed, what is happening next, blockers and decisions. Write for a human who has not read the implementation threads. Save a checkpoint when useful.",
    parameters: updateSchema,
    async execute(input, { threadId }) {
      if (!threadId)
        throw new ProjectError("Publish updates from an initiative thread.");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (!m || m.former || (m.workerNum !== 0 && m.workerNum !== -1))
        throw new ProjectError(
          "Publish updates from the coordinator or the user's own initiative thread.",
        );
      return JSON.stringify(
        await perform(
          m.project.id,
          input,
          m.workerNum === 0 ? "coordinator" : "user",
          threadId,
        ),
      );
    },
  });
  registerTool({
    name: "initiative_message",
    parameters: messageSchema,
    description: "Send one native message to a current W# work peer or coordinator in your Initiative. Example {target:\"W4\",text:\"The agreed RPC is ready; see the contract artifact.\",mode:\"queue\"}. Use steer for urgent blockers/corrections, queue for future facts. Sender comes from actual caller membership. No work grant, role change, resume, retry or separate inbox. Independent reviewers communicate through coordinator. Finished/stopped/cancelled/former/retired threads are refused. Return the actual native receipt and resolved thread/generation; inspect uncertain errors before another send. Retained sessions: bb initiative message '<json>'.",
    async execute(input, { threadId }) {
      if (!threadId) throw new ProjectError("Message from a current managed Initiative thread.");
      await ensureMember(threadId);
      return JSON.stringify(await service.message(threadId, input));
    },
  });
  registerTool({
    name: "initiative_read",
    description: "Read compact Initiative state or exactly selected records. Refs-only infers mixed T/W/A/D/U collections: {refs:[\"A7\",\"T3\"],detailed:true}. Explicit view must agree with refs. Collection pages default to summaries with total/nextOffset/missingRefs/truncated; limit1..30. For a selective report: {view:\"assignments\",refs:[\"A7\"],detailed:true,fields:[\"report.handoff\",\"report.evidence\"]}. A reported assignment's standard handoff (outcome, revisions, files, checks, artifacts, open issues, next steps, dirty and background state): {refs:[\"A7\"],detailed:true,fields:[\"standardHandoff\"]}. Full native inventory/telemetry require view threads/usage; dashboard RPC stays separate. Oversized records need field selection; JSON is never clipped. Reading never wakes agents.",
    parameters: agentReadSchema,
    async execute(input, { threadId }) {
      if (!threadId) throw new ProjectError("Use initiative_read from an Initiative thread.");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (!m) throw new ProjectError("This thread does not belong to an Initiative.");
      const { view, ...rawOptions } = input;
      const options = readOptionsSchema.parse(rawOptions);
      if (view === "overview" && Object.keys(rawOptions).length)
        throw new ProjectError("overview has no refs/detail/pagination selectors. Omit view for refs, or select a collection such as assignments, threads or usage.");
      if (!view && !options.refs && Object.keys(rawOptions).length)
        throw new ProjectError("Specify view or refs for detail/pagination selectors, for example view:assignments, limit:5.");
      if (!view && options.refs || view === "records") return JSON.stringify(readRefs(store, m.project.id, options));
      if (!view || view === "overview") return JSON.stringify(compactOverview(store, m.project.id));
      if (view === "threads") return JSON.stringify(await readThreads(m.project.id, options));
      return JSON.stringify(read(m.project.id, view, options));
    },
  });

  registerTool({
    name: "initiative_report",
    description:
      "Record the assignment outcome, exact checked revision, evidence and a bounded handoff. Record implementation choices in a linked artifact and list background work and unverified checks. Follow the configured worker guidance for communication and completion; native notification/fallback delivery stays in place. Idle is not a report.",
    parameters: reportSchema.safeExtend({ assignment: z.string().optional() }),
    async execute(input, { threadId }) {
      if (!threadId) throw new ProjectError("Report from the worker thread.");
      await ensureMember(threadId);
      const result = await service.report(threadId, input);
      return JSON.stringify(result);
    },
  });
  registerTool({
    name: "initiative_progress",
    description:
      "Record assigned work's human-readable progress and next checkpoint without waking agents. Follow the configured worker guidance for actionable native communication and routine phases. Note decision forks.",
    parameters: z
      .object({
        note: z.string().trim().min(1).max(2000),
        nextCheckpoint: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    async execute(input, { threadId }) {
      if (!threadId)
        throw new ProjectError("Report progress from the worker thread.");
      await ensureMember(threadId);
      const result = service.progress(threadId, input);
      return JSON.stringify(result);
    },
  });

  bb.cli.register({
    name: "initiative",
    summary: "Durable initiatives, worker lifecycles, decisions and overview",
    commands: [
      { name: "message", summary: "One native current-peer/coordinator message; no work grant, retry or resume", usage: "bb initiative message '{\"target\":\"W4\",\"text\":\"Interface fact\",\"mode\":\"queue\"}'" },
      { name: "describe", summary: "Show valid short JSON examples for reads, checkpoints, reviews and questions", usage: "bb initiative describe [read|task-checkpoint|review|question|answer|quiet-answer|decision|supersede|reject|scope-release|urgent-continue|fresh-with-handoff|decision-cleanup|withdraw|message]" },
      { name: "list", summary: "List initiatives", usage: "bb initiative list" },
      {
        name: "overview",
        summary: "Read the four-part initiative overview",
        usage: "bb initiative overview [initiative-id]",
      },
      {
        name: "read",
        summary: "Read a stored collection",
        usage:
          "bb initiative read <records|tasks|workers|assignments|decisions|inbox|updates|activity|usage|threads> [initiative-id] [options-json]; records takes mixed refs; inbox is historical rows only",
      },
      {
        name: "command",
        summary: "Run typed Initiative JSON. Decisions require madeBy: user for explicit user choices, agent only for significant independent forks; exclude routine steps/setup and agent-added defaults. Answers notify by default, notify:false is quiet; coordinator chat stays quiet. Current coordinator decision-cleanup accept/veto/remove requires an explicit user request/reason, retains history and never self-notifies. withdraw retracts the current coordinator's own open question with a reason and records no answer. profile.serviceTier accepts default|fast",
        usage: "bb initiative command '<json>' [initiative-id]",
      },
      {
        name: "report",
        summary: "Report from the current worker thread",
        usage: "bb initiative report '<json>'",
      },
      {
        name: "reconcile",
        summary: "Reconcile uncertain operations using native receipts",
        usage: "bb initiative reconcile",
      },
    ],
    run: (argv, ctx) => announcing(async () => {
      try {
        const args = argv.filter((a) => a !== "--json");
        const [action, value, explicitId] = args;
        if (ctx.threadId) await ensureMember(ctx.threadId);
        const member = ctx.threadId ? store.membership(ctx.threadId) : null;
        const id = explicitId ?? member?.project.id;
        let result: unknown;
        if (action === "describe" && args.length <= 2) {
          if (!value) result = { commands: Object.keys(COMMAND_EXAMPLES), reads: READ_EXAMPLES, note: "bb initiative describe <name>; replace fixture refs/revision with actual recorded work." };
          else if (value === "read") result = READ_EXAMPLES;
          else if (value in COMMAND_EXAMPLES) result = COMMAND_EXAMPLES[value as keyof typeof COMMAND_EXAMPLES];
          else throw new ProjectError(`Unknown example ${value}. Use bb initiative describe for available names.`);
        } else if (action === "list" && args.length === 1)
          result = store.projects().map((p) => summary(p.id));
        else if (action === "overview" && args.length <= 2)
          result = ctx.threadId ? compactOverview(store, value ?? member?.project.id ?? "") : await overview(value ?? member?.project.id ?? "");
        else if (action === "read" && args.length <= 4) {
          const view = z.enum(["records", ...READ_VIEWS]).parse(value);
          const options = readOptionsSchema.parse(args[3] ? JSON.parse(args[3]) : {});
          result = view === "records" ? readRefs(store, id ?? "", options)
            : view === "threads" ? await readThreads(id ?? "", options)
            : read(id ?? "", view, options);
        } else if (action === "message" && value && args.length === 2) {
          if (!ctx.threadId) throw new ProjectError("Message from a current managed Initiative thread.");
          result = await service.message(ctx.threadId, messageSchema.parse(JSON.parse(value)));
        } else if (action === "command" && value && args.length <= 3) {
          const command = parseCommandInput(JSON.parse(value));
          if (
            ctx.threadId &&
            ["acknowledge", "decision-review", "question-close"].includes(command.action)
          )
            throw new ProjectError(
              "This action needs the user in the Initiative panel.",
            );
          if (command.action === "message") {
            if (!ctx.threadId) throw new ProjectError("Message from a current managed Initiative thread.");
            result = await service.message(ctx.threadId, command, id);
          } else if (ctx.threadId && command.action === "answer") {
            const { projectId, recordedBy } = chatAnswerRecorder(ctx.threadId, id);
            result = await service.answerOpinion(projectId, command.decision, command, recordedBy);
          } else if (ctx.threadId && command.action === "decision" && member?.workerNum !== 0) {
            const { projectId, recordedBy } = chatAnswerRecorder(ctx.threadId, id);
            result = service.recordDecision(projectId, command, recordedBy);
          } else {
            if (ctx.threadId && command.action !== "create") {
              if (!member || member.former || member.workerNum !== 0)
                throw new ProjectError("Only the current initiative coordinator manages work from an agent CLI.");
              if (id !== member.project.id)
                throw new ProjectError("A coordinator cannot manage another initiative through its agent CLI.");
            }
            result = await perform(id, command, ctx.threadId ? "coordinator" : "user", ctx.threadId ?? null);
          }
        } else if (
          action === "report" &&
          value &&
          args.length === 2 &&
          ctx.threadId
        ) {
          result = await service.report(
            ctx.threadId,
            reportSchema
              .safeExtend({ assignment: z.string().optional() })
              .parse(JSON.parse(value)),
          );
        } else if (action === "reconcile" && args.length === 1) {
          result = await service.reconcile();
        } else
          throw new ProjectError(
            "Usage: bb initiative list | overview [id] | read <view> [id] | message '<json>' | command '<json>' [id] | report '<json>' | reconcile",
          );
        const stdout = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(stdout) > 900_000)
          throw new ProjectError(
            "Result too large. Read a narrower collection or use the Initiative panel.",
          );
        return { exitCode: 0, stdout };
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      }
    }, () => projectOf(ctx.threadId)),
  });
  const event = scopedNativeEvent(store, changed);
  bb.events.on(
    "thread.idle",
    event(({ thread }) => runtime.onThreadIdle(thread)),
  );
  bb.events.on(
    "thread.failed",
    event(({ thread, error }) => runtime.onThreadFailed(thread, error)),
  );
  bb.events.on(
    "thread.archived",
    event(({ thread }) => runtime.onThreadArchived(thread)),
  );
  bb.events.on(
    "thread.deleted",
    event(({ thread }) => runtime.onThreadArchived(thread)),
  );
  // Discovery memory only: a created child or an unarchived thread may sit under
  // a member parent the sweep had stopped listing, which must now be listed. Only
  // member threads are recorded. No SDK call, ledger write or association.
  const invalidateMembers = (...threadIds: (string | null | undefined)[]) => {
    const members = threadIds.filter((id): id is string => !!id && store.membership(id, true) !== null);
    if (members.length) service.discovery.invalidate(...members);
  };
  bb.events.on("thread.created", ({ thread }) => invalidateMembers(thread.parentThreadId));
  bb.events.on("thread.unarchived", ({ thread }) => {
    invalidateMembers(thread.id, thread.parentThreadId);
    service.threadUnarchived(thread.id);
  });
  // Lifecycle events carry the current DTO: keep dashboard facts current.
  for (const name of ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.unarchived", "thread.deleted"] as const)
    bb.events.on(name, ({ thread }) => liveThreads.observe(thread));
  bb.events.on(
    "message.dispatched",
    event(({ entry }) => runtime.onMessageDispatched(entry.id)),
  );
  bb.events.on(
    "message.cancelled",
    event(({ entry }) => runtime.onMessageCancelled(entry.id)),
  );
  bb.background.service("initiatives-sweep", {
    async start(signal) {
      runtime.start(signal);
      try {
        while (!signal.aborted) {
          const before = ledgerVersion();
          await runtime.sweep(signal);
          if (signal.aborted) break;
          if (ledgerVersion() !== before) changed();
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, SWEEP_INTERVAL_MS);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      } finally {
        runtime.dispose();
      }
    },
  });
  // Tests drive commands as an entry point would, announcement included.
  const command = (...args: Parameters<typeof perform>) => announcing(() => perform(...args), () => args[0]);
  return { service, store, runtime, perform: command, overview, tree, preferences };
}
