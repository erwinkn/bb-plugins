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
  parseCommandInput,
  parseDecisionCommand,
  refuseRemoved,
  REMOVED_ACTIONS,
  updateSchema,
  runCommand,
  type Command,
} from "./lib/commands";
import {
  advertisedSchema,
  manageCommand,
  manageToolSchema,
  messageCommand,
  messageToolAdvertised,
  messageToolSchema,
  reportToolSchema,
  spawnCommand,
  spawnToolSchema,
  taskCommand,
  taskToolSchema,
  updateToolSchema,
  workerCommand,
  workerToolSchema,
} from "./lib/agent-tools";
import { legacyReportSchema, LEGACY_TOOL_NAMES } from "./lib/legacy";
import { reportSchema } from "./lib/schema";
import { definePreferences } from "./lib/settings";
import { WriteReceipts } from "./lib/write-receipts";
import { CHAT_MEMORY_PLUGIN_ID } from "./lib/memory-scopes";
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
import { MergeQueueCache } from "./lib/merge-queue-server";
import { canonicalPrUrl, prToolSchema } from "./lib/pr-stages";
import { AssignedPrs, COORDINATOR, recordPrs, type PrCaller } from "./lib/pr-records";
import { branchThreadId } from "./lib/merge-queue";
import { prSummary } from "./lib/pr-map";
import { notDeliveredMessages, queueTargets } from "./lib/not-delivered";
import { COMMAND_EXAMPLES, DESCRIBE_GROUPS, READ_EXAMPLES } from "./lib/examples";

