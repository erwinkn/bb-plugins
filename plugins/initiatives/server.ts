import type {
  BbPluginApi,
  PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  projectsContract,
  type ChildPage,
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
  normalizeReport,
  prUnwatchToolSchema,
  prWatchToolSchema,
  reportToolSchema,
  questionToolSchema,
  ruleCommand,
  ruleToolSchema,
  spawnCommand,
  spawnToolAdvertised,
  spawnToolSchema,
  taskCommand,
  taskToolAdvertised,
  taskToolSchema,
  updateToolSchema,
  workerCommand,
  workerMessageToolSchema,
  workerPrWatchToolSchema,
  workerToolSchema,
} from "./lib/agent-tools";
import { legacyReportSchema, LEGACY_TOOL_NAMES } from "./lib/legacy";
import { reportSchema } from "./lib/schema";
import { definePreferences } from "./lib/settings";
import { WriteReceipts } from "./lib/write-receipts";
import { CHAT_MEMORY_PLUGIN_ID } from "./lib/memory-scopes";
import { Store, MIGRATIONS, type WorkerRecord } from "./lib/store";
import { CHILD_PAGE, ProjectsService } from "./lib/service";
import { Runtime, SWEEP_INTERVAL_MS } from "./lib/runtime";
import { ReviewerFallback } from "./lib/reviewer-fallback";
import { withProfileDefaults } from "./lib/settings";
import {
  buildOverview,
  buildSummary,
  threadsToWatch,
  type CoordinatorHome,
  type LiveThread,
  type OverviewDetail,
} from "./lib/overview";
import { Background, FIRST_READ_WAIT_MS, LiveThreads, Recent, liveOf } from "./lib/live-threads";
import { MergeQueueCache } from "./lib/merge-queue-server";
import { PrWatcher, WATCH_TICK_MS, WatchLedger, readPrWatch, watchAnswer, watcherLabel } from "./lib/pr-watch";
import { canonicalPrUrl, prToolSchema, workerPrToolSchema } from "./lib/pr-stages";
import { MAX_ERROR_BYTES, ToolInputError, clipBytes, parseToolInput } from "./lib/tool-errors";
import { AssignedPrs, COORDINATOR, initiativeNamed, recordPrs, type PrCaller } from "./lib/pr-records";
import { prsReferenced } from "./lib/task-status";
import { PrOwners, ledgerThreads } from "./lib/pr-owners";
import { readPrDetail } from "./lib/pr-detail";
import { branchThreadId } from "./lib/merge-queue";
import { matchesRef, prsByRef, prSummary } from "./lib/pr-map";
import { notDeliveredMessages, queueTargets } from "./lib/not-delivered";
import { COMMAND_EXAMPLES, DESCRIBE_GROUPS, READ_EXAMPLES } from "./lib/examples";

