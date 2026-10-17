import { preSwitchLine } from "./cutover";
import type { NotDeliveredMessage } from "./not-delivered";
import type { WorkerGroup } from "./worker-group";
import { isAcceptableAgentDecision } from "./decision-eligibility";
import { BUSY_STATUSES, type Running } from "./bb";
import type { WaitingOn } from "./context";
import { blockerAnswerItem, blockerKey, dismissalItem, openBlockers, undismissed } from "./blockers";
import { describeProfile } from "./policy";
import { buildUsage, unloadedUsage, type InitiativeUsage } from "./usage";
import type {
  Decision,
  Policy,
  ProjectContext,
  Role,
  TaskStatus,
  WorkerKind,
} from "./schema";
import type {
  AssignmentRecord,
  DecisionRecord,
  Delivery,
  OverviewAssignment,
  Provenance,
  Store,
  TaskRecord,
  WorkerRecord,
} from "./store";
import { assignmentRef, taskRef, workerRef } from "./store";

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
 * W496: a thread's status while the dashboard's first read of it is still pending ("loading", the
 * overview stopped waiting for it) or failed ("unreadable"). Shown in its rows; never a fact.
 */
export type UnreadStatus = "loading" | "unreadable";
/** Native facts for one overview; `unread` names the threads it has none for yet, and why. */
export type LiveFacts = Map<string, LiveThread> & { unread?: ReadonlyMap<string, UnreadStatus> };

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
  /** The label this assignment names its worker by: the one a queued continuation staged, until the worker takes it, else owner.label. */
  brief: string;
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
  /** T136: the worker's final message, which is the report itself. */
  finalMessage: string | null;
  reportedAt: number | null;
  checkpoint?: AssignmentRecord["checkpoint"];
}

/** D386: a blocked report the coordinator has not acted on; it waits on the user until answered. */
export interface BlockerItem {
  assignment: string;
  role: Role;
  tasks: TaskLink[];
  owner: { worker: string; label: string; threadId: string | null };
  question: string;
  context: string;
  /** W476: the report's options and the worker's recommendation; none on older reports. */
  options: { label: string; consequences: string }[];
  recommendation: string | null;
  reportedAt: number | null;
  /**
   * The user's answer, kept until the coordinator acts on the report. choice:
   * the option picked (W476). to: who received it (T130). delivery: the
   * worker's receipt; notification: the coordinator's notice, or for a worker
   * answer its FYI (T132). inChat: the user gave it in the coordinator's chat,
   * and the coordinator recorded it (W488).
   */
  answer: { ref: string; choice: string | null; note: string; at: number; to: "coordinator" | "worker"; delivery: Delivery | null; notification: DecisionRecord["notification"]; inChat: boolean } | null;
}

/** T132: the user's blocker answer as its decision row carries it, so an undelivered one can retry after its card is gone. */
export interface BlockerAnswerItem {
  assignment: string;
  /** The answered worker's W#, when the summary still lists it. */
  worker: string | null;
  question: string;
  context: string;
  choice: string | null;
  note: string;
  to: "coordinator" | "worker";
  delivery: Delivery | null;
}

/** T128: a blocker the user dismissed, as its decision row carries it; the assignment and blocker let a failed notice retry. */
export interface DismissalItem {
  assignment: string;
  question: string;
  context: string;
  note: string;
  notify: boolean;
  at: number;
  undoneAt: number | null;
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
  /** Client-side only: BB's live list counts work running on the thread though its status reads as an error. */
  liveWork?: boolean;
  label: string;
  role: Role;
  /** What the coordinator asked for on spawn; null for reviewers and older workers. */
  kind: WorkerKind | null;
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
  /** v9: its open assignment, if any. */
  open: { ref: string; state: string; tasks: string[] } | null;
  /** v9: its latest report, with the pre-switch line for work given out before the switch. */
  latestReport: { ref: string; outcome: string; summary: string; question: string | null; reportedAt: number | null; preSwitch: string | null } | null;
  /** Its latest work's stop reason (a failed thread says why). */
  stopReason: string | null;
  /** Total tokens recorded for its thread (the full tier only). */
  tokens: number | null;
  /** When its current work started: the open assignment's creation, else its latest one's, else the worker's. */
  since: number;
  /** The PRs its records name. */
  prs: { url: string; stage: string | null }[];
}