const CLI_COMMANDS = ["describe", "list", "overview", "read", "message", "command", "report", "pr", "reconcile", "recreate-coordinators"];
/** Tools initiative_batch can run, by their name without the initiative_ prefix. */
const BATCH_TOOLS = ["spawn", "message", "task", "worker", "decision", "update", "pr", "read"] as const;
const CLI_USAGE = "Usage: bb initiative describe [name] | list | overview [id] | read <view> [id] [options-json] | message '<json>' | command '<json>' [id] | report '<json>' | pr '<json>' [id] | reconcile | recreate-coordinators (--all | <id>...) [--dry-run] [--wait=<s>]";
import { decisionToolJsonSchema } from "./lib/decision-input";
import { toolReceipt } from "./lib/receipts";
import { ProjectError, errorMessage } from "./lib/bb";
import { isOwnOrigin } from "./lib/identity";
import { scopedNativeEvent } from "./lib/native-events";
import { initiativesContext, membersContext, recordText, threadContext } from "./lib/context";
import { messageSchema, currentIdentity, workerWork } from "./lib/messaging";
import {
  readCollection, readContext, readRefs, readRows, compactOverview, agentReadSchema, validateSelection, withImpliedDetail,
  readOptionsSchema,
  READ_VIEWS,
  MAX_READ_BYTES,
  type ReadOptions,
  type ReadView,
} from "./lib/read";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const preferences = definePreferences(bb, { has: (key) => store.hasFlag(key), set: (key) => store.setFlag(key) });
  const service = new ProjectsService(bb, store, preferences);
  const runtime = new Runtime(service);
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
  // W244, W248: a dashboard write sent again after its answer was lost runs once.
  const receipts = new WriteReceipts(db, ledgerVersion);
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
    options = withImpliedDetail(options);
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
  const assignedPrs = new AssignedPrs(store);
  const mergeQueue = new MergeQueueCache({
    memberProjectIds: (projectId) => service.requireProject(projectId).memberProjectIds,
    project: async (bbProjectId) => {
      const p = await bb.sdk.projects.get({ projectId: bbProjectId });
      return { name: p.name, gitRemoteUrl: p.gitRemoteUrl ?? null };
    },
    workers: (projectId) =>
      new Map(store.workers(projectId).flatMap((w) => (w.threadId ? [[w.threadId, w.ref] as const] : []))),
    prRecords: (projectId) => store.prRecords(projectId),
    assignedPrs: (projectId) => assignedPrs.read(projectId),
    notes: (projectId) => service.prNotes.summaries(projectId),
  }, undefined, undefined,
  // D441: reads never wait on GitHub; a finished fetch tells the dashboards to read again.
  (repo) => bb.realtime.publish("merge-queue-changed", { repo }));
  bb.rpc.register(projectsContract, {
    mergeQueue: ({ projectId, refresh }) => mergeQueue.read(projectId, { refresh }),
    prNotes: ({ projectId, url }) => {
      service.requireProject(projectId);
      const key = canonicalPrUrl(url);
      if (!key) throw new ProjectError("Expected a GitHub PR URL.");
      return service.prNotes.list(projectId, key);
    },
    resetSetting: async ({ field }) => {
      await preferences.handle.experimental_set({ [field]: null });
      return { ok: true as const };
    },
    list,
    tree,
    overview: ({ projectId, detailed, detail }) =>
      overview(projectId, detail ?? (detailed === false ? "summary" : "full"), { fresh: false }),
    membership: ({ threadId }) => membershipOf(threadId),
    reportReadTimeout: ({ read, ...r }) => {
      bb.log.warn(
        `An Initiatives ${read} read timed out in a client: elapsedMs=${r.elapsedMs} hidden=${r.hidden} online=${r.online} sinceVisibleMs=${r.sinceVisibleMs} hiddenDuringRead=${r.hiddenDuringRead}`,
      );
      return { ok: true as const };
    },
    panel: async ({ threadId }) => {
      const membership = membershipOf(threadId);
      return {
        membership,
        summary: membership ? await overview(membership.projectId, "summary", { fresh: false }) : null,
      };
    },
    read: async ({ projectId, view, ...options }) => view === "threads" ? readThreads(projectId, options) : read(projectId, view, options),
    command: ({ projectId, command, key }) => {
      const write = () => {
        if (command.action === "thread-create" && "prompt" in command) {
          if (!projectId) throw new ProjectError("Pass an Initiative ID.");
          const run = () => service.createLegacyUserThread(projectId, command);
          const next = writes.then(run, run);
          writes = next.catch(() => undefined);
          return announcing(() => next, () => projectId);
        }
        return announcing(() => perform(projectId, command, "user", null), () => projectId);
      };
      // A keyed write answers with a WriteAnswer, which sendWrite unwraps.
      return key ? receipts.run(key, { projectId, command }, async () => write()) : write();
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
    "initiative_spawn",
    "initiative_message",
    "initiative_task",
    "initiative_worker",
    "initiative_decision",
    "initiative_update",
    "initiative_manage",
    "initiative_pr",
    "initiative_batch",
  ];
  bb.agents.configure((ctx) => {
    const guidance = () => preferences.configuration();
    const meta = ctx.pluginMetadata;
    // T136: the short-lived handover writer gets no Initiative tools; its prompt is everything it needs.
    // This plugin's metadata namespace is its own, so only its writer can carry this role.
    if (meta.role === "handover-writer") return { tools: [], skills: [] };
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
        instructions: [
          guidance().coordinatorInstructions,
          start && ["pending", "uncertain"].includes(start.state)
            ? `You are the pending coordinator of this initiative. Your start receipt is recorded but this thread's checkout is still being proven against the primary repository's default source. Read initiative state once this thread is confirmed; until then, Initiative reads and mutations require confirmed membership. If membership is unavailable, leave confirmation and settlement to the operator. Do not retry the start.`
            : `Your coordinator start did not confirm (state ${start?.state ?? "unknown"}). Initiative reads and mutations require confirmed membership. Leave settlement to the operator. Do not retry the start.`,
        ].join("\n\n"),
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
      // T145: the memory tools, guidance and turn hook come from the Chat memory plugin.
      return {
        tools: coordinatorTools,
        skills: ["initiative-coordinator"],
        instructions: [guidance().coordinatorInstructions, `Current Initiative membership: ${JSON.stringify(currentIdentity(store, m))}`].join("\n\n"),
      };
    const worker = m?.worker ?? pendingMember(ctx)?.worker;
    const work = m?.worker ? workerWork(store, m.project.id, m.worker.num, m.worker.generation).assignments[0] : null;
    if (worker)
      return {
        tools: ["initiative_read", "initiative_report", "initiative_message", "initiative_decision", "initiative_pr"],
        skills: ["initiative-worker"],
        instructions: guidance().workerInstructions + "\n\n" + `You are ${worker.ref} "${worker.label}" (${worker.area}), role ${worker.role}${m && !m.former ? "" : " (membership still being confirmed)"}.`,
      };
    return { tools: ["initiative_create"], skills: [] };
  });
  // New configurations advertise canonical names only. Retained native sessions
  // may still call their already-constructed old allowlist; no runtime restart.
  // One "parse, then handle" per tool, shared by the tool itself and initiative_batch,
  // so a batched action gets exactly the tool's validation. Every tool publishes plain,
  // slim JSON Schema (advertisedSchema, T143); zod parameters are parsed here, and tools
  // that publish JSON Schema parse inside their own execute.
  type ToolExecute = Parameters<typeof bb.agents.registerTool>[0]["execute"];
  const handlers = new Map<string, ToolExecute>();
  /**
   * T143: the tools Claude Code loads upfront rather than behind ToolSearch (Erwin's choice),
   * through the fork's alwaysLoad (MCP _meta "anthropic/alwaysLoad"). Older SDK types lack the
   * field and an older BB ignores it, so it is spread in untyped.
   */
  const UPFRONT = ["initiative_read", "initiative_message", "initiative_spawn", "initiative_batch"];
  const registerTool: typeof bb.agents.registerTool = (tool: Parameters<typeof bb.agents.registerTool>[0]) => {
    const schema = typeof (tool.parameters as { safeParse?: unknown }).safeParse === "function" ? tool.parameters as unknown as z.ZodType : null;
    const run: ToolExecute = (input, context) => tool.execute(schema ? parsed(schema, input, tool.name) : input, context);
    handlers.set(tool.name, run);
    const definition: typeof tool = {
      ...tool,
      parameters: advertisedSchema(tool.parameters),
      execute: (input, context) => announcing(() => run(input, context), () => projectOf(context.threadId)),
    };
    bb.agents.registerTool({ ...definition, ...(UPFRONT.includes(definition.name) ? { alwaysLoad: true } : {}) });
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
  // T145 (A469): sessions built while this plugin owned the memory know initiative_zoom and
  // initiative_read {view:"memory"}. Both stay, read only, over the Chat memory plugin's RPCs;
  // configure never selects initiative_zoom, so new sessions use memory_zoom.
  const chatMemory = <T>(method: "read" | "zoom", input: { threadId: string; id?: number; n?: number }, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: CHAT_MEMORY_PLUGIN_ID, method, input, outputSchema });
  registerTool({
    name: "initiative_zoom",
    description: "Retained-session compatibility only. Use memory_zoom after natural session construction.",
    parameters: z.object({ id: z.number().int().min(0), n: z.number().int().min(1) }).strict(),
    execute: async ({ id, n }, { threadId }) => {
      if (!threadId) throw new ProjectError("Use initiative_zoom from a thread with chat memory.");
      return chatMemory("zoom", { threadId, id, n }, z.string());
    },
  });
  // A cached obsolete publisher must fail visibly; it cannot write legacy rows.
  bb.agents.registerTool({
    name: "project_knowledge",
    description: "Removed publisher. Use initiative_decision for lightweight user and agent choices.",
    parameters: z.record(z.string(), z.unknown()),
    execute: async () => { throw new ProjectError("This publisher was removed. Use initiative_decision for lightweight user and agent choices. Retained sessions can use bb initiative command without restarting."); },
  });
  registerTool({
    name: "initiative_create",
    description:
      "Start a durable initiative across BB repositories. Create an Opus coordinator or adopt this thread. Existing native tools remain available.",
    parameters: createSchema,
    execute: async (input, { threadId }) =>
      JSON.stringify(await perform(undefined, input, "user", threadId ?? null)),
  });
  /**
   * T136 tools. Each publishes plain JSON Schema and validates in execute, so a session
   * constructed before T136 can still send its older payloads: those run as the commands
   * they always were, and removed actions answer with what replaces them.
   */
  const coordinatorProject = async (threadId: string | undefined) => {
    if (!threadId) throw new ProjectError("Use Initiative tools from a BB thread.");
    await ensureMember(threadId);
    return service.coordinatorOf(threadId);
  };
  const parsed = <T,>(schema: z.ZodType<T>, raw: unknown, tool: string): T => {
    const result = schema.safeParse(raw);
    if (!result.success) throw new ProjectError(`Invalid arguments for ${tool}: ${result.error.issues.map(issue => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ")}`);
    return result.data;
  };
  /** An older session's payload for a reused tool name: run it as the command it always was. */
  const legacyCommand = async (raw: unknown, threadId: string, actions: readonly string[]) => {
    const action = (raw as { action?: unknown } | null)?.action;
    if (typeof action !== "string" || !actions.includes(action)) return null;
    refuseRemoved(raw);
    const p = await coordinatorProject(threadId);
    return JSON.stringify(await perform(p.id, parseCommandInput(raw), "coordinator", threadId));
  };
  /** initiative_message and `bb initiative message`: a plain message, or more work for a worker. */
  const sendMessage = async (raw: unknown, threadId: string) => {
    await ensureMember(threadId);
    const command = messageCommand(parsed(messageToolSchema, raw, "initiative_message"));
    if (command.action === "message") return service.message(threadId, command);
    // Work for a reviewer is refused: each review round gets a fresh reviewer (W239).
    return perform(service.coordinatorOf(threadId).id, command, "coordinator", threadId);
  };
  const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  /** W215: write tools answer with a short receipt; initiative_read has the full records. */
  const receipt = (value: unknown) => JSON.stringify(toolReceipt(value));
  registerTool({
    name: "initiative_spawn",
    parameters: jsonSchema(spawnToolSchema),
    description: 'Give work to a new worker: {label:"Search index",purpose:"search ranking",text:"<the brief>",tasks:["T40"]}. A review: {role:"review",reviews:"W12",label,purpose,text:"what to check"}. The result lists warnings, such as another writer in the same checkout.',
    async execute(raw, { threadId }) {
      const p = await coordinatorProject(threadId);
      return receipt(await perform(p.id, spawnCommand(parsed(spawnToolSchema, raw, "initiative_spawn")), "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_message",
    parameters: jsonSchema(messageToolAdvertised),
    description: 'One message to a worker (W#) or the coordinator: {to:"W4",text:"…"}. With tasks:["T41"] or work:true it gives the worker more work, and the worker reports again; a plain message corrects work in progress. Messages never resume a stopped or retired worker.',
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Message from a current Initiative thread.");
      return receipt(await sendMessage(raw, threadId));
    },
  });
  registerTool({
    name: "initiative_task",
    parameters: jsonSchema(taskToolSchema),
    description: 'Optional tasks. {action:"create",title,text?} · {action:"update",task:"T4",title?,text?,note?} · {action:"close",task:"T4",outcome:"done"|"cancelled",note?} (cancelling stops its running work) · {action:"reopen",task:"T4",note?}.',
    async execute(raw, { threadId }) {
      const legacy = await legacyCommand(raw, threadId!, ["task-create", "task-update", "task-cancel", "task-reopen", "assignment-stop", "assignment-settle", ...Object.keys(REMOVED_ACTIONS)]);
      if (legacy) return legacy;
      const p = await coordinatorProject(threadId);
      return receipt(await perform(p.id, taskCommand(parsed(taskToolSchema, raw, "initiative_task")), "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_worker",
    parameters: jsonSchema(workerToolSchema),
    description: 'Retire a finished worker ({action:"retire",worker:"W4"}; once its turn has ended, since a report can arrive first; its reports stay readable), stop its running work ({action:"stop",worker:"W4",reason}), or adopt an existing thread ({action:"adopt",threadId,role,label,purpose}).',
    async execute(raw, { threadId }) {
      const legacy = await legacyCommand(raw, threadId!, ["worker-retire"]);
      if (legacy) return legacy;
      // An older session's adopt payload (area, tasks, detachNativeParent) runs as it always did.
      const old = raw as Record<string, unknown> | null;
      if (old?.action === "adopt" && ["area", "tasks", "detachNativeParent"].some(key => key in old) && !("purpose" in old)) {
        const p = await coordinatorProject(threadId);
        return JSON.stringify(await perform(p.id, parseCommandInput(raw), "coordinator", threadId!));
      }
      const p = await coordinatorProject(threadId);
      const command = workerCommand(parsed(workerToolSchema, raw, "initiative_worker"));
      if (command.action === "worker-stop") {
        const worker = service.requireWorker(p, command.worker);
        const open = store.openAssignment(p.id, worker.num);
        if (!open) throw new ProjectError(`${worker.ref} has no running work to stop.`);
        return receipt(await perform(p.id, { action: "assignment-stop", assignment: open.ref, reason: command.reason }, "coordinator", threadId!));
      }
      return receipt(await perform(p.id, command, "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_manage",
    parameters: jsonSchema(manageToolSchema),
    description: 'Manage the Initiative: {action:"pause"|"resume"|"stop-work"|"archive"} · {action:"edit",name?,objective?,memberProjectIds?} · {action:"handover",reason?,note?} hands over to a fresh coordinator once your turn ends; GPT-6 Luna writes its first message from recent activity. cancel:true withdraws it.',
    async execute(raw, { threadId }) {
      const legacy = await legacyCommand(raw, threadId!, ["coordinator-settle", "replace-coordinator", "coordinator-handover"]);
      if (legacy) return legacy;
      const action = (raw as { action?: unknown } | null)?.action;
      // An older session's {action:"pause",paused} still works, exactly as it was.
      if (action === "pause" && typeof (raw as { paused?: unknown }).paused === "boolean" && Object.keys(raw as object).length === 2) {
        const p = await coordinatorProject(threadId);
        return JSON.stringify(await perform(p.id, { action: "pause", paused: (raw as { paused: boolean }).paused }, "coordinator", threadId!));
      }
      const p = await coordinatorProject(threadId);
      return JSON.stringify(await perform(p.id, manageCommand(parsed(manageToolSchema, raw, "initiative_manage")), "coordinator", threadId!));
    },
  });
  // Older sessions only: their constructed allowlists still name these.
  registerTool({
    name: "initiative_delegate",
    parameters: jsonSchema(z.object({ action: z.string().optional() }).passthrough()),
    description: "Older sessions only. Use initiative_spawn for a new worker and initiative_message (tasks or work:true) for an existing one.",
    async execute(raw, { threadId }) {
      refuseRemoved({ action: "delegate", ...(raw as object) });
      const p = await coordinatorProject(threadId);
      return JSON.stringify(await perform(p.id, parsed(delegateSchema, { action: "delegate", ...(raw as object) }, "initiative_delegate"), "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_decision",
    // Plain JSON Schema with an object root: Claude's bridge blanks union roots. Validation is
    // parseDecisionCommand, shared with the CLI, so every refusal carries a valid example.
    parameters: decisionToolJsonSchema as Record<string, unknown>,
    description: 'Record choices for the user, who follows and redirects the work with them; never consult the log for your own work. {action:"user-choice",description} records the user\'s explicit choice from chat; {action:"veto-request",description} a choice of yours the user may want to veto (you proceed unless they do). Routine steps are not decisions. Coordinator only: {action:"question",question,context,options?,recommendation?,blocksTaskIds?} asks a real open choice (never inferred from prose); {action:"withdraw",ref:"D12",reason} retracts your own open question. {action:"answer",ref:"D12",choice,note?} records the user\'s explicit answer; workers notify the coordinator unless notify:false.',
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Record decisions from an Initiative thread.");
      await ensureMember(threadId);
      const input = parseDecisionCommand(raw);
      if (input.action === "answer") {
        const { projectId, recordedBy } = chatAnswerRecorder(threadId);
        const answered = await service.answerOpinion(projectId, input.decision, input, recordedBy);
        return JSON.stringify({ ref: answered.ref, madeBy: answered.madeBy, status: answered.status, notification: answered.notification });
      }
      const { projectId, recordedBy: provenance } = chatAnswerRecorder(threadId);
      let result;
      if (input.action === "question") {
        if (provenance.author !== "coordinator") throw new ProjectError("Ask the user questions through the coordinator.");
        result = service.recordQuestion(projectId, input.question, provenance);
      } else if (input.action === "question-withdraw") {
        const withdrawn = service.withdrawQuestion(projectId, input.decision, input.reason, provenance);
        return JSON.stringify({ ref: withdrawn.ref, status: withdrawn.status, madeBy: withdrawn.madeBy, notification: withdrawn.notification,
          tasks: withdrawn.blocks.map(num => store.task(projectId, num)).filter(task => task !== null).map(task => ({ ref: task.ref, status: task.status, progress: task.progress })) });
      } else result = service.recordDecision(projectId, input, provenance);
      // W215: no echo of the description the caller just wrote; initiative_read has the record.
      return JSON.stringify({ ref: result.ref, madeBy: result.madeBy, status: result.status, review: result.review });
    },
  });
  /** initiative_pr and `bb initiative pr`: record PR stages, categories and notes, in one transaction. */
  const setPrStages = (projectId: string, raw: unknown, tool: string, caller: PrCaller) => {
    const input = parsed(prToolSchema, raw, tool);
    service.requireProject(projectId);
    return store.db.transaction(() => recordPrs(store, service.prNotes, projectId, input, Date.now(), caller))();
  };
  /** D442: a worker notes the PRs its assignments name, the coordinator gave it, or its branch opened. */
  const workerCaller = (projectId: string, worker: { num: number; ref: string; threadId: string | null }, threadId: string): PrCaller => ({
    author: worker.ref,
    threadId,
    worker: {
      ref: worker.ref,
      owns: (url) => {
        if (assignedPrs.ofWorker(projectId, worker.num).has(url) || store.prRecords(projectId).get(url)?.worker === worker.ref) return true;
        const head = mergeQueue.cachedPr(url)?.head;
        return !!head && branchThreadId(head) === worker.threadId;
      },
    },
  });
  registerTool({
    name: "initiative_pr",
    parameters: jsonSchema(prToolSchema),
    description: 'Keep each pull request\'s record and notes, several PRs per call: {prs:[{url:"https://github.com/o/r/pull/12",stage:"in-review",note:"W14 reviewing",category:"Security",waitingOn:"W14: move the lock",changes:["drop the retry"],decision:{text:"Keep 5m TTL",link:"D437"},worker:"W14",notes:[{kind:"question",text:"No migration test?"}],answered:[{n:3,text:"Yes"}]}]}, every field but url optional. Only given fields change; null clears one. stage clear removes yours (the dashboard guesses from GitHub again). category is a free-form workstream: reuse one from the result\'s categories; {rename:[{from:"Sec",to:"Security"}]} renames or merges. changes replaces the list. notes append to the PR\'s log (the result numbers them n); answered closes questions by n. An assignment (A#) names its worker. Workers only add notes, to PRs their assignments name or their branch opened.',
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Use Initiative tools from a BB thread.");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (m && !m.former && m.workerNum > 0 && m.worker) {
        const { project, worker } = service.workerOf(threadId);
        return receipt(setPrStages(project.id, raw, "initiative_pr", workerCaller(project.id, worker, threadId)));
      }
      const p = await coordinatorProject(threadId);
      return receipt(setPrStages(p.id, raw, "initiative_pr", { ...COORDINATOR, threadId }));
    },
  });
  registerTool({
    name: "initiative_update",
    description: "Tell the user how things stand in a short update: what is done, what is next, what you need. Write for someone who has not read the threads.",
    parameters: jsonSchema(updateToolSchema),
    async execute(raw, { threadId }) {
      if (!threadId)
        throw new ProjectError("Publish updates from an initiative thread.");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (!m || m.former || (m.workerNum !== 0 && m.workerNum !== -1))
        throw new ProjectError(
          "Publish updates from the coordinator or the user's own initiative thread.",
        );
      const input = parsed(updateToolSchema, raw, "initiative_update");
      return receipt(
        await perform(
          m.project.id,
          parsed(updateSchema, { action: "update", ...input }, "initiative_update"),
          m.workerNum === 0 ? "coordinator" : "user",
          threadId,
        ),
      );
    },
  });
  registerTool({
    name: "initiative_read",
    description: 'Read the Initiative. {} is the overview; {refs:["W12","T40","A301"]} reads exact records (a W# with its latest report); {view:"workers"} and the other views list records, limit 1..30, offset to page; {view:"prs"}: open PRs by category and stage, their stacks, what the user can review next. detailed:true gives full records; fields picks parts, e.g. {refs:["W12","D4"],fields:["report","body"]}, each record the ones it has. Reading never wakes agents.',
    parameters: agentReadSchema,
    async execute(input, { threadId }) {
      if (!threadId) throw new ProjectError("Use initiative_read from an Initiative thread.");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (!m) {
        const pending = service.pendingCoordinatorIdentity(threadId, await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId }).catch(() => ({})) as Record<string, unknown>);
        if (pending) return JSON.stringify(pending);
        throw new ProjectError("This thread does not belong to an Initiative.");
      }
      const { view, ...rawOptions } = input;
      const options = readOptionsSchema.parse(rawOptions);
      if (view === "overview" && Object.keys(rawOptions).length)
        throw new ProjectError("overview has no refs/detail/pagination selectors. Omit view for refs, or select a collection such as workers or reports.");
      if (!view && !options.refs && Object.keys(rawOptions).length)
        throw new ProjectError("Specify view or refs for detail/pagination selectors, for example view:reports, limit:5.");
      if (!view && options.refs || view === "records") return JSON.stringify(readRefs(store, m.project.id, options));
      if (!view || view === "overview") return JSON.stringify(compactOverview(store, m.project.id));
      if (view === "threads") return JSON.stringify(await readThreads(m.project.id, options));
      if (view === "context") return JSON.stringify(readContext(store, m.project.id));
      if (view === "memory") return JSON.stringify(await chatMemory("read", { threadId }, z.object({ messages: z.number(), view: z.string(), note: z.string() })));
      if (view === "prs") return JSON.stringify(prSummary(await mergeQueue.read(m.project.id)));
      return JSON.stringify(read(m.project.id, view, options));
    },
  });
  const batchSchema = z.object({
    actions: z.array(z.object({ tool: z.enum(BATCH_TOOLS) }).passthrough()).min(1).max(20),
  }).strict();
  registerTool({
    name: "initiative_batch",
    parameters: jsonSchema(batchSchema),
    description: 'Several Initiative actions in one call, run in order; one failing never stops the rest. Each is {tool, ...that tool\'s arguments}: {actions:[{tool:"task",action:"close",task:"T4",outcome:"done"},{tool:"message",to:"W12",text:"…"}]}. Returns one result per action. Coordinator only.',
    async execute(raw, context) {
      await coordinatorProject(context.threadId);
      const { actions } = parsed(batchSchema, raw, "initiative_batch");
      type Result = { tool: string; ok: boolean; result?: unknown; error?: string; omitted?: true; reason?: string; [key: string]: unknown };
      // Every action runs first; the response is built afterwards.
      const full: Result[] = [];
      for (const { tool, ...args } of actions) {
        try {
          const out = await handlers.get(`initiative_${tool}`)!(args, context);
          let result: unknown = out;
          if (typeof out === "string") try { result = JSON.parse(out); } catch { /* plain text result */ }
          // W215: a write's receipt sits flat in its entry, {tool,ok,ref,state}; a read stays under result.
          if (tool !== "read" && Array.isArray(result) && result.length === 1) result = result[0];
          const flat = tool !== "read" && !!result && typeof result === "object" && !Array.isArray(result) && !("tool" in result) && !("ok" in result);
          full.push(flat ? { tool, ok: true, ...(result as Record<string, unknown>) } : { tool, ok: true, result });
        } catch (error) {
          full.push({ tool, ok: false, error: errorMessage(error) });
        }
      }
      // One budget for the complete serialized response, the size of a single read:
      // start from a placeholder per action and admit each full entry, in order, only
      // when the whole response (envelope, note, separators) still fits.
      const capped = (entry: Result): Result => ({ tool: entry.tool, ok: entry.ok, omitted: true, reason: `${entry.ok ? "result" : "error"} left out: the batch response is capped at ${MAX_READ_BYTES / 1024} KiB` });
      const shown = full.map(capped);
      const render = () => {
        const omitted = shown.filter(r => r.omitted).length;
        return JSON.stringify({
          succeeded: full.filter(r => r.ok).length,
          failed: full.filter(r => !r.ok).length,
          ...(omitted ? { note: `${omitted} result${omitted === 1 ? "" : "s"} left out to stay under ${MAX_READ_BYTES / 1024} KiB; the actions ran. Read what you need separately, e.g. initiative_read with refs.` } : {}),
          results: shown,
        });
      };
      for (const [index, entry] of full.entries()) {
        shown[index] = entry;
        if (Buffer.byteLength(render()) > MAX_READ_BYTES) shown[index] = capped(entry);
      }
      return render();
    },
  });
  registerTool({
    name: "initiative_report",
    description: 'Finish with this: {outcome:"done"|"blocked"|"failed",summary,report}. The coordinator gets summary (which must stand on its own: outcome, PR URL and head, merge order, what you need) and reads report, your full report, on demand; a short report is sent whole. blocked needs question.',
    parameters: jsonSchema(reportToolSchema),
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Report from the worker thread.");
      await ensureMember(threadId);
      // An older session's full structured report still records as it always did.
      if (typeof raw === "object" && raw !== null && "handoff" in raw)
        return JSON.stringify(await service.report(threadId, parsed(reportSchema.safeExtend({ assignment: z.string().optional() }), raw, "initiative_report")));
      const input = parsed(reportToolSchema, raw, "initiative_report");
      if (input.outcome === "blocked" && !input.question) throw new ProjectError("A blocked report needs the question you need answered.");
      return JSON.stringify(await service.shortReport(threadId, input));
    },
  });
  registerTool({
    name: "initiative_progress",
    description: "Older sessions only; progress is no longer recorded. Finish with initiative_report and your full report.",
    parameters: jsonSchema(z.object({ note: z.string().optional(), nextCheckpoint: z.string().optional() }).passthrough()),
    async execute() {
      return JSON.stringify({ note: "Progress is no longer recorded. Keep working, then finish with initiative_report and your full report." });
    },
  });

  bb.cli.register({
    name: "initiative",
    summary: "Durable initiatives, worker lifecycles, decisions and overview",
    commands: [
      { name: "message", summary: "One message to a worker or the coordinator; the coordinator adds tasks or work:true to give a worker more work", usage: "bb initiative message '{\"to\":\"W4\",\"text\":\"Interface fact\"}'" },
      { name: "describe", summary: "Show short valid JSON examples for commands and reads", usage: "bb initiative describe [read|decision|spawn|review|work-message|fresh-with-handoff|message|task-close|question|answer|quiet-answer|user-choice|veto-request|supersede|withdraw|handover|<initiative_tool>]" },
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
          "bb initiative read <records|tasks|workers|reports|assignments|decisions|updates|activity|usage|threads> [initiative-id] [options-json]; records takes mixed refs. The coordinator's memory: bb chat-memory",
      },
      {
        name: "command",
        summary: "Run typed Initiative JSON (see bb initiative describe). Decisions: user-choice for the user's explicit choices, veto-request for your own choices the user may want to veto.",
        usage: "bb initiative command '<json>' [initiative-id]",
      },
      {
        name: "pr",
        summary: "Set or clear the workflow stage of pull requests (coordinator, or a terminal with an initiative id)",
        usage: "bb initiative pr '{\"prs\":[{\"url\":\"https://github.com/o/r/pull/12\",\"stage\":\"in-review\"}]}' [initiative-id]",
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
      {
        name: "recreate-coordinators",
        summary: "Start a fresh coordinator for each Initiative from a GPT-6 Luna handover; --dry-run only writes and prints the handovers",
        usage: "bb initiative recreate-coordinators (--all | <initiative-id>...) [--dry-run] [--wait=<seconds>]",
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
          if (!value) result = { commands: Object.keys(COMMAND_EXAMPLES), reads: READ_EXAMPLES, note: "bb initiative describe <name>; replace the example refs with real ones." };
          else if (value === "read" || value === "initiative_read") result = READ_EXAMPLES;
          else if (value in COMMAND_EXAMPLES) result = COMMAND_EXAMPLES[value as keyof typeof COMMAND_EXAMPLES];
          else if (value in DESCRIBE_GROUPS) result = Object.fromEntries(DESCRIBE_GROUPS[value]!.map(name => [name, COMMAND_EXAMPLES[name]]));
          else throw new ProjectError(`Unknown example ${value}. Available: read, ${[...Object.keys(DESCRIBE_GROUPS), ...Object.keys(COMMAND_EXAMPLES)].join(", ")}.`);
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
          result = await sendMessage(JSON.parse(value), ctx.threadId);
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
        } else if (action === "pr" && value && args.length <= 3) {
          if (ctx.threadId) {
            if (!member || member.former || member.workerNum !== 0)
              throw new ProjectError("Only the current initiative coordinator sets PR stages from an agent CLI.");
            if (id !== member.project.id)
              throw new ProjectError("A coordinator cannot set another initiative's PR stages.");
          }
          if (!id) throw new ProjectError("Pass the initiative id: bb initiative pr '<json>' <initiative-id>.");
          result = setPrStages(id, JSON.parse(value), "bb initiative pr", ctx.threadId ? { ...COORDINATOR, threadId: ctx.threadId } : { ...COORDINATOR, author: "user" });
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
        } else if (action === "recreate-coordinators") {
          if (member && (member.former || member.workerNum !== 0))
            throw new ProjectError("Run this from a terminal or from a coordinator thread.");
          const flags = args.slice(1);
          const ids = flags.filter(a => !a.startsWith("--"));
          const all = flags.includes("--all");
          if (all === (ids.length > 0)) throw new ProjectError("Pass --all, or the Initiative ids to recreate.");
          const wait = flags.find(a => a.startsWith("--wait="));
          const waitMs = wait ? Math.max(0, Math.min(1800, Number(wait.slice(7)) || 0)) * 1000 : 12 * 60_000;
          result = await service.recreateCoordinators(all ? store.projects().filter(p => p.archivedAt === null).map(p => p.id) : ids, { dryRun: flags.includes("--dry-run"), waitMs });
        } else
          throw new ProjectError(
            `${action && !CLI_COMMANDS.includes(action) ? `Unknown subcommand ${action}. ` : action ? `Unexpected arguments for ${action}. ` : ""}${CLI_USAGE}`,
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
    },
  });
  // Tests drive commands as an entry point would, announcement included.
  const command = (...args: Parameters<typeof perform>) => announcing(() => perform(...args), () => args[0]);
  return { service, store, runtime, perform: command, overview, tree, preferences };
}
