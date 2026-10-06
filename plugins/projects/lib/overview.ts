import { isAcceptableAgentDecision } from "./decision-eligibility";
import { BUSY_STATUSES } from "./bb";
import { describeProfile } from "./policy";
import { buildUsage, unloadedUsage, type InitiativeUsage } from "./usage";
import type {
  Decision,
  Policy,
  ProjectContext,
  Role,
  TaskStatus,
} from "./schema";
import type {
  AssignmentRecord,
  DecisionRecord,
  Provenance,
  Store,
  TaskRecord,
  WorkerRecord,
} from "./store";
import { taskRef, workerRef } from "./store";

// The dashboard model. Built only from stored records and BB thread status;
// building it never wakes the coordinator. Native status is the liveness
// source: the ledger records assignment state, not worker liveness.

export interface LiveThread {
  status: string;
  archived: boolean;
  title: string | null;
  environmentId?: string | null;
  projectId?: string | null;
  parentThreadId?: string | null;
}

/**
 * The Initiative's coordinator home: the primary member project's default
 * source checkout. Derived per refresh from native project/environment
 * facts; `mismatch` is the honest description of any gap between the live
 * coordinator and that home.
 */
export interface CoordinatorHome {
  bbProjectId: string;
  hostId: string | null;
  environmentId: string | null;
  name: string | null;
  path: string | null;
  mismatch: string | null;
}

export interface TaskLink {
  ref: string;
  title: string;
}

export interface InFlightItem {
  assignment: string;
  role: Role;
  outcome: string;
  tasks: TaskLink[];
  owner: {
    worker: string;
    label: string;
    threadId: string | null;
    profile: string;
  };
  state: AssignmentRecord["state"];
  checkpoint?: AssignmentRecord["checkpoint"];
  threadBusy: boolean;
  progress: string;
  nextCheckpoint: string;
  warnings: string[];
  since: number;
}

/** A report the coordinator has not accepted or rejected yet. */
export interface AwaitingItem {
  assignment: string;
  role: Role;
  tasks: TaskLink[];
  owner: { worker: string; label: string; threadId: string | null };
  outcome: string;
  summary: string;
  reportedAt: number | null;
  checkpoint?: AssignmentRecord["checkpoint"];
}

export interface RemainingItem {
  ref: string;
  title: string;
  summary: string;
  status: TaskStatus;
  priority: number;
  owner: string | null;
  why: string;
  updatedAt?: number;
}

export interface OpinionItem {
  ref: string;
  title: string;
  question: string;
  context: string;
  options: { label: string; consequences: string }[];
  recommendation: string | null;
  blocks: TaskLink[];
  askedAt: number;
}

export interface RevisitItem {
  ref: string;
  title: string;
  outcome: string;
  rationale: string;
  context: string | null;
  tradeoff: string | null;
  revisitReason: string;
  deadline: string | null;
  decidedAt: number;
}

/** A needs-opinion decision the user answered; rendered as their own words. */
export interface AnsweredItem {
  ref: string;
  title: string;
  question: string;
  context: string | null;
  options: { label: string; consequences: string }[];
  recommendation: string | null;
  choice: string | null;
  note: string;
  answeredAt: number;
  /** Set when the user answered in an agent's chat and that agent recorded it. */
  recordedBy: "coordinator" | "worker" | null;
}

export interface WorkerItem {
  ref: string;
  label: string;
  role: Role;
  area: string;
  bbProjectId: string;
  threadId: string | null;
  generation: number;
  generations: number;
  state: WorkerRecord["state"];
  profile: string | null;
  forkedFrom: string | null;
  nativeParent: boolean;
  /** The worker's latest assignment with a stored report: its standard handoff (T96). */
  lastHandoff: string | null;
  runtime: string;
  context: {
    used: number | null;
    window: number | null;
    estimated: boolean | null;
  };
}

/**
 * How much of the dashboard model to build. `summary` is the first paint:
 * current work and attention only, with no history lists or telemetry.
 * `history` adds every decision, completed task and retired worker; `full`
 * adds thread telemetry (usage and member threads).
 */