/** v9: one BB child thread (a reviewer, a helper, theirs), from BB's own thread row: one row of a childPage. */
export interface WorkerChild {
  threadId: string;
  title: string;
  status: string;
  archived: boolean;
  /** What still runs in it (running()); null when it is quiet. */
  running: Running | null;
  providerId: string | null;
  updatedAt: number;
  /** Its own child threads as the cache knows them; null before a listing says. */
  children: number | null;
}

/** v9: what a worker's descendants are doing as far as the cache knows (RunningChildren.waitingOn). */
export interface WorkerWaiting {
  /** A running descendant it waits on. */
  on: WaitingOn | null;
  /** False while part of its tree has never been listed (just after a reload): no answer yet. */
  checked: boolean;
  /** Its own child threads as the cache knows them; null (or absent) before a listing says. */
  children?: number | null;
}

/** v9: a task with its shown status and why (computed unless set by hand). */
export interface TaskItem {
  ref: string;
  title: string;
  status: TaskStatus;
  statusReason: string;
  setByHand: boolean;
  /** The stored description, which the task editor edits. */
  summary: string;
  workers: string[];
  updatedAt: number;
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
    /** Historical: the last persistent checkpoint before T136; never written or injected now. */
    checkpoint: string | null;
    /** T136: the handover a replacement coordinator will start from, while one is being prepared. */
    handoverDraft: { state: "requested" | "generating" | "ready"; source: "luna" | "fallback" | "user" | null; text: string | null; detail: string | null; startsReplacement: boolean; updatedAt: number } | null;
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
  /** Unresolved blocked reports, oldest first; unanswered ones count toward Needs you. */
  blockers: BlockerItem[];
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
  decisions: { acceptEligible?: boolean; ref: string; description: string; madeBy: "user" | "agent"; review: "pending" | "okay" | "not-okay" | null; reviewMessage: string | null; notification: DecisionRecord["notification"]; recordedBy: DecisionRecord["provenance"]; updatedAt: number; dismissal?: DismissalItem; blockerAnswer?: BlockerAnswerItem }[];
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
  /** Messages BB is holding for member threads with nothing running to deliver them (T133); filled by the server's native read. */
  notDelivered?: NotDeliveredMessage[];
  /** v9: tasks with their shown status; done and cancelled ones only with history (`history`, `full`). */
  tasks: TaskItem[];
  /** v9 (D523): the standing rules, in order. */
  rules: { ref: string; text: string; sources: string[] }[];
  /** v9: each live worker's descendants as the server's cache knows them (W# →); no native read. */
  workerWaiting?: Record<string, WorkerWaiting>;
  /**
   * Each current worker's Workers-tab group (W# →), from the one derivation in worker-group.ts;
   * the Threads sidebar reads it instead of deriving its own. `quiet` and `errored` are the group
   * it would be in were its thread quiet, or failed: where BB's live view moves a worker the
   * cache reads as running, or one with a new unread error.
   */
  workerGroups?: Record<string, { group: WorkerGroup; quiet: WorkerGroup; errored: WorkerGroup }>;
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
  live: LiveFacts,
  now: number,
  home?: CoordinatorHome | null,
  detail: boolean | OverviewDetail = true,
): Overview {
  const level = detail === true ? "full" : detail === false ? "summary" : detail;
  const detailed = level === "full";
  const history = level !== "summary";
  const project = store.project(projectId);
  if (!project) throw new Error(`Unknown Initiative ${projectId}`);
  const tasks = store.tasks(projectId);
  const workers = store.workers(projectId);
  const assignments = store.assignmentsForOverview(projectId, history);
  const lastReported = store.lastReportedAssignments(projectId);
  const decisions = store.decisions(projectId);
  const taskByNum = new Map(tasks.map((task) => [task.num, task]));
  const link = (num: number): TaskLink => ({
    ref: taskRef(num),
    title: taskByNum.get(num)?.title ?? "(deleted task)",
  });
  const workerByNum = new Map(workers.map((worker) => [worker.num, worker]));
  // W492: each worker's assignments, oldest first, so per-worker facts do not rescan the history.
  const assignmentsOf = new Map<number, OverviewAssignment[]>();
  for (const a of assignments) {
    const mine = assignmentsOf.get(a.workerNum);
    if (mine) mine.push(a);
    else assignmentsOf.set(a.workerNum, [a]);
  }
  // Each task's work assignees, in the order they were first given it.
  const taskWorkers = new Map<number, Set<string>>();
  for (const a of assignments) {
    if (a.role !== "work") continue;
    for (const num of a.taskNums) {
      const refs = taskWorkers.get(num);
      if (refs) refs.add(workerRef(a.workerNum));
      else taskWorkers.set(num, new Set([workerRef(a.workerNum)]));
    }
  }
  const generations = detailed ? store.projectGenerations(projectId) : null;
  const threadOf = (assignment: OverviewAssignment) =>
    assignment.threadId ? live.get(assignment.threadId) : undefined;
  const isBusy = (assignment: OverviewAssignment) => {
    const thread = threadOf(assignment);
    return Boolean(
      thread && !thread.archived && BUSY_STATUSES.has(thread.status),
    );
  };
  // W492: read only the reports a view shows in full: reported work of a worker still on the
  // Initiative or on a busy thread. A retired worker's reported work is in no view, and in a long
  // Initiative that is most of them.
  const reports = store.reports(projectId, assignments
    .filter((a) => a.state === "reported" && (workerByNum.get(a.workerNum)?.state !== "retired" || isBusy(a)))
    .map((a) => a.num));
  for (const a of assignments) a.report = reports.get(a.num) ?? null;
  // The Workers tab's latest report: with history each worker's latest filing, decoded once per
  // filing (a retired worker's too); the first paint lists live workers, whose latest awaiting
  // acceptance is read above.
  const assignmentByNum = new Map(assignments.map((a) => [a.num, a]));
  const latestReports = history
    ? store.reportFacts(projectId, [...lastReported.values()].flatMap((num) => assignmentByNum.get(num) ?? []))
    : new Map(assignments.flatMap((a) => (a.report ? [[a.num, { outcome: a.report.outcome, summary: a.report.summary, question: a.report.blocker?.question ?? null }] as const] : [])));

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

  // Before T143, delegating wrote "With W12" as the task's progress, which every assignment on
  // the task then repeated. Who works on a task is its assignments; only a real note is shown.
  const taskNote = (progress: string | null | undefined) => (progress && !/^With W\d+$/.test(progress) ? progress : null);
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
        brief: assignment.label ?? assignment.pendingIdentity?.label ?? worker.label,
        tasks:
          assignment.role === "review"
            ? reviewed
            : [...new Set(assignment.taskNums)].map(link),
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
          taskNote(first?.progress) ??
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
      taskByNum.get(num)?.status ?? "done",
    );
  // T136: nothing is accepted. A report stays here while it is its live worker's latest and
  // its tasks are still open; closing the tasks or retiring the worker moves it to history.
  const latestByWorker = new Map<number, number>();
  for (const a of assignments) latestByWorker.set(a.workerNum, Math.max(latestByWorker.get(a.workerNum) ?? 0, a.num));
  const awaitingAcceptance: AwaitingItem[] = assignments
    .filter((assignment) => {
      if (assignment.state !== "reported" || isBusy(assignment)) return false;
      if (latestByWorker.get(assignment.workerNum) !== assignment.num) return false;
      if (workerByNum.get(assignment.workerNum)?.state === "retired") return false;
      const subject = assignment.role === "review" ? (assignment.reviewOf ?? []) : assignment.taskNums;
      return !(subject.length && subject.every(closedTask));
    })
    .map((assignment) => {
      const worker = workerByNum.get(assignment.workerNum)!;
      return {
        assignment: assignment.ref,
        role: assignment.role,
        tasks:
          assignment.role === "review"
            ? (assignment.reviewOf ?? []).map(link)
            : [...new Set(assignment.taskNums)].map(link),
        owner: {
          worker: worker.ref,
          label: worker.label,
          threadId: assignment.threadId,
        },
        outcome: assignment.report?.outcome ?? "reported",
        summary: assignment.report?.summary ?? "",
        finalMessage: assignment.report?.finalMessage ?? null,
        reportedAt: assignment.reportedAt,
        checkpoint: assignment.checkpoint,
      };
    })
    .sort((a, b) => (a.reportedAt ?? 0) - (b.reportedAt ?? 0));

  const blockerAnswers = new Map(
    decisions.flatMap((item) => (item.body.blocker && item.body.answer ? [[blockerKey(item.body.blocker.assignment, item.body.blocker), item] as const] : [])),
  );
  const dismissedBlockers = new Set(
    decisions.flatMap((item) => (item.status === "active" && item.body.blocker && item.body.dismissal ? [blockerKey(item.body.blocker.assignment, item.body.blocker)] : [])),
  );
  const blockers: BlockerItem[] = undismissed(
    openBlockers(assignments.map((a) => ({ ...a, outcome: a.report?.outcome ?? null })), closedTask, (num) => workerByNum.get(num)?.state === "retired"),
    (a) => a.report?.blocker,
    dismissedBlockers,
  ).map((assignment) => {
    const worker = workerByNum.get(assignment.workerNum)!;
    const blocker = assignment.report?.blocker;
    const answer = blocker ? blockerAnswers.get(blockerKey(assignment.num, blocker)) : undefined;
    return {
      assignment: assignment.ref,
      role: assignment.role,
      tasks: (assignment.role === "review" ? (assignment.reviewOf ?? []) : assignment.taskNums).map(link),
      owner: { worker: worker.ref, label: worker.label, threadId: assignment.threadId },
      question: blocker?.question ?? assignment.report?.summary ?? "",
      context: blocker?.context ?? "",
      options: blocker?.options ?? [],
      recommendation: blocker?.recommendation ?? null,
      reportedAt: assignment.reportedAt,
      answer: answer ? { ref: answer.ref, choice: answer.body.answer?.choice ?? null, note: answer.body.answer?.note ?? "", at: answer.body.answer?.at ?? answer.createdAt, to: answer.body.answer?.to ?? "coordinator", delivery: answer.body.answer?.delivery ?? null, notification: answer.notification, inChat: answer.provenance.author !== "user" } : null,
    };
  });

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
      // v9: why it stands where it does is its computed status's reason (or "set by hand").
      const why = unmet.length ? `Waiting on ${unmet.map(taskRef).join(", ")}.` : task.statusReason || "Not given out yet.";
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
    const delivered = (assignmentsOf.get(worker.num) ?? []).filter(
      (a) => a.threadId === worker.threadId && a.generation === worker.generation &&
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
      kind: worker.kind,
      area: worker.area,
      bbProjectId: worker.bbProjectId,
      threadId: worker.threadId,
      generation: worker.generation,
      generations: detailed ? (generations?.get(worker.num)?.length ?? 0) : 1,
      state: worker.state,
      profile:
        profile
          ? describeProfile(profile)
          : worker.providerId && worker.model
          ? `${worker.providerId} / ${worker.model}${worker.reasoningLevel ? ` / ${worker.reasoningLevel}` : ""} / tier unspecified`
          : null,
      forkedFrom: worker.forkedFrom ? workerRef(worker.forkedFrom) : null,
      nativeParent: worker.nativeParent,
      lastHandoff: lastReported.has(worker.num) ? assignmentRef(lastReported.get(worker.num)!) : null,
      runtime: !worker.threadId
        ? "no thread"
        : thread
          ? thread.archived
            ? "archived"
            : thread.status
          : (live.unread?.get(worker.threadId) ?? "unknown"),
      context: {
        used: usage?.contextUsed ?? null,
        window: usage?.contextWindow ?? null,
        estimated: usage?.contextEstimated ?? null,
      },
      ...workerFacts(worker),
    };
  };
  // v9: the facts the Workers tab shows, all from recorded data.
  const prRecords = store.prRecords(projectId);
  // W492: each worker's PRs in record order: the ones it is named on or one of its assignments is.
  const workerOfAssignment = new Map(assignments.map((a) => [a.ref, workerRef(a.workerNum)]));
  const prsOf = new Map<string, WorkerItem["prs"]>();
  for (const r of prRecords.values())
    for (const ref of new Set([r.worker, r.assignment ? workerOfAssignment.get(r.assignment) : null])) {
      if (!ref) continue;
      const prs = prsOf.get(ref);
      if (prs) prs.push({ url: r.url, stage: r.stage });
      else prsOf.set(ref, [{ url: r.url, stage: r.stage }]);
    }
  const workerFacts = (worker: WorkerRecord) => {
    const mine = assignmentsOf.get(worker.num) ?? [];
    const open = mine.find((a) => OPEN_STATES.includes(a.state));
    const latest = open ?? mine.at(-1);
    // The latest filing: with history any, else one still awaiting acceptance.
    const reported = history ? assignmentByNum.get(lastReported.get(worker.num) ?? -1) : mine.filter((a) => a.report).at(-1);
    const facts = reported && latestReports.get(reported.num);
    const usage = worker.threadId ? usageByThread.get(worker.threadId) : undefined;
    const total = usage ? (usage.sessionTotals?.total ?? 0) + (usage.closedTotals.total ?? 0) : null;
    return {
      open: open ? { ref: open.ref, state: open.state, tasks: open.taskNums.map(taskRef) } : null,
      latestReport: reported && facts
        ? { ref: reported.ref, outcome: facts.outcome === "succeeded" ? "done" : facts.outcome, summary: facts.summary,
            question: facts.question, reportedAt: reported.reportedAt, preSwitch: preSwitchLine(reported) }
        : null,
      stopReason: latest?.stopReason ?? null,
      tokens: total,
      since: (open ?? latest)?.createdAt ?? worker.createdAt,
      prs: prsOf.get(worker.ref) ?? [],
    };
  };

  const usage = detailed ? buildUsage(store, projectId, live, { workers, generations: generations!, usage: usageRecords }) : unloadedUsage();
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
          : (live.get(project.coordinatorThreadId)?.status ?? live.unread?.get(project.coordinatorThreadId) ?? "unknown")
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
      handoverDraft: (() => {
        const d = store.handoverDraft(projectId);
        return d ? { state: d.state, source: d.source, text: d.text, detail: d.detail === "queued" ? null : d.detail, startsReplacement: d.thenReplace !== null, updatedAt: d.updatedAt } : null;
      })(),
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
    closedQuestions: decisions.filter(item => item.madeBy === null && (item.status === "closed" || item.status === "withdrawn")).reverse().slice(0, 10).map(item => ({
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
    blockers,
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
    // Done and cancelled tasks (folded on the Tasks tab) come with the history tier.
    tasks: tasks.filter((task) => history || !["done", "cancelled"].includes(task.status)).map((task) => ({
      ref: task.ref,
      title: task.title,
      status: task.status,
      statusReason: task.statusReason,
      setByHand: task.statusSetAt !== null,
      summary: task.summary,
      workers: [...(taskWorkers.get(task.num) ?? [])],
      updatedAt: task.updatedAt,
    })),
    rules: store.rules(projectId).map((r) => ({ ref: r.ref, text: r.text, sources: r.sources })),
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
      (history || item.madeBy === "agent" && item.review === "pending" || unresolvedNotification(item) || unresolvedDelivery(item))).map(item => ({
      acceptEligible: isAcceptableAgentDecision(item), ref: item.ref, description: item.description, madeBy: item.madeBy!, review: item.review, reviewMessage: item.reviewMessage, notification: item.notification, recordedBy: item.provenance, updatedAt: item.updatedAt,
      ...(item.body.dismissal && item.body.blocker ? { dismissal: dismissalItem(item.body.blocker, item.body.dismissal) } : {}),
      ...(item.body.answer && item.body.blocker ? { blockerAnswer: blockerAnswerItem(item.body.blocker, item.body.answer, workerByNum.get(assignments.find((a) => a.num === item.body.blocker!.assignment)?.workerNum ?? -1)?.ref ?? null) } : {}),
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
          : (live.unread?.get(thread.threadId) ?? null),
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
const unresolvedDelivery = (item: DecisionRecord) =>
  ["failed", "pending", "uncertain"].includes(item.body.answer?.delivery?.state ?? "");

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
  for (const worker of store.liveWorkers(projectId))
    if (worker.threadId) ids.add(worker.threadId);
  for (const t of store.projectThreads(projectId))
    if (t.threadId) ids.add(t.threadId);
  // W496: a nested thread seen archived or deleted is shown from its last fact, not read again.
  for (const t of store.nestedProjectThreads(projectId)) if (!t.ended) ids.add(t.threadId);
  return [...ids];
}

/** W496: the nested threads seen archived or deleted, with their last native fact. */
export function endedNestedThreads(store: Store, projectId: string): Map<string, LiveThread> {
  return new Map(store.nestedProjectThreads(projectId).flatMap((t) => (t.ended ? [[t.threadId, t.ended] as const] : [])));
}

/** Unanswered open blockers, from the few columns `openBlockers` reads. */
function summaryBlockers(store: Store, projectId: string, tasks: { num: number; status: string }[]) {
  const rows = store.db.prepare("SELECT num, worker_num, role, task_nums, review_of, state FROM assignments WHERE project_id=? ORDER BY num").all(projectId) as { num: number; worker_num: number; role: "work" | "review"; task_nums: string; review_of: string | null; state: string }[];
  // openBlockers keeps a blocked report only while it is a live worker's latest assignment that
  // did not fail: read those few reports, not the whole history.
  const retired = new Set(store.retiredWorkerNums(projectId));
  const latest = new Map<number, number>();
  for (const row of rows) if (row.state !== "failed") latest.set(row.worker_num, row.num);
  const candidates = rows.filter((row) => row.state === "reported" && latest.get(row.worker_num) === row.num && !retired.has(row.worker_num)).map((row) => row.num);
  const reports = new Map((store.db.prepare("SELECT num, CASE WHEN json_valid(report) THEN json_extract(report, '$.outcome') END AS outcome, CASE WHEN json_valid(report) AND blocked_on_lead IS NOT report_seq THEN json_extract(report, '$.blocker.question') END AS question, CASE WHEN json_valid(report) THEN json_extract(report, '$.blocker.context') END AS context FROM assignments WHERE project_id=? AND num IN (SELECT value FROM json_each(?))").all(projectId, JSON.stringify(candidates)) as { num: number; outcome: string | null; question: string | null; context: string | null }[]).map((r) => [r.num, r]));
  if (![...reports.values()].some((r) => r.outcome === "blocked")) return 0;
  const settled = store.db.prepare("SELECT json_extract(body, '$.blocker.assignment') AS assignment, json_extract(body, '$.blocker.question') AS question, json_extract(body, '$.blocker.context') AS context, json_extract(body, '$.dismissal') IS NOT NULL AS dismissal FROM knowledge WHERE project_id=? AND kind='decision' AND status NOT IN ('superseded','removed') AND json_valid(body) AND json_extract(body, '$.blocker') IS NOT NULL AND (json_extract(body, '$.dismissal') IS NULL OR status='active')").all(projectId) as { assignment: number; question: string; context: string; dismissal: number }[];
  const keys = (dismissal: boolean) => new Set(settled.filter((row) => !!row.dismissal === dismissal).map((row) => blockerKey(row.assignment, row)));
  const answered = keys(false);
  const closed = new Set(tasks.filter((t) => ["done", "cancelled"].includes(t.status)).map((t) => t.num));
  return undismissed(openBlockers(
    rows.map((row) => {
      const report = reports.get(row.num);
      return { num: row.num, workerNum: row.worker_num, role: row.role, taskNums: JSON.parse(row.task_nums) as number[], reviewOf: row.review_of ? (JSON.parse(row.review_of) as number[]) : null, state: row.state, outcome: report?.outcome ?? null, blocker: report?.question == null ? null : { question: report.question, context: report.context ?? "" } };
    }),
    (num) => closed.has(num),
    (num) => retired.has(num),
  ), (row) => row.blocker, keys(true)).filter((row) => !row.blocker || !answered.has(blockerKey(row.num, row.blocker))).length;
}

/** Compact list/tree projection, without parsing report bodies or telemetry histories. */
export function buildSummary(store: Store, projectId: string) {
  const project = store.project(projectId)!;
  const assignments = store.db.prepare("SELECT state,task_nums FROM assignments WHERE project_id=?").all(projectId) as { state: string; task_nums: string }[];
  const active = assignments.filter(a => OPEN_STATES.includes(a.state as AssignmentRecord["state"]));
  const assigned = new Set<number>(active.flatMap(a => JSON.parse(a.task_nums)));
  // v9: the shown status is computed from the work and its PRs (Store.tasks).
  const tasks = store.tasks(projectId).map((t) => ({ num: t.num, status: t.status }));
  const attention = store.db.prepare("SELECT human_attention,decision_owner,decision_review FROM knowledge WHERE project_id=? AND status='active' AND kind='decision'").all(projectId) as { human_attention: string; decision_owner: string | null; decision_review: string | null }[];
  const opinions = attention.filter(d => d.human_attention === "needs-opinion").length;
  const blocked = summaryBlockers(store, projectId, tasks);
  return { id: project.id, name: project.name, objective: project.objective, paused: project.paused,
    coordinatorThreadId: project.coordinatorThreadId, memberProjectIds: project.memberProjectIds,
    inFlight: active.length, remaining: tasks.filter(t => !["done", "cancelled"].includes(t.status) && !assigned.has(t.num)).length,
    opinions, needsYou: opinions + blocked,
    revisit: attention.filter(d => d.decision_owner === "agent" && d.decision_review === "pending").length,
    appearance: project.appearance };
}