/** W473: Workers-tab child listings in flight at once (each is one ~2 ms BB query). */
const PREFETCH_LISTINGS = 3;
/** W473: the most often one prefetch batch announces what it found. */
const PREFETCH_ANNOUNCE_MS = 100;
const CLI_COMMANDS = ["describe", "list", "overview", "read", "message", "command", "report", "pr", "rules", "reconcile", "recreate-coordinators"];
/** Tools initiative_batch can run, by their name without the initiative_ prefix. */
const BATCH_TOOLS = ["spawn", "message", "task", "worker", "question", "rule", "decision", "update", "pr", "read"] as const;
const CLI_USAGE = "Usage: bb initiative describe [name] | list | overview [id] | read <view> [id] [options-json] | message '<json>' | command '<json>' [id] | report '<json>' | pr '<json>' [id] | rules (import <id> <file> | export <id> [file]) | reconcile | recreate-coordinators (--all | <id>...) [--dry-run] [--wait=<s>]";
import { decisionToolJsonSchema } from "./lib/decision-input";
import { toolReceipt } from "./lib/receipts";
import { SLOW_CALL_MS } from "./lib/step-timing";
import { BUSY_STATUSES, ProjectError, errorMessage } from "./lib/bb";
import { codeReviewSkillMissing } from "./lib/service";
import { assembleInstructions, clip80, leadRulesPointer, workerRulesPointer } from "./lib/instructions";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { isOwnOrigin } from "./lib/identity";
import { scopedNativeEvent } from "./lib/native-events";
import { workerGroup } from "./lib/worker-group";
import { initiativesContext, membersContext, recordText, threadContext } from "./lib/context";
import {
  readCollection, readContext, readRefs, readRows, compactOverview, agentReadSchema, agentReadAdvertised, validateSelection, withImpliedDetail,
  readOptionsSchema, isPrRef, readMixedRefs,
  READ_VIEWS,
  MAX_READ_BYTES,
  type ReadOptions,
  type ReadView,
} from "./lib/read";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  // W506: the PR refs of assignments written before the index, or by the previous build.
  store.catchUpPrRefs();
  // v9 (§7): closes the previous build made stay closed, as hand-set statuses.
  for (const closed of store.reconcileTaskOverrides())
    store.log(closed.projectId, "task", `T${closed.num} was ${closed.status === "done" ? "closed as done" : "cancelled"} while the previous build ran; kept as set by hand.`, { task: closed.num });
  const skillMissing = codeReviewSkillMissing();
  const preferences = definePreferences(bb, { has: (key) => store.hasFlag(key), set: (key) => store.setFlag(key) },
    skillMissing ? { workerInstructions: `Warning: ${skillMissing}` } : undefined);
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
  const serialized = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = writes.then(run, run);
    writes = next.catch(() => undefined);
    return next;
  };
  service.serialize = serialized;
  service.announce = changed;
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
      ["answer", "blocker-answer", "blocker-dismiss", "pause", "assignment-stop", "worker-stop", "stop-work"].includes(
        command.action,
      )
    )
      return run();
    return serialized(run);
  };
  // Dashboard reads share native facts: lifecycle events keep them current,
  // and a stale fact is answered at once, then re-read in the background; a
  // change found that way announces the Initiative. Agent and CLI reads stay fresh.
  const liveThreads = new LiveThreads(
    (threadId) => bb.sdk.threads.get({ threadId }),
    undefined,
    (threadId, error) => bb.log.warn(`Could not read thread ${threadId} for the dashboard: ${errorMessage(error)}`),
  );
  service.revivedNested = (thread) => liveThreads.observe(thread);
  /** W496: a nested thread seen archived or deleted keeps that fact and is no longer read for the dashboard. */
  const endNested = (threadId: string, fact: LiveThread) => {
    if (fact.archived || fact.status === "deleted") store.endNestedThread(threadId, fact);
  };
  const nativeContext = new Recent<unknown>(10_000);
  const childPages = new Background<{ rows: Omit<ChildPage["rows"][number], "children">[]; next: ChildPage["next"] }>(10_000);
  /** W473: each cached page's listing, as RunningChildren.begin() numbers it, so a newer complete listing wins over it. */
  const childPageEpochs = new Map<string, number>();
  /** W473: cached pages whose latest refresh has already announced its tree. */
  const childPageAnnounced = new Set<string>();
  const instanceEpoch = Math.random().toString(36).slice(2, 10);
  /**
   * W473: the trees the Workers tab is about to show are listed before anyone opens them: each
   * thread the cache has never listed, once (lifecycle events keep it current after), through one
   * queue for the instance, PREFETCH_LISTINGS at a time. A listing that changes a count a row
   * shows (unknown and none both show no toggle) announces its batch, at most once per
   * PREFETCH_ANNOUNCE_MS. No read waits on it; a failed listing is logged once and tried again by
   * a later read.
   */
  const prefetching = new Set<string>();
  /** Threads whose first child page answered loading: a listing that fills the cache tells their open trees. */
  const awaitingRows = new Set<string>();
  /** Threads whose last listing failed and was logged: an outage logs each once, not every read. */
  const prefetchFailed = new Set<string>();
  const prefetchQueue: { threadId: string; settled: () => void }[] = [];
  let prefetchRunning = 0;
  const pumpPrefetch = () => {
    while (prefetchRunning < PREFETCH_LISTINGS && prefetchQueue.length) {
      const { threadId, settled } = prefetchQueue.shift()!;
      prefetchRunning++;
      void service.listChildren(threadId).then(() => {
        prefetchFailed.delete(threadId);
        if (awaitingRows.delete(threadId)) announceChildren(threadId);
      }, (error) => {
        if (prefetchFailed.has(threadId)) return;
        prefetchFailed.add(threadId);
        try {
          bb.log.warn(`Listing ${threadId}'s child threads failed; a later read tries again: ${errorMessage(error)}`);
        } catch {
          /* the plugin reloaded meanwhile */
        }
      }).finally(() => {
        prefetching.delete(threadId);
        prefetchRunning--;
        settled();
        pumpPrefetch();
      });
    }
  };
  const announceChildren = (threadId: string) => {
    try {
      bb.realtime.publish("initiatives-children", { threadId });
    } catch {
      /* the plugin reloaded meanwhile */
    }
  };
  const prefetchChildren = (threadIds: readonly string[], announce: () => void) => {
    const cache = service.runningChildren;
    let timer: ReturnType<typeof setTimeout> | null = null;
    for (const threadId of new Set(threadIds)) {
      if (cache.isListed(threadId) || prefetching.has(threadId)) continue;
      prefetching.add(threadId);
      const before = cache.childCount(threadId) ?? 0;
      prefetchQueue.push({ threadId, settled: () => {
        if (timer || (cache.childCount(threadId) ?? 0) === before) return;
        timer = setTimeout(() => {
          timer = null;
          try {
            announce();
          } catch {
            /* the plugin reloaded meanwhile: its successor announces its own reads */
          }
        }, PREFETCH_ANNOUNCE_MS);
      } });
    }
    pumpPrefetch();
  };
  const overview = async (
    projectId: string,
    detail: OverviewDetail = "full",
    { fresh = true }: { fresh?: boolean } = {},
  ) => {
    service.requireProject(projectId);
    const recent = <T,>(key: string, load: () => Promise<T>) =>
      fresh ? load() : (nativeContext.get(key, load) as Promise<T>);
    // W496: a dashboard read waits at most FIRST_READ_WAIT_MS for threads it has never read; their
    // rows show loading (or unreadable) until the reads land and announce the Initiative.
    const live = await liveThreads.get(threadsToWatch(store, projectId), {
      fresh,
      revalidated: () => changed(projectId),
      ...(fresh ? {} : { wait: FIRST_READ_WAIT_MS }),
    });
    for (const t of store.nestedProjectThreads(projectId)) {
      if (t.ended) {
        if (!live.has(t.threadId)) live.set(t.threadId, t.ended);
      } else {
        const fact = liveThreads.current(t.threadId);
        if (fact) endNested(t.threadId, fact);
      }
    }
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
    // v9: what each live worker's descendants are doing, from the cache events and the sweep keep;
    // no native read, so no first paint waits on a walk. The Workers tab opens a tree by childPage,
    // and offers to only when the cache knows a child there: retired workers (the history tier)
    // are listed too once the cache knows their count.
    const cache = service.runningChildren;
    result.workerWaiting = Object.fromEntries([
      ...result.workers.current.flatMap((w) => w.threadId ? [[w.ref, { ...cache.waitingOn(w.threadId), children: cache.childCount(w.threadId) }]] : []),
      ...result.workers.retired.flatMap((w) => {
        const children = w.threadId ? cache.childCount(w.threadId) : null;
        return children === null ? [] : [[w.ref, { ...cache.waitingOn(w.threadId!), children }]];
      }),
    ]);
    const asksUser = new Set(result.blockers.filter((b) => !b.answer).map((b) => b.owner.worker));
    result.workerGroups = Object.fromEntries(result.workers.current.map((w) => {
      const facts = {
        asksUser: asksUser.has(w.ref), runtime: w.runtime, waiting: !!result.workerWaiting?.[w.ref]?.on,
        open: !!w.open, stopReason: !!w.stopReason, outcome: w.latestReport?.outcome ?? null,
      };
      return [w.ref, {
        group: workerGroup(facts),
        // What BB's live view moves it to when the thread is not running: quiet, or errored.
        quiet: workerGroup({ ...facts, runtime: "idle" }),
        errored: workerGroup({ ...facts, runtime: "error" }),
      }];
    }));
    prefetchChildren(result.workers.current.flatMap((w) => w.threadId ? [w.threadId] : []), () => changed(projectId));
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
  /** Live workers with each fork right after the worker it was forked from. */
  const orderedWorkers = (workers: WorkerRecord[]) => {
    const seen = new Set<number>();
    const ordered: WorkerRecord[] = [];
    const visit = (w: WorkerRecord) => {
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
  /**
   * D532: threads that once belonged to the Initiative and no longer show as nodes: retired
   * workers' threads and every earlier coordinator and worker generation, so the sidebar can
   * hide them with their descendants.
   */
  const formerThreadIds = (projectId: string, current: Set<string>) => {
    const rows = store.db.prepare(`SELECT thread_id FROM generations WHERE project_id = ? UNION SELECT thread_id FROM workers WHERE project_id = ? AND thread_id IS NOT NULL`)
      .all(projectId, projectId) as { thread_id: string }[];
    return [...new Set(rows.map((r) => r.thread_id))].filter((id) => !current.has(id)).sort();
  };
  // Summaries are shared by the tree and the list: one build per ledger version.
  const summaries = memo(() => new Map(store.projects().map((p) => [p.id, summary(p.id)])));
  const list = memo(() => [...summaries().values()]);
  // W483: one pass of a few queries per Initiative. A per-row membership read
  // took seconds on large histories and blocked BB's server meanwhile.
  const buildTree = (): ProjectTree => {
    const shown = summaries();
    // Explicit membership wins: a thread later adopted as a worker or
    // coordinator is emitted under that role, not again as an associated one.
    const claimed = store.claimedThreadIds();
    return {
      version: 1,
      projects: store.projects().map((p) => {
        const workers = orderedWorkers(store.liveWorkers(p.id));
        return {
          ...shown.get(p.id)!,
          retired: store.retiredWorkerNums(p.id).length,
          formerThreadIds: formerThreadIds(p.id, new Set([p.coordinatorThreadId, ...workers.map((w) => w.threadId)].filter((id): id is string => !!id))),
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
            ...workers.map((w) => ({
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
              .filter((t) => t.state !== "failed" && (!t.threadId || !claimed.has(t.threadId)))
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
              // Nested associations follow the same precedence.
              .filter((t) => !claimed.has(t.threadId))
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
        };
      }),
    };
  };
  const tree = memo(buildTree);
  const read = (
    projectId: string,
    view: ReadView,
    options: ReadOptions = readOptionsSchema.parse({}),
  ) => {
    service.requireProject(projectId);
    return readCollection(store, projectId, view, options);
  };
  /** v9 (D523): the full numbered list, current first; removed rules are left out. */
  const readRules = (projectId: string) => {
    const project = service.requireProject(projectId);
    const rules = store.rules(projectId);
    return { initiative: project.name, count: rules.length, rules: rules.map((r) => ({ ref: r.ref, text: r.text, ...(r.sources.length ? { sources: r.sources } : {}) })),
      note: "Follow every rule. A lead adds one when the user states a lasting choice (initiative_rule), and edits or removes one only when the user asks." };
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
  /**
   * R2: a move's destination, by its stable id, once its repositories are known: the lookup may
   * wait on BB (never GitHub). The write then checks it again as it is (prMoveFits), in the same
   * synchronous step that moves the PR, so a rename, a member change or an archive meanwhile
   * can't slip past.
   */
  const prMoveTarget = async (name: string) => {
    const target = initiativeNamed(store, name);
    await mergeQueue.reposOf(target.id);
    return target.id;
  };
  /** R2: a PR moves only to an Initiative listing its repository; elsewhere it would show nowhere. */
  const prMoveFits = (target: { id: string; name: string }, url: string) => {
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)![1]!;
    const repos = mergeQueue.cachedRepos(target.id);
    if (repos === null) throw new ProjectError(`${target.name}'s repositories are still being looked up; try again in a moment.`);
    if (!repos.includes(repo))
      throw new ProjectError(`${target.name} doesn't list ${repo}, so ${url} would show in no Adventure. Move it to an Adventure whose projects include ${repo}.`);
  };
  // R2: each PR's owner Initiative. An owner found behind a read tells the dashboards to read again.
  const prOwners = new PrOwners(store.db,
    ledgerThreads(store, async (threadId) => (await bb.sdk.threads.get({ threadId })).parentThreadId ?? null),
    () => bb.realtime.publish("merge-queue-changed", { repo: null }));
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
    owners: (pullRequests) => prOwners.owners(pullRequests),
    prStates: {
      markOpen: (urls, at) => store.markPrsOpen(urls, at),
      toLookUp: (listed, at, limit) => store.prsToLookUp(listed, at, limit),
      save: (url, at, result) => store.savePrLookup(url, at, result),
    },
  }, undefined, undefined,
  // D441: reads never wait on GitHub; a finished fetch tells the dashboards to read again.
  (repo) => bb.realtime.publish("merge-queue-changed", { repo }),
  // W548: a landed list is diffed by the PR watches.
  () => prWatcher.poke());
  // W548, W554: a PR an agent watches (initiative_pr_watch) wakes it when it changes on GitHub.
  const watchLedger = new WatchLedger(store.db, () => store.now());
  /** A wake as a lead's more work (initiative_message work:true) from the coordinator, serialized with every other write. */
  const prWatchWork = (projectId: string, workerRef: string, text: string, still: () => void = () => {}) => announcing(() => serialized(async () => {
    // The wake may have stopped applying while earlier writes ran (a mute, a pause, a retire), or
    // while the dispatch reads BB: checked before, and again just before the work is recorded.
    still();
    const project = service.requireProject(projectId);
    const [result] = await service.delegate(projectId, { route: "continue", role: "work", worker: workerRef, note: text, replyTo: project.coordinatorThreadId, ready: still });
    return result!.assignment;
  }), () => projectId);
  const prWatcher = new PrWatcher({
    store,
    ledger: watchLedger,
    cache: mergeQueue,
    sdk: bb.sdk,
    coldCheck: (worker) => service.coldCache.check(worker),
    giveWork: prWatchWork,
    changed: () => bb.realtime.publish("merge-queue-changed", { repo: null }),
    warn: (message) => bb.log.warn(message),
  });
  bb.rpc.register(projectsContract, {
    mergeQueue: async ({ projectId, refresh }) => {
      // W516: the dashboard's read keeps its repositories on the two-minute cadence; agents' reads don't.
      const queue = await mergeQueue.read(projectId, { refresh, viewer: true });
      // From the remotes cache; one never read is looked up behind the answer and announced.
      return { ...queue, initiatives: store.projects().map((p) => ({ id: p.id, name: p.name, repos: mergeQueue.cachedRepos(p.id) })) };
    },
    prOwner: async ({ projectId, url, initiative }) => {
      service.requireProject(projectId);
      const key = canonicalPrUrl(url);
      if (!key) throw new ProjectError("Expected a GitHub PR URL.");
      const id = initiative === null ? null : await prMoveTarget(initiative);
      const target = id === null ? null : initiativeNamed(store, id);
      if (target) prMoveFits(target, key);
      prOwners.move(key, target?.id ?? null, Date.now());
      bb.realtime.publish("merge-queue-changed", { repo: null });
      return { url: key, initiative: target?.name ?? null };
    },
    prNotes: ({ projectId, url }) => {
      service.requireProject(projectId);
      const key = canonicalPrUrl(url);
      if (!key) throw new ProjectError("Expected a GitHub PR URL.");
      return service.prNotes.list(projectId, key);
    },
    prWatch: ({ projectId, url }) => {
      service.requireProject(projectId);
      const key = canonicalPrUrl(url);
      if (!key) throw new ProjectError("Expected a GitHub PR URL.");
      return readPrWatch(store, watchLedger, key);
    },
    prUnwatch: ({ projectId, url }) => {
      service.requireProject(projectId);
      const key = canonicalPrUrl(url);
      if (!key) throw new ProjectError("Expected a GitHub PR URL.");
      if (watchLedger.unwatch(key)) bb.realtime.publish("merge-queue-changed", { repo: null });
      return readPrWatch(store, watchLedger, key);
    },
    prDetail: ({ projectId, url }) => {
      service.requireProject(projectId);
      const key = canonicalPrUrl(url);
      if (!key) throw new ProjectError("Expected a GitHub PR URL.");
      return readPrDetail(store, service.prNotes, projectId, key, mergeQueue.cachedPr(key)?.head ?? null);
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
    childPage: ({ projectId, threadId, offset = 0 }) => {
      service.requireProject(projectId);
      const cache = service.runningChildren;
      // W473: a changed page re-reads only this thread's open trees; the Adventure's views re-read
      // only when the thread's count changed, which its row shows.
      const announce = () => announceChildren(threadId);
      // Never waits on BB: the cached page, or loading.
      const key = `${threadId}:${offset}`;
      const page = childPages.get(key, async () => {
        childPageAnnounced.delete(key);
        const count = cache.childCount(threadId) ?? 0;
        // The first page may be served from the cache: a refresh that changes it announces the
        // tree even when BB's page reads as it did last time.
        const shown = offset === 0 ? JSON.stringify(cache.rows(threadId)) : null;
        const page = await service.childPage(threadId, offset);
        if ((cache.childCount(threadId) ?? 0) !== count) changed(projectId);
        else if (shown !== null && JSON.stringify(cache.rows(threadId)) !== shown) {
          childPageAnnounced.add(key);
          announce();
        }
        childPageEpochs.set(key, page.epoch);
        return { next: page.next, rows: page.rows.map((row) => ({ threadId: row.id, title: row.title ?? row.titleFallback ?? "Thread", status: row.status,
          archived: row.archivedAt !== null, running: row.running, providerId: row.providerId ?? null, updatedAt: row.updatedAt })) };
      }, () => {
        // Once per refresh: one that announced its cache change has already said so.
        if (!childPageAnnounced.delete(key)) announce();
      });
      // W473: the first page of a tree the cache has listed (the prefetch, the sweep, or this read
      // before) comes from the cache, which events keep current, so it opens at once; the read
      // above refreshes it in the background. A first page with a next one, read after the
      // cache's listing (a child moved in without an event), pages from BB.
      const paged = page.status === "ready" && page.value.next !== null && (childPageEpochs.get(key) ?? 0) > (cache.listedAt(threadId) ?? -1);
      const known = offset === 0 && !paged ? cache.rows(threadId) : null;
      const answer = known && known.length < CHILD_PAGE ? { status: "ready" as const, value: { rows: known, next: null } } : page;
      if (answer.status !== "ready") {
        if (offset === 0) awaitingRows.add(threadId);
        return answer;
      }
      if (offset === 0) awaitingRows.delete(threadId);
      // Each child's own count comes from the cache as it stands now, so a tree listed since shows;
      // the children it cannot count yet are listed next, so their toggles show before a click.
      const rows = answer.value.rows.map((row) => ({ ...row, children: cache.childCount(row.threadId) }));
      prefetchChildren(rows.flatMap((row) => row.children === null ? [row.threadId] : []), announce);
      return { ...answer, value: { ...answer.value, rows } };
    },
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
          return announcing(() => serialized(() => service.createLegacyUserThread(projectId, command)), () => projectId);
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
  const runningChildren = service.runningChildren;
  for (const [path, read] of [["/context/v1/thread", (s: Store, q: URLSearchParams) => threadContext(s, q, runningChildren)], ["/context/v1/record", recordText], ["/context/v1/initiatives", initiativesContext], ["/context/v1/members", membersContext]] as const)
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
      throw new ProjectError("Only the coordinator or a current worker records the user's chat answer.");
    if (projectId && projectId !== m.project.id)
      throw new ProjectError("Record answers only for questions in your own Initiative.");
    return {
      projectId: m.project.id,
      recordedBy: {
        author: m.kind === "worker" ? ("worker" as const) : ("coordinator" as const),
        threadId,
        assignment: m.kind === "worker" ? (store.openAssignment(m.project.id, m.workerNum)?.num ?? null) : null,
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
  /**
   * A worker's tools. W492: initiative_message and initiative_pr are offered without the lead's
   * fields (giving work, categories, waitingOn, worker…), which workers kept copying in.
   */
  const WORKER_TOOLS = [
    "initiative_read",
    "initiative_report",
    { name: "initiative_message", parameters: advertisedSchema(workerMessageToolSchema) },
    { name: "initiative_pr", parameters: advertisedSchema(workerPrToolSchema) },
    { name: "initiative_pr_watch", parameters: advertisedSchema(workerPrWatchToolSchema) },
    "initiative_pr_unwatch",
  ];
  const leadTools = [
    "initiative_read",
    "initiative_spawn",
    "initiative_message",
    "initiative_task",
    "initiative_worker",
    "initiative_question",
    "initiative_rule",
    "initiative_update",
    "initiative_manage",
    "initiative_pr",
    "initiative_pr_watch",
    "initiative_pr_unwatch",
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
      const project = store.project(meta.projectId);
      return {
        tools: leadTools,
        skills: ["initiative-coordinator"],
        instructions: assembleInstructions([
          start && ["pending", "uncertain"].includes(start.state)
            ? `You are the pending coordinator of the "${clip80(project?.name ?? meta.projectId)}" Initiative: this thread's checkout is still being proven. Initiative reads and changes need confirmed membership; if it stays unavailable, leave it to the operator. Do not retry the start.`
            : `Your coordinator start did not confirm (state ${start?.state ?? "unknown"}). Initiative reads and changes need confirmed membership. Leave settlement to the operator. Do not retry the start.`,
          leadRulesPointer(store.rulesStamp(meta.projectId)),
        ], guidance().coordinatorInstructions),
      };
    }
    // A user thread can configure before the create RPC's own confirm lands ("discussion": one an
    // older build started before Discussions were removed, R6; it is now an ordinary user thread).
    if (
      isOwnOrigin(bb.pluginId, ctx.origin.pluginId) &&
      (meta.role === "adhoc" || meta.role === "discussion") &&
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
        tools: leadTools,
        skills: ["initiative-coordinator"],
        instructions: assembleInstructions([
          `You are the coordinator of the "${clip80(m.project.name)}" Initiative (${m.project.id}), thread ${ctx.thread.id}.`,
          leadRulesPointer(store.rulesStamp(m.project.id)),
        ], guidance().coordinatorInstructions),
      };
    const pending = m?.worker ? null : pendingMember(ctx);
    const worker = m?.worker ?? pending?.worker;
    const projectId = m?.project.id ?? pending?.project.id;
    if (worker && projectId)
      return {
        tools: WORKER_TOOLS,
        skills: ["initiative-worker"],
        instructions: assembleInstructions([
          `You are ${worker.ref} "${clip80(worker.label)}" (${clip80(worker.area)}), role ${worker.role}${m && !m.former ? "" : " (membership still being confirmed)"}.`,
          workerRulesPointer(store.rulesStamp(projectId)),
        ], guidance().workerInstructions),
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
    const run: ToolExecute = (input, context) => {
      return tool.execute(schema ? parseToolInput(schema, input, tool.name) : input, context);
    };
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
  /** The Initiative a coordinator acts on. */
  const coordinatorProject = async (threadId: string | undefined) => {
    if (!threadId) throw new ProjectError("Use Initiative tools from a BB thread.");
    await ensureMember(threadId);
    return service.coordinatorOf(threadId);
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
    const command = messageCommand(parseToolInput(messageToolSchema, raw, "initiative_message"));
    if (command.action === "message") return service.message(threadId, command);
    const p = await coordinatorProject(threadId);
    // W492: more work for a worker still running its open work, on no task beyond it, is that work's
    // too: it steers in as a message, and the open work's report covers it. Only mid-turn: an idle
    // thread (waiting on its reviewer, say) takes more work the usual way, cold-cache check included.
    if (command.action === "delegate" && command.worker) {
      const worker = /^W(\d+)$/i.exec(command.worker) ? store.worker(p.id, Number(command.worker.slice(1))) : null;
      const open = worker ? store.openAssignment(p.id, worker.num) : null;
      if (worker?.threadId && command.note && open?.state === "running" && open.opState === "done" && !open.cancelRequested && worker.role === "work"
        && (command.tasks ?? []).every((task) => open.taskNums.includes(Number(task.replace(/^T/i, ""))))
        && BUSY_STATUSES.has((await bb.sdk.threads.get({ threadId: worker.threadId })).status))
        return { ...await service.message(threadId, { target: worker.ref, text: command.note }),
          note: `${worker.ref} is still working on ${open.ref}, so this went to it as a steer message; its ${open.ref} report covers it.` };
    }
    // Work for a reviewer is refused: each review round gets a fresh reviewer (W239).
    return perform(p.id, command, "coordinator", threadId);
  };
  const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  /** W215: write tools answer with a short receipt; initiative_read has the full records. */
  const receipt = (value: unknown) => JSON.stringify(toolReceipt(value));
  registerTool({
    name: "initiative_spawn",
    parameters: jsonSchema(spawnToolAdvertised),
    description: 'Give one PR (or a few small related ones) to a new worker, which implements, reviews with its own reviewers and reports once: {label:"Search index",purpose:"search ranking",text:"<the brief>",tasks:["T40"]}. Its reports come back to this tab. It runs in the project\'s checkout on its default host; host:"<name or id>" picks another host, worktree:true a new worktree there (environment is a deprecated alias of both). The result lists warnings, such as another writer in the same checkout.',
    async execute(raw, { threadId }) {
      const p = await coordinatorProject(threadId);
      return receipt(await perform(p.id, spawnCommand(parseToolInput(spawnToolSchema, raw, "initiative_spawn")), "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_message",
    parameters: jsonSchema(messageToolAdvertised),
    description: 'One message to a worker (W#), your lead ("lead", for a worker) or the coordinator tab: {to:"W4",text:"…"}. From a lead, tasks:["T41"] or work:true gives the worker more work (it reports again; the message carries the current worker loop and rules); a plain message corrects work in progress. A lead\'s message to a worker always steers (it arrives mid-turn, in order); a worker that has not started yet receives it once it starts. Messages never resume a stopped or retired worker.',
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Message from a current Initiative thread.");
      return receipt(await sendMessage(raw, threadId));
    },
  });
  registerTool({
    name: "initiative_task",
    parameters: jsonSchema(taskToolAdvertised),
    description: 'Optional tasks; their status follows their work and PRs. {action:"create",title,text?} · {action:"update",task:"T4",title?,text?,note?} · only when the user asks: {action:"status",task:"T4",status:"planned"|"cancelled"|"done"|"auto",reason:"<the user\'s words>"} sets it by hand (cancelled stops its running work; auto follows the work again).',
    async execute(raw, { threadId }) {
      const legacy = await legacyCommand(raw, threadId!, ["task-create", "task-update", "task-cancel", "task-reopen", "assignment-stop", "assignment-settle", ...Object.keys(REMOVED_ACTIONS)]);
      if (legacy) return legacy;
      const p = await coordinatorProject(threadId);
      return receipt(await perform(p.id, taskCommand(parseToolInput(taskToolSchema, raw, "initiative_task")), "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_worker",
    parameters: jsonSchema(workerToolSchema),
    description: 'Retire a finished worker ({action:"retire",worker:"W4"}; once its turn has ended and its children are quiet; its reports stay readable), stop it and its running children ({action:"stop",worker:"W4",reason}), or adopt an existing thread as a worker ({action:"adopt",threadId,label,purpose}; it gets one open assignment and the worker loop, and finishes with initiative_report).',
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
      const command = workerCommand(parseToolInput(workerToolSchema, raw, "initiative_worker"));
      if (command.action === "worker-stop")
        return receipt(await perform(p.id, { action: "worker-stop", worker: command.worker, reason: command.reason }, "coordinator", threadId!));
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
      return JSON.stringify(await perform(p.id, manageCommand(parseToolInput(manageToolSchema, raw, "initiative_manage")), "coordinator", threadId!));
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
      return JSON.stringify(await perform(p.id, parseToolInput(delegateSchema, { action: "delegate", ...(raw as object) }, "initiative_delegate"), "coordinator", threadId!));
    },
  });
  registerTool({
    name: "initiative_decision",
    // Plain JSON Schema with an object root: Claude's bridge blanks union roots. Validation is
    // parseDecisionCommand, shared with the CLI, so every refusal carries a valid example.
    parameters: decisionToolJsonSchema as Record<string, unknown>,
    description: 'Older sessions only. Questions: initiative_question. A lasting choice of the user: initiative_rule add. A choice about one PR: a note with initiative_pr. A choice the user may reverse: say "Reversible: …" in your update.',
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Record decisions from an Initiative thread.");
      await ensureMember(threadId);
      // v9 (D518): parseDecisionCommand refuses the retired decision log with where each choice goes now.
      const input = parseDecisionCommand(raw);
      if (input.action === "answer") {
        const { projectId, recordedBy } = chatAnswerRecorder(threadId);
        const answered = await service.answerOpinion(projectId, input.decision, input, recordedBy);
        return JSON.stringify({ ref: answered.ref, madeBy: answered.madeBy, status: answered.status, notification: answered.notification });
      }
      const { projectId, recordedBy: provenance } = chatAnswerRecorder(threadId);
      let result;
      if (input.action === "question") {
        if (provenance.author !== "coordinator") throw new ProjectError("Ask the user questions through your lead, or report blocked with the question.");
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
  registerTool({
    name: "initiative_question",
    parameters: jsonSchema(questionToolSchema),
    description: 'Ask the user a real open choice (never inferred from prose): {question,context,options?:[{label,consequences}],recommendation?}. It shows in the Inbox; the answer comes back to this tab. {withdraw:"D12",reason} retracts your own open question. {answered:"A31",question:"<the blocker\'s question, as the user answered it>",text:"<the user\'s words>"} (coordinator tab only) records on its Inbox card the answer the user gave you in chat to the blocker a worker reported on A31, which clears it from Needs you; use it only after the user actually answered that question, never for your own guess. It sends nothing: then continue the worker as usual (initiative_message work:true). Decide routine things yourself.',
    async execute(raw, { threadId }) {
      const p = await coordinatorProject(threadId);
      const input = parseToolInput(questionToolSchema, raw, "initiative_question");
      const provenance = { author: "coordinator" as const, threadId: threadId!, assignment: null };
      if (input.answered) {
        if (input.context || input.options || input.recommendation || input.withdraw || input.reason) throw new ToolInputError("answered records an answer; ask or withdraw in a separate call.");
        if (!input.question) throw new ToolInputError("answered needs question: the blocker's question the user answered, as written on its report.");
        if (!input.text) throw new ToolInputError("answered needs text: what the user said, quoted or faithfully summed up.");
        if (!/^A\d+$/i.test(input.answered)) throw new ToolInputError(`answered takes the A# of the blocked report (from "W12 reported (blocked) on A301"); got ${input.answered}.`);
        const recorded = await service.recordChatBlockerAnswer(p.id, input.answered, input.question, input.text, provenance);
        return receipt({ ref: recorded.ref, status: recorded.status });
      }
      if (input.withdraw) {
        if (!input.reason) throw new ToolInputError("withdraw needs a reason: why the user no longer needs to answer.");
        const withdrawn = service.withdrawQuestion(p.id, input.withdraw, input.reason, provenance);
        return receipt({ ref: withdrawn.ref, status: withdrawn.status });
      }
      if (!input.question || !input.context) throw new ToolInputError("A question needs question and context.");
      const question = parseDecisionCommand({ action: "question", question: input.question, context: input.context,
        ...(input.options ? { options: input.options } : {}), ...(input.recommendation ? { recommendation: input.recommendation } : {}) });
      if (question.action !== "question") throw new ToolInputError("A question needs question and context.");
      const result = service.recordQuestion(p.id, question.question, provenance);
      return receipt({ ref: result.ref, status: result.status });
    },
  });
  registerTool({
    name: "initiative_rule",
    parameters: jsonSchema(ruleToolSchema),
    description: 'The standing rules every lead and worker follows (initiative_read {view:"rules"}). Add one when the user states a lasting choice: {action:"add",text:"One or two sentences."}; edit or remove one only when the user asks: {action:"edit",rule:"R5",text} · {action:"remove",rule:"R5"}. Each change is announced to the workers with open work; the result names them.',
    async execute(raw, { threadId }) {
      const p = await coordinatorProject(threadId);
      return receipt(await perform(p.id, ruleCommand(parseToolInput(ruleToolSchema, raw, "initiative_rule")), "coordinator", threadId!));
    },
  });
  /** initiative_pr and `bb initiative pr`: record PR stages, categories and notes, in one transaction. */
  const setPrStages = async (projectId: string, raw: unknown, tool: string, caller: PrCaller) => {
    const input = parseToolInput(prToolSchema, raw, tool);
    service.requireProject(projectId);
    // Destinations by id from here, so a rename while their repositories are looked up changes nothing.
    const prs = input.prs && await Promise.all(input.prs.map(async (pr) => (pr.initiative ? { ...pr, initiative: await prMoveTarget(pr.initiative) } : pr)));
    const owners = { move: prOwners.move.bind(prOwners), fits: prMoveFits };
    const result = store.db.transaction(() => recordPrs(store, service.prNotes, projectId, { ...input, prs }, Date.now(), caller, owners))();
    if (input.prs?.some((pr) => pr.initiative !== undefined)) bb.realtime.publish("merge-queue-changed", { repo: null });
    return result;
  };
  /**
   * D442: a worker keeps the PRs its assignments name, the coordinator gave it, or its branch
   * opened. W492: and a PR no one else holds, which it then holds: most branches don't name
   * their thread, and a PR opened a minute ago isn't in the cache yet.
   */
  const workerCaller = (projectId: string, worker: { num: number; ref: string; threadId: string | null }, threadId: string): PrCaller => ({
    author: worker.ref,
    threadId,
    worker: {
      ref: worker.ref,
      heldBy: (url) => {
        const recorded = store.prRecords(projectId).get(url)?.worker ?? null;
        if (assignedPrs.ofWorker(projectId, worker.num).has(url) || recorded === worker.ref) return null;
        const head = mergeQueue.cachedPr(url)?.head;
        const opener = head ? branchThreadId(head) : null;
        if (opener && opener === worker.threadId) return null;
        if (recorded) return `${recorded} holds it`;
        // F4: a PR a standing rule names is every worker's reference and none's to change.
        const rule = store.rules(projectId).find((r) => prsReferenced(r.text).includes(url));
        if (rule) return `${rule.ref} names it`;
        const named = assignedPrs.referencing(projectId, url);
        if (named) return `${named.worker}'s ${named.assignment} names it`;
        const other = opener ? store.membership(opener)?.worker : null;
        if (other) return `${other.ref}'s branch opened it`;
        // Nor one another Adventure holds: its records, its owner (R2) or its assignments.
        const name = (id: string) => store.project(id)?.name ?? id;
        const elsewhere = store.prHolders(url).find((h) => h.projectId !== projectId && store.project(h.projectId)?.archivedAt === null);
        if (elsewhere) return `${elsewhere.worker} in ${name(elsewhere.projectId)} holds it`;
        const owner = prOwners.all().get(url)?.projectId;
        if (owner && owner !== projectId && store.project(owner)?.archivedAt === null) return `${name(owner)} owns it`;
        const mentioned = store.projects().find((p) => p.id !== projectId && assignedPrs.referencing(p.id, url));
        return mentioned ? `${assignedPrs.referencing(mentioned.id, url)!.worker} in ${mentioned.name} works on it` : null;
      },
    },
  });
  registerTool({
    name: "initiative_pr",
    parameters: jsonSchema(prToolSchema),
    description: 'Keep each pull request\'s record and notes, several PRs per call, every field but url optional. Anyone: {prs:[{url:"https://github.com/o/r/pull/12",stage:"ready-for-erwin",note:"Clean review r2",notes:[{kind:"question",text:"No migration test?"}]}]}. Workers do only that, and initiative, on their own PRs: those their assignment names, they opened, or no one else holds. Leads also set category, waitingOn, changes, decision, worker and answered: {prs:[{url,category:"Security",waitingOn:"W14: move the lock",changes:["drop the retry"],decision:{text:"Keep 5m TTL",link:"D437"},worker:"W14",answered:[{n:3,text:"Yes"}]}]}. Only given fields change; null clears one. stage clear removes yours (the dashboard guesses from GitHub again). category is a free-form workstream: reuse one from the result\'s categories; {rename:[{from:"Sec",to:"Security"}]} renames or merges. changes replaces the list. notes append to the PR\'s log (the result numbers them n); answered closes questions by n. An assignment (A#) names its worker. initiative:"Equisafe UI" (a name or id) moves the PR to that Adventure, null unassigns it: a PR is listed by its one owner, or by every Adventure under Unassigned; a worker\'s PR is its Adventure\'s unless moved.',
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Use Initiative tools from a BB thread.");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (m && !m.former && m.workerNum > 0 && m.worker) {
        const { project, worker } = service.workerOf(threadId);
        return receipt(await setPrStages(project.id, raw, "initiative_pr", workerCaller(project.id, worker, threadId)));
      }
      const p = await coordinatorProject(threadId);
      return receipt(await setPrStages(p.id, raw, "initiative_pr", { ...COORDINATOR, threadId }));
    },
  });
  /** W554: the PR a watch tool names: a URL or owner/repo#12, else "#12" or "repo#12" among the PRs this Adventure lists. */
  const watchedPr = async (projectId: string, pr: string) => {
    const url = canonicalPrUrl(pr);
    if (url) return url;
    const matches = matchesRef(pr);
    if (!matches) throw new ToolInputError(`"${pr}" names no PR: give its URL, "owner/repo#12" or "#12".`);
    const found = (await mergeQueue.read(projectId)).pullRequests.filter(matches);
    if (found.length !== 1)
      throw new ToolInputError(found.length
        ? `"${pr}" matches ${found.length} PRs (${found.map((p) => `${p.repo}#${p.number}`).join(", ")}): give its URL.`
        : `"${pr}" matches no PR this Adventure lists: give its URL.`);
    return canonicalPrUrl(found[0]!.url)!;
  };
  /** W554: whose watch a watch tool call is: a worker's own; a lead's own, or with `worker` that worker's thread's. */
  const watchCaller = async (threadId: string | undefined, worker: string | undefined) => {
    if (!threadId) throw new ProjectError("Use Initiative tools from a BB thread.");
    await ensureMember(threadId);
    const m = store.membership(threadId);
    if (m && !m.former && m.workerNum > 0 && m.worker) {
      if (worker && worker !== m.worker.ref) throw new ToolInputError(`Workers watch for themselves; only your lead watches a PR for ${worker}.`);
      return { projectId: m.project.id, threadId, label: m.worker.ref, worker: true };
    }
    const p = await coordinatorProject(threadId);
    if (!worker) return { projectId: p.id, threadId, label: "the coordinator", worker: false };
    const w = /^W\d+$/.test(worker) ? store.worker(p.id, Number(worker.slice(1))) : null;
    if (!w) throw new ToolInputError(`${worker} is no worker of this Adventure.`);
    if (w.role !== "work" || w.state === "retired" || !w.threadId)
      throw new ToolInputError(`${worker} can't take a PR's news (${w.role !== "work" ? "a reviewer" : w.state === "retired" ? "retired" : "no thread yet"}): watch it yourself, or for a working worker.`);
    return { projectId: p.id, threadId: w.threadId, label: w.ref, worker: false };
  };
  registerTool({
    name: "initiative_pr_watch",
    parameters: jsonSchema(prWatchToolSchema),
    description: 'Watch a pull request: the plugin wakes this thread when it changes on GitHub (checks failing, required checks passing, new comments or reviews by others, a conflict, no check 15 min after a push) until it merges or closes, or you unwatch it. Call it after you open or push a PR: {pr:"https://github.com/o/r/pull/12"}. It answers with the PR\'s state now (checks, review decision, conflicts, unresolved threads): only later changes wake, so act on what it shows. One watcher per PR; a new watch replaces the old. A lead may watch for a worker: {pr, worker:"W3"}.',
    async execute(raw, { threadId }) {
      const input = parseToolInput(prWatchToolSchema, raw, "initiative_pr_watch");
      const caller = await watchCaller(threadId, input.worker);
      const url = await watchedPr(caller.projectId, input.pr);
      const { facts, replaced } = await prWatcher.watch(url, caller.projectId, caller.threadId);
      const was = replaced?.watcher && replaced.watcher !== caller.threadId && !replaced.state?.ended
        ? `${watcherLabel(store, watchLedger, replaced.projectId, replaced.watcher)}${replaced.projectId === caller.projectId ? "" : ` (${store.project(replaced.projectId)?.name ?? replaced.projectId})`}`
        : null;
      return JSON.stringify(watchAnswer(url, facts, caller.worker || !input.worker ? "you" : caller.label, was));
    },
  });
  registerTool({
    name: "initiative_pr_unwatch",
    parameters: jsonSchema(prUnwatchToolSchema),
    description: 'Stop watching a pull request, for example once you hand it off or stop caring: {pr}. A worker unwatches its own watches; a lead, any of its Adventure\'s.',
    async execute(raw, { threadId }) {
      const input = parseToolInput(prUnwatchToolSchema, raw, "initiative_pr_unwatch");
      const caller = await watchCaller(threadId, undefined);
      const url = await watchedPr(caller.projectId, input.pr);
      const row = watchLedger.row(url);
      if (!row?.watcher) {
        // A W548 row its Adventure's lead unwatches stays unwatched after a rollback too.
        if (row && !row.muted && !caller.worker && row.projectId === caller.projectId) watchLedger.unwatch(url);
        return JSON.stringify({ url, unwatched: false, note: "Nobody watches it." });
      }
      const label = watcherLabel(store, watchLedger, row.projectId, row.watcher);
      if (caller.worker ? row.watcher !== caller.threadId : row.projectId !== caller.projectId)
        throw new ProjectError(`${label}${row.projectId === caller.projectId ? "" : ` of ${store.project(row.projectId)?.name ?? row.projectId}`} watches ${url}; ${caller.worker ? "only your lead unwatches it for them" : "only its own Adventure unwatches it"}.`);
      if (!watchLedger.unwatch(url, row.watcher)) return JSON.stringify({ url, unwatched: false, note: "Its watch changed meanwhile; read it again." });
      bb.realtime.publish("merge-queue-changed", { repo: null });
      return JSON.stringify({ url, unwatched: true, ...(row.watcher === caller.threadId ? {} : { was: label }) });
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
      const input = parseToolInput(updateToolSchema, raw, "initiative_update");
      return receipt(
        await perform(
          m.project.id,
          parseToolInput(updateSchema, { action: "update", ...input }, "initiative_update"),
          m.workerNum === 0 ? "coordinator" : "user",
          threadId,
        ),
      );
    },
  });
  registerTool({
    name: "initiative_read",
    description: 'Read the Initiative. {} is the overview; {view:"rules"} the standing rules; {refs:["W12","T40","A301"]} reads exact records (a W# with its latest report); {view:"workers"} and the other views list records, limit 1..30, offset to page; {view:"prs"}: what the user can review next, open PRs by category and stage, their stacks, and the state of those needing action (a question, changes, a wait), paged by offset; category:"CI" or stage:"in-review" lists a slice with every PR\'s state (unassigned:true: the PRs no Adventure owns), refs:["#2273","infra#12"] reads whole PRs, paged the same way (a PR too long to fit comes back compact with clipped:true). detailed:true gives full records; fields picks parts, e.g. {refs:["W12","D4"],fields:["report","body"]}, each record the ones it has. Reading never wakes agents.',
    parameters: jsonSchema(agentReadAdvertised),
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Use initiative_read from an Initiative thread.");
      const input = parseToolInput(agentReadSchema, raw, "initiative_read");
      await ensureMember(threadId);
      const m = store.membership(threadId);
      if (!m) {
        const pending = service.pendingCoordinatorIdentity(threadId, await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId }).catch(() => ({})) as Record<string, unknown>);
        if (pending) return JSON.stringify(pending);
        throw new ProjectError("This thread does not belong to an Initiative.");
      }
      const { view, category, stage, unassigned, ...rawOptions } = input;
      const options = parseToolInput(readOptionsSchema, rawOptions, "initiative_read");
      if ((category !== undefined || stage !== undefined || unassigned !== undefined) && (view !== "prs" || options.refs))
        throw new ToolInputError('category, stage and unassigned select a slice of view prs without refs, for example initiative_read {view:"prs",category:"CI"}.');
      if (view === "overview" && Object.keys(rawOptions).length)
        throw new ToolInputError(`overview has no ${Object.keys(rawOptions).join(", ")} selectors. Omit view for refs, or select a collection such as workers or reports.`);
      if (!view && !options.refs && Object.keys(rawOptions).length)
        throw new ToolInputError(`Selectors (${Object.keys(rawOptions).join(", ")}) need a view or refs, and this call has neither. Add view (${READ_VIEWS.join(", ")}) or refs.`);
      // PR refs (#12, infra#12, a URL) read like view prs refs, durable refs (T/W/A/D/U) as records.
      if (!view && options.refs?.some(isPrRef)) return JSON.stringify(readMixedRefs(store, m.project.id, options, await mergeQueue.read(m.project.id)));
      if (!view && options.refs || view === "records") return JSON.stringify(readRefs(store, m.project.id, options));
      if (!view || view === "overview") return JSON.stringify(compactOverview(store, m.project.id));
      if (view === "threads") return JSON.stringify(await readThreads(m.project.id, options));
      if (view === "context") return JSON.stringify(readContext(store, m.project.id));
      if (view === "rules") return JSON.stringify(readRules(m.project.id));
      // W492: a thread without chat memory (every worker) is told so, not answered with Chat memory's HTTP 500.
      if (view === "memory") return JSON.stringify(await chatMemory("read", { threadId }, z.object({ messages: z.number(), view: z.string(), note: z.string() })).catch((error) => {
        if (!/no chat memory/i.test(errorMessage(error))) throw error;
        return { messages: 0, view: "", note: m.worker
          ? `Workers have no chat memory: your brief and messages are in this thread. initiative_read {refs:["${m.worker.ref}"],fields:["brief"]} reads your latest brief.`
          : "This thread has no chat memory: turn it on in the thread's Memory panel." };
      }));
      if (view === "prs") {
        const queue = await mergeQueue.read(m.project.id);
        const page = { offset: options.offset, limit: options.limit };
        return JSON.stringify(options.refs ? prsByRef(queue, options.refs, page) : prSummary(queue, { category, stage, unassigned, ...page }));
      }
      return JSON.stringify(read(m.project.id, view, options));
    },
  });
  const batchSchema = z.object({
    actions: z.array(z.object({ tool: z.enum(BATCH_TOOLS) }).passthrough()).min(1).max(20),
  }).strict();
  registerTool({
    name: "initiative_batch",
    parameters: jsonSchema(batchSchema),
    description: 'Several Initiative actions in one call, run in order; one failing never stops the rest. Each is {tool, ...that tool\'s arguments}: {actions:[{tool:"rule",action:"add",text:"…"},{tool:"message",to:"W12",text:"…"}]}. Returns one result per action. Leads only.',
    async execute(raw, context) {
      await coordinatorProject(context.threadId);
      const { actions } = parseToolInput(batchSchema, raw, "initiative_batch");
      type Result = { tool: string; ok: boolean; result?: unknown; error?: string; omitted?: true; reason?: string; [key: string]: unknown };
      // Every action runs first; the response is built afterwards.
      const full: Result[] = [];
      for (const [index, { tool, ...args }] of actions.entries()) {
        const began = performance.now();
        try {
          const out = await handlers.get(`initiative_${tool}`)!(args, context);
          let result: unknown = out;
          if (typeof out === "string") try { result = JSON.parse(out); } catch { /* plain text result */ }
          // W215: a write's receipt sits flat in its entry, {tool,ok,ref,state}; a read stays under result.
          if (tool !== "read" && Array.isArray(result) && result.length === 1) result = result[0];
          const flat = tool !== "read" && !!result && typeof result === "object" && !Array.isArray(result) && !("tool" in result) && !("ok" in result);
          full.push(flat ? { tool, ok: true, ...(result as Record<string, unknown>) } : { tool, ok: true, result });
        } catch (error) {
          // T147: an argument error keeps its message, led by the action it belongs to.
          full.push({ tool, ok: false, error: `${error instanceof ToolInputError ? `actions[${index}]: ` : ""}${errorMessage(error)}` });
        }
        // W514: an action over a second is logged once; a retire adds its own step breakdown line.
        const took = performance.now() - began;
        if (took > SLOW_CALL_MS) bb.log.warn(`Slow batch action ${index + 1} of ${actions.length} (${tool}${typeof args.action === "string" ? ` ${args.action}` : ""}): ${Math.round(took)} ms`);
      }
      // One budget for the complete serialized response, the size of a single read. Every error is
      // admitted first, clipped to a fixed size, so a failure is never left out for a payload; the
      // successful results then take what remains, in order, each only when the whole response
      // (envelope, note, separators) still fits.
      const capped = (entry: Result): Result => ({ tool: entry.tool, ok: true, omitted: true, reason: `result left out: the batch response is capped at ${MAX_READ_BYTES / 1024} KiB` });
      const shown = full.map(entry => entry.ok ? capped(entry) : { ...entry, error: clipBytes(entry.error!, MAX_ERROR_BYTES) });
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
        if (!entry.ok) continue;
        shown[index] = entry;
        if (Buffer.byteLength(render()) > MAX_READ_BYTES) shown[index] = capped(entry);
      }
      return render();
    },
  });
  /** initiative_report and `bb initiative report`: W492 reads what it can (normalizeReport) and says so. */
  const shortReport = async (threadId: string, raw: unknown, tool: string) => {
    const normalized = normalizeReport(raw);
    const result = await service.shortReport(threadId, parseToolInput(reportToolSchema, normalized.raw, tool));
    if (!normalized.notes.length) return result;
    return { ...result, note: [result.note, ...normalized.notes].filter(Boolean).join(" ") };
  };
  registerTool({
    name: "initiative_report",
    description: 'Finish with this: {outcome:"done"|"blocked"|"failed",summary,report}. The coordinator gets summary (which must stand on its own: outcome, PR URL and head, merge order, what you need) and reads report, your full report, on demand; a short report is sent whole. blocked waits on your lead; when only the user can answer, add question, options [{label,consequences}] and recommendation (starting with its label), and the user picks one in the Inbox.',
    parameters: jsonSchema(reportToolSchema),
    async execute(raw, { threadId }) {
      if (!threadId) throw new ProjectError("Report from the worker thread.");
      await ensureMember(threadId);
      // An older session's full structured report still records as it always did.
      if (typeof raw === "object" && raw !== null && "handoff" in raw)
        return JSON.stringify(await service.report(threadId, parseToolInput(reportSchema.safeExtend({ assignment: z.string().optional() }), raw, "initiative_report")));
      return JSON.stringify(await shortReport(threadId, raw, "initiative_report"));
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
      { name: "describe", summary: "Show short valid JSON examples for commands and reads", usage: "bb initiative describe [read|spawn|work-message|fresh-with-handoff|message|task-status|rule|question|answer|quiet-answer|withdraw|handover|<initiative_tool>]" },
      { name: "list", summary: "List initiatives", usage: "bb initiative list" },
      { name: "rules", summary: "Import a standing-rules file (the live list becomes exactly the file's; the previous list is written next to it as rules-before-<time>.md, the undo) or export the list", usage: "bb initiative rules import <initiative-id> <file> | bb initiative rules export <initiative-id> [file]" },
      {
        name: "overview",
        summary: "Read the four-part initiative overview",
        usage: "bb initiative overview [initiative-id]",
      },
      {
        name: "read",
        summary: "Read a stored collection",
        usage:
          "bb initiative read <records|rules|tasks|workers|reports|assignments|decisions|updates|activity|usage|threads> [initiative-id] [options-json]; records takes mixed refs. The coordinator's memory: bb chat-memory",
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
        summary: "Report from the current worker thread: {outcome:\"done\"|\"blocked\"|\"failed\",summary,report,question?}",
        usage: "bb initiative report '{\"outcome\":\"done\",\"summary\":\"…\",\"report\":\"…\"}'",
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
          result = list();
        else if (action === "overview" && args.length <= 2)
          result = ctx.threadId ? compactOverview(store, value ?? member?.project.id ?? "") : await overview(value ?? member?.project.id ?? "");
        else if (action === "read" && args.length <= 4) {
          const view = z.enum(["records", "rules", ...READ_VIEWS]).parse(value);
          const options = readOptionsSchema.parse(args[3] ? JSON.parse(args[3]) : {});
          result = view === "rules" ? readRules(id ?? "")
            : view === "records" ? readRefs(store, id ?? "", options)
            : view === "threads" ? await readThreads(id ?? "", options)
            : read(id ?? "", view, options);
        } else if (action === "message" && value && args.length === 2) {
          if (!ctx.threadId) throw new ProjectError("Message from a current managed Initiative thread.");
          result = await sendMessage(JSON.parse(value), ctx.threadId);
        } else if (action === "command" && value && args.length <= 3) {
          const command = parseCommandInput(JSON.parse(value));
          if (
            ctx.threadId &&
            ["acknowledge", "decision-review", "question-close", "inbox-dismiss-all"].includes(command.action)
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
                throw new ProjectError("Only the coordinator manages work from an agent CLI.");
              if (id !== member.project.id)
                throw new ProjectError("A coordinator cannot manage another initiative through its agent CLI.");
            }
            result = await perform(id, command, ctx.threadId ? "coordinator" : "user", ctx.threadId ?? null);
          }
        } else if (action === "pr" && value && args.length <= 3) {
          if (ctx.threadId) {
            if (!member || member.former || member.workerNum < 0)
              throw new ProjectError("Only the coordinator or a worker sets PR stages from an agent CLI.");
            if (id !== member.project.id)
              throw new ProjectError("A thread cannot set another initiative's PR stages.");
          }
          if (!id) throw new ProjectError("Pass the initiative id: bb initiative pr '<json>' <initiative-id>.");
          // v9: an adopted worker whose tools predate the switch keeps its PRs from the shell.
          result = ctx.threadId && member?.worker
            ? await setPrStages(id, JSON.parse(value), "bb initiative pr", workerCaller(id, service.workerOf(ctx.threadId).worker, ctx.threadId))
            : await setPrStages(id, JSON.parse(value), "bb initiative pr", ctx.threadId ? { ...COORDINATOR, threadId: ctx.threadId } : { ...COORDINATOR, author: "user" });
        } else if (
          action === "report" &&
          value &&
          args.length === 2 &&
          ctx.threadId
        ) {
          const raw = JSON.parse(value);
          // The short form, as initiative_report takes it, or an older session's full report.
          if (typeof raw === "object" && raw !== null && "handoff" in raw)
            result = await service.report(ctx.threadId, reportSchema.safeExtend({ assignment: z.string().optional() }).parse(raw));
          else {
            result = await shortReport(ctx.threadId, raw, "bb initiative report");
          }
        } else if (action === "rules" && (value === "import" || value === "export") && args.length >= 3 && args.length <= 4) {
          // v9: `rules import <id> <file>` makes the live list exactly the file's, after writing the
          // current one to rules-before-<time>.md next to it (importing that is the exact undo).
          const [, , projectId, file] = args as [string, string, string, string | undefined];
          if (ctx.threadId && !(member && !member.former && member.workerNum === 0 && member.project.id === projectId))
            throw new ProjectError("Import or export rules from a terminal or the coordinator of that Initiative.");
          if (value === "export") {
            const text = service.exportRules(projectId);
            if (file) writeFileSync(resolvePath(file), text);
            result = file ? { written: resolvePath(file) } : text;
          } else {
            if (!file || !existsSync(resolvePath(file))) throw new ProjectError("Name the rules file: bb initiative rules import <initiative-id> <file>.");
            const path = resolvePath(file);
            const before = join(dirname(path), `rules-before-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
            writeFileSync(before, service.exportRules(projectId));
            result = { ...(await service.importRules(projectId, readFileSync(path, "utf8"), ctx.threadId ?? null)), undo: `bb initiative rules import ${projectId} ${before}` };
          }
        } else if (action === "reconcile" && args.length === 1) {
          result = await service.reconcile();
        } else if (action === "recreate-coordinators") {
          // Archived Initiatives included: their workers are no terminals either.
          const caller = ctx.threadId ? store.membership(ctx.threadId, true) : null;
          if (caller && (caller.former || caller.workerNum !== 0))
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
  // W545: a worker's reviewer that a usage limit or an unavailable model stops is rerun on the
  // fallback reviewer by the plugin. thread.failed carries the error text; turn.failed the
  // classification of a request refused at the door.
  const reviewerFallback = new ReviewerFallback({
    sdk: bb.sdk,
    store,
    policy: async (projectId) => withProfileDefaults(store.project(projectId)?.policy ?? { profiles: {} }, await preferences.read()),
    warn: (message) => bb.log.warn(message),
  });
  bb.events.on("thread.failed", ({ thread, error }) => reviewerFallback.onFailed(thread.id, { error, parentThreadId: thread.parentThreadId }));
  bb.events.on("turn.failed", ({ threadId, errorInfo, rateLimits }) =>
    reviewerFallback.onFailed(threadId, { errorInfo, rateLimitBlocked: rateLimits?.status === "blocked" }));
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
    bb.events.on(name, ({ thread }) => {
      liveThreads.observe(thread);
      runningChildren.observe(thread);
      // W496: an archived or deleted nested thread is no longer read for the dashboard; an
      // unarchived one is again.
      if (name === "thread.unarchived") store.reviveNestedThread(thread.id);
      else if (name === "thread.archived" || name === "thread.deleted") endNested(thread.id, liveOf(thread));
    });
  bb.events.on(
    "message.dispatched",
    event(({ entry }) => runtime.onMessageDispatched(entry.id)),
  );
  bb.events.on(
    "message.cancelled",
    event(({ entry }) => runtime.onMessageCancelled(entry.id)),
  );
  // W548: a pass of the PR watches every WATCH_TICK_MS; one also follows each list that lands.
  bb.background.service("initiatives-pr-watch", {
    async start(signal) {
      try {
        prWatcher.recover();
      } catch (error) {
        bb.log.warn(`PR watch recovery failed: ${errorMessage(error)}`);
      }
      while (!signal.aborted) {
        await prWatcher.check();
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, WATCH_TICK_MS);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
      prWatcher.stop();
    },
  });
  bb.background.service("initiatives-sweep", {
    async start(signal) {
      runtime.start(signal);
      // W545: a reviewer switch the previous load cut short goes back to its worker.
      void reviewerFallback.recover().catch((error) => bb.log.warn(`Reviewer fallback recovery failed: ${errorMessage(error)}`));
      // v9 (§12): a load that follows the previous build's activity tells the coordinators once.
      await announcing(() => service.runCutover()).catch((error) => bb.log.warn(`Cutover check failed: ${errorMessage(error)}`));
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
  return { service, store, runtime, perform: command, overview, tree, preferences, prWatcher, prWatchWork, mergeQueue };
}