export type OverviewDetail = "summary" | "history" | "full";

export interface Overview {
  /** Usage and member threads are present (`full`). */
  detailsLoaded?: boolean;
  /** Every decision, completed task and retired worker is present (`history` or `full`). */
  historyLoaded?: boolean;
  /**
   * The ledger state this snapshot was built from: `version` grows with every
   * write within one server instance (`epoch`). Orders snapshots of different tiers.
   */
  revision?: { epoch: string; version: number };
  project: {
    id: string;
    name: string;
    objective: string;
    paused: boolean;
    memberProjectIds: string[];
    coordinatorThreadId: string | null;
    coordinatorGeneration: number;
    coordinatorStatus: string;
    coordinatorProfile?: string | null;
    /** checkoutPending: BB returned the coordinator but has not reported its checkout yet. */
    coordinatorStart: { state: string; threadId: string | null; checkoutPending: boolean } | null;
    coordinatorHandover: {
      state: "pending" | "failed";
      reason: string;
      profile: string;
      /** Requested environment, or null for "the incumbent's". */
      environment: string | null;
      detail: string | null;
      requestedAt: number;
    } | null;
    formerCoordinators: {
      threadId: string;
      endedAt: number | null;
      reason: string | null;
      /** Why the last convergence left this predecessor live; null once nothing holds it. */
      holdReason: string | null;
      live: LiveThread | null;
    }[];
    coordinatorHome: CoordinatorHome | null;
    checkpoint: string | null;
    policy: Policy;
    /** Global fallbacks only; recorded Initiative policy remains separate. */
    profileDefaults?: Policy["profiles"];
    context: ProjectContext;
    updatedAt: number;
  };
  counts: {
    inFlight: number;
    awaitingAcceptance: number;
    remaining: number;
    opinionNeeded: number;
    revisit: number;
    done: number;
    answered: number;
  };
  updates: { ref: string; summary: string; body: string; createdAt: number }[];
  inFlight: InFlightItem[];
  awaitingAcceptance: AwaitingItem[];
  remaining: RemainingItem[];
  opinionNeeded: OpinionItem[];
  revisit: RevisitItem[];
  answered: AnsweredItem[];
  /** withdrawn: the coordinator withdrew its own question (D340); otherwise the user closed it. */
  closedQuestions: { ref: string; question: string; note: string; closedAt: number; withdrawn?: boolean }[];
  done: {
    ref: string;
    title: string;
    result: string | null;
    updatedAt: number;
  }[];
  unconfirmed: { assignment: string; worker: string; since: number }[];
  workers: { current: WorkerItem[]; retired: WorkerItem[] };
  /** User-owned ad-hoc threads linked to the project; never managed work. */
  threads: {
    threadId: string | null;
    label: string;
    state: "pending" | "active" | "uncertain" | "failed";
    live: { status: string; archived: boolean; title: string | null } | null;
    createdAt: number;
  }[];
  decisions: { acceptEligible?: boolean; ref: string; description: string; madeBy: "user" | "agent"; review: "pending" | "okay" | "not-okay" | null; reviewMessage: string | null; notification: DecisionRecord["notification"]; recordedBy: DecisionRecord["provenance"]; updatedAt: number }[];
  usage: InitiativeUsage;
  /** Recorded members with native parent facts; separate from tree v1. */
  memberThreads: (InitiativeUsage["threads"][number] & {
    parentThreadId: string | null;
    parentKnown: boolean;
    environmentId: string | null;
    bbProjectId: string | null;
    nativeTitle: string | null;
    /** Positive native lifecycle fact; null when not observed. */
    nativeStatus: string | null;
  })[];
  activity: { at: number; kind: string; summary: string }[];
}

/** Assignment states where work is still owed; reported work is separate. */
const OPEN_STATES: AssignmentRecord["state"][] = [
  "dispatching",
  "queued",
  "running",
  "idle_no_report",
  "stopped",
];

export function buildOverview(
  store: Store,
  projectId: string,
  live: Map<string, LiveThread>,
  now: number,
  home?: CoordinatorHome | null,
  detail: boolean | OverviewDetail = true,
): Overview {
  const level = detail === true ? "full" : detail === false ? "summary" : detail;
  const detailed = level === "full";
  const history = level !== "summary";
  const project = store.project(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  const tasks = store.tasks(projectId);
  const workers = store.workers(projectId);
  const assignments = store.assignments(projectId);
  const decisions = store.decisions(projectId);
  const taskByNum = new Map(tasks.map((task) => [task.num, task]));
  const link = (num: number): TaskLink => ({
    ref: taskRef(num),
    title: taskByNum.get(num)?.title ?? "(deleted task)",
  });
  const workerByNum = new Map(workers.map((worker) => [worker.num, worker]));
  const threadOf = (assignment: AssignmentRecord) =>
    assignment.threadId ? live.get(assignment.threadId) : undefined;
  const isBusy = (assignment: AssignmentRecord) => {
    const thread = threadOf(assignment);
    return Boolean(
      thread && !thread.archived && BUSY_STATUSES.has(thread.status),
    );
  };

  // Current work is an open assignment, or a reported one whose thread is
  // still natively busy. A report already delivered on an idle thread is not
  // in flight — it is awaiting acceptance, however old the report is.
  const inFlightAssignments = assignments.filter(
    (assignment) =>
      OPEN_STATES.includes(assignment.state) ||
      (assignment.state === "reported" && isBusy(assignment)),
  );
  const inFlightTaskNums = new Set(
    inFlightAssignments.flatMap((assignment) => assignment.taskNums),
  );

  const inFlight: InFlightItem[] = inFlightAssignments
    .map((assignment) => {
      const worker = workerByNum.get(assignment.workerNum)!;
      const first = taskByNum.get(assignment.taskNums[0] ?? -1);
      const reviewed = (assignment.reviewOf ?? []).map(link);
      const thread = threadOf(assignment);
      const warnings: string[] = [];
      if (assignment.state === "idle_no_report")
        warnings.push(
          "Went idle without a report. Idle is not the same as done.",
        );
      if (
        OPEN_STATES.includes(assignment.state) &&
        thread &&
        !thread.archived &&
        !BUSY_STATUSES.has(thread.status)
      )
        warnings.push(`Its thread is ${thread.status} — no report yet.`);
      if (assignment.opState === "uncertain")
        warnings.push("BB has not confirmed this delegation yet.");
      if (assignment.stopReason) warnings.push(assignment.stopReason);
      if (thread?.archived) warnings.push("Its thread is archived.");
      const outcome =
        assignment.role === "review"
          ? `Independent review of ${reviewed.map((task) => `${task.ref} ${task.title}`).join(", ")}`
          : (first?.brief?.objective ?? first?.summary ?? "(no brief)");
      return {
        assignment: assignment.ref,
        role: assignment.role,
        outcome,
        tasks:
          assignment.role === "review"
            ? reviewed
            : assignment.taskNums.map(link),
        owner: {
          worker: worker.ref,
          label: worker.label,
          threadId: assignment.threadId,
          profile: describeProfile(
            assignment.actualProfile ?? assignment.profile,
          ),
        },
        state: assignment.state,
        checkpoint: assignment.checkpoint,
        threadBusy: isBusy(assignment),
        progress:
          (assignment.state === "reported"
            ? `Thread is still active after its report. ${assignment.report?.summary ?? ""}`
            : null) ??
          first?.progress ??
          (assignment.state === "queued"
            ? "Queued behind the worker's current turn"
            : assignment.state === "dispatching"
              ? "Starting"
              : thread
                ? `Thread is ${thread.status}`
                : "Working"),
        nextCheckpoint:
          assignment.state === "reported"
            ? "Worker finishes, then the coordinator checks the report"
            : (first?.nextCheckpoint ?? "Worker report"),
        warnings,
        since: assignment.createdAt,
      };
    })
    .sort((a, b) => a.since - b.since);

  const closedTask = (num: number) =>
    ["done", "cancelled"].includes(
      tasks.find((task) => task.num === num)?.status ?? "done",
    );
  const awaitingAcceptance: AwaitingItem[] = assignments
    .filter(
      (assignment) =>
        assignment.state === "reported" &&
        !isBusy(assignment) &&
        // A review whose whole scope is already decided belongs to history,
        // not to current acceptance work.
        !(
          assignment.role === "review" &&
          (assignment.reviewOf ?? []).every(closedTask)
        ),
    )
    .map((assignment) => {
      const worker = workerByNum.get(assignment.workerNum)!;
      return {
        assignment: assignment.ref,
        role: assignment.role,
        tasks:
          assignment.role === "review"
            ? (assignment.reviewOf ?? []).map(link)
            : assignment.taskNums.map(link),
        owner: {
          worker: worker.ref,
          label: worker.label,
          threadId: assignment.threadId,
        },
        outcome: assignment.report?.outcome ?? "reported",
        summary: assignment.report?.summary ?? "",
        reportedAt: assignment.reportedAt,
        checkpoint: assignment.checkpoint,
      };
    })
    .sort((a, b) => (a.reportedAt ?? 0) - (b.reportedAt ?? 0));

  const openDecisions = decisions.filter(
    (item) => item.status === "active",
  );
  const blockingQuestions = new Map<number, DecisionRecord[]>();
  for (const item of openDecisions.filter(
    (item) => item.humanAttention === "needs-opinion",
  ))
    for (const num of item.blocks)
      blockingQuestions.set(num, [...(blockingQuestions.get(num) ?? []), item]);

  const latestOwner = (task: TaskRecord) => {
    const last = [...assignments]
      .reverse()
      .find((assignment) => assignment.taskNums.includes(task.num));
    return last ? workerRef(last.workerNum) : null;
  };
  const remaining: RemainingItem[] = tasks
    .filter(
      (task) =>
        task.status !== "done" &&
        task.status !== "cancelled" &&
        !inFlightTaskNums.has(task.num),
    )
    .map((task) => {
      const unmet = task.dependsOn.filter(
        (num) => taskByNum.get(num)?.status !== "done",
      );
      const questions = blockingQuestions.get(task.num) ?? [];
      const why =
        task.status === "awaiting_acceptance"
          ? `Done by ${latestOwner(task) ?? "a worker"}; waiting for the coordinator to accept it.`
          : questions.length
            ? `Waiting for your opinion on ${questions.map((item) => item.ref).join(", ")}.`
            : unmet.length
              ? `Waiting on ${unmet.map(taskRef).join(", ")}.`
              : task.status === "blocked"
                ? (task.progress ?? "Blocked.")
                : task.brief
                  ? "Ready; not assigned yet."
                  : "Not briefed or assigned yet.";
      return {
        ref: task.ref,
        title: task.title,
        summary: task.summary,
        status: task.status,
        priority: task.priority,
        owner: task.status === "awaiting_acceptance" ? latestOwner(task) : null,
        why,
        updatedAt: task.updatedAt,
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        Number(a.ref.slice(1)) - Number(b.ref.slice(1)),
    );

  const opinionNeeded: OpinionItem[] = openDecisions
    .filter((item) => item.humanAttention === "needs-opinion")
    .map((item) => {
      const body = item.body as Decision;
      return {
        ref: item.ref,
        title: item.title,
        question: body.question ?? item.title,
        context: body.context ?? "",
        options: body.options,
        recommendation: body.recommendation ?? null,
        blocks: item.blocks.map(link),
        askedAt: item.createdAt,
      };
    });

  const revisit: RevisitItem[] = openDecisions
    .filter((item) => item.madeBy === "agent" && item.review === "pending")
    .map((item) => {
      const body = item.body as Decision;
      return {
        ref: item.ref,
        title: item.title,
        outcome: item.description,
        rationale: body.rationale ?? "",
        context: body.context ?? null,
        tradeoff: body.tradeoff ?? null,
        revisitReason: "Review this agent decision",
        deadline: body.deadline ?? null,
        decidedAt: item.createdAt,
      };
    })
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));

  const unresolvedAnswerNotifications = new Set(decisions.filter(item => item.status === "answered" && unresolvedNotification(item)).map(item => item.ref));
  const answered: AnsweredItem[] = decisions
    .filter((item) => item.status === "answered")
    .map((item) => {
      const body = item.body as Decision & {
        answer?: { choice: string | null; note: string; at: number; recordedBy?: Provenance };
      };
      return {
        ref: item.ref,
        title: item.title,
        question: body.question ?? item.title,
        context: body.context ?? null,
        options: body.options,
        recommendation: body.recommendation ?? null,
        choice: body.answer?.choice ?? null,
        note: body.answer?.note ?? "",
        answeredAt: body.answer?.at ?? item.updatedAt,
        recordedBy: body.answer?.recordedBy && body.answer.recordedBy.author !== "user"
          ? body.answer.recordedBy.author
          : null,
      };
    })
    .sort((a, b) => b.answeredAt - a.answeredAt)
    // Keep unresolved delivery receipts available for inspection/retry even
    // after the answer falls outside the ten recent answers.
    .filter((answer, index) => index < 10 || unresolvedAnswerNotifications.has(answer.ref));

  const usageRecords = detailed ? store.projectUsage(projectId) : [];
  const usageByThread = new Map(
    usageRecords.map((record) => [record.threadId, record]),
  );
  const workerItem = (worker: WorkerRecord): WorkerItem => {
    const thread = worker.threadId ? live.get(worker.threadId) : undefined;
    // Use the last delivered assignment in this native context, including
    // its resolved profile when reported. An undelivered/failed override is
    // not evidence that the worker's execution changed.
    const delivered = assignments.filter(
      (a) => a.threadId === worker.threadId &&
        a.workerNum === worker.num && a.generation === worker.generation &&
        (a.actualProfile !== null || a.briefDelivered),
    ).at(-1);
    const profile = delivered?.actualProfile ?? delivered?.profile;
    const usage = worker.threadId
      ? usageByThread.get(worker.threadId)
      : undefined;
    return {
      ref: worker.ref,
      label: worker.label,
      role: worker.role,
      area: worker.area,
      bbProjectId: worker.bbProjectId,
      threadId: worker.threadId,
      generation: worker.generation,
      generations: detailed ? store.generations(projectId, worker.num).length : 1,
      state: worker.state,
      profile:
        profile
          ? describeProfile(profile)
          : worker.providerId && worker.model
          ? `${worker.providerId} / ${worker.model}${worker.reasoningLevel ? ` / ${worker.reasoningLevel}` : ""} / tier unspecified`
          : null,
      forkedFrom: worker.forkedFrom ? workerRef(worker.forkedFrom) : null,
      nativeParent: worker.nativeParent,
      lastHandoff: assignments.filter((a) => a.workerNum === worker.num && a.report !== null).at(-1)?.ref ?? null,
      runtime: !worker.threadId
        ? "no thread"
        : thread
          ? thread.archived
            ? "archived"
            : thread.status
          : "unknown",
      context: {
        used: usage?.contextUsed ?? null,
        window: usage?.contextWindow ?? null,
        estimated: usage?.contextEstimated ?? null,
      },
    };
  };

  const usage = detailed ? buildUsage(store, projectId, live) : unloadedUsage();
  const nestedByThread = new Map(
    store
      .nestedProjectThreads(projectId)
      .map((thread) => [thread.threadId, thread]),
  );

  return {
    detailsLoaded: detailed,
    historyLoaded: history,
    project: {
      id: project.id,
      name: project.name,
      objective: project.objective,
      paused: project.paused,
      memberProjectIds: project.memberProjectIds,
      coordinatorThreadId: project.coordinatorThreadId,
      coordinatorGeneration: project.coordinatorGeneration,
      coordinatorStatus: project.coordinatorThreadId
        ? live.get(project.coordinatorThreadId)?.archived
          ? "archived"
          : (live.get(project.coordinatorThreadId)?.status ?? "unknown")
        : "missing",
      coordinatorStart: (() => {
        const row = store.db
          .prepare(
            "SELECT state, thread_id, reason FROM coordinator_starts WHERE project_id=?",
          )
          .get(projectId) as
          { state: string; thread_id: string | null; reason: string | null } | undefined;
        return row
          ? {
              state: row.state,
              threadId: row.thread_id,
              checkoutPending:
                row.state === "pending" && row.thread_id !== null && !row.reason?.includes("home unproven"),
            }
          : null;
      })(),
      coordinatorHandover: (() => {
        const handover = store.handover(projectId);
        return handover
          ? {
              state: handover.state,
              reason: handover.reason,
              profile: handover.profile
                ? describeProfile(handover.profile)
                : "current effective profile",
              environment:
                handover.environment?.type === "reuse"
                  ? handover.environment.environmentId
                  : (handover.environment?.type ?? null),
              detail: handover.detail,
              requestedAt: handover.updatedAt,
            }
          : null;
      })(),
      formerCoordinators: store
        .generations(projectId, 0)
        .filter(
          (generation) => generation.threadId !== project.coordinatorThreadId,
        )
        .map((generation) => ({
          threadId: generation.threadId,
          endedAt: generation.endedAt,
          reason: generation.endReason,
          holdReason: generation.holdReason,
          live: live.get(generation.threadId) ?? null,
        })),
      coordinatorHome: home ?? null,
      checkpoint: project.checkpoint,
      policy: project.policy,
      context: project.context,
      updatedAt: project.updatedAt,
    },
    counts: {
      inFlight: inFlight.length,
      awaitingAcceptance: awaitingAcceptance.length,
      remaining: remaining.length,
      opinionNeeded: opinionNeeded.length,
      revisit: revisit.length,
      done: tasks.filter((task) => task.status === "done").length,
      answered: answered.length,
    },
    closedQuestions: decisions.filter(item => item.status === "closed" || item.status === "withdrawn").reverse().slice(0, 10).map(item => ({
      ref: item.ref, question: (item.body as Decision).question ?? item.title,
      note: item.body.resolution?.note ?? "", closedAt: item.body.resolution?.at ?? item.updatedAt,
      withdrawn: item.status === "withdrawn",
    })),
    updates: store.updates(projectId, 5).map((update) => ({
      ref: update.ref,
      summary: update.summary,
      body: update.body,
      createdAt: update.createdAt,
    })),
    inFlight,
    awaitingAcceptance,
    remaining,
    opinionNeeded,
    revisit,
    answered,
    done: !history ? [] : tasks
      .filter((task) => task.status === "done")
      .map((task) => ({
        ref: task.ref,
        title: task.title,
        result: task.result,
        updatedAt: task.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    unconfirmed: [
      ...assignments
        .filter(
          (assignment) =>
            assignment.opState === "uncertain" ||
            assignment.opState === "pending",
        )
        .map((assignment) => ({
          assignment: assignment.ref,
          worker: workerRef(assignment.workerNum),
          since: assignment.createdAt,
        })),
      ...store
        .projectThreads(projectId)
        .filter((t) => t.state === "pending" || t.state === "uncertain")
        .map((t) => ({
          assignment: t.opId,
          worker: `thread "${t.label}"`,
          since: t.createdAt,
        })),
    ],
    workers: {
      current: workers
        .filter((worker) => worker.state !== "retired")
        .map(workerItem),
      retired: !history ? [] : workers
        .filter((worker) => worker.state === "retired")
        .map(workerItem),
    },
    threads: store
      .projectThreads(projectId)
      .filter(
        (t) =>
          !t.threadId || store.membership(t.threadId, true)?.kind === "adhoc",
      )
      .map((t) => ({
        threadId: t.threadId,
        label: t.label,
        state: t.state,
        live: t.threadId ? (live.get(t.threadId) ?? null) : null,
        createdAt: t.createdAt,
      })),
    // The summary keeps what the Inbox acts on: unchecked agent decisions and
    // undelivered answer notifications.
    decisions: decisions.filter(item => item.madeBy !== null && item.status !== "removed" &&
      (history || item.madeBy === "agent" && item.review === "pending" || unresolvedNotification(item))).map(item => ({
      acceptEligible: isAcceptableAgentDecision(item), ref: item.ref, description: item.description, madeBy: item.madeBy!, review: item.review, reviewMessage: item.reviewMessage, notification: item.notification, recordedBy: item.provenance, updatedAt: item.updatedAt,
    })),
    usage,
    memberThreads: usage.threads.map((thread) => {
      const native = live.get(thread.threadId);
      const nested = nestedByThread.get(thread.threadId);
      return {
        ...thread,
        parentThreadId: native?.parentThreadId ?? null,
        parentKnown: native?.parentThreadId !== undefined,
        environmentId: native?.environmentId ?? null,
        bbProjectId: native?.projectId ?? nested?.bbProjectId ?? null,
        nativeTitle: native?.title ?? null,
        nativeStatus: native
          ? native.status === "deleted"
            ? "deleted"
            : native.archived
              ? "archived"
              : native.status
          : null,
      };
    }),
    activity: store.activity(projectId, 25).map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      summary: entry.summary,
    })),
  };
}

const unresolvedNotification = (item: DecisionRecord) =>
  !!item.notification && ["failed", "pending", "uncertain"].includes(item.notification.state);

/** Threads whose live status the dashboard shows. */
export function threadsToWatch(store: Store, projectId: string): string[] {
  const project = store.project(projectId);
  const ids = new Set<string>();
  if (project?.coordinatorThreadId) ids.add(project.coordinatorThreadId);
  // Recent ended coordinator generations stay watched: a predecessor whose
  // child transfer is still converging shows its live status here.
  if (project)
    for (const generation of store
      .generations(projectId, 0)
      .filter((g) => g.threadId !== project.coordinatorThreadId)
      .slice(-5))
      ids.add(generation.threadId);
  for (const worker of store.workers(projectId))
    if (worker.threadId && worker.state !== "retired") ids.add(worker.threadId);
  for (const t of store.projectThreads(projectId))
    if (t.threadId) ids.add(t.threadId);
  for (const t of store.nestedProjectThreads(projectId)) ids.add(t.threadId);
  return [...ids];
}

/** Compact list/tree projection, without parsing report bodies or telemetry histories. */
export function buildSummary(store: Store, projectId: string) {
  const project = store.project(projectId)!;
  const assignments = store.db.prepare("SELECT state,task_nums FROM assignments WHERE project_id=?").all(projectId) as { state: string; task_nums: string }[];
  const active = assignments.filter(a => OPEN_STATES.includes(a.state as AssignmentRecord["state"]));
  const assigned = new Set<number>(active.flatMap(a => JSON.parse(a.task_nums)));
  const tasks = store.db.prepare("SELECT num,status FROM tasks WHERE project_id=?").all(projectId) as { num: number; status: string }[];
  const attention = store.db.prepare("SELECT human_attention,decision_owner,decision_review FROM knowledge WHERE project_id=? AND status='active' AND kind='decision'").all(projectId) as { human_attention: string; decision_owner: string | null; decision_review: string | null }[];
  const opinions = attention.filter(d => d.human_attention === "needs-opinion").length;
  const blocked = (store.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE project_id=? AND state='reported' AND json_valid(report) AND json_extract(report, '$.outcome')='blocked'").get(projectId) as { n: number }).n;
  return { id: project.id, name: project.name, objective: project.objective, paused: project.paused,
    coordinatorThreadId: project.coordinatorThreadId, memberProjectIds: project.memberProjectIds,
    inFlight: active.length, remaining: tasks.filter(t => !["done", "cancelled"].includes(t.status) && !assigned.has(t.num)).length,
    opinions, needsYou: opinions + blocked,
    revisit: attention.filter(d => d.decision_owner === "agent" && d.decision_review === "pending").length,
    appearance: project.appearance };
}
