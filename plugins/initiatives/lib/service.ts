import { withProfileDefaults, type PreferencesReader } from "./settings";
import { PROJECT_DETAILS_CONFLICT } from "./project-context";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  BUSY_STATUSES,
  ProjectError,
  checkCatalog,
  errorMessage,
  isDefiniteRejection,
  newOpId,
  newProjectId,
  projectHostId,
  promptTexts,
  textInput,
  threadExecution,
  type Sdk,
  type ThreadDto,
  type ThreadListRow,
} from "./bb";
import { blockerKey, openBlockers } from "./blockers";
import { isAcceptableAgentDecision } from "./decision-eligibility";
import { messageCallerAdmitted, sendInitiativeMessage, type InitiativeMessage } from "./messaging";
import { opMarker, renderAssignment, renderCoordinatorSeed } from "./brief";
import { isOwnOrigin } from "./identity";
import {
  chooseWorkProfile,
  delegationViolations,
  describeProfile,
  planReview,
  profileFor,
  sameProfile,
  seriesOf,
  type DelegationFacts,
  type ReviewPartition,
} from "./policy";
import { holdGroups, legacyReadOnly, reportVersion, unreleasedBackground, type HoldGroup } from "./write-holds";
import { handoffSource, renderStandardHandoff, resolveHandoffs } from "./handoffs";
import {
  briefSchema,
  reportSchema,
  decisionSchema,
  policySchema,
  projectContextSchema,
  type Brief,
  type AssignmentAccess,
  type Decision,
  type EnvironmentChoice,
  type Policy,
  type Profile,
  type Report,
  type Role,
  type WorkKind,
} from "./schema";
import {
  assignmentRef,
  parseRef,
  taskRef,
  workerRef,
  type AssignmentRecord,
  type HandoverRecord,
  type DecisionRecord,
  type Membership,
  type ProjectRecord,
  type Provenance,
  type Store,
  type TaskRecord,
  type ReviewTargetRecord,
  type WorkerRecord,
} from "./store";
import { DiscoveryMemory, DISCOVERY_PARENT_CAP } from "./discovery";
import { receiptBlockReason, reportedRetryHint, unsettledReason } from "./receipts";

export const METADATA_VERSION = 1;
/** Unconfirmed creates and sends older than this are surfaced to the coordinator; they are never assumed failed. */
export const RECONCILE_GRACE_MS = 2 * 60_000;
const DESCENDANT_PAGE = 100;
const DESCENDANT_BUDGET = 500;
const LIST_PAGE = 200;
const LIST_SCAN_BUDGET = 1000;
/** Receipt scans read at most this many list pages per sweep, resuming where the last sweep stopped. */
const RECEIPT_SCAN_PAGES = LIST_SCAN_BUDGET / LIST_PAGE;
/** A former coordinator refusing the same way again waits this long before the sweep retries, doubling up to the cap. */
const FORMER_RETRY_BASE_MS = 60_000;
const FORMER_RETRY_MAX_MS = 15 * 60_000;
/** T91 project-filtered evidence reads: at most this many list pages and bytes, then GETs. */
const HOLD_LIST_BYTES = 2_000_000;
const HOLD_GET_CAP = 20;
const CHECKOUT_PENDING_NOTE =
  "The coordinator started; BB has not reported its checkout yet. It is confirmed automatically once the checkout proves to be the default source checkout.";

/** Why an answer cannot land on this record, and the action that fits instead. */
function notOpenQuestion(item: DecisionRecord) {
  const why = item.status === "answered" ? "it is already answered; the recorded answer stands"
    : item.status === "closed" ? "the user closed it"
    : item.status === "withdrawn" ? `the coordinator withdrew it: ${item.body.resolution?.note ?? ""}. Withdrawal records no answer. If the user has since made this choice explicitly, record {"action":"decision","madeBy":"user","description":"<the user's choice>"}`
    : item.status !== "active" ? `it is ${item.status}`
    : item.madeBy === "agent" ? `it is an agent decision. Only the current coordinator, on the user's explicit cleanup request, may accept, veto or remove it: {"action":"cleanup","ref":"${item.ref}","operation":"accept","reason":"<the user's request>"}`
    : `it is a recorded user decision. If the user explicitly changed it, record {"action":"decision","madeBy":"user","description":"<the new choice>","supersedes":"${item.ref}"}`;
  return `${item.ref} is not an open question: ${why}.`;
}

/** An unconfirmed coordinator start as the sweep reads it. */
type PendingCoordinatorStart = {
  project_id: string;
  op_id: string;
  reason: string | null;
  thread_id: string | null;
  created_at: number;
};

/**
 * A returned coordinator whose only missing fact is the checkout BB has not
 * reported yet: live, in the primary member, no environment. Any other gap,
 * or a reported checkout that is wrong, remains a real home problem.
 */
function checkoutNotYetReported(
  project: { memberProjectIds: string[] },
  thread: { projectId?: string | null; environmentId?: string | null; archivedAt?: unknown; deletedAt?: unknown },
) {
  return (
    !thread.environmentId &&
    thread.projectId === project.memberProjectIds[0] &&
    thread.archivedAt == null &&
    thread.deletedAt == null
  );
}

export type Workspace = "shared" | "isolated";
export type { EnvironmentChoice };

/**
 * One reviewer to start: a default-plan partition, or an explicit choice
 * (key null when it spans families). `shared` is true only when other
 * reviewers from the same plan cover the rest of the scope.
 */
type ReviewDispatch = ReviewPartition & { shared: boolean };

/** Execution settings carried from the predecessor through a handover. */
type HandoverExecution = {
  permissionMode?: Parameters<Sdk["threads"]["spawn"]>[0]["permissionMode"];
  serviceTier?: Parameters<Sdk["threads"]["spawn"]>[0]["serviceTier"];
};

/**
 * The result of revalidating a recorded handover mid-drain. `ok` continues;
 * `rescan` re-reads the request because its durable revision changed; `hold`
 * keeps it pending with a surfaced reason; `drop` removes it as obsolete.
 */
type HandoverRecheck =
  | { kind: "ok"; predecessor: ThreadDto | null }
  | { kind: "rescan" }
  | { kind: "hold"; reason: string }
  | { kind: "drop"; reason: string };

/** Thrown out of a replacement's final revalidation to settle the drain. */
class HandoverAbort extends Error {
  constructor(readonly outcome: Exclude<HandoverRecheck, { kind: "ok" }>) {
    super("handover revalidation failed");
  }
}

export interface DelegateInput {
  route: "fresh" | "continue" | "fork";
  role?: Role;
  /** Per-assignment coordination promise; omitted work may write on every route. */
  access?: AssignmentAccess;
  tasks?: string[];
  reviewOf?: string[];
  reviewTargets?: { task: string; assignment: string; revision: string }[];
  worker?: string;
  kind?: WorkKind;
  profile?: Profile;
  bbProjectId?: string;
  environment?: EnvironmentChoice;
  label?: string;
  area?: string;
  note?: string;
  forkAtSeq?: number;
  delivery?: "steer" | "queue";
  rationale?: string;
  /** Prior A# whose standard handoffs this work brief embeds (T96); provenance only. */
  handoffs?: string[];
  /** Explicit approval posture for the new thread; omitted uses the environment's configured default. */
  permissionMode?: "accept-edits" | "auto" | "full";
}

export interface DelegateResult {
  assignment: string;
  worker: string;
  threadId: string | null;
  state: AssignmentRecord["state"];
  profile: string;
  rationale: string | null;
  note: string | null;
}

type HoldEvidence = { verdict: "ended" | "running" | "unknown"; seen: string; signature: string };

/**
 * Where a writer's files live, as far as the ledger and BB's list row prove:
 * an environment id, whether it is a managed worktree, and whether it is the
 * project's default checkout (a fresh project-default dispatch, id not yet known).
 */
interface Checkout { id: string | null; worktree: boolean | null; projectDefault: boolean }

function checkoutOf(recorded: string | null, row: ThreadListRow | undefined, projectDefault: boolean): Checkout {
  const id = recorded ?? (typeof row?.environmentId === "string" ? row.environmentId : null);
  const worktree = row && row.environmentId === id && typeof row.environmentIsWorktree === "boolean" ? row.environmentIsWorktree : null;
  return { id, worktree, projectDefault };
}

/**
 * Two writers cannot touch each other's files only when that is proven: two
 * known, different environments, or a managed worktree against the project's
 * default checkout. Anything unknown stays the same checkout.
 */
function separateCheckouts(a: Checkout, b: Checkout): boolean {
  if (a.id && b.id) return a.id !== b.id;
  return (a.projectDefault && !a.id && b.worktree === true) || (b.projectDefault && !b.id && a.worktree === true);
}

/**
 * The project ledger. It records delegation intent before every native call,
 * confirms or reconciles the receipt afterwards, and exposes project state.
 * BB owns thread execution, queues, Stop semantics and parent-to-coordinator
 * completion notices; nothing here retries, wakes or schedules threads.
 */
export class ProjectsService {
  private coordinatorSwitches = new Map<string, string | null>();
  /** What discovery reads learned in this instance; never persisted, never authorizes a mutation. */
  discovery = new DiscoveryMemory();
  /** Sweep backoff for former coordinators that refused to converge, by predecessor thread. */
  private formerRetries = new Map<string, { attempts: number; nextAt: number }>();
  /** Former coordinators seen archived, deleted or gone: done, never read again. */
  private endedFormers = new Set<string>();
  /** Coordinator-start ops whose retained receipt is archived, deleted or gone. */
  private endedReceipts = new Set<string>();
  /** Where each unfinished receipt scan resumes next sweep, by scan key. */
  private receiptCursors = new Map<string, number>();
  /** Sweep backoff and the last logged refusal for assignment ops that could not be reconciled, by op. */
  private opRetries = new Map<string, { reason: string; attempts: number; nextAt: number }>();
  /** Continue-route ops whose worker thread is archived, deleted or gone: not re-read, by op → thread. */
  private parkedOps = new Map<string, string>();
  /** Unarchive events seen per thread: a lifecycle read that an unarchive overtook never parks. */
  private unarchives = new Map<string, number>();
  /** Initiatives whose handover replacement has passed the journal boundary. */
  private handoverSpawnInflight = new Set<string>();
  /**
   * The per-Initiative parenting protocol: every plugin-issued native parent
   * mutation registers under the parent whose child-set it may still change
   * while its call is in flight. A former coordinator's archive drains that
   * parent's registry before re-verifying descendants — no op can register on
   * a superseded target, so a drained registry proves nothing already issued
   * can still land a child beneath it mid-archive. This replaces re-reading
   * the coordinator around individual mutations: an A→B reparent held across
   * a B→C switch can no longer straddle B's descendant check and archive.
   */
  private parentOps = new Map<string, Map<string, number>>();
  private parentOpWaiters = new Map<string, (() => void)[]>();

  private parentOpBegin(projectId: string, parentId: string | null) {
    if (!parentId) return;
    let project = this.parentOps.get(projectId);
    if (!project) this.parentOps.set(projectId, (project = new Map()));
    project.set(parentId, (project.get(parentId) ?? 0) + 1);
  }

  private parentOpEnd(projectId: string, parentId: string | null) {
    if (!parentId) return;
    const project = this.parentOps.get(projectId);
    if (!project) return;
    const next = (project.get(parentId) ?? 0) - 1;
    if (next > 0) {
      project.set(parentId, next);
      return;
    }
    project.delete(parentId);
    const key = `${projectId}${parentId}`;
    const waiters = this.parentOpWaiters.get(key) ?? [];
    this.parentOpWaiters.delete(key);
    for (const wake of waiters) wake();
  }

  /** Resolves once no issued parent mutation can still land beneath `parentId`. */
  private parentOpsIdle(projectId: string, parentId: string): Promise<void> {
    if (!this.parentOps.get(projectId)?.get(parentId))
      return Promise.resolve();
    const key = `${projectId}${parentId}`;
    return new Promise((resolve) => {
      const waiters = this.parentOpWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.parentOpWaiters.set(key, waiters);
    });
  }

  private async assertCoordinatorIdle(threadId: string | null) {
    if (!threadId) return;
    try {
      const current = await this.sdk.threads.get({ threadId });
      if (
        !current.archivedAt &&
        !current.deletedAt &&
        BUSY_STATUSES.has(current.status)
      )
        throw new ProjectError(
          "The coordinator is still running. Let its turn finish, or stop it before switching.",
        );
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  constructor(
    readonly bb: BbPluginApi,
    readonly store: Store,
    readonly preferences: PreferencesReader,
  ) {}

  get sdk(): Sdk {
    return this.bb.sdk;
  }

  now() {
    return this.store.now();
  }

  // Lookups ------------------------------------------------------------------

  requireProject(projectId: string): ProjectRecord {
    const project = this.store.project(projectId);
    if (!project || project.archivedAt !== null)
      throw new ProjectError(`Unknown Initiative ${projectId}.`);
    return project;
  }

  requireTask(project: ProjectRecord, ref: string): TaskRecord {
    const num = parseRef("T", ref);
    const task = num === null ? null : this.store.task(project.id, num);
    if (!task)
      throw new ProjectError(`Unknown task ${ref} in ${project.name}.`);
    return task;
  }

  requireWorker(project: ProjectRecord, ref: string): WorkerRecord {
    const num = parseRef("W", ref);
    const worker = num === null ? null : this.store.worker(project.id, num);
    if (!worker)
      throw new ProjectError(`Unknown worker ${ref} in ${project.name}.`);
    return worker;
  }

  requireAssignment(project: ProjectRecord, ref: string): AssignmentRecord {
    const num = parseRef("A", ref);
    const assignment =
      num === null ? null : this.store.assignment(project.id, num);
    if (!assignment)
      throw new ProjectError(`Unknown assignment ${ref} in ${project.name}.`);
    return assignment;
  }

  /** The project a calling thread coordinates; tools use it as their authority. */
  coordinatorOf(threadId: string | null | undefined): ProjectRecord {
    const membership = threadId ? this.store.membership(threadId) : null;
    if (!membership || membership.workerNum !== 0 || membership.former)
      throw new ProjectError(
        "This thread is not the current coordinator of an Initiative.",
      );
    return membership.project;
  }

  workerOf(
    threadId: string | null | undefined,
  ): Membership & { worker: WorkerRecord } {
    const membership = threadId ? this.store.membership(threadId) : null;
    if (!membership || membership.workerNum === 0 || !membership.worker)
      throw new ProjectError("This thread is not an Initiative worker.");
    if (membership.former || membership.worker.threadId !== threadId)
      throw new ProjectError(
        `This thread is a previous context generation of ${membership.worker.ref}; its current thread is ${membership.worker.threadId ?? "not started"}.`,
      );
    return membership as Membership & { worker: WorkerRecord };
  }

  message(caller: string, input: InitiativeMessage, projectId?: string) {
    return sendInitiativeMessage(this.store, this.sdk, caller, input, projectId);
  }

  // Initiatives -------------------------------------------------------------------

  async createProject(input: {
    name: string;
    objective: string;
    memberProjectIds: string[];
    coordinator:
      | { kind: "new"; bbProjectId?: string; environment?: EnvironmentChoice }
      | { kind: "adopt"; threadId: string };
    policy?: Policy;
  }): Promise<{ project: ProjectRecord; note: string | null }> {
    const members = [...new Set(input.memberProjectIds)];
    if (!members.length) throw new ProjectError("Add at least one BB project.");
    for (const id of members) {
      try {
        await this.sdk.projects.get({ projectId: id });
      } catch {
        throw new ProjectError(`BB project ${id} does not exist.`);
      }
    }
    const policy = policySchema.parse(input.policy ?? {});
    if (input.coordinator.kind === "adopt") {
      const thread = await this.sdk.threads.get({
        threadId: input.coordinator.threadId,
      });
      await this.assertAdoptionRole(thread, "coordinator");
      const existing = this.store.membership(thread.id);
      if (existing && (existing.workerNum !== 0 || !existing.former))
        throw new ProjectError(
          `That thread already belongs to ${existing.project.name}.`,
        );
      // The coordinator's home is the primary member's default checkout: an
      // adopted thread living on a secondary or foreign project is rejected,
      // never silently re-homed or appended as a member.
      if (thread.projectId !== members[0])
        throw new ProjectError(
          `The coordinator must run on the primary member project ${members[0]} (its default source checkout); the adopted thread lives in ${thread.projectId}.`,
        );
      await this.assertAdoptedCoordinatorHome(
        members[0]!,
        thread.environmentId,
      );
      const project = this.store.tx(() => {
        const created = this.store.createProject({
          id: newProjectId(),
          name: input.name,
          objective: input.objective,
          memberProjectIds: members,
          coordinatorThreadId: thread.id,
          policy,
        });
        this.store.log(
          created.id,
          "project",
          `Created with ${thread.title ?? thread.id} as coordinator`,
        );
        return created;
      });
      await this.tagThread(thread.id, {
        role: "coordinator",
        projectId: project.id,
      });
      const note = await this.reloadToolsIfIdle(thread);
      return { project, note };
    }
    const project = this.store.tx(() => {
      const created = this.store.createProject({
        id: newProjectId(),
        name: input.name,
        objective: input.objective,
        memberProjectIds: members,
        coordinatorThreadId: null,
        policy,
      });
      this.store.log(created.id, "project", "Created");
      return created;
    });
    try {
      // The coordinator always runs on the primary member's default checkout;
      // a caller naming a different member is told why it was overridden.
      if (
        input.coordinator.bbProjectId &&
        input.coordinator.bbProjectId !== members[0]
      )
        this.store.log(
          project.id,
          "coordinator",
          `Coordinator requested on ${input.coordinator.bbProjectId}; coordinators run on the primary member ${members[0]}.`,
        );
      const started = await this.spawnCoordinator(
        project,
        members[0]!,
        null,
        input.coordinator.environment,
      );
      if (!started.confirmed)
        return { project: this.store.project(project.id)!, note: CHECKOUT_PENDING_NOTE };
    } catch (error) {
      this.store.log(
        project.id,
        "coordinator",
        `Coordinator could not start: ${errorMessage(error)}`,
      );
      const start = this.store.db
        .prepare("SELECT state FROM coordinator_starts WHERE project_id=?")
        .get(project.id) as { state: string } | undefined;
      const status =
        start?.state === "done"
          ? "started; BB lost the response"
          : start?.state === "uncertain"
            ? "is unconfirmed; inspect native threads before retrying"
            : "could not start";
      return {
        project: this.store.project(project.id)!,
        note: `The Initiative was created. Its coordinator ${status}: ${errorMessage(error)}`,
      };
    }
    return { project: this.store.project(project.id)!, note: null };
  }

  private async spawnCoordinator(
    project: ProjectRecord,
    bbProjectId: string,
    reason: string | null,
    environment?: EnvironmentChoice,
    requestedProfile?: Profile,
    options?: {
      /** Extra execution settings carried to the spawn (e.g. preserved handover mode/tier). */
      execution?: HandoverExecution;
      /** Runs after the last awaited lookup and before the start is journaled; throws to abort. */
      revalidate?: () => Promise<void>;
      /** Marks the point of no return, invoked right before the spawn call. */
      onCommit?: () => void;
    },
  ) {
    const primaryMember = project.memberProjectIds[0];
    if (!primaryMember || bbProjectId !== primaryMember)
      throw new ProjectError(
        `The coordinator must run on the primary member project ${primaryMember ?? "(none)"}: the initiative's coordinator home is its default source checkout, and ${bbProjectId} is ${project.memberProjectIds.includes(bbProjectId) ? "a secondary member" : "not a member"}.`,
      );
    const pending = this.store.db
      .prepare("SELECT state FROM coordinator_starts WHERE project_id = ?")
      .get(project.id) as { state: string } | undefined;
    if (pending && ["pending", "uncertain"].includes(pending.state))
      throw new ProjectError(
        "A coordinator start is still unconfirmed. Reconcile it before starting another coordinator.",
      );
    const settings = await this.preferences.read();
    const selected = requestedProfile ?? profileFor(withProfileDefaults(project.policy, settings), "coordinator");
    const profile: Profile = {
      ...selected,
      ...(selected.serviceTier ?? options?.execution?.serviceTier
        ? { serviceTier: selected.serviceTier ?? options?.execution?.serviceTier }
        : {}),
    };
    // A coordinator's home is a real checkout of its member project — never a
    // worker worktree, and a reused environment only after it proves to be a
    // ready non-worktree environment of that project.
    if (environment?.type === "worktree")
      throw new ProjectError(
        "A coordinator runs on the member project's checkout, not a worker worktree.",
      );
    let env: {
      request: Parameters<Sdk["threads"]["spawn"]>[0]["environment"];
      routing: Parameters<typeof checkCatalog>[2];
    };
    if (environment?.type === "reuse") {
      await this.assertCoordinatorEnvironment(
        bbProjectId,
        environment.environmentId,
      );
      env = { request: environment, routing: { environmentId: environment.environmentId } };
    } else {
      // Native project-default can select a worktree. Select the proven
      // source host/path explicitly, bypassing automatic environment choice.
      // An absent, unreadable or incomplete source cannot become home.
      let source: Awaited<
        ReturnType<ProjectsService["coordinatorDefaultSource"]>
      >;
      try {
        source = await this.coordinatorDefaultSource(bbProjectId);
      } catch (error) {
        throw new ProjectError(
          `The default source of ${bbProjectId} could not be read (${errorMessage(error)}), so the coordinator's default checkout cannot be proven.`,
        );
      }
      if (!source)
        throw new ProjectError(
          `${bbProjectId} has no default source; the coordinator's default checkout cannot be proven.`,
        );
      if (!source.hostId || !source.path)
        throw new ProjectError(
          `The default source of ${bbProjectId} reports no ${source.hostId ? "path" : "host"}; the coordinator's default checkout cannot be proven.`,
        );
      env = {
        request: {
          type: "host",
          hostId: source.hostId,
          workspace: { type: "unmanaged", path: source.path },
        },
        routing: { hostId: source.hostId },
      };
    }
    const check = await checkCatalog(this.sdk, profile, env.routing);
    if (!check.ok) throw new ProjectError(check.reason!);
    // Catalog and host lookups can outlast a native coordinator turn. The
    // incumbent must still be idle and unchanged before recording a
    // replacement intent.
    if (reason !== null) {
      await this.assertCoordinatorIdle(project.coordinatorThreadId);
      if (
        this.requireProject(project.id).coordinatorThreadId !==
        project.coordinatorThreadId
      )
        throw new ProjectError(
          "The coordinator changed while preparing its replacement. Read the current Initiative.",
        );
    }
    await options?.revalidate?.();
    const op = newOpId();
    if (requestedProfile) {
      const current = this.requireProject(project.id);
      project = this.store.updateProject(project.id, {
        policy: {
          ...current.policy,
          profiles: {
            ...current.policy.profiles,
            coordinator: requestedProfile,
          },
        },
      });
    }
    this.store.db
      .prepare(
        "INSERT INTO coordinator_starts(project_id, op_id, state, reason, created_at) VALUES(?, ?, 'pending', ?, ?) ON CONFLICT(project_id) DO UPDATE SET op_id=excluded.op_id, state='pending', thread_id=NULL, reason=excluded.reason, created_at=excluded.created_at",
      )
      .run(project.id, op, reason, this.now());
    let thread: ThreadDto;
    options?.onCommit?.();
    try {
      thread = await this.sdk.threads.spawn({
        projectId: bbProjectId,
        environment: env.request,
        // BB 0.43.1 rejects startedOnBehalfOf on ordinary originKind-null
        // starts. Keep native/plugin provenance without spoofing a fork.
        providerId: profile.providerId,
        model: profile.model,
        reasoningLevel: profile.reasoningLevel,
        ...(options?.execution?.permissionMode
          ? { permissionMode: options.execution.permissionMode }
          : {}),
        ...(profile.serviceTier
          ? { serviceTier: profile.serviceTier }
          : {}),
        title: `${project.name} · coordinator`,
        prompt: renderCoordinatorSeed({
          project,
          replacing: reason !== null,
          reason,
        }),
        pluginMetadata: {
          role: "coordinator",
          projectId: project.id,
          op,
          v: METADATA_VERSION,
        },
      });
    } catch (error) {
      const receipt = this.store.db
        .prepare("SELECT state FROM coordinator_starts WHERE project_id = ?")
        .get(project.id) as { state: string };
      if (receipt.state !== "done")
        this.store.db
          .prepare("UPDATE coordinator_starts SET state=? WHERE project_id=?")
          .run(isDefiniteRejection(error) ? "failed" : "uncertain", project.id);
      throw error;
    }
    // The exact default source was requested before the spawn, but it is
    // only a claim until the returned thread's
    // own project and environment prove the landing. A wrong or unprovable
    // checkout is never confirmed: the receipt stays visible and unconfirmed
    // with the native thread id retained, so a retry cannot start a second
    // coordinator and no incumbent is touched.
    // BB can return the thread before it reports the checkout it attached:
    // read that known receipt once before judging its home.
    if (!thread.environmentId)
      thread = await this.sdk.threads
        .get({ threadId: thread.id })
        .catch(() => thread);
    const homeProblem = await this.coordinatorReceiptHomeProblem(
      project,
      thread,
    );
    if (homeProblem && checkoutNotYetReported(project, thread)) {
      // Everything but the checkout is proven. The start stays pending with
      // its receipt; the sweep confirms it with the same exact home proof
      // once BB reports the checkout. Nothing is retried or polled here.
      const held = this.store.db
        .prepare(
          "UPDATE coordinator_starts SET thread_id=? WHERE project_id=? AND op_id=? AND state='pending'",
        )
        .run(thread.id, project.id, op);
      if (held.changes) {
        this.store.log(
          project.id,
          "coordinator",
          `Coordinator ${thread.id} started; BB has not reported its checkout yet. It is confirmed once the checkout proves to be the default source checkout.`,
          { threadId: thread.id },
        );
        return { thread, confirmed: false };
      }
    }
    if (homeProblem) {
      const held = this.store.db
        .prepare(
          "UPDATE coordinator_starts SET state='uncertain', thread_id=?, reason=? WHERE project_id=? AND op_id=? AND state='pending'",
        )
        .run(
          thread.id,
          `returned home unproven: ${homeProblem}`,
          project.id,
          op,
        );
      if (held.changes) {
        this.store.log(
          project.id,
          "coordinator",
          `BB returned coordinator ${thread.id}, but its checkout cannot be proven to be the default source checkout: ${homeProblem} The start stays unconfirmed with the native receipt retained — inspect and settle it instead of retrying.`,
          { threadId: thread.id },
        );
        throw new ProjectError(
          `The coordinator BB returned cannot be proven to run on the default checkout: ${homeProblem} Its start is recorded unconfirmed with native thread ${thread.id} retained; inspect and settle it instead of retrying.`,
        );
      }
      // A racing confirmation already settled this receipt — fall through to
      // the idempotent confirm instead of unwinding a completed start.
    }
    const confirmed = this.store.tx(() => {
      const outcome = this.store.confirmCoordinatorReceipt(
        project.id,
        op,
        thread.id,
        primaryMember,
        reason ?? "started",
      );
      if (outcome === "confirmed")
        this.store.log(
          project.id,
          "coordinator",
          `Coordinator started (${describeProfile(profile)})`,
          { threadId: thread.id },
        );
      return outcome;
    });
    if (confirmed !== "confirmed") {
      // The start, its recorded candidate, or the primary member moved while
      // the checkout proof was in flight — never confirm against stale
      // facts. The receipt stays visible and unconfirmed for inspection.
      this.store.db
        .prepare(
          "UPDATE coordinator_starts SET state='uncertain', thread_id=?, reason=? WHERE project_id=? AND op_id=? AND state IN ('pending','uncertain')",
        )
        .run(
          thread.id,
          "confirmation superseded: the start, candidate or primary member changed during validation",
          project.id,
          op,
        );
      this.store.log(
        project.id,
        "coordinator",
        `Coordinator ${thread.id} was not confirmed: the start or the primary member changed while its checkout was being proven. The receipt is retained unconfirmed; inspect and settle it.`,
        { threadId: thread.id },
      );
      throw new ProjectError(
        "The coordinator start or the primary member changed while the returned checkout was being proven; the start stays unconfirmed with the native receipt retained.",
      );
    }
    return { thread, confirmed: true };
  }

  async settleCoordinator(
    projectId: string,
    outcome: { threadId: string } | { notSent: true },
  ) {
    this.requireProject(projectId);
    const start = this.store.db
      .prepare("SELECT op_id, state, thread_id FROM coordinator_starts WHERE project_id=?")
      .get(projectId) as { op_id: string; state: string; thread_id: string | null } | undefined;
    // A pending start with a returned receipt is awaiting its checkout; one
    // without a receipt may still be in flight and is never settled.
    if (!start || !(start.state === "uncertain" || (start.state === "pending" && start.thread_id)))
      throw new ProjectError(
        "Only an unconfirmed coordinator start can be settled after inspection.",
      );
    if ("threadId" in outcome) {
      const thread = await this.sdk.threads.get({ threadId: outcome.threadId });
      const meta = await this.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: this.bb.pluginId });
      if (
        !isOwnOrigin(this.bb.pluginId, thread.originPluginId) ||
        meta.op !== start.op_id ||
        meta.projectId !== projectId
      )
        throw new ProjectError(
          "This thread is not the receipt for the unconfirmed coordinator start.",
        );
      const project = this.requireProject(projectId);
      const homeProblem = await this.coordinatorReceiptHomeProblem(
        project,
        thread,
      );
      if (homeProblem)
        throw new ProjectError(
          `The inspected coordinator receipt cannot be proven to run on the default checkout: ${homeProblem} The start stays unconfirmed; settle it as never sent or inspect again.`,
        );
      if (
        this.store.confirmCoordinatorReceipt(
          projectId,
          start.op_id,
          thread.id,
          project.memberProjectIds[0]!,
          "coordinator start settled after inspection",
        ) !== "confirmed"
      )
        throw new ProjectError(
          "The coordinator start, its candidate, or the primary member changed while inspecting its receipt. Read the current state and settle again.",
        );
      await this.convergeFormerCoordinators(projectId);
    } else {
      // "Never sent" must never contradict a positive receipt: a retained
      // thread id or a live native thread carrying this op is evidence the
      // spawn landed, whatever its home provability. Only a receipt proven
      // dead (archived, deleted, or gone) lets the start honestly fail.
      const retained = this.store.db
        .prepare(
          "SELECT thread_id FROM coordinator_starts WHERE project_id=? AND op_id=?",
        )
        .get(projectId, start.op_id) as
        | { thread_id: string | null }
        | undefined;
      if (retained?.thread_id) {
        let dead = false;
        try {
          const receipt = await this.sdk.threads.get({
            threadId: retained.thread_id,
          });
          dead = receipt.archivedAt !== null || receipt.deletedAt !== null;
        } catch (error) {
          if ((error as { status?: number }).status === 404) dead = true;
          else
            throw new ProjectError(
              `The retained coordinator receipt ${retained.thread_id} could not be checked (${errorMessage(error)}); the start cannot be declared never sent.`,
            );
        }
        if (!dead)
          throw new ProjectError(
            `A native coordinator receipt ${retained.thread_id} is recorded for this start — "never sent" would erase a thread BB still runs. Inspect and settle it explicitly, or archive it in BB first.`,
          );
      } else {
        // No retained id: a receipt may still exist natively (spawn reply
        // lost before it could be recorded). Scan every offset page of live
        // native threads for this operation before declaring the start never
        // happened — one page is not absence evidence, and a scan that
        // cannot complete leaves the receipt uncertain rather than failing
        // it on incomplete results.
        try {
          for (let offset = 0; ; offset += LIST_PAGE) {
            const rows = await this.sdk.threads.list({
              originPluginId: this.bb.pluginId,
              includeHidden: true,
              limit: LIST_PAGE,
              offset,
            });
            for (const row of rows) {
              if (row.archivedAt !== null || row.deletedAt !== null) continue;
              const meta = await this.sdk.threads.getPluginMetadata({ threadId: row.id, pluginId: this.bb.pluginId });
              if (meta.op === start.op_id && meta.projectId === projectId) {
                this.store.db
                  .prepare(
                    "UPDATE coordinator_starts SET thread_id=? WHERE project_id=? AND op_id=? AND state IN ('pending','uncertain')",
                  )
                  .run(row.id, projectId, start.op_id);
                throw new ProjectError(
                  `A live native thread ${row.id} carries this start's operation receipt — "never sent" would orphan it. Inspect and settle it explicitly, or archive it in BB first.`,
                );
              }
            }
            if (rows.length < LIST_PAGE) break;
          }
        } catch (error) {
          if (error instanceof ProjectError) throw error;
          throw new ProjectError(
            `The native receipt scan could not complete (${errorMessage(error)}); the start stays unconfirmed rather than being declared never sent on incomplete evidence.`,
          );
        }
      }
      // The fail transition is atomic with the evidence it relies on: same
      // uncertain operation and the same candidate evidence this inspection
      // used (null for a scan that found nothing, or the dead receipt's own
      // id). A configure-observed thread id, a different candidate, or a
      // confirmation landing during the checks reverses the outcome instead
      // of being erased.
      const result = this.store.db
        .prepare(
          "UPDATE coordinator_starts SET state='failed' WHERE project_id=? AND op_id=? AND state='uncertain' AND thread_id IS ?",
        )
        .run(projectId, start.op_id, retained?.thread_id ?? null);
      if (!result.changes)
        throw new ProjectError(
          "A native receipt or confirmation arrived while the coordinator start was being inspected — it cannot be declared never sent. Read the current state.",
        );
      this.store.log(
        projectId,
        "coordinator",
        "Unconfirmed coordinator start explicitly settled as never sent",
      );
    }
    return this.store.project(projectId)!;
  }

  /**
   * Opens a user-owned thread linked to the project. It has no managed role,
   * no assignment and no coordinator authority over it: the native chat stays
   * the user's, and initiative_read gives its agent the project context. It
   * lands as a native child of the current coordinator — parenting is the
   * initiative's tree topology, never a worker claim — so it navigates and
   * transfers with the rest of the tree. The op is journaled before the
   * native call so a lost response reconciles by pluginMetadata instead of
   * duplicating a thread.
   */
  async createUserThread(
    projectId: string,
    input: {
      title?: string;
      request: import("@get-bb/plugin-sdk/app").NewThreadRequest;
    },
  ) {
    return this.spawnUserThread(projectId, input.title, input.request);
  }

  /** Temporary input adapter for already-installed Sidebar/old panel callers. */
  async createLegacyUserThread(projectId: string, input: import("./legacy").LegacyThreadCreate) {
    const project = this.requireProject(projectId);
    const bbProjectId = input.bbProjectId ?? project.memberProjectIds[0];
    if (!bbProjectId || !project.memberProjectIds.includes(bbProjectId))
      throw new ProjectError("The thread's BB project must be an Initiative member.");
    const env = this.environmentFor(input.environment, { type: "project-default" },
      input.environment?.type === "worktree" ? await projectHostId(this.sdk, bbProjectId) : undefined);
    if (input.profile) {
      const check = await checkCatalog(this.sdk, input.profile, env.environmentId
        ? { environmentId: env.environmentId } : { hostId: await projectHostId(this.sdk, bbProjectId) });
      if (!check.ok) throw new ProjectError(check.reason!);
    }
    return this.spawnUserThread(projectId, input.title, {
      projectId: bbProjectId,
      environment: env.request as Parameters<Sdk["threads"]["spawn"]>[0]["environment"],
      ...(input.profile ?? {}), input: textInput(input.prompt),
    });
  }

  private async spawnUserThread(projectId: string, title: string | undefined,
    request: Parameters<Sdk["threads"]["spawn"]>[0]) {
    const project = this.requireProject(projectId);
    const bbProjectId = request.projectId;
    if (!project.memberProjectIds.includes(bbProjectId))
      throw new ProjectError("Choose one of this Initiative's repositories in the native composer.");
    // The initiative's tree is the coordinator's native tree: a member root
    // spawns under the current coordinator whenever that thread is live. The
    // target is re-read at issue time and the spawn registers under it, so a
    // switch racing the create can't strand the new thread beneath an
    // archiving predecessor — convergence would move a landed child anyway.
    let parentId = this.store.project(project.id)?.coordinatorThreadId ?? null;
    if (parentId) {
      try {
        const coordinator = await this.sdk.threads.get({
          threadId: parentId,
        });
        if (coordinator.archivedAt !== null || coordinator.deletedAt !== null)
          parentId = null;
      } catch {
        // An unreadable coordinator is no proof either way; spawning under it
        // either lands or is refused, and the sweep repairs the tree later.
      }
    }
    if (!parentId) throw new ProjectError("Open a current coordinator before creating an Initiative thread.");
    const op = newOpId();
    const label = title?.trim() || "Thread";
    this.store.openProjectThread({
      projectId: project.id,
      opId: op,
      label,
      bbProjectId,
    });
    let thread: ThreadDto;
    try {
      this.parentOpBegin(project.id, parentId);
      try {
        thread = await this.sdk.threads.spawn({
          ...request,
          title: `${project.name} · ${label}`.slice(0, 120),
          ...(parentId ? { parentThreadId: parentId } : {}),
          pluginMetadata: {
            role: "adhoc",
            projectId: project.id,
            op,
            v: METADATA_VERSION,
          },
        });
      } finally {
        this.parentOpEnd(project.id, parentId);
      }
    } catch (error) {
      if (isDefiniteRejection(error)) {
        this.store.markProjectThread(op, "failed");
        throw new ProjectError(`BB refused the thread: ${errorMessage(error)}`);
      }
      this.store.markProjectThread(op, "uncertain");
      this.store.log(
        project.id,
        "thread",
        `Opening "${label}": outcome uncertain (${errorMessage(error)}); reconciling before showing it`,
      );
      return {
        threadId: null,
        state: "uncertain" as const,
        note: "BB did not confirm the thread. The plugin reconciles it; check the Initiative panel instead of retrying.",
      };
    }
    this.store.tx(() => {
      this.store.confirmProjectThread(op, thread.id);
      this.store.log(project.id, "thread", `You opened a thread: ${label}`, {
        threadId: thread.id,
      });
    });
    return { threadId: thread.id, state: "active" as const, note: null };
  }

  /**
   * A native child of a coordinator-generation thread joins the project as an
   * ordinary project thread: no task, assignment, worker row, message or
   * report — the row only names the association for membership and the tree.
   * Explicit membership anywhere wins outright (a worker, a coordinator
   * generation or an earlier claim in any project); the coordinator lineage is
   * the only parent that confers it, so nested children ride native parentage
   * without rows of their own. Works for current and former coordinators, so
   * association survives replacement and picks up children adopted threads
   * already had.
   */
  associateNativeChild(thread: {
    id: string;
    projectId: string;
    parentThreadId: string | null;
    archivedAt: number | null;
    title: string | null;
    titleFallback: string | null;
  }): boolean {
    const parentId = thread.parentThreadId;
    if (!parentId || thread.archivedAt !== null) return false;
    const parent = this.store.membership(parentId, true);
    if (!parent || parent.project.archivedAt !== null) return false;
    if (this.store.membership(thread.id, true)) return false;
    const label =
      (thread.title ?? thread.titleFallback ?? "Thread").slice(0, 120) ||
      "Thread";
    if (parent.workerNum === 0) {
      // A direct child of a coordinator generation — current or former — gets
      // the ordinary project-thread row that lists it in the tree.
      const existing = this.store.projectThreadByThreadId(thread.id);
      if (existing) {
        if (existing.label !== label)
          this.store.refreshProjectThreadLabel(thread.id, label);
        return false;
      }
      if (
        !this.store.associateProjectThread({
          projectId: parent.project.id,
          opId: newOpId(),
          threadId: thread.id,
          label,
          bbProjectId: thread.projectId,
        })
      )
        return false;
      this.store.log(
        parent.project.id,
        "thread",
        `Associated native child thread "${label}" with the Initiative`,
        { threadId: thread.id },
      );
      return true;
    }
    // A deeper descendant of any other member (worker, adhoc, nested): no
    // project-thread row, but a lightweight membership claim so selection and
    // read tools resolve the right durable project when BB repositories
    // overlap. The Sidebar already walks it under its native parent.
    const nested = this.store.nestedThreadByThreadId(thread.id);
    if (nested) {
      if (nested.label !== label)
        this.store.refreshNestedThreadLabel(thread.id, label);
      return false;
    }
    if (
      !this.store.associateNestedThread({
        projectId: parent.project.id,
        threadId: thread.id,
        label,
        bbProjectId: thread.projectId,
      })
    )
      return false;
    this.store.log(
      parent.project.id,
      "thread",
      `Associated nested native thread "${label}" with the Initiative`,
      { threadId: thread.id },
    );
    return true;
  }

  /**
   * Sweep-time discovery for children the idle/failed events did not catch:
   * spawns while the plugin was down, and threads an adopted coordinator
   * brought with it. Breadth-first from every coordinator generation —
   * including former ones, so association survives replacement — through
   * every already-claimed member thread, so deeper descendants of workers
   * and associated threads gain nested membership. Threads another project
   * owns end the walk: their subtrees are that project's business.
   */
  async associateNativeChildren(projectId: string, signal?: AbortSignal) {
    const project = this.store.project(projectId);
    if (!project || project.archivedAt !== null) return;
    const seeds = new Set<string>();
    if (project.coordinatorThreadId) seeds.add(project.coordinatorThreadId);
    for (const generation of this.store.generations(projectId, 0))
      seeds.add(generation.threadId);
    for (const worker of this.store.workers(projectId))
      for (const generation of this.store.generations(
        projectId,
        worker.num,
      ))
        seeds.add(generation.threadId);
    for (const thread of this.store.projectThreads(projectId))
      if (thread.threadId) seeds.add(thread.threadId);
    for (const thread of this.store.nestedProjectThreads(projectId))
      seeds.add(thread.threadId);
    // Skip parents an earlier sweep saw archived (bar event obligations and a
    // rotating re-check) and order the rest so the cap rotates instead of
    // starving the same tail.
    const discovery = this.discovery;
    const { queue, skip, recheck } = discovery.plan(projectId, [...seeds], project.coordinatorThreadId);
    const seen = new Set<string>();
    let parents = 0;
    while (queue.length && parents < DISCOVERY_PARENT_CAP) {
      if (signal?.aborted) return;
      const parentId = queue.shift()!;
      if (seen.has(parentId) || skip(parentId)) continue;
      seen.add(parentId);
      parents++;
      const token = discovery.listing(projectId, parentId, recheck);
      for (let offset = 0; ; offset += 50) {
        const epoch = discovery.begin();
        const page = await this.sdk.threads.list({
          parentThreadId: parentId,
          includeHidden: true,
          limit: 50,
          offset,
          signal,
        });
        if (signal?.aborted) return;
        discovery.observe(page, epoch, seeds);
        for (const child of page) {
          const member = this.store.membership(child.id, true);
          if (!member) {
            if (this.associateNativeChild(child)) queue.push(child.id);
          } else if (member.project.id === projectId) queue.push(child.id);
        }
        if (page.length < 50) break;
      }
      // Only a completed listing discharges an event's obligation to list this parent.
      discovery.completed(parentId, token);
    }
    await this.attachStrandedMemberRoots(projectId, signal, skip, seeds);
  }

  /**
   * The coordinator-tree invariant applies to existing members too: a
   * user-owned thread claimed before the tree existed, or one whose parent
   * has since vanished, joins under the current coordinator. Only a stranded
   * root attaches — parentless or under an archived/deleted/gone parent. A
   * thread already nested under a live thread keeps that arrangement, foreign
   * or not; the sweep never rewrites deliberate placement. Each attach
   * re-resolves the coordinator at issue time and receipts the actual parent
   * afterwards, so a switch mid-pass can only strand, never misplace, one —
   * the next convergence moves it with the rest of the tree.
   */
  private async attachStrandedMemberRoots(
    projectId: string,
    signal: AbortSignal | undefined,
    skip: (threadId: string) => boolean,
    members: ReadonlySet<string>,
  ) {
    for (const record of [
      ...this.store.projectThreads(projectId),
      ...this.store.nestedProjectThreads(projectId),
    ]) {
      if (signal?.aborted) return;
      if (!record.threadId) continue;
      if ("state" in record && record.state !== "active") continue;
      const member = this.store.membership(record.threadId, true);
      if (
        member?.kind !== "adhoc" ||
        member.former ||
        member.project.id !== projectId
      )
        continue;
      // A member an earlier read saw archived is not stranded; its re-check
      // comes through the listing rotation. Attaching still reads afresh.
      if (skip(record.threadId)) continue;
      let thread: ThreadDto;
      const epoch = this.discovery.begin();
      try {
        thread = await this.sdk.threads.get({ threadId: record.threadId });
      } catch {
        continue;
      }
      this.discovery.observe([thread], epoch, members);
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (thread.parentThreadId) {
        try {
          const parent = await this.sdk.threads.get({
            threadId: thread.parentThreadId,
          });
          if (parent.archivedAt === null && parent.deletedAt === null)
            continue;
        } catch {
          // The parent is gone — the member root is stranded and attaches.
        }
      }
      const target =
        this.store.project(projectId)?.coordinatorThreadId ?? null;
      if (!target || target === thread.parentThreadId || signal?.aborted)
        continue;
      this.parentOpBegin(projectId, target);
      try {
        await this.sdk.threads
          .update({ threadId: record.threadId, parentThreadId: target })
          .catch(() => undefined);
        let actual: string | null | undefined;
        try {
          actual = (await this.sdk.threads.get({ threadId: record.threadId }))
            .parentThreadId;
        } catch {
          actual = undefined;
        }
        if (actual === target)
          this.store.log(
            projectId,
            "thread",
            `"${record.label}" joined the coordinator's native tree`,
            { threadId: record.threadId },
          );
      } finally {
        this.parentOpEnd(projectId, target);
      }
    }
  }

  async replaceCoordinator(
    projectId: string,
    input: {
      reason: string;
      profile?: Profile;
      checkpoint?: string;
      adoptThreadId?: string;
      bbProjectId?: string;
      environment?: EnvironmentChoice;
    },
    options?: {
      execution?: HandoverExecution;
      revalidate?: () => Promise<void>;
      onCommit?: () => void;
      signal?: AbortSignal;
      /** The caller's voice; the handover drain marks its own re-entry. */
      author?: "user" | "coordinator";
    },
  ) {
    const project = this.requireProject(projectId);
    if (this.coordinatorSwitches.has(projectId))
      throw new ProjectError("A coordinator switch is already in progress.");
    // A user's request to replace a still-working or still-unconfirmed
    // incumbent is durable intent, not a blocked action: it lands in the same
    // journaled handover the coordinator can request itself, and the drain
    // performs the guarded swap at the incumbent's natural quiescence. Idle,
    // error and missing incumbents take the direct recovery path below. The
    // drain re-enters this method with a revalidate hook, which is how its
    // call is told apart from a fresh user request.
    if (
      !options?.revalidate &&
      !input.adoptThreadId &&
      project.coordinatorThreadId &&
      (options?.author ?? "user") === "user" &&
      (await this.incumbentBusy(projectId, project.coordinatorThreadId))
    )
      return this.requestHandover(
        projectId,
        {
          reason: input.reason,
          checkpoint: input.checkpoint,
          profile: input.profile,
          environment: input.environment,
        },
        "user",
      );
    this.coordinatorSwitches.set(projectId, project.coordinatorThreadId);
    try {
      return await this.performCoordinatorReplacement(projectId, input, options);
    } finally {
      this.coordinatorSwitches.delete(projectId);
    }
  }

  /**
   * Whether replacement must wait for the incumbent: an unconfirmed start,
   * a busy foreground turn, queued or background work, or a lookup that
   * answered nothing. Archived, deleted, missing and quiet threads — including
   * the `error` status — return false so the direct recovery path runs.
   */
  private async incumbentBusy(projectId: string, threadId: string) {
    const start = this.coordinatorStart(projectId);
    if (start && ["pending", "uncertain"].includes(start.state)) return true;
    try {
      const thread = await this.sdk.threads.get({ threadId });
      return (
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (BUSY_STATUSES.has(thread.status) ||
          thread.status === "pending" ||
          thread.queuedMessageCount > 0 ||
          thread.activeBackgroundAgentCount > 0)
      );
    } catch (error) {
      // A failed lookup proves nothing either way; the durable path retries.
      return (error as { status?: number }).status !== 404;
    }
  }

  private async performCoordinatorReplacement(
    projectId: string,
    input: Parameters<ProjectsService["replaceCoordinator"]>[1],
    options?: Parameters<ProjectsService["replaceCoordinator"]>[2],
  ) {
    const project = this.requireProject(projectId);
    if (input.adoptThreadId && input.profile)
      throw new ProjectError(
        "Adopting keeps that thread’s execution settings. Choose a profile when starting a new coordinator.",
      );
    await this.assertCoordinatorIdle(project.coordinatorThreadId);
    if (input.checkpoint)
      this.store.updateProject(projectId, { checkpoint: input.checkpoint });
    if (input.adoptThreadId) {
      const start = this.coordinatorStart(projectId);
      if (start && ["pending", "uncertain"].includes(start.state))
        throw new ProjectError(
          "Settle the unconfirmed coordinator start before adopting a replacement.",
        );
      const thread = await this.sdk.threads.get({
        threadId: input.adoptThreadId,
      });
      await this.assertAdoptionRole(thread, "coordinator");
      const existing = this.store.membership(thread.id);
      // A lightweight adhoc claim on this project upgrades to coordinator
      // the same way it upgrades to an explicit worker membership; every
      // other existing membership still wins.
      if (
        existing &&
        !(existing.kind === "adhoc" && existing.project.id === projectId) &&
        (existing.workerNum !== 0 ||
          (!existing.former && existing.project.id !== projectId))
      )
        throw new ProjectError(
          `That thread already belongs to ${existing.project.name}.`,
        );
      const primaryMember = project.memberProjectIds[0];
      if (thread.projectId !== primaryMember)
        throw new ProjectError(
          `The coordinator must run on the primary member project ${primaryMember} (its default source checkout); the adopted thread lives in ${thread.projectId}.`,
        );
      await this.assertAdoptedCoordinatorHome(
        primaryMember!,
        thread.environmentId,
      );
      await this.assertCoordinatorIdle(project.coordinatorThreadId);
      const current = this.requireProject(projectId);
      if (current.coordinatorThreadId !== project.coordinatorThreadId)
        throw new ProjectError(
          "The coordinator changed while inspecting its replacement. Read the current Initiative.",
        );
      if (current.memberProjectIds[0] !== primaryMember)
        throw new ProjectError(
          "The primary member project changed while inspecting its replacement. Re-read the Initiative.",
        );
      this.store.tx(() => {
        this.store.setCoordinator(projectId, thread.id, input.reason);
        this.store.log(
          projectId,
          "coordinator",
          `Coordinator replaced by ${thread.title ?? thread.id}: ${input.reason}`,
        );
      });
      await this.tagThread(thread.id, { role: "coordinator", projectId });
      const note = await this.reloadToolsIfIdle(thread);
      await this.convergeFormerCoordinators(projectId);
      return {
        threadId: thread.id,
        note,
      };
    }
    // Preserve the incumbent's effective execution settings unless the caller
    // overrode them — the same defaultExecutionOptions resolution the
    // handover drain performs. A positively missing incumbent has nothing to
    // preserve, but a lookup that fails or comes back empty without proving
    // absence leaves the settings unknown: replacing now would silently drop
    // its model, approval mode, and service tier, so the replacement holds
    // instead. The provider comes from the incumbent DTO already read here —
    // a second lookup could only fail, and a policy provider/model is never a
    // stand-in for a live incumbent's effective profile.
    let profile = input.profile;
    let execution = options?.execution;
    const incumbentId = project.coordinatorThreadId;
    if ((!profile || !execution) && incumbentId) {
      let incumbent: ThreadDto | null;
      try {
        incumbent = await this.sdk.threads.get({ threadId: incumbentId });
      } catch (error) {
        if ((error as { status?: number }).status === 404) incumbent = null;
        else
          throw new ProjectError(
            `The incumbent coordinator ${incumbentId} could not be checked (${errorMessage(error)}); its effective settings are unprovable, so the replacement is held. Read the current Initiative before retrying.`,
          );
      }
      if (incumbent) {
        let resolved: Awaited<
          ReturnType<Sdk["threads"]["defaultExecutionOptions"]>
        > | null = null;
        let incumbentGone = false;
        try {
          resolved = await this.sdk.threads.defaultExecutionOptions({
            threadId: incumbentId,
          });
        } catch (error) {
          if ((error as { status?: number }).status === 404) {
            // The incumbent disappeared between the existence check and the
            // settings lookup — positively absent, nothing to preserve.
            incumbentGone = true;
          } else {
            throw new ProjectError(
              `The incumbent coordinator's effective settings could not be resolved (${errorMessage(error)}); replacing it now would silently drop its model, approval mode, and service tier, so the replacement is held. Retry once the lookup responds.`,
            );
          }
        }
        if (!incumbentGone) {
          // Null options are a resolved answer, not absence: the incumbent is
          // positively live and BB reports no effective execution options —
          // permission mode and service tier are unprovable even when the
          // caller overrode the profile, so the replacement holds rather than
          // proceeding on assumed defaults.
          if (resolved == null)
            throw new ProjectError(
              `BB has no recorded execution options for the incumbent coordinator, so its effective permission mode and service tier are unprovable; the replacement is held rather than silently dropping them. Retry once the incumbent's settings resolve.`,
            );
          if (!profile) {
            if (!resolved.model || !resolved.reasoningLevel || !incumbent.providerId)
              throw new ProjectError(
                `The incumbent coordinator's effective profile is unprovable (${[
                  resolved.model ? null : "no recorded model",
                  resolved.reasoningLevel ? null : "no recorded reasoning level",
                  incumbent.providerId ? null : "no provider id on the thread record",
                ]
                  .filter(Boolean)
                  .join(", ")}); the replacement is held rather than silently falling back to the policy default. Pass an explicit profile to override.`,
              );
            profile = {
              providerId: incumbent.providerId,
              model: resolved.model,
              reasoningLevel:
                resolved.reasoningLevel as Profile["reasoningLevel"],
              ...(resolved.serviceTier ? { serviceTier: resolved.serviceTier } : {}),
            };
          }
          execution ??= {
            permissionMode: resolved.permissionMode,
            serviceTier: resolved.serviceTier,
          };
        }
      }
    }
    const { thread, confirmed } = await this.spawnCoordinator(
      this.store.project(projectId)!,
      input.bbProjectId ?? project.memberProjectIds[0]!,
      input.reason,
      input.environment,
      profile,
      { ...options, execution },
    );
    // The sweep confirms a late checkout and then converges the predecessor.
    if (!confirmed)
      return { threadId: thread.id, state: "checkout-pending" as const, note: CHECKOUT_PENDING_NOTE };
    // The swap is durable now: children move to the new coordinator and the
    // predecessor archives once that transfer is positively complete. Nothing
    // this settles throws — a partial or blocked move leaves the predecessor
    // live and the sweep converges it.
    await this.convergeFormerCoordinators(projectId, options?.signal);
    return { threadId: thread.id, note: null };
  }

  /**
   * Converge every ended coordinator generation that is still live natively:
   * this covers the immediate predecessor after a confirmed switch and any
   * former coordinator an earlier transfer left behind. Called after each
   * confirmed switch and by the sweep; the sweep (`backoff`) skips a
   * predecessor whose last refusal is still inside its retry delay, while
   * event-driven calls always try.
   */
  async convergeFormerCoordinators(
    projectId: string,
    signal?: AbortSignal,
    options?: { backoff?: boolean },
  ) {
    const project = this.store.project(projectId);
    if (!project || project.archivedAt !== null || !project.coordinatorThreadId)
      return;
    const current = project.coordinatorThreadId;
    // A thread made coordinator again is no longer an ended former.
    this.endedFormers.delete(current);
    for (const generation of this.store.generations(projectId, 0))
      if (
        generation.threadId !== current &&
        generation.endedAt !== null &&
        !this.endedFormers.has(generation.threadId)
      ) {
        if (signal?.aborted) return;
        if (
          options?.backoff &&
          (this.formerRetries.get(generation.threadId)?.nextAt ?? 0) > this.now()
        )
          continue;
        await this.convergeFormerCoordinator(projectId, generation.threadId, signal);
      }
  }

  /**
   * A predecessor stays live for `reason`: the reason is recorded on its
   * generation and logged only when it changes. A new refusal is retried on
   * the next sweep; only a repeat of the same one backs the sweep off.
   */
  private holdFormerCoordinator(
    projectId: string,
    predecessorId: string,
    reason: string,
  ) {
    const changed = this.store.holdGeneration(projectId, predecessorId, reason);
    const previous = this.formerRetries.get(predecessorId);
    const attempts = changed || !previous ? 1 : previous.attempts + 1;
    this.formerRetries.set(predecessorId, {
      attempts,
      nextAt:
        attempts === 1
          ? 0
          : this.now() +
            Math.min(FORMER_RETRY_BASE_MS * 2 ** (attempts - 2), FORMER_RETRY_MAX_MS),
    });
    if (changed)
      this.store.log(
        projectId,
        "coordinator",
        `Former coordinator ${predecessorId} stays live: ${reason}`,
        { threadId: predecessorId },
      );
  }

  /** The predecessor is archived, deleted or gone: done, and dropped from every later pass. */
  private formerCoordinatorEnded(projectId: string, predecessorId: string) {
    this.formerRetries.delete(predecessorId);
    this.endedFormers.add(predecessorId);
    this.store.holdGeneration(projectId, predecessorId, null);
  }

  /**
   * Finish a confirmed coordinator switch for one predecessor: move its live
   * native children under the current coordinator, then archive it under the
   * same quiet/descendant guards workers retire with. Anything that fails —
   * an unmoved child, an unconfirmed worker attach, or a successor that was
   * itself replaced mid-pass — leaves the predecessor live and visible; the
   * sweep retries until it converges.
   */
  private async convergeFormerCoordinator(
    projectId: string,
    predecessorId: string | null,
    signal?: AbortSignal,
  ) {
    if (!predecessorId) return;
    const project = this.store.project(projectId);
    if (
      !project ||
      project.archivedAt !== null ||
      !project.coordinatorThreadId ||
      project.coordinatorThreadId === predecessorId
    )
      return;
    try {
      let live: ThreadDto;
      const epoch = this.discovery.begin();
      try {
        live = await this.sdk.threads.get({ threadId: predecessorId });
      } catch (error) {
        if ((error as { status?: number }).status === 404)
          return this.formerCoordinatorEnded(projectId, predecessorId);
        throw error;
      }
      // A parentless former generation appears in no listing; this read is its observation.
      this.discovery.observe([live], epoch, new Set([predecessorId]));
      // Only a well-formed archive/delete timestamp proves it ended; unreadable
      // lifecycle fields keep it held, visible and retried.
      if (
        !ProjectsService.lifecycleWellFormed(live.archivedAt) ||
        !ProjectsService.lifecycleWellFormed(live.deletedAt)
      )
        return this.holdFormerCoordinator(
          projectId,
          predecessorId,
          "its native thread returned unreadable lifecycle evidence",
        );
      if (live.archivedAt !== null || live.deletedAt !== null)
        return this.formerCoordinatorEnded(projectId, predecessorId);
      // Each round receipts every worker against the CURRENT coordinator,
      // then drains the parent-op registry for this predecessor before the
      // descendant check and archive — a reparent issued while it was still
      // current can no longer land a child between that check and the
      // archive mutation. A drained op that still landed something loops the
      // round instead of archiving over it.
      for (let round = 0; round < 4; round++) {
        if (signal?.aborted) return;
        const unresolved = await this.transferCoordinatorChildren(
          projectId,
          predecessorId,
          signal,
        );
        if (signal?.aborted) return;
        const remaining = await this.liveChildren(predecessorId);
        if (remaining.length || unresolved.length) {
          this.holdFormerCoordinator(
            projectId,
            predecessorId,
            `${
              [
                remaining.length
                  ? `${remaining.length} native ${remaining.length === 1 ? "child" : "children"} could not be confirmed moved`
                  : null,
                unresolved.length
                  ? `${unresolved.join(", ")} ${unresolved.length === 1 ? "is" : "are"} not confirmed under the new coordinator`
                  : null,
              ]
                .filter(Boolean)
                .join("; ")
            }; the sweep retries until the transfer is positive.`,
          );
          return;
        }
        await this.parentOpsIdle(projectId, predecessorId);
        const snapshot = this.store.project(projectId);
        if (
          !snapshot ||
          snapshot.archivedAt !== null ||
          !snapshot.coordinatorThreadId ||
          snapshot.coordinatorThreadId === predecessorId
        ) {
          this.holdFormerCoordinator(
            projectId,
            predecessorId,
            "the coordinator changed during the transfer; the next pass settles the leftovers.",
          );
          return;
        }
        // An issued op that drained mid-wait may still have landed a child —
        // rechecking under the drained registry proves the set is empty for
        // the archive call itself.
        if ((await this.liveChildren(predecessorId)).length) continue;
        if (signal?.aborted) return;
        await this.retireThread(predecessorId);
        this.formerCoordinatorEnded(projectId, predecessorId);
        this.store.log(
          projectId,
          "coordinator",
          "Former coordinator archived after its transfer to the replacement completed.",
        );
        return;
      }
      this.holdFormerCoordinator(
        projectId,
        predecessorId,
        "its child set did not stay empty across four convergence rounds; the sweep retries.",
      );
    } catch (error) {
      this.holdFormerCoordinator(projectId, predecessorId, errorMessage(error));
    }
  }

  /** Every live native child, hidden ones included — archived rows are already safe under a parent archive. */
  private async liveChildren(
    parentThreadId: string,
  ): Promise<ThreadListRow[]> {
    const out: ThreadListRow[] = [];
    for (let offset = 0; ; offset += DESCENDANT_PAGE) {
      const page = await this.sdk.threads.list({
        parentThreadId,
        archived: false,
        includeHidden: true,
        limit: DESCENDANT_PAGE,
        offset,
      });
      out.push(...page);
      if (page.length < DESCENDANT_PAGE) return out;
    }
  }

  /**
   * Every current member root moves to the successor — managed workers AND
   * the user's own project threads — with a positive receipt for each; the
   * caller keeps the predecessor live while that list or any live native
   * child remains.
   *
   * Phase one classifies each live child of `fromId`. A current worker or a
   * current user-owned member root moves in the receipt pass below. A
   * still-unclaimed child is claimed into the ledger first so its initiative
   * link survives, then moves like any member. A thread another initiative
   * owns is NEVER detached just to let the archive pass: it stays attached
   * and the predecessor stays live, with the foreign hold logged honestly.
   * Only an ended member of this initiative — a former generation or a
   * retired worker still live — is detached, so the predecessor's archive
   * cannot cascade its subtree.
   *
   * Phase two produces a positive receipt for EVERY current member root,
   * wherever it natively sits: a member under the predecessor, an adopted or
   * user thread with no native parent, one stranded under an older
   * generation. A user thread nested under another live member of this
   * initiative keeps that arrangement — roots move, subtrees are never
   * flattened. The receipt target is re-read from the ledger for every
   * mutation because a sweep can race a second replacement — members must
   * never be moved back under an already-former coordinator. A thread that
   * is positively archived or deleted needs no receipt; an unreadable or
   * failed attach stays unresolved and holds the predecessor live.
   *
   * After `signal` aborts no further child or member is read or moved; a
   * reparent already issued still finishes with its confirmation, and the
   * caller leaves the predecessor live for the next sweep. The unresolved
   * list of an aborted pass is incomplete, so the caller must check the
   * signal before treating it as a finished transfer.
   */
  private async transferCoordinatorChildren(
    projectId: string,
    fromId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const currentSuccessor = () =>
      this.store.project(projectId)?.coordinatorThreadId ?? null;
    // Every issued reparent registers under the parent whose child-set it can
    // still change — an attach beneath `watched` — so an issued-but-unresolved
    // update holds that parent's archival until its receipt lands.
    const reparent = async (
      threadId: string,
      target: string | null,
      watched: string | null,
    ) => {
      this.parentOpBegin(projectId, watched);
      try {
        let confirmed: string | null | undefined;
        try {
          confirmed = (
            await this.sdk.threads.update({
              threadId,
              parentThreadId: target,
            })
          ).parentThreadId;
        } catch {
          confirmed = undefined;
        }
        if (confirmed !== target) {
          try {
            confirmed = (
              await this.sdk.threads.get({ threadId })
            ).parentThreadId;
          } catch {
            confirmed = undefined;
          }
        }
        return confirmed === target;
      } finally {
        this.parentOpEnd(projectId, watched);
      }
    };
    for (const child of await this.liveChildren(fromId)) {
      if (signal?.aborted) return [];
      const title = child.title ?? child.titleFallback ?? child.id;
      let member = this.store.membership(child.id, true);
      if (!member) {
        // A still-unclaimed child of the outgoing coordinator is a member of
        // this initiative by discovery's own rule — claim it first so its
        // ledger link survives, then let the receipt pass move it.
        this.associateNativeChild(child);
        member = this.store.membership(child.id, true);
        if (member?.project.id === projectId && !member.former) continue;
        this.store.log(
          projectId,
          "coordinator",
          `Native child ${title} of the former coordinator could not be claimed into the initiative; it stays attached and keeps the predecessor live until ownership settles.`,
        );
        continue;
      }
      if (member.project.id !== projectId) {
        // A thread another initiative owns is never detached just to let the
        // archive pass: the predecessor stays live with the hold logged.
        this.store.log(
          projectId,
          "coordinator",
          `${title} belongs to ${member.project.name}; it stays under the former coordinator — which remains live — until its own initiative moves it.`,
        );
        continue;
      }
      if (
        !member.former &&
        (member.kind === "adhoc" ||
          (member.kind === "worker" && member.worker?.state !== "retired"))
      )
        // A current member — a worker or a user-owned thread — moves in the
        // receipt pass below.
        continue;
      // Ours but ended — a former generation or a retired worker still live —
      // or the current coordinator itself, which is a tree root, not a child.
      // Detaching protects its subtree from the predecessor's archive
      // cascade; history stays in the ledger.
      if (!(await reparent(child.id, null, child.parentThreadId ?? fromId))) {
        this.store.log(
          projectId,
          "coordinator",
          `Could not confirm detaching native child ${title} off the former coordinator; it stays where it is for now.`,
        );
        continue;
      }
      this.store.log(
        projectId,
        "coordinator",
        `Detached ${title} — ${
          member.kind === "coordinator" && !member.former
            ? "the current coordinator, which is a tree root, not a child"
            : "an ended member of this initiative"
        } — from the former coordinator before archiving it.`,
      );
    }
    const unresolved = new Set<string>();
    // Bounded re-verification: when the coordinator changed mid-pass the
    // next pass receipts every worker against the fresh successor, so an
    // in-flight move to the older one is repaired instead of stranded.
    for (let pass = 0; pass < 3; pass++) {
      if (signal?.aborted) break;
      const target = currentSuccessor();
      unresolved.clear();
      // The pass holds an op under its captured target from decision to the
      // last issued update: a target since superseded can still have
      // in-flight reads to answer, and its archive must wait out every
      // reparent this pass can still issue — not only the already-issued.
      this.parentOpBegin(projectId, target);
      try {
        for (const worker of this.store.workers(projectId)) {
          if (signal?.aborted) break;
          if (worker.state === "retired" || !worker.threadId) continue;
          if (!target || target === fromId) {
            unresolved.add(worker.ref);
            continue;
          }
          let thread: ThreadDto;
          try {
            thread = await this.sdk.threads.get({ threadId: worker.threadId });
          } catch (error) {
            // A positively-gone thread needs no receipt; any other failure
            // proves nothing and keeps the predecessor live.
            if ((error as { status?: number }).status !== 404)
              unresolved.add(worker.ref);
            continue;
          }
          if (signal?.aborted) break;
          if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
          if (thread.parentThreadId === target) {
            if (!worker.nativeParent)
              this.store.updateWorker(projectId, worker.num, {
                nativeParent: true,
              });
            continue;
          }
          if (await reparent(worker.threadId, target, target)) {
            this.store.updateWorker(projectId, worker.num, {
              nativeParent: true,
            });
            continue;
          }
          unresolved.add(worker.ref);
          this.store.log(
            projectId,
            "coordinator",
            `Could not attach ${worker.ref} natively to the new coordinator; the former coordinator stays live until its transfer is confirmed.`,
          );
        }
        // The user's own member threads move like workers do — every current
        // member root joins the successor's tree — except one the user nested
        // under another live member of this initiative, which rides with that
        // subtree instead of being flattened out of it.
        for (const record of [
          ...this.store.projectThreads(projectId),
          ...this.store.nestedProjectThreads(projectId),
        ]) {
          if (signal?.aborted) break;
          if (!record.threadId) continue;
          // Nested claims carry no create-op state; project threads do.
          if ("state" in record && record.state !== "active") continue;
          const member = this.store.membership(record.threadId, true);
          if (
            member?.kind !== "adhoc" ||
            member.former ||
            member.project.id !== projectId
          )
            continue;
          const ref = `"${record.label}"`;
          if (!target || target === fromId) {
            unresolved.add(ref);
            continue;
          }
          let thread: ThreadDto;
          try {
            thread = await this.sdk.threads.get({ threadId: record.threadId });
          } catch (error) {
            if ((error as { status?: number }).status !== 404)
              unresolved.add(ref);
            continue;
          }
          if (signal?.aborted) break;
          if (thread.archivedAt !== null || thread.deletedAt !== null)
            continue;
          if (thread.parentThreadId === target) continue;
          const parentMember = thread.parentThreadId
            ? this.store.membership(thread.parentThreadId, true)
            : null;
          if (
            parentMember &&
            !parentMember.former &&
            parentMember.project.id === projectId &&
            parentMember.kind !== "coordinator" &&
            (parentMember.kind !== "worker" ||
              parentMember.worker?.state !== "retired")
          )
            continue;
          if (await reparent(record.threadId, target, target)) continue;
          unresolved.add(ref);
          this.store.log(
            projectId,
            "coordinator",
            `Could not attach user thread "${record.label}" natively to the new coordinator; the former coordinator stays live until its transfer is confirmed.`,
          );
        }
      } finally {
        this.parentOpEnd(projectId, target);
      }
      if (signal?.aborted || unresolved.size || currentSuccessor() === target)
        break;
      // The successor changed during the pass: re-verify against the new one.
    }
    return [...unresolved];
  }

  // Coordinator handovers ------------------------------------------------------
  // A handover is durable intent, not a call into BB: the runtime drains it at
  // the predecessor's natural idle boundary through the guarded replacement.

  /**
   * Record a fresh-coordinator request, callable from inside the current
   * coordinator's own turn. Nothing native happens here; the drain runs the
   * replacement once the predecessor finishes naturally.
   */
  requestHandover(
    projectId: string,
    input: {
      reason?: string;
      checkpoint?: string;
      profile?: Profile;
      environment?: EnvironmentChoice;
    },
    author: "coordinator" | "user",
  ) {
    const project = this.requireProject(projectId);
    if (this.coordinatorSwitches.has(projectId))
      throw new ProjectError(
        "A coordinator switch is already in progress. Wait for it to settle.",
      );
    const reason =
      input.reason ??
      (author === "coordinator"
        ? "The coordinator handed over to a fresh thread"
        : "Handover requested from the dashboard");
    const pending = this.store.pendingHandover(projectId) !== null;
    const start = this.coordinatorStart(projectId);
    const waiting = [
      author === "coordinator" ? "the current turn" : null,
      project.paused ? "the Initiative pause" : null,
      start && ["pending", "uncertain"].includes(start.state)
        ? "an unconfirmed coordinator start"
        : null,
    ].filter((hold): hold is string => hold !== null);
    this.store.tx(() => {
      if (input.checkpoint !== undefined)
        this.store.updateProject(projectId, { checkpoint: input.checkpoint });
      this.store.upsertHandover({
        projectId,
        threadId: project.coordinatorThreadId,
        reason,
        profile: input.profile ?? null,
        environment: input.environment ?? null,
        requestedBy: author,
      });
      this.store.log(
        projectId,
        "coordinator",
        `${author === "coordinator" ? "The coordinator" : "You"} requested a fresh coordinator${pending ? " (updating the pending request)" : ""}: ${reason}${input.environment?.type === "reuse" ? ` on environment ${input.environment.environmentId}` : ""}`,
      );
    });
    return {
      state: "pending" as const,
      updated: pending,
      waiting,
      profile: input.profile
        ? describeProfile(input.profile)
        : "the current effective profile",
      environment:
        input.environment?.type === "reuse"
          ? input.environment.environmentId
          : (input.environment?.type ?? "the incumbent's environment"),
      note: "Recorded. The replacement starts when the current coordinator turn ends naturally; it does not interrupt running work. Cancel with the same action and cancel:true.",
    };
  }

  /** Withdraw a recorded handover; the current coordinator stays in charge. */
  cancelHandover(projectId: string, author: "coordinator" | "user") {
    this.requireProject(projectId);
    const handover = this.store.handover(projectId);
    if (!handover)
      throw new ProjectError("No coordinator handover is recorded.");
    if (this.handoverSpawnInflight.has(projectId))
      return {
        state: "pending" as const,
        detail: handover.detail,
        note: "The replacement spawn is already in flight and cannot be withdrawn. Its outcome will be recorded and reconciled; inspect the Initiative before retrying.",
      };
    // A durable unconfirmed start means a replacement send may already have
    // landed even after a reload — never claim the coordinator stays in
    // charge while one is unresolved.
    const start = this.coordinatorStart(projectId);
    if (start && ["pending", "uncertain"].includes(start.state))
      return {
        state: "pending" as const,
        detail: handover.detail,
        note: "The replacement coordinator's start is still unconfirmed — it may already have launched and will be reconciled rather than withdrawn. Inspect the Initiative once it settles.",
      };
    this.store.tx(() => {
      this.store.clearHandover(projectId);
      this.store.log(
        projectId,
        "coordinator",
        `Coordinator handover ${author === "coordinator" ? "withdrawn by the coordinator" : "cancelled"}`,
      );
    });
    return {
      state: "cancelled" as const,
      detail: handover.detail,
      note: "The recorded handover was withdrawn; the current coordinator stays in charge.",
    };
  }

  private coordinatorStart(projectId: string) {
    return this.store.db
      .prepare("SELECT op_id, state FROM coordinator_starts WHERE project_id=?")
      .get(projectId) as { op_id: string; state: string } | undefined;
  }

  /**
   * Consume a recorded handover once the predecessor is quiesced. The drain is
   * bound to the durable request revision it last read: after every awaited
   * lookup and again at the journal/spawn boundary it revalidates intent,
   * pause, incumbent identity, natural completion and all queued or
   * background work. A superseded or cancelled request is rebound, never
   * cleared or failed by the stale attempt.
   */
  async drainHandover(projectId: string, signal?: AbortSignal) {
    for (let passes = 0; passes < 10; passes++) {
      if (signal?.aborted) return;
      const request = this.store.pendingHandover(projectId);
      if (!request) return;
      if ((await this.drainHandoverAttempt(projectId, request, signal)) !== "rescan")
        return;
    }
  }

  private async drainHandoverAttempt(
    projectId: string,
    request: HandoverRecord,
    signal?: AbortSignal,
  ): Promise<"resolved" | "rescan"> {
    const revision = request.revision;
    // The incumbent the drain verified most recently; reused for environment
    // and provider preservation so every check looks at the same snapshot.
    let predecessor: ThreadDto | null = null;
    const readPredecessor = () => predecessor;
    // True while this attempt's own replaceCoordinator holds the switch flag;
    // revalidating inside it must not mistake our own hold for a foreign one.
    let inReplacement = false;

    // Gates that must hold at every boundary: the same request revision is
    // still pending, the incumbent coordinator is unchanged, and the project
    // is live, unpaused and not already switching.
    const checkGates = (): HandoverRecheck | null => {
      // Shutdown leaves the request pending, untouched, for the next sweep.
      if (signal?.aborted) return { kind: "rescan" };
      const current = this.store.pendingHandover(projectId);
      if (!current || current.revision !== revision)
        return { kind: "rescan" };
      const project = this.store.project(projectId);
      if (!project || project.archivedAt !== null)
        return {
          kind: "drop",
          reason: "Coordinator handover dropped: the Initiative is archived.",
        };
      if (project.coordinatorThreadId !== request.threadId)
        return {
          kind: "drop",
          reason:
            "Coordinator handover dropped: the coordinator already changed.",
        };
      if (project.paused)
        return { kind: "hold", reason: "the Initiative is paused" };
      if (!inReplacement && this.coordinatorSwitches.get(projectId) !== undefined)
        return {
          kind: "hold",
          reason: "a coordinator switch is already in progress",
        };
      const start = this.coordinatorStart(projectId);
      if (start && ["pending", "uncertain"].includes(start.state))
        return {
          kind: "hold",
          reason:
            "a coordinator start is still unconfirmed — reconcile it first",
        };
      return null;
    };

    // The predecessor must be quiesced and naturally completed: nothing
    // running, queued or backgrounded, and positive evidence that its latest
    // turn completed. History is read before the quiescence snapshot so work
    // arriving during that await is still caught; degraded predecessors are
    // held, never revived or bypassed. An interrupted latest turn holds the
    // handover until a newer native turn completes — BB owns what counts as
    // continuation.
    const checkPredecessor = async (): Promise<HandoverRecheck | null> => {
      if (!request.threadId) return null;
      let boundary: { type?: string; data?: unknown } | undefined;
      try {
        [boundary] = await this.sdk.threads.events.list({
          threadId: request.threadId,
          types: ["turn/started", "turn/completed"],
          order: "desc",
          limit: "1",
        });
      } catch {
        return {
          kind: "hold",
          reason:
            "the current coordinator's turn history could not be checked; it retries automatically",
        };
      }
      const gates = checkGates();
      if (gates) return gates;
      try {
        predecessor = await this.sdk.threads.get({
          threadId: request.threadId,
        });
      } catch (error) {
        return {
          kind: "hold",
          reason:
            (error as { status?: number }).status === 404
              ? "the current coordinator's thread no longer resolves"
              : "checking the current coordinator failed; it retries automatically",
        };
      }
      const after = checkGates();
      if (after) return after;
      if (predecessor.archivedAt !== null || predecessor.deletedAt !== null)
        return {
          kind: "hold",
          reason: "the current coordinator was archived or deleted",
        };
      if (
        BUSY_STATUSES.has(predecessor.status) ||
        predecessor.status === "pending"
      )
        return {
          kind: "hold",
          reason: "the current coordinator is still working",
        };
      if (predecessor.status !== "idle")
        return {
          kind: "hold",
          reason: `the current coordinator is ${predecessor.status}`,
        };
      if (predecessor.queuedMessageCount > 0)
        return {
          kind: "hold",
          reason: "new input is queued for the current coordinator",
        };
      if (predecessor.activeBackgroundAgentCount > 0)
        return {
          kind: "hold",
          reason: "the current coordinator still has background work",
        };
      // Absence of history is not evidence: a quiesced thread whose latest
      // turn boundary is missing, still open, or lacks a recorded outcome
      // holds until a natural completion lands.
      if (!boundary)
        return {
          kind: "hold",
          reason:
            "no completed turn is recorded for the current coordinator; the handover waits for one",
        };
      if (boundary.type === "turn/started")
        return {
          kind: "hold",
          reason:
            "the current coordinator's latest turn has no completion receipt; the handover waits for it to finish",
        };
      const lastTurn =
        (boundary.data as { status?: string } | undefined)?.status ?? null;
      if (lastTurn === "interrupted")
        return {
          kind: "hold",
          reason: "the current coordinator's last turn was interrupted",
        };
      if (lastTurn !== "completed")
        return {
          kind: "hold",
          reason: lastTurn
            ? `the current coordinator's last turn ${lastTurn}`
            : "the current coordinator's last turn has no recorded outcome",
        };
      return null;
    };

    const recheck = async (): Promise<HandoverRecheck> =>
      checkGates() ??
      (await checkPredecessor()) ?? { kind: "ok", predecessor: readPredecessor() };

    const apply = (outcome: HandoverRecheck): "resolved" | "rescan" => {
      if (outcome.kind === "rescan") return "rescan";
      if (outcome.kind === "hold")
        return this.holdHandover(projectId, revision, outcome.reason);
      if (outcome.kind !== "drop") return "resolved";
      this.store.tx(() => {
        if (this.store.clearHandover(projectId, revision))
          this.store.log(projectId, "coordinator", outcome.reason);
      });
      return "resolved";
    };

    const first = await recheck();
    if (first.kind !== "ok") return apply(first);

    // Execution settings to preserve: the model/effort/provider only for a
    // context-only request; permission mode and service tier ride along
    // either way so the replacement keeps the predecessor's posture.
    let profile = request.profile;
    let execution: HandoverExecution | undefined;
    if (request.threadId) {
      let options: Awaited<
        ReturnType<Sdk["threads"]["defaultExecutionOptions"]>
      > | null;
      try {
        options = await this.sdk.threads.defaultExecutionOptions({
          threadId: request.threadId,
        });
      } catch {
        return apply({
          kind: "hold",
          reason:
            "checking the current coordinator's execution options failed; it retries automatically",
        });
      }
      const again = await recheck();
      if (again.kind !== "ok") return apply(again);
      // Null options are a resolved answer, not absence: the incumbent is
      // positively live, and BB reports no effective execution options — its
      // permission mode and service tier are unprovable even when the caller
      // overrode the profile. A definite evidence gap fails the handover;
      // it never proceeds on assumed defaults.
      if (options === null || options === undefined)
        return this.markHandoverFailed(
          projectId,
          revision,
          "BB has no recorded execution options for the current coordinator, so its effective permission mode and service tier cannot be preserved. Request the handover again once its settings resolve.",
        );
      if (!profile) {
        if (
          !options.model ||
          !options.reasoningLevel ||
          !again.predecessor?.providerId
        )
          return this.markHandoverFailed(
            projectId,
            revision,
            `BB ${[
              options.model ? null : "has no recorded model",
              options.reasoningLevel ? null : "has no recorded reasoning level",
              again.predecessor?.providerId
                ? null
                : "returned no provider id on the coordinator's thread record",
            ]
              .filter(Boolean)
              .join(", ")}; the incumbent's effective profile cannot be preserved. Request the handover again with an explicit profile.`,
          );
        profile = {
          // The recheck above fetched the incumbent, so it is non-null here.
          providerId: again.predecessor.providerId,
          model: options.model,
          reasoningLevel: options.reasoningLevel as Profile["reasoningLevel"],
          ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        };
      }
      execution = {
        permissionMode: options.permissionMode,
        serviceTier: options.serviceTier,
      };
    }
    const project = this.requireProject(projectId);
    const verified = readPredecessor();
    const primaryMember = project.memberProjectIds[0]!;
    // The coordinator's home is the primary member's default checkout: an
    // incumbent living on a secondary member is not a home source.
    const sameProject =
      verified && verified.projectId === primaryMember ? verified : null;
    const bbProjectId = primaryMember;
    // The request's environment wins: an explicit override exists precisely to
    // move the replacement off an incumbent registered on the wrong host. An
    // incumbent environment is only reused when it strictly proves to be the
    // coordinator home; otherwise the replacement lands on the default
    // checkout instead of perpetuating the mismatch.
    const incumbentEnvironment = sameProject?.environmentId
      ? await this.sdk.environments
          .get({ environmentId: sameProject.environmentId })
          .then(async (env) =>
            (await this.coordinatorHomeProblem(
              bbProjectId,
              { ...env, id: sameProject.environmentId! },
              true,
            )) === null
              ? ({
                  type: "reuse",
                  environmentId: sameProject.environmentId,
                } as EnvironmentChoice)
              : null,
          )
          .catch(() => null)
      : null;
    const environment: EnvironmentChoice =
      request.environment ??
      incumbentEnvironment ?? { type: "project-default" };
    const startBefore = this.coordinatorStart(projectId);
    inReplacement = true;
    try {
      await this.replaceCoordinator(
        projectId,
        {
          reason: request.reason,
          ...(profile ? { profile } : {}),
          bbProjectId,
          environment,
        },
        {
          execution,
          onCommit: () => this.handoverSpawnInflight.add(projectId),
          signal,
          revalidate: async () => {
            const outcome = await recheck();
            if (outcome.kind !== "ok") throw new HandoverAbort(outcome);
          },
        },
      );
    } catch (error) {
      if (error instanceof HandoverAbort) return apply(error.outcome);
      const message = errorMessage(error);
      const current = this.store.project(projectId);
      const start = this.coordinatorStart(projectId);
      const attempted =
        start !== undefined && start.op_id !== startBefore?.op_id;
      if (
        !current ||
        current.archivedAt !== null ||
        current.coordinatorThreadId !== request.threadId
      )
        return apply({
          kind: "drop",
          reason:
            "Coordinator handover dropped: the coordinator changed while its replacement was being prepared.",
        });
      if (attempted)
        return start.state === "failed"
          ? this.markHandoverFailed(
              projectId,
              revision,
              `The replacement could not start: ${message}`,
            )
          : apply({
              kind: "hold",
              reason:
                "the replacement's start is unconfirmed — reconcile it before retrying",
            });
      // The failure happened before the start was journaled. Re-run the cheap
      // gates first so a race during the awaited catalog/host lookups lands on
      // the same hold, drop or rescan it would have produced mid-flight.
      const gates = checkGates();
      if (gates) return apply(gates);
      if (await this.coordinatorBusy(current.coordinatorThreadId))
        return apply({
          kind: "hold",
          reason: "the current coordinator is still working",
        });
      // ProjectError is a definite rejection (validation, catalog, member
      // rules). Anything else thrown here is a transient lookup failure and
      // stays pending for the next drain.
      if (!(error instanceof ProjectError))
        return apply({
          kind: "hold",
          reason: `the replacement could not be prepared: ${message} — it retries automatically`,
        });
      return this.markHandoverFailed(projectId, revision, message);
    } finally {
      inReplacement = false;
      this.handoverSpawnInflight.delete(projectId);
    }
    // Consumed only if the same revision is still pending.
    this.store.clearHandover(projectId, revision);
    return "resolved";
  }

  /** Record why a pending handover is waiting; logs only when the reason changes. */
  private holdHandover(
    projectId: string,
    revision: number,
    reason: string,
  ): "resolved" {
    const current = this.store.handover(projectId);
    if (current?.revision !== revision || current.state !== "pending")
      return "resolved";
    if (current.detail !== reason)
      this.store.tx(() => {
        if (this.store.holdHandover(projectId, reason, revision))
          this.store.log(
            projectId,
            "coordinator",
            `Coordinator handover held: ${reason}.`,
          );
      });
    return "resolved";
  }

  private markHandoverFailed(
    projectId: string,
    revision: number | undefined,
    detail: string,
  ): "resolved" {
    this.store.tx(() => {
      if (this.store.failHandover(projectId, detail, revision))
        this.store.log(
          projectId,
          "coordinator",
          `Coordinator handover failed: ${detail}`,
        );
    });
    return "resolved";
  }

  private async coordinatorBusy(threadId: string | null) {
    if (!threadId) return false;
    try {
      const thread = await this.sdk.threads.get({ threadId });
      return (
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (BUSY_STATUSES.has(thread.status) ||
          thread.status === "pending" ||
          thread.queuedMessageCount > 0 ||
          thread.activeBackgroundAgentCount > 0)
      );
    } catch {
      return false;
    }
  }

  // Project settings -------------------------------------------------------------

  editProject(
    projectId: string,
    patch: {
      name?: string;
      objective?: string;
      memberProjectIds?: string[];
      policy?: unknown;
      context?: unknown;
      expected?: { name: string; objective: string; context: unknown };
    },
    author: "user" | "coordinator" = "user",
  ) {
    const project = this.requireProject(projectId);
    if (
      patch.expected &&
      (patch.expected.name !== project.name ||
        patch.expected.objective !== project.objective ||
        JSON.stringify(projectContextSchema.parse(patch.expected.context)) !==
          JSON.stringify(project.context))
    )
      throw new ProjectError(
        `${PROJECT_DETAILS_CONFLICT}. Your draft is preserved; review the current details before saving.`,
      );
    const next: Parameters<Store["updateProject"]>[1] = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.objective !== undefined) next.objective = patch.objective;
    if (patch.context !== undefined) {
      const parsed = projectContextSchema.safeParse(patch.context);
      if (!parsed.success)
        throw new ProjectError(
          `Invalid context: ${parsed.error.issues[0]?.message}`,
        );
      next.context = parsed.data;
    }
    if (patch.memberProjectIds !== undefined) {
      if (!patch.memberProjectIds.length)
        throw new ProjectError("An Initiative needs at least one BB project.");
      next.memberProjectIds = [...new Set(patch.memberProjectIds)];
    }
    if (patch.policy !== undefined) {
      const parsed = policySchema.safeParse(patch.policy);
      if (!parsed.success)
        throw new ProjectError(
          `Invalid policy: ${parsed.error.issues[0]?.message}`,
        );
      next.policy = parsed.data;
    }
    const changedFields = [
      ...(next.name !== undefined && next.name !== project.name
        ? ["name"]
        : []),
      ...(next.objective !== undefined && next.objective !== project.objective
        ? ["purpose"]
        : []),
      ...(["vision", "objectives", "ideas"] as const).filter(
        (field) =>
          next.context !== undefined &&
          JSON.stringify(next.context[field]) !==
            JSON.stringify(project.context[field]),
      ),
      ...(next.memberProjectIds !== undefined &&
      JSON.stringify(next.memberProjectIds) !==
        JSON.stringify(project.memberProjectIds)
        ? ["repositories"]
        : []),
      ...(next.policy !== undefined &&
      JSON.stringify(next.policy) !== JSON.stringify(project.policy)
        ? ["policy"]
        : []),
    ];
    return this.store.tx(() => {
      const result = this.store.updateProject(project.id, next);
      if (changedFields.length)
        this.store.log(
          project.id,
          "project",
          `Initiative details edited by ${author === "user" ? "you" : "the coordinator"}: ${changedFields.join(", ")}`,
          { author, fields: changedFields },
        );
      return result;
    });
  }

  /** Icon and color are cosmetic: no activity entry, no order change. Omitted keeps a field; null resets it. */
  setAppearance(projectId: string, patch: { icon?: string | null; color?: string | null }) {
    const project = this.requireProject(projectId);
    const appearance = {
      icon: patch.icon === undefined ? project.appearance.icon : patch.icon,
      color: patch.color === undefined ? project.appearance.color : patch.color,
    };
    return { appearance: this.store.setAppearance(project.id, appearance).appearance };
  }

  /**
   * Pause gates what the plugin starts: delegation and the handover drain.
   * It never touches native queues, stops threads or suppresses reports.
   */
  setPaused(projectId: string, paused: boolean) {
    const project = this.requireProject(projectId);
    if (project.paused === paused) return project;
    return this.store.tx(() => {
      const result = this.store.updateProject(projectId, { paused });
      this.store.log(
        projectId,
        "project",
        paused ? "Paused: no new delegations or handovers" : "Resumed",
      );
      return result;
    });
  }

  archiveProject(projectId: string) {
    this.requireProject(projectId);
    const start = this.coordinatorStart(projectId);
    if (start && ["pending", "uncertain"].includes(start.state))
      throw new ProjectError(
        "Settle unconfirmed native operations before archiving.",
      );
    if (this.store.pendingHandover(projectId))
      throw new ProjectError(
        "A coordinator handover is pending; cancel it or let it finish before archiving.",
      );
    if (
      this.store
        .assignments(projectId)
        .some((a) =>
          [
            "dispatching",
            "queued",
            "running",
            "stopped",
            "idle_no_report",
            "reported",
          ].includes(a.state),
        )
    )
      throw new ProjectError(
        "Accept or cancel the remaining assignments before archiving this Initiative.",
      );
    return this.store.updateProject(projectId, { archivedAt: this.now() });
  }

  /** Cancels every assignment still in an open state and stops its thread. */
  async stopRunningWork(projectId: string) {
    const project = this.requireProject(projectId);
    const running = this.store
      .assignments(project.id)
      .filter((assignment) =>
        ["dispatching", "queued", "running"].includes(assignment.state),
      );
    const results: string[] = [];
    for (const assignment of running) {
      try {
        await this.stopAssignment(
          project.id,
          assignment.ref,
          "Stopped with all running work",
        );
        results.push(`${assignment.ref} stopped`);
      } catch (error) {
        results.push(`${assignment.ref}: ${errorMessage(error)}`);
      }
    }
    return results;
  }

  // Tasks ----------------------------------------------------------------------

  createTask(
    projectId: string,
    input: {
      title: string;
      summary: string;
      brief?: unknown;
      priority?: number;
      dependsOn?: string[];
      workKind?: WorkKind;
      profile?: Profile;
    },
    author: "coordinator" | "user",
  ): TaskRecord {
    const project = this.requireProject(projectId);
    const brief = this.parseBrief(input.brief);
    const dependsOn = (input.dependsOn ?? []).map(
      (ref) => this.requireTask(project, ref).num,
    );
    return this.store.tx(() => {
      const task = this.store.createTask({
        projectId,
        title: input.title,
        summary: input.summary,
        brief,
        priority: input.priority ?? 2,
        dependsOn,
        workKind: input.workKind ?? "implementation",
        profileOverride: input.profile ?? null,
        profileSource: input.profile
          ? author === "user"
            ? "user"
            : "coordinator"
          : null,
      });
      this.store.log(projectId, "task", `${task.ref} planned: ${task.title}`, {
        task: task.num,
      });
      return task;
    });
  }

  private parseBrief(value: unknown): Brief | null {
    if (value === undefined || value === null) return null;
    const parsed = briefSchema.safeParse(value);
    if (!parsed.success)
      throw new ProjectError(
        `Invalid brief: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    return parsed.data;
  }

  updateTask(
    projectId: string,
    ref: string,
    patch: {
      title?: string;
      summary?: string;
      brief?: unknown;
      priority?: number;
      dependsOn?: string[];
      workKind?: WorkKind;
      profile?: Profile | null;
    },
    author: "coordinator" | "user",
  ) {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, ref);
    const next: Parameters<Store["updateTask"]>[2] = {};
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.summary !== undefined) next.summary = patch.summary;
    if (patch.brief !== undefined) next.brief = this.parseBrief(patch.brief);
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.workKind !== undefined) next.workKind = patch.workKind;
    if (patch.dependsOn !== undefined) {
      const nums = patch.dependsOn.map(
        (dep) => this.requireTask(project, dep).num,
      );
      if (nums.includes(task.num))
        throw new ProjectError("A task cannot depend on itself.");
      next.dependsOn = nums;
    }
    if (patch.profile !== undefined) {
      if (author === "coordinator" && task.profileSource === "user")
        throw new ProjectError(
          `${task.ref}'s profile was chosen by the user; ask them before changing it.`,
        );
      next.profileOverride = patch.profile;
      next.profileSource = patch.profile ? author : null;
    }
    return this.store.tx(() => {
      const updated = this.store.updateTask(project.id, task.num, next);
      this.store.log(project.id, "task", `${task.ref} updated`, {
        task: task.num,
      });
      return updated;
    });
  }

  async cancelTask(projectId: string, ref: string, reason: string) {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, ref);
    if (task.status === "done")
      throw new ProjectError(`${task.ref} is already done.`);
    for (const assignment of this.store
      .assignments(projectId)
      .filter(
        (a) =>
          a.taskNums.includes(task.num) &&
          ["dispatching", "queued", "running", "idle_no_report"].includes(
            a.state,
          ),
      ))
      await this.stopAssignment(
        projectId,
        assignment.ref,
        `Task cancelled: ${reason}`,
      );
    return this.store.tx(() => {
      const updated = this.store.updateTask(project.id, task.num, {
        status: "cancelled",
        result: reason,
      });
      this.store.log(project.id, "task", `${task.ref} cancelled: ${reason}`, {
        task: task.num,
      });
      return updated;
    });
  }

  reopenTask(projectId: string, ref: string, reason: string) {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, ref);
    return this.store.tx(() => {
      const updated = this.store.updateTask(project.id, task.num, {
        status: "planned",
        progress: reason,
        acceptedAssignment: null,
      });
      this.store.log(project.id, "task", `${task.ref} reopened: ${reason}`, {
        task: task.num,
      });
      return updated;
    });
  }

  /**
   * The coordinator accepts a result; only then is a task done. Retiring the
   * worker is a separate explicit step (worker-retire) once its turn ends.
   */
  async acceptTask(
    projectId: string,
    ref: string,
    input: {
      assignment?: string;
      result?: string;
    },
  ) {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, ref);
    if (task.status === "done")
      throw new ProjectError(`${task.ref} is already done.`);
    if (task.status === "cancelled")
      throw new ProjectError(`${task.ref} was cancelled.`);
    const candidates = this.store
      .assignments(project.id)
      .filter(
        (assignment) =>
          assignment.role === "work" && assignment.taskNums.includes(task.num),
      );
    const assignment = input.assignment
      ? this.requireAssignment(project, input.assignment)
      : [...candidates]
          .reverse()
          .find((candidate) => candidate.state === "reported");
    if (assignment && !assignment.taskNums.includes(task.num))
      throw new ProjectError(`${assignment.ref} did not work on ${task.ref}.`);
    if (assignment && assignment.state !== "reported")
      throw new ProjectError(
        `${assignment.ref} has no report to accept (${assignment.state}).`,
      );
    if (assignment && assignment.report?.outcome !== "succeeded")
      throw new ProjectError(
        `${assignment.ref} reported ${assignment.report?.outcome}, so it cannot be accepted. ${reportedRetryHint(assignment, task.ref)} To drop ${task.ref} instead, use task-cancel.`,
      );
    if (assignment?.report?.pendingBackgroundWork.length)
      throw new ProjectError(
        "The report still lists background work. Wait for a final report before accepting it.",
      );
    if (assignment?.role !== undefined && assignment.role !== "work")
      throw new ProjectError(
        "Accept review reports separately; a reviewer cannot complete implementation tasks.",
      );
    if (
      assignment?.report?.evidence.some(
        (e) => e.kind === "check" && e.result === "failed",
      ) &&
      !input.result
    )
      throw new ProjectError(
        "The report contains failed checks. Resolve them or supply a result explaining what you verified.",
      );
    if (
      !assignment &&
      candidates.some(
        (a) =>
          [
            "dispatching",
            "queued",
            "running",
            "idle_no_report",
            "stopped",
          ].includes(a.state) || ["pending", "uncertain"].includes(a.opState),
      )
    )
      throw new ProjectError(
        "Managed work is still outstanding. Obtain its report before accepting this task.",
      );
    if (!assignment && !input.result)
      throw new ProjectError(
        `${task.ref} has no worker report to accept. Ask the worker to call initiative_report, or pass result to accept work you verified yourself.`,
      );
    const result = input.result ?? assignment!.report!.summary;
    this.store.tx(() => {
      this.store.updateTask(project.id, task.num, {
        status: "done",
        result,
        acceptedAssignment: assignment?.num ?? null,
        progress: null,
        nextCheckpoint: null,
      });
      if (assignment) {
        const others = assignment.taskNums.filter(
          (num) =>
            num !== task.num &&
            this.store.task(project.id, num)?.status !== "done",
        );
        if (!others.length)
          this.store.updateAssignment(project.id, assignment.num, {
            state: "accepted",
          });
      }
      this.store.log(
        project.id,
        "task",
        `${task.ref} accepted${assignment ? ` from ${assignment.ref}` : " (verified by the coordinator)"}`,
        { task: task.num },
      );
    });
    let workerNote: string | null = null;
    if (assignment) {
      const worker = this.store.worker(project.id, assignment.workerNum)!;
      workerNote = this.store.openAssignment(project.id, worker.num)
        ? `${worker.ref} still has ${this.store.openAssignment(project.id, worker.num)!.ref} open.`
        : `Retire ${worker.ref} with initiative_worker once its native turn ends; its report and handoff stay in the ledger either way.`;
    }
    return { task: this.store.task(project.id, task.num)!, workerNote };
  }

  async acceptReview(projectId: string, ref: string) {
    const project = this.requireProject(projectId);
    const assignment = this.requireAssignment(project, ref);
    if (
      assignment.role !== "review" ||
      assignment.state !== "reported" ||
      !assignment.report
    )
      throw new ProjectError("A reported review assignment is required.");
    if (assignment.report.pendingBackgroundWork.length)
      throw new ProjectError(
        "Wait for the review's background work to finish.",
      );
    const worker = this.store.worker(projectId, assignment.workerNum)!;
    this.store.tx(() => {
      this.store.updateAssignment(projectId, assignment.num, {
        state: "accepted",
      });
      this.store.log(
        projectId,
        "review",
        `${assignment.ref} accepted; findings are preserved in its report`,
      );
    });
    const workerNote = this.store.openAssignment(projectId, worker.num)
      ? `${worker.ref} still has ${this.store.openAssignment(projectId, worker.num)!.ref} open.`
      : `Retire ${worker.ref} with initiative_worker once its native turn ends.`;
    return { assignment: assignment.ref, workerNote };
  }

  async rejectReport(projectId: string, ref: string, reason: string) {
    const project = this.requireProject(projectId);
    const assignment = this.requireAssignment(project, ref);
    if (assignment.state !== "reported")
      throw new ProjectError("Only a reported assignment can be rejected.");
    // Same recorded-background rule as acceptance: the report is not final yet,
    // unless the worker's context has positively ended and can never update it.
    if (assignment.report?.pendingBackgroundWork.length)
      return this.rejectOrphanedReport(projectId, assignment, reason);
    return this.commitReject(projectId, assignment, reason);
  }

  private commitReject(projectId: string, assignment: AssignmentRecord, stopReason: string) {
    return this.store.tx(() => {
      this.store.updateAssignment(projectId, assignment.num, {
        state: "rejected",
        stopReason,
      });
      for (const num of assignment.taskNums) {
        const task = this.store.task(projectId, num)!;
        if (!["done", "cancelled"].includes(task.status))
          this.store.updateTask(projectId, num, {
            status: "planned",
            progress: stopReason,
          });
      }
      this.store.log(
        projectId,
        "report",
        `${assignment.ref} rejected: ${stopReason}`,
      );
      return this.store.assignment(projectId, assignment.num)!;
    });
  }

  /**
   * D342: a report that still lists background work can be rejected only when its
   * worker can never update it, proven natively — a retired worker whose thread BB
   * confirms can no longer run, or a thread BB shows archived, deleted or missing. A
   * retired label with a running or unreadable thread is not enough. The report and
   * its listed work are kept as filed; the reason records that work as unverified.
   */
  private async rejectOrphanedReport(projectId: string, assignment: AssignmentRecord, reason: string) {
    const hint = reportedRetryHint(assignment, assignment.taskNums.map((n) => `T${n}`).join(", "));
    const worker = this.store.worker(projectId, assignment.workerNum)!;
    const retired = worker.state === "retired";
    const threadId = assignment.threadId;
    let ended: string | null = null;
    if (threadId && retired) {
      const evidence = await this.executionEvidence(threadId);
      if (evidence === "ended") ended = `${worker.ref} is retired and BB confirms its thread is no longer running`;
      else
        throw new ProjectError(
          `${worker.ref} is retired, but its thread is not confirmed ended (${evidence === "running" ? "BB shows it running" : "BB's thread state could not be read"}), so the listed background work may still be running. Nothing was recorded; assignment-reject proceeds once the thread is positively quiet or gone.`,
        );
    } else if (threadId) {
      const gone = await this.threadGone(threadId);
      if (gone) ended = `${worker.ref}'s thread is ${gone} in BB`;
    }
    if (!ended) throw new ProjectError(hint);
    // Native reads took time: only commit what was checked.
    const current = this.store.assignment(projectId, assignment.num);
    const now = this.store.worker(projectId, assignment.workerNum);
    if (
      !current || current.state !== "reported" || current.threadId !== threadId ||
      JSON.stringify(current.report) !== JSON.stringify(assignment.report) ||
      now?.state !== worker.state || now.threadId !== worker.threadId
    )
      throw new ProjectError(`${assignment.ref} or ${worker.ref} changed while checking BB; nothing was recorded. Read ${assignment.ref} again.`);
    return this.commitReject(projectId, current, `${reason} [${ended}; the report's listed background work remains unverified: those jobs may still be running and keep ${assignment.ref}'s write scope until an explicit assignment-scope-release; a rejected assignment takes no later report.]`);
  }

  /**
   * D343: release the write scope that a report's listed background work still holds.
   * Requires a reason, the current coordinator (or the user), no unresolved receipt,
   * and BB's positive end evidence for the thread. The report and its listed work stay
   * as filed; the release is bound to this report version and is not evidence that
   * those jobs finished.
   */
  async releaseScope(projectId: string, ref: string, expectedVersion: string, reason: string, by: "coordinator" | "user", recordedBy: string | null) {
    const project = this.requireProject(projectId);
    if (by === "coordinator" && (!recordedBy || recordedBy !== project.coordinatorThreadId))
      throw new ProjectError("Only the current coordinator or the user releases an assignment's write scope.");
    const assignment = this.requireAssignment(project, ref);
    if (assignment.role !== "work" || assignment.access === "read-only")
      throw new ProjectError(`${assignment.ref} holds no write scope.`);
    if (["pending", "uncertain"].includes(assignment.opState) || assignment.queuedMessageId)
      throw new ProjectError(`${assignment.ref} still has an unconfirmed operation or queued brief, so its scope follows those receipts and cannot be released. ${receiptBlockReason(assignment)}`);
    if (["dispatching", "queued", "running"].includes(assignment.state))
      throw new ProjectError(`${assignment.ref} is ${assignment.state}; running work keeps its scope. Stop it or wait for its report.`);
    if (!assignment.report?.pendingBackgroundWork.length)
      throw new ProjectError(`${assignment.ref}'s report lists no background work, so there is nothing to release; its scope follows its native thread state.`);
    // Bind to the report filing the caller inspected, not whichever is current now: an
    // identical re-file is a new version, so a release never carries over to it.
    const currentVersion = reportVersion(assignment);
    if (expectedVersion !== currentVersion)
      throw new ProjectError(
        `${assignment.ref}'s report changed since you read it (you sent ${expectedVersion}; it is now ${currentVersion}, from a later filing, possibly with identical content). Nothing was recorded. Read it again with initiative_read {"refs":["${assignment.ref}"],"detailed":true,"fields":["report"]}, check its listed background work, and release with "reportVersion":"${currentVersion}".`,
      );
    if (!unreleasedBackground(assignment).length) return assignment;
    if (!assignment.threadId) throw new ProjectError(`${assignment.ref} has no native thread to check.`);
    const end = await this.nativeEnd(assignment.threadId);
    if (end.verdict !== "ended")
      throw new ProjectError(
        `${assignment.ref}'s thread is not confirmed ended (${end.verdict === "running" ? "BB shows it running" : "BB's thread state could not be read"}). Nothing was recorded; release once BB shows the thread ended and you have checked its listed background work.`,
      );
    const current = this.store.assignment(projectId, assignment.num);
    if (
      !current || current.state !== assignment.state || current.threadId !== assignment.threadId ||
      current.opState !== assignment.opState || current.queuedMessageId !== assignment.queuedMessageId ||
      reportVersion(current) !== currentVersion ||
      JSON.stringify(current.scopeRelease) !== JSON.stringify(assignment.scopeRelease) ||
      (by === "coordinator" && this.store.project(projectId)?.coordinatorThreadId !== recordedBy)
    )
      throw new ProjectError(`${assignment.ref} changed while checking BB; nothing was recorded. Read ${assignment.ref} again.`);
    const listed = current.report!.pendingBackgroundWork;
    return this.store.tx(() => {
      const released = this.store.updateAssignment(projectId, current.num, {
        scopeRelease: {
          by, recordedBy, reason: reason.trim(), at: this.now(), reportVersion: currentVersion,
          evidence: `BB shows ${current.ref}'s thread ended: ${end.seen}, at release.`,
        },
      });
      this.store.log(projectId, "report", `${current.ref}'s write scope was released by the ${by}: ${reason.trim()} Its report still lists ${listed.length} background job${listed.length === 1 ? "" : "s"}, unverified; this release is not evidence that it finished.`);
      return released;
    });
  }

  /** Positive native evidence that a thread can never act again: archived, deleted or missing (404). */
  private async threadGone(threadId: string): Promise<"archived" | "deleted" | "missing" | null> {
    let thread: ThreadDto;
    try {
      thread = await this.sdk.threads.get({ threadId });
    } catch (error) {
      return (error as { status?: number }).status === 404 ? "missing" : null;
    }
    if (!thread || !ProjectsService.lifecycleWellFormed(thread.archivedAt) || !ProjectsService.lifecycleWellFormed(thread.deletedAt)) return null;
    return thread.deletedAt !== null ? "deleted" : thread.archivedAt !== null ? "archived" : null;
  }

  // Decisions and updates -------------------------------------------------------

  recordDecision(
    projectId: string,
    input: { decision: { description: string; madeBy: "user" | "agent" }; scope?: string; topic?: string; supersedes?: string },
    provenance: Provenance,
  ) {
    const project = this.requireProject(projectId);
    const previous = input.supersedes ? this.requireDecision(project, input.supersedes) : null;
    if (previous && previous.status !== "active") throw new ProjectError(`${previous.ref} is ${previous.status}; only active decisions can be superseded.`);
    if (previous?.madeBy === null) throw new ProjectError(`${previous.ref} is an open question for the user, not a decision to supersede. Only the user's explicit answer closes it: {"action":"answer","ref":"${previous.ref}","choice":"<the user's option>"}. Otherwise record your decision without supersedes; ${previous.ref} stays open for the user.`);
    const madeBy = input.decision.madeBy;
    if (previous?.madeBy === "user" && madeBy !== "user")
      throw new ProjectError("An agent decision cannot replace an explicit user choice.");
    if (previous && provenance.author === "worker" && (previous.provenance.author !== "worker" || previous.provenance.threadId !== provenance.threadId))
      throw new ProjectError("Workers revise only their own recorded choices.");
    return this.store.tx(() => {
      const item = this.store.addDecision({
        projectId, title: input.decision.description.slice(0, 100),
        topic: input.topic ?? previous?.topic ?? slug(input.decision.description),
        scope: input.scope ?? "project", status: "active",
        body: { description: input.decision.description },
        madeBy,
        humanAttention: "none", blocks: [], deadline: null,
        provenance, supersedes: previous?.num ?? null,
      });
      this.store.log(projectId, "decision", `${item.ref} ${item.madeBy === "user" ? "Your decision" : "Agent decision"}: ${item.description}`);
      return item;
    });
  }

  recordQuestion(projectId: string, input: unknown, provenance: Provenance) {
    const project = this.requireProject(projectId);
    const decision = decisionSchema.parse(input);
    if (decision.humanAttention !== "needs-opinion")
      throw new ProjectError(`A question is always an open choice for the user (needs-opinion). Example: {"action":"question","question":"Where is the Monolith repo?","context":"It is not under ~/Code."}.`);
    const blocks = decision.blocksTaskIds.map(ref => {
      const task = this.requireTask(project, ref);
      if (["done", "cancelled"].includes(task.status)) throw new ProjectError(`${ref} is ${task.status}; name an unfinished task or create a follow-up for this question.`);
      return task.num;
    });
    return this.store.tx(() => {
      const item = this.store.addDecision({
        projectId, title: decision.title, topic: slug(decision.title), scope: "project",
        status: "active", body: decision, madeBy: null, humanAttention: "needs-opinion",
        blocks, deadline: null, provenance, supersedes: null,
      });
      for (const num of blocks) {
        const task = this.store.task(projectId, num)!;
        if (["planned", "in_progress", "awaiting_acceptance"].includes(task.status)) this.store.updateTask(projectId, num, { status: "blocked", progress: `Waiting for your opinion on ${item.ref}` });
      }
      this.store.log(projectId, "decision", `${item.ref} needs your opinion: ${item.title}`);
      return item;
    });
  }

  /** One explicit human dashboard action; no notification or per-row RPC. */
  acceptAgentDecisions(projectId: string) {
    this.requireProject(projectId);
    return this.store.tx(() => {
      const eligible = this.store.decisions(projectId).filter(isAcceptableAgentDecision);
      for (const item of eligible) this.store.updateDecision(projectId, item.num, {
        ...this.decisionVerdict("okay", ""), notification: null, humanAttention: "none",
      });
      if (eligible.length) this.store.log(projectId, "decision-review", `You accepted ${eligible.length} unchecked agent decisions`, { decisions: eligible.map(item => item.ref), recordedBy: "user" });
      return { accepted: eligible.length, refs: eligible.map(item => item.ref) };
    });
  }

  private decisionVerdict(verdict: "okay" | "not-okay", message: string) {
    if (verdict === "not-okay" && !message.trim()) throw new ProjectError("Not okay needs a message for the coordinator.");
    return { review: verdict, reviewMessage: verdict === "not-okay" ? message.trim() : null };
  }

  /** Current coordinator records an explicitly requested user cleanup; no self-message. */
  async cleanupDecision(projectId: string, ref: string, operation: "accept" | "veto" | "remove", reason: string, recordedBy: string | null) {
    const project = this.requireProject(projectId);
    if (!recordedBy || recordedBy !== project.coordinatorThreadId) throw new ProjectError("Only the current coordinator may clean up agent decisions on an explicit user request.");
    if (!reason.trim()) throw new ProjectError("Decision cleanup needs the user's requested scope/reason; never silence the Inbox unilaterally.");
    const item = this.requireDecision(project, ref);
    if (item.madeBy !== "agent" || item.body.answer || item.humanAttention === "needs-opinion") throw new ProjectError("Cleanup only applies to agent choices; user decisions and questions are protected.");
    const last = item.body.cleanupHistory?.at(-1);
    if (last?.operation === operation && last.reason === reason.trim() && last.recordedBy === recordedBy) return item;
    if (item.status !== "active") throw new ProjectError(`${item.ref} is ${item.status}; cleanup cannot rewrite historical decisions.`);
    // Preserve any existing delivery receipt: cleanup never proves queued work cancelled.
    // Reuse the same verdict projection as dashboard reviews, with quiet delivery.
    return this.store.tx(() => {
      if (this.store.project(projectId)?.coordinatorThreadId !== recordedBy) throw new ProjectError("Coordinator changed during requested cleanup; read current state.");
      const reviewed = this.requireDecision(project, ref);
      const result = this.store.updateDecision(projectId, item.num, {
        ...(operation === "remove" ? { status: "removed" as const, humanAttention: "none" as const } : this.decisionVerdict(operation === "accept" ? "okay" : "not-okay", reason)),
        body: { ...reviewed.body, cleanupHistory: [...(reviewed.body.cleanupHistory ?? []), { operation, reason: reason.trim(), recordedBy, at: this.now() }] },
      });
      this.store.log(projectId, "decision-cleanup", `${recordedBy} recorded user-requested ${operation} of ${item.ref}: ${reason.trim()}`, { decision: item.ref, recordedBy });
      return result;
    });
  }

  async reviewDecision(projectId: string, ref: string, verdict: "okay" | "not-okay", message = "") {
    const project = this.requireProject(projectId);
    const item = this.requireDecision(project, ref);
    if (item.status !== "active") throw new ProjectError(`${item.ref} is ${item.status}; only active agent decisions can be reviewed.`);
    if (item.madeBy !== "agent") throw new ProjectError("Only agent decisions need your review.");
    if (verdict === "not-okay" && !message.trim()) throw new ProjectError("Not okay needs a message for the coordinator.");
    // Repeating the same review after a lost HTTP response never sends twice.
    if (verdict === "not-okay" && item.review === verdict && item.reviewMessage === message.trim() && item.notification && item.notification.state !== "failed") return item;
    const coordinatorThreadId = this.store.project(projectId)?.coordinatorThreadId ?? null;
    const op = newOpId();
    this.store.tx(() => {
      this.store.updateDecision(projectId, item.num, {
        ...this.decisionVerdict(verdict, message),
        notification: verdict === "not-okay" ? { op, state: "pending", coordinatorThreadId } : null,
      });
      this.store.log(projectId, "decision", `You marked ${item.ref} ${verdict === "okay" ? "okay" : "not okay"}${message.trim() ? `: ${message.trim()}` : ""}`);
    });
    // Okay is private bookkeeping. Rejection sends exactly one ordinary native
    // message to the current coordinator; BB owns dispatch/queueing. No wake loop.
    if (verdict === "not-okay")
      await this.sendDecisionNotice(projectId, item.num, op, coordinatorThreadId, "Your review is saved.",
        `Initiative · ${project.name} · Your review of ${item.ref}\n\nNot okay: ${item.description}\n\n${message.trim()}`);
    return this.store.decisionItem(projectId, item.num)!;
  }

  /**
   * Send one decision's pending coordinator notice and record its receipt. A
   * newer notice for the same decision owns the record; this send never
   * overwrites it.
   */
  private async sendDecisionNotice(projectId: string, num: number, op: string, coordinatorThreadId: string | null, saved: string, text: string, senderThreadId?: string | null) {
    const settle = (notification: NonNullable<DecisionRecord["notification"]>) => {
      if (this.store.decisionItem(projectId, num)?.notification?.op === op) this.store.updateDecision(projectId, num, { notification });
    };
    if (!coordinatorThreadId) return settle({ op, state: "failed", coordinatorThreadId, detail: `No current coordinator. ${saved}` });
    try {
      const sent = await this.sdk.threads.send({
        threadId: coordinatorThreadId, mode: "steer-if-active",
        ...(senderThreadId ? { senderThreadId } : {}),
        input: textInput(`${text}\n\n${opMarker(op)}`),
      });
      settle({ op, state: sent.delivery === "queued" ? "queued" : "sent", coordinatorThreadId, ...(sent.delivery === "queued" ? { queuedId: sent.queuedMessage.id } : {}) });
    } catch (error) {
      settle({ op, state: isDefiniteRejection(error) ? "failed" : "uncertain", coordinatorThreadId, detail: errorMessage(error) });
    }
  }

  requireDecision(project: ProjectRecord, ref: string): DecisionRecord {
    const num = parseRef("D", ref) ?? parseRef("K", ref);
    const item =
      num === null ? null : this.store.decisionItem(project.id, num);
    if (!item) throw new ProjectError(`Unknown decision or open request ${ref}.`);
    return item;
  }

  /**
   * The user's answer to an open question, given in the panel or, when
   * recordedBy is set, explicitly in an agent's chat and recorded by that
   * agent. Either way the choice is the user's.
   */
  async answerOpinion(
    projectId: string,
    ref: string,
    input: { choice: string | null; note: string; notify?: boolean },
    recordedBy?: Provenance,
  ) {
    const project = this.requireProject(projectId);
    const item = this.requireDecision(project, ref);
    const body = item.body as DecisionRecord["body"] & Decision;
    const note = input.note.trim();
    const notify = input.notify !== false && recordedBy?.threadId !== project.coordinatorThreadId;
    // An identical notified answer is a transport retry, not a new choice.
    // Pending/queued/sent/uncertain receipts never authorize another send.
    const retry = item.status === "answered" && item.notification !== null &&
      body.answer?.choice === input.choice && body.answer.note === note;
    // The panel user cannot run agent JSON; tell them plainly what happened and what to do.
    if (!retry && !recordedBy && item.status === "withdrawn")
      throw new ProjectError(`The coordinator withdrew ${item.ref}: ${item.body.resolution?.note ?? ""}. Your answer was not saved. If you still want this choice recorded, tell the coordinator in chat.`);
    if (!retry && (item.madeBy !== null || item.humanAttention !== "needs-opinion" || item.status !== "active"))
      throw new ProjectError(notOpenQuestion(item));
    if (retry && (!notify || item.notification!.state !== "failed")) return item;
    if (input.choice !== null && body.options.length && !body.options.some(option => option.label === input.choice))
      throw new ProjectError(`"${input.choice}" is not one of the options.`);
    if (input.choice === null && !note) throw new ProjectError("Pick an option or write an answer.");
    const op = newOpId();
    const coordinatorThreadId = project.coordinatorThreadId;
    this.store.tx(() => {
      this.store.updateDecision(project.id, item.num, {
        ...(retry ? {} : {
          status: "answered", madeBy: "user",
          body: { ...body, answer: { choice: input.choice, note, at: this.now(), ...(recordedBy ? { recordedBy } : {}) } },
        }),
        notification: notify ? { op, state: "pending", coordinatorThreadId } : null,
      });
      if (!retry) {
        this.releaseQuestionTasks(project.id, item, `You answered ${item.ref}`);
        this.store.log(project.id, "decision", recordedBy
          ? `You answered ${item.ref} in chat; ${recordedBy.author === "coordinator" ? "the coordinator" : "a worker"} recorded it`
          : `You answered ${item.ref}`, recordedBy?.threadId ? { threadId: recordedBy.threadId } : undefined);
      }
    });
    if (notify)
      await this.sendDecisionNotice(project.id, item.num, op, coordinatorThreadId, "Your answer is saved.",
        `Initiative · ${project.name} · Your answer to ${item.ref}\n\n${body.question ?? item.title}\nChoice: ${input.choice ?? "Written answer"}${note ? `\nNote: ${note}` : ""}${recordedBy ? `\nRecorded from chat by ${recordedBy.threadId}.` : ""}`,
        recordedBy?.threadId);
    return this.store.decisionItem(project.id, item.num)!;
  }

  /**
   * D386: the user answers a worker's blocked report from the Inbox. The answer
   * is recorded as the user's decision and sent to the coordinator, who
   * continues, rejects or accepts the report; the Inbox item stays until then.
   * T130: `to: "worker"` sends it straight to the worker, which continues the
   * same assignment and reports again; the coordinator gets a short FYI.
   * Repeating the same answer to the same target retries only a failed
   * delivery; a different answer or target supersedes the previous one and is
   * sent again. `seen` is the blocker the user answered; an answer to an older
   * question or context is refused.
   */
  async answerBlocker(projectId: string, ref: string, seen: { question: string; context: string }, note: string, to: "coordinator" | "worker" = "coordinator") {
    const project = this.requireProject(projectId);
    const { assignment, blocker } = this.seenBlocker(project, ref, seen, "answer");
    const text = note.trim();
    if (!text) throw new ProjectError("Write an answer.");
    const worker = this.store.worker(project.id, assignment.workerNum)!;
    // The thread that reported the blocker, which the Inbox card links to.
    if (to === "worker" && !assignment.threadId) throw new ProjectError(`${worker.ref} has no thread to send to. Send your answer to the coordinator instead.`);
    const key = blockerKey(assignment.num, blocker);
    const previous = this.store.decisions(project.id).find((item) => item.body.blocker && item.body.answer && blockerKey(item.body.blocker.assignment, item.body.blocker) === key);
    const same = previous?.body.answer?.note === text && (previous.body.answer.to ?? "coordinator") === to;
    if (same && previous!.notification?.state !== "failed") return previous!;
    const subject = (assignment.role === "review" ? (assignment.reviewOf ?? []) : assignment.taskNums).map(taskRef).join(", ");
    const op = newOpId();
    const coordinatorThreadId = project.coordinatorThreadId;
    const target = to === "worker" ? assignment.threadId : coordinatorThreadId;
    const item = this.store.tx(() => {
      if (same) {
        this.store.updateDecision(project.id, previous!.num, { notification: { op, state: "pending", coordinatorThreadId: target } });
        return previous!;
      }
      const description = `Answer to ${worker.ref}'s blocker on ${subject || assignment.ref} (${assignment.ref})${to === "worker" ? `, sent to ${worker.ref}` : ""}: ${text}`;
      const added = this.store.addDecision({
        projectId: project.id, title: description.slice(0, 100),
        topic: previous?.topic ?? `blocker-${assignment.ref.toLowerCase()}`, scope: "project", status: "active",
        body: { description, blocker: { assignment: assignment.num, question: blocker.question, context: blocker.context }, answer: { choice: null, note: text, at: this.now(), ...(to === "worker" ? { to } : {}) } },
        madeBy: "user", humanAttention: "none", blocks: [], deadline: null,
        provenance: { author: "user", threadId: null, assignment: null }, supersedes: previous?.num ?? null,
      });
      this.store.updateDecision(project.id, added.num, { notification: { op, state: "pending", coordinatorThreadId: target } });
      this.store.log(project.id, "decision", `${added.ref} You answered ${worker.ref}'s blocker (${assignment.ref})${to === "worker" ? ` and sent it to ${worker.ref}` : ""}: ${text}`);
      return added;
    });
    const about = `${assignment.ref}${subject ? `, ${subject}` : ""}, ${item.ref}`;
    if (to === "coordinator") {
      await this.sendDecisionNotice(project.id, item.num, op, coordinatorThreadId, "Your answer is saved.",
        `Initiative · ${project.name} · Your answer to ${worker.ref}'s blocker (${about})\n\nBlocker: ${blocker.question}\nContext: ${blocker.context}\nAnswer: ${text}\n\nContinue ${worker.ref} with this answer, or reject or accept ${assignment.ref}. The Inbox item clears when you do.`);
      return this.store.decisionItem(project.id, item.num)!;
    }
    await this.sendDecisionNotice(project.id, item.num, op, target, "Your answer is saved.",
      `Initiative · ${project.name} · The user answered your blocker directly (${about})\n\nBlocker: ${blocker.question}\nAnswer: ${text}\n\nContinue ${assignment.ref} with this answer and report again with initiative_report when done. The coordinator has been told.`);
    const delivered = this.store.decisionItem(project.id, item.num)!;
    // The coordinator's records stay consistent: one FYI once the worker has the answer, best effort and logged.
    if (delivered.notification?.state === "sent" || delivered.notification?.state === "queued") {
      let outcome = "told the coordinator";
      if (!coordinatorThreadId) outcome = "no current coordinator to tell";
      else
        try {
          await this.sdk.threads.send({
            threadId: coordinatorThreadId, mode: "queue-if-active",
            input: textInput(`Initiative · ${project.name} · FYI: the user answered ${worker.ref}'s blocker (${about}) directly to ${worker.ref}\n\nBlocker: ${blocker.question}\nAnswer: ${text}\n\n${worker.ref} continues ${assignment.ref} with it and reports again. Nothing to send; review its next report as usual.`),
          });
        } catch (error) {
          outcome = `could not tell the coordinator: ${errorMessage(error)}`;
        }
      this.store.log(project.id, "decision", `${item.ref} reached ${worker.ref}; ${outcome}`);
    }
    return delivered;
  }

  /** The open blocker on `ref`, refused unless it is still exactly the one the user saw. */
  private seenBlocker(project: ProjectRecord, ref: string, seen: { question: string; context: string }, what: "answer" | "dismissal") {
    const assignment = this.requireAssignment(project, ref);
    const tasks = this.store.tasks(project.id);
    const open = openBlockers(
      this.store.assignments(project.id).map((a) => ({ ...a, outcome: a.report?.outcome ?? null })),
      (num) => ["done", "cancelled"].includes(tasks.find((task) => task.num === num)?.status ?? "done"),
    ).some((a) => a.num === assignment.num);
    if (!open) throw new ProjectError(`${assignment.ref} is no longer waiting on a blocker; the coordinator already acted on it. Your ${what} was not saved.`);
    const blocker = assignment.report!.blocker;
    if (!blocker || blocker.question !== seen.question || blocker.context !== seen.context)
      throw new ProjectError(`${assignment.ref}'s blocker changed since you opened it. Read the new question and context; your ${what} was not saved.`);
    return { assignment, blocker };
  }

  /**
   * T128: the user dismisses a worker's blocker without answering it. It
   * leaves the Inbox and Needs you for as long as the worker re-files the same
   * question and context. Silent sends nothing; notify sends the coordinator
   * one message with the note. Dismissing again only retries a failed notice.
   */
  async dismissBlocker(projectId: string, ref: string, seen: { question: string; context: string }, input: { notify: boolean; note: string }) {
    const project = this.requireProject(projectId);
    const { assignment, blocker } = this.seenBlocker(project, ref, seen, "dismissal");
    const key = blockerKey(assignment.num, blocker);
    const previous = this.store.decisions(project.id).find((item) =>
      item.status === "active" && item.body.blocker && item.body.dismissal && blockerKey(item.body.blocker.assignment, item.body.blocker) === key);
    if (previous && !(previous.body.dismissal!.notify && previous.notification?.state === "failed")) return previous;
    const worker = this.store.worker(project.id, assignment.workerNum)!;
    const subject = (assignment.role === "review" ? (assignment.reviewOf ?? []) : assignment.taskNums).map(taskRef).join(", ");
    const op = newOpId();
    const coordinatorThreadId = project.coordinatorThreadId;
    const item = this.store.tx(() => {
      if (previous) {
        this.store.updateDecision(project.id, previous.num, { notification: { op, state: "pending", coordinatorThreadId } });
        return previous;
      }
      const note = input.note.trim();
      const description = `Dismissed ${worker.ref}'s blocker on ${subject || assignment.ref} (${assignment.ref}) without answering${input.notify ? "; told the coordinator" : ""}${note ? `: ${note}` : "."}`;
      const added = this.store.addDecision({
        projectId: project.id, title: description.slice(0, 100),
        topic: `blocker-dismissal-${assignment.ref.toLowerCase()}`, scope: "project", status: "active",
        body: { description, blocker: { assignment: assignment.num, question: blocker.question, context: blocker.context }, dismissal: { note, notify: input.notify, at: this.now() } },
        madeBy: "user", humanAttention: "none", blocks: [], deadline: null,
        provenance: { author: "user", threadId: null, assignment: null }, supersedes: null,
      });
      if (input.notify) this.store.updateDecision(project.id, added.num, { notification: { op, state: "pending", coordinatorThreadId } });
      this.store.log(project.id, "decision", `${added.ref} You dismissed ${worker.ref}'s blocker (${assignment.ref})${input.notify ? " and told the coordinator" : ""}${note ? `: ${note}` : ""}`);
      return added;
    });
    const dismissal = item.body.dismissal!;
    if (dismissal.notify)
      await this.sendDecisionNotice(project.id, item.num, op, coordinatorThreadId, "Your dismissal is saved.",
        `Initiative · ${project.name} · The user dismissed ${worker.ref}'s blocker (${assignment.ref}${subject ? `, ${subject}` : ""}, ${item.ref}) without answering it\n\nBlocker: ${blocker.question}\nContext: ${blocker.context}${dismissal.note ? `\nNote: ${dismissal.note}` : ""}\n\nDecide how to settle ${assignment.ref} without an answer: continue ${worker.ref} another way, reject or accept the report.`);
    return this.store.decisionItem(project.id, item.num)!;
  }

  /** T128: the user takes a dismissal back; the record stays in history, closed, and the blocker counts again while it is open. */
  undoBlockerDismissal(projectId: string, ref: string) {
    const project = this.requireProject(projectId);
    const item = this.requireDecision(project, ref);
    const dismissal = item.body.dismissal;
    if (!dismissal) throw new ProjectError(`${item.ref} is not a blocker dismissal.`);
    if (dismissal.undoneAt) return item;
    return this.store.tx(() => {
      const result = this.store.updateDecision(project.id, item.num, { status: "closed", body: { ...item.body, dismissal: { ...dismissal, undoneAt: this.now() } } });
      this.store.log(project.id, "decision", `You undid ${item.ref}; ${assignmentRef(item.body.blocker!.assignment)}'s blocker is back in the Inbox if it is still open`);
      return result;
    });
  }

  closeQuestion(projectId: string, ref: string, note: string) {
    const project = this.requireProject(projectId);
    const item = this.requireDecision(project, ref);
    if (item.status === "closed" && item.body.resolution?.note === note.trim()) return item;
    if (item.madeBy !== null || item.humanAttention !== "needs-opinion" || item.status !== "active")
      throw new ProjectError(`${item.ref} is not an open question.`);
    return this.store.tx(() => {
      const result = this.store.updateDecision(project.id, item.num, {
        status: "closed", body: { ...item.body, resolution: { note: note.trim(), at: this.now() } },
      });
      this.releaseQuestionTasks(project.id, item, `You closed ${item.ref} quietly`);
      this.store.log(project.id, "decision", `You closed ${item.ref} quietly; no answer recorded${note.trim() ? `: ${note.trim()}` : ""}`);
      return result;
    });
  }

  /**
   * D340: the current coordinator withdraws an open question it recorded itself, with a
   * reason. Distinct from the user's quiet close and never an answer: madeBy stays null,
   * nobody is messaged, and only this question's blocks are released.
   */
  withdrawQuestion(projectId: string, ref: string, reason: string, by: Provenance) {
    const project = this.requireProject(projectId);
    if (by.author !== "coordinator" || !by.threadId || by.threadId !== project.coordinatorThreadId)
      throw new ProjectError("Only the current coordinator withdraws an open question, and only one it recorded itself. The user can close a question quietly in the panel.");
    const note = reason.trim();
    if (!note) throw new ProjectError(`Withdrawal needs a reason: why the user no longer needs to answer. Example: {"action":"withdraw","ref":"${ref}","reason":"Settled by D15: Erwin chose Base UI in chat."}.`);
    const item = this.requireDecision(project, ref);
    const asker = item.provenance;
    if (item.madeBy === null && item.humanAttention === "needs-opinion" && (asker.author !== "coordinator" || asker.threadId !== by.threadId))
      throw new ProjectError(`${item.ref} was recorded by ${asker.author === "coordinator" ? `coordinator thread ${asker.threadId ?? "unknown"}` : `the ${asker.author}`}; a coordinator withdraws only questions it recorded itself. The user can answer or close it in the panel.`);
    if (item.status === "withdrawn") {
      // An identical repeat after a lost response returns the saved withdrawal unchanged.
      if (item.body.resolution?.note === note && item.body.resolution.withdrawnBy?.threadId === by.threadId) return item;
      throw new ProjectError(`${item.ref} is already withdrawn: ${item.body.resolution?.note ?? ""}. The recorded reason stands.`);
    }
    if (item.madeBy !== null || item.humanAttention !== "needs-opinion" || item.status !== "active" || item.body.answer)
      throw new ProjectError(notOpenQuestion(item));
    return this.store.tx(() => {
      const result = this.store.updateDecision(project.id, item.num, {
        status: "withdrawn", body: { ...item.body, resolution: { note, at: this.now(), withdrawnBy: by } },
      });
      this.releaseQuestionTasks(project.id, item, `The coordinator withdrew ${item.ref}`);
      this.store.log(project.id, "decision", `The coordinator withdrew ${item.ref}; no answer recorded: ${note}`, { decision: item.ref, threadId: by.threadId });
      return result;
    });
  }

  private releaseQuestionTasks(projectId: string, item: DecisionRecord, progress: string) {
    for (const num of item.blocks) {
      const task = this.store.task(projectId, num);
      if (task?.status !== "blocked" || ![`Waiting for your opinion on ${item.ref}`, `Waiting for your opinion on K${item.num}`].includes(task.progress ?? "")) continue;
      const next = this.store.decisions(projectId).find(d => d.status === "active" && d.humanAttention === "needs-opinion" && d.blocks.includes(num));
      const work = this.store.assignments(projectId).filter(a => a.role === "work" && a.taskNums.includes(num) && ["dispatching", "queued", "running", "idle_no_report", "reported"].includes(a.state)).at(-1);
      const reported = work?.state === "reported" && work.report ? work.report : null;
      const resume = reported ? reported.outcome === "succeeded" ? "awaiting_acceptance" : "blocked"
        : work && ["dispatching", "queued", "running", "idle_no_report"].includes(work.state) ? "in_progress" : "planned";
      this.store.updateTask(projectId, num, next
        ? { status: "blocked", progress: `Waiting for your opinion on ${next.ref}`, nextCheckpoint: `Answer ${next.ref}` }
        : { status: resume, progress: reported && resume === "blocked" ? reported.summary : progress,
            nextCheckpoint: resume === "awaiting_acceptance" ? "Coordinator acceptance" : resume === "blocked" ? "Coordinator decision" : resume === "in_progress" ? "Worker report" : null });
    }
  }

  acknowledgeDecision(projectId: string, ref: string, _note: string) {
    return this.reviewDecision(projectId, ref, "okay");
  }

  recordUpdate(
    projectId: string,
    input: { summary: string; body: string; checkpoint?: string },
    threadId: string | null,
  ) {
    this.requireProject(projectId);
    return this.store.tx(() => {
      const update = this.store.addUpdate(
        projectId,
        input.summary,
        input.body,
        threadId,
      );
      if (input.checkpoint)
        this.store.updateProject(projectId, { checkpoint: input.checkpoint });
      this.store.log(
        projectId,
        "update",
        `Initiative update ${update.ref}: ${input.summary}`,
      );
      return update;
    });
  }

  // Delegation -------------------------------------------------------------------

  private reviewTargets(project: ProjectRecord, input: DelegateInput): ReviewTargetRecord[] {
    if (input.role !== "review") {
      if (input.reviewOf?.length || input.reviewTargets?.length) throw new ProjectError("reviewOf/reviewTargets require role review.");
      return [];
    }
    if (input.tasks?.length) throw new ProjectError("Review tasks go in reviewOf/reviewTargets, not tasks. Never substitute an unrelated in-progress task.");
    const refs = input.reviewOf ?? [...new Set(input.reviewTargets?.map(t => t.task) ?? [])];
    if (!refs.length) throw new ProjectError("A review needs reviewOf tasks or explicit reviewTargets {task,assignment,revision}.");
    if (input.reviewTargets && [...new Set(input.reviewTargets.map(t => t.task))].sort().join() !== [...new Set(refs)].sort().join())
      throw new ProjectError("reviewOf and reviewTargets must name exactly the same tasks.");
    const targets = input.reviewTargets ?? refs.map(ref => {
      const task = this.requireTask(project, ref);
      const source = this.store.assignments(project.id).filter(a => a.role === "work" && a.taskNums.includes(task.num) && ["reported", "accepted"].includes(a.state) && a.report?.outcome === "succeeded").at(-1);
      if (!source) throw new ProjectError(`${ref} has no recorded implemented result. Use task-checkpoint with the actual worker and report before review; do not borrow another task.`);
      return { task: ref, assignment: source.ref, revision: source.report!.handoff.verificationRevision ?? source.report!.handoff.workspaceRevision };
    });
    return targets.map(target => {
      const task = this.requireTask(project, target.task), a = this.requireAssignment(project, target.assignment);
      if (!task.brief) throw new ProjectError(`${task.ref} needs its actual brief before review.`);
      if (task.status === "cancelled") throw new ProjectError(`${task.ref} was cancelled.`);
      if (a.role !== "work" || !a.taskNums.includes(task.num)) throw new ProjectError(`${a.ref} did not implement ${task.ref}. Check the task/assignment association.`);
      if (!["reported", "accepted"].includes(a.state) || a.cancelRequested || a.opState !== "done" || a.queuedMessageId)
        throw new ProjectError(`${a.ref} is ${a.state}/${a.opState}; its native operation must be settled before review.`);
      if (a.report?.outcome !== "succeeded" || a.report.pendingBackgroundWork.length) throw new ProjectError(`${a.ref} needs a successful final report or checkpoint before review.`);
      const revision = a.report.handoff.verificationRevision ?? a.report.handoff.workspaceRevision;
      if (revision !== target.revision) throw new ProjectError(`${a.ref} reports revision ${revision}, not ${target.revision}. Read its report or checkpoint the newly checked revision.`);
      return { ...target, worker: workerRef(a.workerNum), profile: a.actualProfile ?? a.profile };
    });
  }

  /** Record explicitly described external/native work. No dispatch, wake, inferred acceptance or unrelated task rewrite. */
  async checkpointTask(projectId: string, input: { task: string; worker: string; assignment?: string; report: Report }, recordedBy: string | null) {
    const project = this.requireProject(projectId), task = this.requireTask(project, input.task), worker = this.requireWorker(project, input.worker);
    if (!recordedBy || recordedBy !== project.coordinatorThreadId) throw new ProjectError("Only the current coordinator records a task-checkpoint; workers use initiative_report.");
    if (worker.role !== "work" || worker.userStopped || !worker.threadId || ["done", "cancelled"].includes(task.status)) throw new ProjectError("Checkpoint needs an unstopped work worker, its native thread, and an unfinished actual task.");
    if (!task.brief) throw new ProjectError(`${task.ref} needs its actual brief before checkpointing.`);
    const source = input.assignment ? this.requireAssignment(project, input.assignment) : null;
    const managed = this.store.assignments(projectId).find(a => a.workerNum === worker.num && a.taskNums.includes(task.num) && ["dispatching", "queued", "running", "idle_no_report", "stopped"].includes(a.state));
    if (!source && managed) throw new ProjectError(`${task.ref} already has ${managed.ref}. Pass that assignment to checkpoint its actual work; do not create a duplicate association.`);
    if (source && (source.workerNum !== worker.num || !source.taskNums.includes(task.num) || source.taskNums.length !== 1 || source.generation !== worker.generation || source.threadId !== worker.threadId || source.role !== "work"))
      throw new ProjectError("Checkpoint assignment must be this worker/generation's work on exactly the named task. Omit assignment to record a separate external milestone.");
    // Only an unresolved operation or a live queue receipt can still execute. A Stop
    // whose op is settled (done, or failed: provably never delivered and released)
    // is history, and the checkpoint below creates its own assignment beside it.
    const holdsCheckpoint = (a: AssignmentRecord) =>
      a.workerNum === worker.num && (["pending", "uncertain"].includes(a.opState) || !!a.queuedMessageId);
    const unsettled = this.store.assignments(projectId).filter(holdsCheckpoint);
    if (unsettled.length) throw new ProjectError(`${worker.ref} cannot be checkpointed while an operation or queue receipt is unsettled. ${unsettled.slice(0, 3).map(receiptBlockReason).join(" ")}${unsettled.length > 3 ? ` ${unsettled.length - 3} more are listed in initiative_read {"view":"assignments"}.` : ""}`);
    if (source && (!["running", "idle_no_report"].includes(source.state) || source.report)) throw new ProjectError(`${source.ref} is ${source.state}${source.report ? " with a report" : ""}; a checkpoint cannot overwrite reported evidence. Omit assignment to append a separate milestone.`);
    const native = await this.sdk.threads.get({ threadId: worker.threadId });
    const execution = await threadExecution(this.sdk, worker.threadId);
    if (native.deletedAt !== null || native.projectId !== worker.bbProjectId || !project.memberProjectIds.includes(native.projectId) || !execution)
      throw new ProjectError("Native worker ownership/execution could not be proven; inspect its thread before checkpointing.");
    const current = this.requireWorker(this.requireProject(projectId), input.worker);
    if (this.store.project(projectId)?.coordinatorThreadId !== recordedBy || current.threadId !== worker.threadId || current.generation !== worker.generation || current.userStopped)
      throw new ProjectError("Coordinator/worker changed while checkpointing; read current state first.");
    const changedReceipt = this.store.assignments(projectId).find(holdsCheckpoint);
    if (changedReceipt)
      throw new ProjectError(`A native receipt or Stop changed while checkpointing; nothing was recorded. ${receiptBlockReason(changedReceipt)}`);
    if (source && (this.store.assignment(projectId, source.num)?.state !== source.state || this.store.assignment(projectId, source.num)?.report)) throw new ProjectError("Checkpoint source outcome changed or was reported; read it again and use a separate milestone.");
    if (["done", "cancelled"].includes(this.requireTask(this.requireProject(projectId), input.task).status)) throw new ProjectError("Task completed or cancelled while checkpointing; read current state.");
    const profile = source?.actualProfile ?? { providerId: native.providerId, ...execution };
    return this.store.tx(() => {
      const a = source ?? this.store.createAssignment({ projectId, workerNum: worker.num, taskNums: [task.num], route: "checkpoint", role: "work", workKind: task.workKind, threadId: worker.threadId, generation: worker.generation, profile, bbProjectId: worker.bbProjectId, environmentId: worker.environmentId, state: "reported", opId: newOpId(), opState: "done", briefText: "Coordinator-recorded external work checkpoint; no brief dispatched.", reviewOf: null, rationale: "Explicit task checkpoint from native/external work; acceptance remains separate.", writeScope: task.brief?.areas.filter(area => area.bbProjectId === worker.bbProjectId).flatMap(area => area.paths) ?? [] });
      const result = this.store.updateAssignment(projectId, a.num, { state: "reported", report: input.report, reportedAt: this.now(), actualProfile: profile, checkpoint: { recordedBy, recordedAt: this.now(), sourceThreadId: worker.threadId! } });
      const waiting = this.store.decisions(projectId).find(d => d.status === "active" && d.humanAttention === "needs-opinion" && d.blocks.includes(task.num));
      this.store.updateTask(projectId, task.num, { status: waiting ? "blocked" : input.report.outcome === "succeeded" ? "awaiting_acceptance" : "blocked", progress: waiting ? `Waiting for your opinion on ${waiting.ref}` : input.report.summary, nextCheckpoint: input.report.outcome === "succeeded" ? "Coordinator acceptance" : "Coordinator decision" });
      this.store.log(projectId, "checkpoint", `${task.ref} checkpointed as ${a.ref} from ${worker.ref}; reported, not accepted`, { task: task.num, assignment: a.num, recordedBy });
      return result;
    });
  }

  async delegate(
    projectId: string,
    input: DelegateInput,
  ): Promise<DelegateResult[]> {
    const project = this.requireProject(projectId);
    const settings = await this.preferences.read();
    const role: Role = input.role ?? "work";
    const targets = this.reviewTargets(project, { ...input, role });
    if (role === "review") input = { ...input, reviewTargets: targets, reviewOf: [...new Set(targets.map(t => t.task))] };
    if (role === "review" && input.route === "fresh") {
      const reviewOf = (input.reviewOf ?? []).map((ref) =>
        this.requireTask(project, ref),
      );
      if (!reviewOf.length)
        throw new ProjectError(
          "A review needs reviewOf: the tasks it reviews.",
        );
      const plan = planReview({
        policy: withProfileDefaults(project.policy, settings),
        taskNums: reviewOf.map((task) => task.num),
        assignments: this.store.assignments(project.id).filter(a => targets.some(t => t.assignment === a.ref)),
      });
      // An explicitly chosen reviewer is honored once over the whole
      // requested scope, whatever its family; only the default plan splits a
      // mixed scope into one reviewer per implementing family, and only when
      // those families' configured profiles differ.
      if (input.profile) {
        const only = plan.length === 1 ? plan[0]! : null;
        return [
          await this.dispatch(
            project,
            { ...input, role, tasks: [] },
            {
              key: only?.key ?? null,
              profile: input.profile,
              taskNums: reviewOf.map((task) => task.num),
              rationale: `Reviewer chosen explicitly for ${reviewOf.map((task) => task.ref).join(", ")}: ${describeProfile(input.profile)}.`,
              shared: false,
            },
          ),
        ];
      }
      const results: DelegateResult[] = [];
      for (const part of plan)
        results.push(
          await this.dispatch(
            project,
            { ...input, role, reviewOf: part.taskNums.map(taskRef), reviewTargets: targets.filter(t => part.taskNums.map(taskRef).includes(t.task)), tasks: [] },
            { ...part, shared: plan.length > 1 },
          ),
        );
      return results;
    }
    return [await this.dispatch(project, { ...input, role }, null)];
  }

  /**
   * The member project's default source: its host and registered checkout
   * path. BB's project DTO carries both; a source without a path cannot prove
   * any environment is its home checkout.
   */
  private async coordinatorDefaultSource(
    bbProjectId: string,
  ): Promise<{ hostId: string | null; path: string | null } | null> {
    const bbProject = (await this.sdk.projects.get({ projectId: bbProjectId })) as {
      sources?: { hostId: string; isDefault: boolean; path?: string }[];
    };
    // Only an explicit default source proves a home: falling back to
    // sources[0] would silently bless an arbitrary checkout when the project
    // declares none.
    const source =
      (bbProject.sources ?? []).find((entry) => entry.isDefault === true) ??
      null;
    return source
      ? { hostId: source.hostId ?? null, path: source.path ?? null }
      : null;
  }

  /**
   * Why an environment is not a coordinator home, or null when it is one.
   * Only facts the DTO positively carries produce a reason — an absent field
   * proves nothing either way. `strict` additionally treats an unprovable
   * source path as a failure: an explicit reuse request claims home, and a
   * claim the SDK cannot prove must surface the gap rather than pass.
   */
  private async coordinatorHomeProblem(
    bbProjectId: string,
    env: {
      id: string;
      projectId?: string | null;
      hostId?: string | null;
      path?: string | null;
      isWorktree?: boolean | null;
      status?: string | null;
      lifecycle?: { phase?: string };
    },
    strict: boolean,
  ): Promise<string | null> {
    if (env.projectId && env.projectId !== bbProjectId)
      return `Environment ${env.id} belongs to ${env.projectId}, not ${bbProjectId}.`;
    if (env.isWorktree === true)
      return `Environment ${env.id} is a worktree; a coordinator runs on the member project's default checkout.`;
    if (env.status && env.status !== "ready")
      return `Environment ${env.id} is ${env.status}, not ready.`;
    const phase = env.lifecycle?.phase;
    if (phase && phase !== "active")
      return `Environment ${env.id} is ${phase}.`;
    let source: Awaited<
      ReturnType<ProjectsService["coordinatorDefaultSource"]>
    >;
    try {
      source = await this.coordinatorDefaultSource(bbProjectId);
    } catch (error) {
      if (!strict) return null;
      return `The default source of ${bbProjectId} could not be read (${errorMessage(error)}), so ${env.id} cannot be proven to be the coordinator's default checkout.`;
    }
    if (!source) {
      if (!strict) return null;
      return `${bbProjectId} has no default source, so ${env.id} cannot be proven to be the coordinator's default checkout.`;
    }
    if (source.hostId && env.hostId && env.hostId !== source.hostId)
      return `Environment ${env.id} is on ${env.hostId}; the default checkout of ${bbProjectId} lives on ${source.hostId}.`;
    if (source.path && env.path && env.path !== source.path)
      return `Environment ${env.id} is ${env.path}, not the default checkout ${source.path}; a coordinator runs on the primary repository's default source checkout.`;
    if (!strict) return null;
    // A home claim must be provable in both directions: a gap on either side
    // surfaces as the reason instead of silently passing.
    if (!source.hostId)
      return `The default source of ${bbProjectId} reports no host, so ${env.id} cannot be proven to be the coordinator's default checkout.`;
    if (!env.hostId)
      return `Environment ${env.id} reports no host, so it cannot be proven to be the coordinator's default checkout on ${source.hostId}.`;
    if (!source.path)
      return `The default source of ${bbProjectId} reports no path, so ${env.id} cannot be proven to be the coordinator's default checkout.`;
    if (!env.path)
      return `Environment ${env.id} records no checkout path, so it cannot be proven to be the coordinator's default checkout ${source.path}.`;
    return null;
  }

  /**
   * Why a natively returned coordinator is not proven to live on the
   * coordinator home, or null when it is. The thread's own BB project and
   * environment are checked against the CURRENT primary member's explicit
   * default source — project-default resolution is only a claim until the
   * returned thread's facts prove where it actually landed. Used before every
   * coordinator start is confirmed, whether the receipt arrives immediately,
   * through manual settlement, or via reconciliation.
   */
  private async coordinatorReceiptHomeProblem(
    project: ProjectRecord,
    thread: {
      id: string;
      projectId?: string | null;
      environmentId?: string | null;
      archivedAt?: unknown;
      deletedAt?: unknown;
    },
  ): Promise<string | null> {
    const primary = project.memberProjectIds[0]!;
    if (thread.archivedAt != null || thread.deletedAt != null)
      return `Thread ${thread.id} is archived or deleted; it cannot be confirmed as coordinator.`;
    if (thread.projectId !== primary)
      return `Thread ${thread.id} lives in ${thread.projectId ?? "an unknown project"}, not the primary member ${primary}.`;
    if (!thread.environmentId)
      return `Thread ${thread.id} reports no environment; its checkout cannot be proven to be ${primary}'s default source checkout.`;
    let env;
    try {
      env = await this.sdk.environments.get({
        environmentId: thread.environmentId,
      });
    } catch (error) {
      return `Thread ${thread.id}'s environment could not be checked (${errorMessage(error)}); its home cannot be proven.`;
    }
    return this.coordinatorHomeProblem(
      primary,
      { ...env, id: thread.environmentId },
      true,
    );
  }

  /**
   * The coordinator's home must be a ready, non-worktree environment of the BB
   * project it coordinates — provably the default source's own checkout, not
   * any ready checkout of the project. Reuse requests are strict: an
   * unprovable home claim is rejected with the exact gap.
   */
  private async assertCoordinatorEnvironment(
    bbProjectId: string,
    environmentId: string,
  ) {
    let env;
    try {
      env = await this.sdk.environments.get({ environmentId });
    } catch (error) {
      throw new ProjectError(
        (error as { status?: number }).status === 404
          ? `Environment ${environmentId} does not exist.`
          : `Environment ${environmentId} could not be checked: ${errorMessage(error)}`,
      );
    }
    const problem = await this.coordinatorHomeProblem(
      bbProjectId,
      { ...env, id: environmentId },
      true,
    );
    if (problem) throw new ProjectError(problem);
  }

  /**
   * An adopted coordinator claims the same home as a spawned one: a missing,
   * unreadable, or unprovable environment cannot prove the default checkout
   * and rejects the adoption. Existing mismatched coordinators are untouched
   * — only the new claim is refused.
   */
  private async assertAdoptedCoordinatorHome(
    bbProjectId: string,
    environmentId: string | null,
  ) {
    if (!environmentId)
      throw new ProjectError(
        "The adopted coordinator reports no environment; its checkout cannot be proven to be the primary repository's default.",
      );
    let env;
    try {
      env = await this.sdk.environments.get({ environmentId });
    } catch (error) {
      throw new ProjectError(
        `The adopted coordinator's environment could not be checked (${errorMessage(error)}); its home cannot be proven.`,
      );
    }
    const problem = await this.coordinatorHomeProblem(
      bbProjectId,
      { ...env, id: environmentId },
      true,
    );
    if (problem) throw new ProjectError(problem);
  }

  private environmentFor(
    choice: EnvironmentChoice | undefined,
    fallback: EnvironmentChoice,
    /** The member project's default-source host; a worktree without it reaches BB homeless. */
    hostId?: string | null,
  ): {
    request: Record<string, unknown>;
    workspace: Workspace;
    environmentId: string | null;
  } {
    const env = choice ?? fallback;
    if (env.type === "worktree")
      return {
        request: {
          type: "host",
          ...(hostId ? { hostId } : {}),
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
        workspace: "isolated",
        environmentId: null,
      };
    if (env.type === "reuse")
      return {
        request: { type: "reuse", environmentId: env.environmentId },
        workspace: "shared",
        environmentId: env.environmentId,
      };
    return {
      request: { type: "project-default" },
      workspace: "shared",
      environmentId: null,
    };
  }

  private async dispatch(
    project: ProjectRecord,
    input: DelegateInput & { role: Role },
    review: ReviewDispatch | null,
  ): Promise<DelegateResult> {
    const settings = await this.preferences.read();
    const access: AssignmentAccess =
      input.role === "review" ? "read-only" : input.access ?? "write";
    const initialReviewTargets = this.reviewTargets(project, input);
    let all = this.store.tasks(project.id);
    let tasks = (input.tasks ?? []).map((ref) =>
      this.requireTask(project, ref),
    );
    let reviewOfTasks = (input.reviewOf ?? []).map((ref) =>
      this.requireTask(project, ref),
    );
    const existing = input.worker
      ? this.requireWorker(project, input.worker)
      : null;
    const kind: WorkKind = input.kind ?? tasks[0]?.workKind ?? "implementation";
    // T96: selected prior handoffs are validated before any native call and
    // re-resolved after the last await; the brief embeds the filing checked then.
    const handoffRefs = input.handoffs ?? [];
    if (handoffRefs.length && input.role === "review")
      throw new ProjectError("Reviews bind reviewTargets and read reports themselves; handoffs are for work assignments.");
    const initialHandoffs = resolveHandoffs(this.store, project.id, handoffRefs, tasks).map(handoffSource);

    // Profile: forks and continues keep the worker's model; reviews follow the
    // review plan; work follows the user's choice, then the coordinator's, then
    // the policy default for its kind.
    let profile: Profile;
    if (review) profile = review.profile;
    else if (
      (input.route === "fork" || input.route === "continue") &&
      existing?.providerId &&
      existing.model &&
      !input.profile
    )
      profile = {
        providerId: existing.providerId,
        model: existing.model,
        reasoningLevel: (existing.reasoningLevel ??
          "high") as Profile["reasoningLevel"],
      };
    else {
      const choice = chooseWorkProfile({
        policy: withProfileDefaults(project.policy, settings),
        kind,
        task: tasks[0] ?? null,
        explicit: input.profile ?? null,
      });
      if (!choice.ok) throw new ProjectError(choice.reason);
      profile = choice.profile;
      for (const task of tasks.slice(1)) {
        const other = chooseWorkProfile({
          policy: withProfileDefaults(project.policy, settings),
          kind,
          task,
          explicit: profile,
        });
        if (!other.ok) throw new ProjectError(other.reason);
        profile = other.profile;
      }
    }

    const bbProjectId =
      input.bbProjectId ??
      (input.route !== "fresh" && existing
        ? existing.bbProjectId
        : undefined) ??
      tasks[0]?.brief?.areas[0]?.bbProjectId ??
      reviewOfTasks[0]?.brief?.areas[0]?.bbProjectId ??
      project.memberProjectIds[0]!;
    if (!project.memberProjectIds.includes(bbProjectId))
      throw new ProjectError(
        `${bbProjectId} is not a member BB project of ${project.name}; the members are ${project.memberProjectIds.join(", ")}. A task brief's areas name the BB project ids, not the Initiative id.`,
      );
    let paths = [...tasks, ...reviewOfTasks].flatMap(
      (task) =>
        task.brief?.areas
          .filter((area) => area.bbProjectId === bbProjectId)
          .flatMap((area) => area.paths) ?? [],
    );
    if (
      existing &&
      ["continue", "fork"].includes(input.route) &&
      existing.bbProjectId !== bbProjectId
    )
      throw new ProjectError(
        "Continuing or forking keeps the source BB project. Start a fresh worker in the other project.",
      );
    // Reviewer independence comes from a fresh, read-only context bound to
    // the reported task/assignment/revision targets (checked above and in
    // evaluateDelegation), not from model family. A different family is only
    // the default plan's recommendation; an explicit or configured reviewer of
    // the same or an unclassified family is dispatched as chosen. The family
    // still describes the scope, and the partition key is recorded only when
    // the scope actually contains the family it names.
    let reviewScopeLabel: string | null = null;
    let reviewKey: ReviewPartition["key"] | null = null;
    if (input.role === "review") {
      const implementers = this.store
        .assignments(project.id)
        .filter(
          (a) =>
            a.role === "work" &&
            input.reviewTargets?.some(t => t.assignment === a.ref) &&
            !["cancelled", "failed", "rejected"].includes(a.state),
        );
      const scopeSeries = new Set(
        implementers.map((a) => seriesOf(a.actualProfile ?? a.profile)),
      );
      const named = [...scopeSeries].filter((s) => s !== "unknown");
      const keyed =
        review?.key === "reviewOfClaude"
          ? ("claude" as const)
          : review?.key === "reviewOfGpt"
            ? ("gpt" as const)
            : null;
      reviewKey = keyed && scopeSeries.has(keyed) ? review!.key : null;
      reviewScopeLabel =
        keyed && scopeSeries.has(keyed)
          ? `the ${keyed === "claude" ? "Claude" : "GPT"} implementation contributions`
          : named.length === 1
            ? `the ${named[0] === "claude" ? "Claude" : "GPT"} implementation contributions`
            : named.length > 1
              ? "the mixed Claude and GPT implementation contributions"
              : implementers.length
                ? "the recorded implementation contributions (its model family is unknown — not Claude or GPT)"
                : "the recorded implementation contributions";
    }
    const unconfirmed = existing
      ? this.store
          .assignments(project.id)
          .filter(
            (a) =>
              a.workerNum === existing.num &&
              ["pending", "uncertain"].includes(a.opState),
          )
      : [];
    if (existing && unconfirmed.length)
      throw new ProjectError(
        `${existing.ref} has an unconfirmed operation, so its context cannot be reused yet. ${unconfirmed
          .slice(0, 3)
          .map(unsettledReason)
          .join(" ")}${unconfirmed.length > 3 ? ` ${unconfirmed.length - 3} more are listed in initiative_read {"view":"assignments"}.` : ""}`,
      );
    const envChoice: EnvironmentChoice =
      input.environment ??
      (input.route === "fork" && input.role === "work"
        ? { type: "worktree" }
        : existing?.environmentId &&
            input.route !== "fresh" &&
            existing.state !== "retired"
          ? { type: "reuse", environmentId: existing.environmentId }
          : { type: "project-default" });
    const env = this.environmentFor(
      envChoice,
      { type: "project-default" },
      envChoice.type === "worktree"
        ? await projectHostId(this.sdk, bbProjectId)
        : undefined,
    );

    // Live facts, read just before dispatch.
    let thread: ThreadDto | null = null;
    let threadModel: string | null = null;
    if (
      existing?.threadId &&
      (input.route === "continue" || input.route === "fork")
    ) {
      try {
        thread = await this.sdk.threads.get({ threadId: existing.threadId });
      } catch {
        thread = null;
      }
      if (thread) {
        const execution = await threadExecution(this.sdk, existing.threadId);
        if (!execution?.model || !execution.reasoningLevel)
          throw new ProjectError(
            `${existing.ref}'s native execution settings could not be resolved. Reuse cannot preserve its model, reasoning and service tier; inspect the thread before retrying.`,
          );
        threadModel = execution.model;
        const inherited: Profile = { providerId: thread.providerId, ...execution };
        const requested = input.profile ?? tasks[0]?.profileOverride;
        profile = requested
          ? {
              ...requested,
              ...(requested.serviceTier ?? inherited.serviceTier
                ? { serviceTier: requested.serviceTier ?? inherited.serviceTier }
                : {}),
            }
          : inherited;
        // Reapply task choices after reading native inheritance, including a
        // user tier on another task in this bounded batch.
        for (const task of tasks) {
          const choice = chooseWorkProfile({ policy: withProfileDefaults(project.policy, settings), kind, task, explicit: profile });
          if (!choice.ok) throw new ProjectError(choice.reason);
          profile = choice.profile;
        }
        // Native fork takes these fields from the source's last execution.
        // It has no override fields in SDK 0.4.87. Never advertise settings
        // that a fork cannot apply or add a second bootstrap/send path.
        if (input.route === "fork" && !sameProfile(profile, inherited))
          throw new ProjectError(
            `A native fork inherits ${describeProfile(inherited)} and cannot override model, reasoning or service tier. Continue the source with the requested settings or start a fresh worker.`,
          );
      }
    }
    const routing = env.environmentId
      ? { environmentId: env.environmentId }
      : { hostId: await projectHostId(this.sdk, bbProjectId) };
    const catalog = await checkCatalog(this.sdk, profile, routing);
    if (!catalog.ok) throw new ProjectError(catalog.reason!);
    project = this.requireProject(project.id);
    // An explicit same-task delegation can encounter a cancelled reservation
    // after its previously accepted native thread has become quiet. Recheck
    // only that known delivery; unreadable/queued/unconfirmed creates stay held.
    const requestedTasks = new Set(tasks.map(task => task.num));
    for (const cancelled of this.store.assignments(project.id))
      if (cancelled.state === "cancelled" && cancelled.briefDelivered &&
          cancelled.threadId && cancelled.queuedMessageId === null &&
          ["pending", "uncertain"].includes(cancelled.opState) &&
          cancelled.taskNums.some(num => requestedTasks.has(num)))
        await this.settleCancelledIfQuiet(cancelled);
    // T91: read native evidence for every past write that could still hold these
    // paths now, before the final re-read; nothing is awaited after that re-read.
    const holdsApply = input.role === "work" && access !== "read-only" && env.workspace === "shared";
    const exemptThreadId = input.route === "continue" ? existing?.threadId ?? null : null;
    // T114: one project listing shows each candidate thread's activity and its
    // actual checkout, so writers in separate managed worktrees never block
    // each other even when the ledger never recorded their environment.
    const candidates = holdsApply ? holdGroups(this.store.assignments(project.id), { bbProjectId, environmentId: null, paths, exemptThreadId }) : [];
    const rows = holdsApply
      ? await this.projectListRows(bbProjectId, new Set([
          ...candidates.map(g => g.threadId),
          ...this.store.assignments(project.id).filter(a => a.role === "work" && a.threadId &&
            (["dispatching", "queued", "running"].includes(a.state) || ["pending", "uncertain"].includes(a.opState))).map(a => a.threadId!),
          ...(exemptThreadId ? [exemptThreadId] : []),
        ]))
      : new Map<string, ThreadListRow>();
    const holdEvidence = await this.holdEvidence(candidates, rows);
    const here = checkoutOf(env.environmentId, exemptThreadId ? rows.get(exemptThreadId) : undefined, env.environmentId === null && !exemptThreadId);
    const separate = (a: AssignmentRecord) => {
      const worker = this.store.worker(project.id, a.workerNum);
      return separateCheckouts(here, checkoutOf(a.environmentId ?? worker?.environmentId ?? null, a.threadId ? rows.get(a.threadId) : undefined, false));
    };
    const holdScope = () => ({ bbProjectId, environmentId: env.environmentId, paths, exemptThreadId, separate });
    project = this.requireProject(project.id);
    // Anything awaited above may have changed task state or execution receipts.
    // These reservations must be current when the dispatch intent is recorded.
    all = this.store.tasks(project.id);
    tasks = (input.tasks ?? []).map((ref) => this.requireTask(project, ref));
    reviewOfTasks = (input.reviewOf ?? []).map((ref) =>
      this.requireTask(project, ref),
    );
    paths = [...tasks, ...reviewOfTasks].flatMap(
      (task) =>
        task.brief?.areas
          .filter((area) => area.bbProjectId === bbProjectId)
          .flatMap((area) => area.paths) ?? [],
    );
    if (input.role === "work")
      for (const task of tasks) {
        const choice = chooseWorkProfile({
          policy: withProfileDefaults(project.policy, settings),
          kind,
          task,
          explicit: profile,
        });
        if (!choice.ok) throw new ProjectError(choice.reason);
        if (!sameProfile(profile, choice.profile))
          throw new ProjectError(
            `${task.ref}'s execution choice changed during dispatch. Read the task again before delegating.`,
          );
        if (
          this.store
            .decisions(project.id)
            .some(
              (k) =>
                k.status === "active" &&
                k.humanAttention === "needs-opinion" &&
                k.blocks.includes(task.num),
            )
        )
          throw new ProjectError(
            `${task.ref} is waiting for the user's opinion. Answer it before delegation.`,
          );
        const active = this.store
          .assignments(project.id)
          .find(
            (a) =>
              a.role === "work" &&
              a.taskNums.includes(task.num) &&
              ([
                "dispatching",
                "queued",
                "running",
                "idle_no_report",
                "stopped",
                "reported",
              ].includes(a.state) ||
                ["pending", "uncertain"].includes(a.opState) ||
                a.queuedMessageId !== null),
          );
        if (active)
          throw new ProjectError(
            active.state === "reported"
              ? `${task.ref} already has ${active.ref} (reported ${active.report?.outcome}). ${reportedRetryHint(active, task.ref)}`
              : `${task.ref} already has ${active.ref} (${active.state}). Accept or stop it before delegating again.`,
          );
      }

    const open = existing
      ? this.store.openAssignment(project.id, existing.num)
      : null;
    const concurrentWork: DelegationFacts["concurrentWork"] = this.store
      .assignments(project.id)
      .filter(
        (a) =>
          a.role === "work" &&
          (["dispatching", "queued", "running"].includes(a.state) ||
            ["pending", "uncertain"].includes(a.opState)) &&
          a.bbProjectId === bbProjectId &&
          // Only a continuation shares the worker's own context; a fork is a new writer.
          !(input.route === "continue" && a.workerNum === existing?.num),
      )
      .map((a) => {
        const worker = this.store.worker(project.id, a.workerNum);
        return {
          ref: a.ref,
          access: legacyReadOnly(a) ? "read-only" as const : a.access,
          workerRef: workerRef(a.workerNum),
          // The scope recorded at dispatch; later brief edits never narrow it.
          paths: a.writeScope ?? [],
          ...(a.writeScope === null ? { legacy: true } : {}),
          workspace: (separate(a) ? "isolated" : "shared") as Workspace,
        };
      });
    // Rebuilt synchronously from the evidence read above: a thread without valid
    // evidence for its current records (new, re-reported or settled meanwhile) is unknown.
    if (holdsApply)
      for (const group of holdGroups(this.store.assignments(project.id), holdScope())) {
        const evidence = holdEvidence.get(group.threadId);
        const held = group.background.length ? "listed" as const
          : !evidence || evidence.signature !== group.signature ? "unknown" as const
          : evidence.verdict === "ended" ? null : evidence.verdict;
        const seen = held === "unknown" ? evidence?.signature === group.signature ? evidence.seen : "its records changed while checking"
          : held === "running" ? evidence!.seen : undefined;
        if (!held) continue;
        // A listed hold names the oldest assignment whose report lists the work, with only its
        // own jobs and version to echo; other listing reports on the thread are named by ref.
        const listing = group.assignments.filter(a => unreleasedBackground(a).length);
        const lead = held === "listed" ? listing[0]! : group.assignments[0]!;
        concurrentWork.push({
          ref: lead.ref, access: "write", workerRef: workerRef(lead.workerNum), workspace: "shared",
          paths: group.paths ?? [], held, state: lead.state, ...(seen ? { seen } : {}),
          ...(held === "listed" ? {
            background: unreleasedBackground(lead), reportVersion: reportVersion(lead),
            ...(listing.length > 1 ? { alsoListed: listing.slice(1).map(a => a.ref) } : {}),
          } : {}),
          ...(group.paths === null ? { legacy: true } : {}),
        });
      }
    const reasons = delegationViolations({
      project,
      route: input.route,
      role: input.role,
      access,
      tasks,
      allTasks: all,
      bbProjectId,
      worker: existing ? this.store.worker(project.id, existing.num) : null,
      workerOpenAssignment: open,
      thread: thread
        ? {
            archived: thread.archivedAt !== null,
            status: thread.status,
            model: threadModel,
          }
        : null,
      requestedProfile: profile,
      workspace: env.workspace,
      concurrentWork,
      paths,
      providerSupportsFork: catalog.supportsFork,
      forkAtCompletedPoint:
        input.route !== "fork" ||
        input.forkAtSeq !== undefined ||
        !open ||
        open.state === "reported" ||
        (thread !== null && !BUSY_STATUSES.has(thread.status)),
      reviewOf: reviewOfTasks.map((task) => task.num),
      reviewOfTasks,
    });
    if (reasons.length) throw new ProjectError(reasons.join(" "));

    const checkedReviewTargets = this.reviewTargets(project, input);
    if (JSON.stringify(checkedReviewTargets) !== JSON.stringify(initialReviewTargets)) throw new ProjectError("Review source profile/revision changed during dispatch; read it again before review.");
    const handoffs = resolveHandoffs(this.store, project.id, handoffRefs, tasks);
    const handoffSources = handoffs.map(handoffSource);
    if (JSON.stringify(handoffSources) !== JSON.stringify(initialHandoffs))
      throw new ProjectError(`A selected handoff's report or state changed during dispatch (${handoffSources.map(h => `${h.assignment} ${h.state}`).join(", ")}); read it again before delegating.`);
    const opId = newOpId();
    const decisions = this.store
      .decisions(project.id)
      .filter(
        (item) =>
          item.status === "active" &&
          (item.scope === "project" || item.scope === bbProjectId),
      )
      .slice(-8);
    const rationale =
      [review?.rationale, input.reviewTargets?.map(t => `${t.task} from ${t.assignment} at ${t.revision}`).join("; "), input.rationale].filter(Boolean).join(" ") || null;

    // Recheck the worker snapshot after the awaited catalog call.
    if (existing) {
      const current = this.store.worker(project.id, existing.num)!;
      if (
        current.threadId !== existing.threadId ||
        current.generation !== existing.generation ||
        (input.route === "continue" && current.state === "retired")
      )
        throw new ProjectError(
          "The worker context changed during dispatch. Read it again before delegating.",
        );
    }
    // Record intent before calling BB so a crash leaves a reconcilable operation.
    const { worker, assignment } = this.store.tx(() => {
      const worker =
        input.route === "fresh" || input.route === "fork"
          ? this.store.createWorker({
              projectId: project.id,
              role: input.route === "fork" ? existing!.role : input.role,
              // A fork keeps the source worker's logical identity unless the
              // caller explicitly renames it.
              label:
                input.label ??
                (input.route === "fork"
                  ? existing!.label
                  : review
                    ? `Review of ${review.taskNums.map(taskRef).join(", ")}`
                    : (tasks[0]?.title ?? "Worker")),
              area:
                input.area ??
                (input.route === "fork"
                  ? existing!.area
                  : paths.join(", ") || bbProjectId),
              bbProjectId,
              forkedFrom: input.route === "fork" ? existing!.num : null,
            })
          : // An explicit rename on continue is staged on the assignment, not
            // committed: the worker's logical identity changes only once the
            // brief that carries it is proven delivered — a refused send
            // leaves the old identity standing, an uncertain one settles the
            // staged rename with its delivery evidence.
            existing!;
      const assignment = this.store.createAssignment({
        projectId: project.id,
        workerNum: worker.num,
        taskNums: tasks.map((task) => task.num),
        route: input.route,
        role: worker.role,
        access,
        workKind: input.role === "work" ? kind : null,
        threadId: input.route === "continue" ? worker.threadId : null,
        generation: input.route === "continue" ? worker.generation : 1,
        profile,
        bbProjectId,
        environmentId: env.environmentId,
        state: "dispatching",
        opId,
        opState: "pending",
        briefText: "",
        reviewOf: reviewOfTasks.length
          ? reviewOfTasks.map((task) => task.num)
          : null,
        writeScope: input.role === "work" ? paths : null,
        handoffSources,
        reviewKey,
        rationale,
        pendingIdentity:
          input.route === "continue" &&
          (input.label !== undefined || input.area !== undefined)
            ? {
                ...(input.label !== undefined ? { label: input.label } : {}),
                ...(input.area !== undefined ? { area: input.area } : {}),
              }
            : null,
      });
      if (checkedReviewTargets.length) this.store.updateAssignment(project.id, assignment.num, { reviewTargets: checkedReviewTargets });
      for (const task of tasks)
        if (task.status === "planned" || task.status === "blocked")
          this.store.updateTask(project.id, task.num, {
            status: "in_progress",
            progress: `Delegated to ${worker.ref}`,
            nextCheckpoint: "Worker report",
          });
      this.store.updateWorker(project.id, worker.num, { state: "active" });
      this.store.log(
        project.id,
        "delegate",
        `${assignment.ref}: ${input.route} → ${worker.ref} (${describeProfile(profile)})`,
        { assignment: assignment.num, worker: worker.num },
      );
      return { worker, assignment };
    });
    // The brief and native title carry the staged identity: it is what the
    // delivery will name, and its commit waits on the positive receipt.
    const effectiveLabel =
      assignment.pendingIdentity?.label ?? worker.label;
    const effectiveArea = assignment.pendingIdentity?.area ?? worker.area;
    const text = renderAssignment({
      project,
      assignmentRef: assignment.ref,
      workerRef: worker.ref,
      workerLabel: effectiveLabel,
      workerPurpose: effectiveArea,
      role: worker.role,
      access: assignment.access,
      profile,
      permissionMode: input.permissionMode,
      guidance: input.route === "fresh" ? null : settings.workerInstructions,
      tasks,
      reviewOf: reviewOfTasks,
      reviewTargets: checkedReviewTargets,
      decisions,
      handoffs: handoffs.map((source) => renderStandardHandoff(this.store, source, true)),
      note:
        [
          input.note,
          reviewScopeLabel
            ? `Review scope: ${reviewScopeLabel}.${review?.shared ? " Another reviewer covers the other model family's contributions in this milestone." : ""}`
            : null,
        ]
          .filter(Boolean)
          .join("\n") || null,
      opId,
    });
    this.store.db
      .prepare(
        `UPDATE assignments SET brief_text = ? WHERE project_id = ? AND num = ?`,
      )
      .run(text, project.id, assignment.num);
    const metadata = {
      role: "worker",
      projectId: project.id,
      worker: worker.num,
      assignment: assignment.num,
      op: opId,
      v: METADATA_VERSION,
    };
    // Every created native title leads with the stable W# logical identity
    // followed by the worker's label and purpose.
    const title = `${worker.ref} ${effectiveLabel} — ${effectiveArea}`.slice(
      0,
      120,
    );
    const notes: string[] = [];
    try {
      if (input.route === "continue") {
        // Native queueing: the brief joins the worker's queue and BB dispatches
        // it when the thread is free. The receipt lands on the assignment.
        const sent = await this.sdk.threads.send({
          threadId: worker.threadId!,
          mode: input.delivery === "steer" ? "steer-if-active" : "queue-if-active",
          ...(project.coordinatorThreadId ? { senderThreadId: project.coordinatorThreadId } : {}),
          input: textInput(text),
          model: profile.model,
          reasoningLevel: profile.reasoningLevel,
          ...(profile.serviceTier ? { serviceTier: profile.serviceTier } : {}),
          ...(input.permissionMode
            ? { permissionMode: input.permissionMode }
            : {}),
        });
        // An explicit rename lands on the native thread too, so the sidebar
        // title keeps matching the logical identity.
        if (input.label !== undefined || input.area !== undefined) {
          try {
            await this.sdk.threads.update({
              threadId: worker.threadId!,
              title,
            });
          } catch {
            notes.push("its native title could not be updated");
          }
        }
        this.store.tx(() => {
          const current = this.store.assignment(project.id, assignment.num)!;
          // The send await took real time: a cancel may have landed while the
          // receipt was in flight. A late sent/queued receipt proves delivery
          // only — never that the cancelled turn ended — so the operation
          // stays uncertain and the reservation held until the common
          // settlement rule observes positive native quiescence.
          const cancelled =
            current.state === "cancelled" || current.cancelRequested;
          this.store.updateAssignment(project.id, assignment.num, {
            state: ["dispatching", "queued", "running"].includes(current.state)
              ? sent.delivery === "queued"
                ? "queued"
                : "running"
              : current.state,
            opState: cancelled ? "uncertain" : "done",
            briefDelivered:
              sent.delivery !== "queued" || current.briefDelivered,
            queuedMessageId:
              sent.delivery === "queued" ? sent.queuedMessage.id : null,
            threadId: worker.threadId,
          });
          if (cancelled)
            this.store.log(
              project.id,
              "delegate",
              `${assignment.ref}'s send returned ${sent.delivery} after its cancellation; the reservation holds until the native side is positively quiet.`,
            );
        });
      } else {
        const created =
          input.route === "fork"
            ? await this.sdk.threads.fork({
                sourceThreadId: existing!.threadId!,
                // SDK0.4.87 fork has no senderThreadId; no unsupported field or extra bootstrap send.
                ...(input.forkAtSeq !== undefined
                  ? { sourceSeqEnd: input.forkAtSeq }
                  : {}),
                input: textInput(text),
                title,
                environment: env.request as never,
                ...(input.permissionMode
                  ? { permissionMode: input.permissionMode }
                  : {}),
                pluginMetadata: metadata,
              })
            : await (async () => {
                // Native parenting: BB delivers this worker's completion
                // notices straight to the coordinator thread. The target is
                // re-read at issue time and the issued spawn registers under
                // it, so a switch racing the spawn can't strand the new
                // thread beneath an archiving predecessor without the ledger
                // knowing.
                const parentId =
                  this.store.project(project.id)?.coordinatorThreadId ?? null;
                this.parentOpBegin(project.id, parentId);
                try {
                  return await this.sdk.threads.spawn({
                    projectId: bbProjectId,
                    environment: env.request as never,
                    providerId: profile.providerId,
                    model: profile.model,
                    reasoningLevel: profile.reasoningLevel,
                    ...(profile.serviceTier ? { serviceTier: profile.serviceTier } : {}),
                    ...(input.permissionMode
                      ? { permissionMode: input.permissionMode }
                      : {}),
                    title,
                    prompt: text,
                    ...(parentId ? { parentThreadId: parentId } : {}),
                    pluginMetadata: metadata,
                  });
                } finally {
                  this.parentOpEnd(project.id, parentId);
                }
              })();
        await this.confirmCreated(project.id, assignment.num, created);
        if (env.workspace === "isolated" && created.environmentId) {
          // BB names managed worktree branches itself; the supported display
          // surface is the environment name, which gets the logical identity.
          try {
            await this.sdk.environments.update({
              environmentId: created.environmentId,
              name: `${worker.ref} ${worker.label}`.slice(0, 80),
            });
          } catch (error) {
            notes.push(
              `its worktree could not be named: ${errorMessage(error)}`,
            );
          }
        }
      }
    } catch (error) {
      if (isDefiniteRejection(error)) {
        // Attribute the refusal to the operation that threw: it cannot erase
        // delivery or execution evidence that landed while it was in flight,
        // nor the cancellation recorded meanwhile.
        const current = this.store.assignment(project.id, assignment.num)!;
        const cancelled =
          current.state === "cancelled" || current.cancelRequested;
        const proven =
          current.briefDelivered ||
          current.report !== null ||
          current.queuedMessageId !== null;
        if (proven || (cancelled && input.route === "continue")) {
          if (current.opState === "pending")
            this.store.updateAssignment(project.id, assignment.num, {
              opState: "uncertain",
            });
          this.store.log(
            project.id,
            "delegate",
            `${assignment.ref}'s ${input.route === "continue" ? "continuation send" : "request"} was refused (${errorMessage(error)}); recorded delivery/execution evidence stands, so the reservation stays held for positive native settlement.`,
          );
          throw new ProjectError(`Delegation failed: ${errorMessage(error)}`);
        }
        if (cancelled) {
          // A refused create proves nothing was created: the reservation is
          // positively never-delivered, released without erasing the
          // cancellation itself.
          this.store.tx(() => {
            const updated = this.store.updateAssignment(
              project.id,
              assignment.num,
              { opState: "failed", pendingIdentity: null },
            );
            this.releaseCancelledTasks(project.id, updated, "never");
            this.store.log(
              project.id,
              "delegate",
              `${assignment.ref}'s create was refused after its cancellation; provably never delivered, so the reservation is released.`,
            );
          });
          throw new ProjectError(`Delegation failed: ${errorMessage(error)}`);
        }
        await this.failDispatch(
          project.id,
          assignment.num,
          `BB refused it: ${errorMessage(error)}`,
        );
        throw new ProjectError(`Delegation failed: ${errorMessage(error)}`);
      }
      if (this.store.assignment(project.id, assignment.num)!.opState !== "done")
        this.store.updateAssignment(project.id, assignment.num, {
          opState: "uncertain",
        });
      this.store.log(
        project.id,
        "delegate",
        `${assignment.ref}: outcome uncertain (${errorMessage(error)}); reconciling before any retry`,
      );
    }
    const final = this.store.assignment(project.id, assignment.num)!;
    return {
      assignment: final.ref,
      worker: workerRef(final.workerNum),
      threadId: final.threadId,
      state: final.state,
      profile: describeProfile(profile),
      rationale,
      note:
        [
          final.opState === "uncertain"
            ? final.briefDelivered
              ? "BB accepted the brief, but its native settlement is unconfirmed. Do not retry while the reservation is held."
              : "BB did not confirm the request. Do not retry; the plugin reconciles it and reports back."
            : null,
          input.route !== "continue" && final.briefDelivered
            ? "BB accepted thread creation and the initial brief; this receipt does not establish that an agent turn started."
            : null,
          final.handoffSources?.length
            ? `The brief embeds the standard handoff of ${final.handoffSources.map(h => `${h.assignment} (${h.state}, report ${h.reportVersion})`).join(", ")} as reference only.`
            : null,
          ...notes,
        ]
          .filter(Boolean)
          .join(" ") || null,
    };
  }

  /**
   * Rewrite a managed worker's native title to its ledger identity. Called
   * after a staged continue rename is dropped (its optimistic title update
   * already landed on a receipted send) and idempotent everywhere else.
   */
  async syncWorkerTitle(projectId: string, workerNum: number) {
    const worker = this.store.worker(projectId, workerNum);
    if (!worker?.threadId) return;
    try {
      await this.sdk.threads.update({
        threadId: worker.threadId,
        title: `${worker.ref} ${worker.label} — ${worker.area}`.slice(0, 120),
      });
    } catch (error) {
      this.store.log(
        projectId,
        "worker",
        `Could not restore ${worker.ref}'s native title to its ledger identity: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Attach a created managed thread under the project coordinator when BB did
   * not already record that parent — fork creates carry no parent argument.
   * A confirmed attach records nativeParent as parenting evidence. Report
   * delivery separately checks the native origin: genuine silent forks still
   * use the canonical fallback even when parenting is confirmed.
   */
  private async ensureCoordinatorParent(projectId: string, thread: ThreadDto) {
    // Each attempt re-resolves the coordinator from the ledger immediately
    // before issuing, registers the issued update under its target, and then
    // positively receipts the thread's actual parent against the CURRENT
    // coordinator — an update confirmed against a since-superseded target is
    // stale evidence, never a nativeParent flag. A stale landing repairs on
    // the next attempt toward the live coordinator; after the bounded tries
    // the flag stays false and reports route through Initiatives.
    for (let attempt = 0; attempt < 3; attempt++) {
      const coordinatorId =
        this.store.project(projectId)?.coordinatorThreadId ?? null;
      if (!coordinatorId) return;
      if (thread.parentThreadId !== coordinatorId) {
        this.parentOpBegin(projectId, coordinatorId);
        try {
          await this.sdk.threads.update({
            threadId: thread.id,
            parentThreadId: coordinatorId,
          });
        } catch {
          // The receipt read below judges the outcome, not the throw.
        } finally {
          this.parentOpEnd(projectId, coordinatorId);
        }
      }
      let actual: string | null | undefined;
      try {
        const fresh = await this.sdk.threads.get({ threadId: thread.id });
        thread = fresh;
        actual = fresh.parentThreadId;
      } catch {
        actual = undefined;
      }
      if (actual === undefined) break;
      const current =
        this.store.project(projectId)?.coordinatorThreadId ?? null;
      if (!current) return;
      if (actual === current) {
        const member = this.store.membership(thread.id);
        if (
          member?.project.id === projectId &&
          member.worker?.threadId === thread.id
        )
          this.store.updateWorker(projectId, member.worker.num, {
            nativeParent: true,
          });
        return;
      }
      // Only a landed attach on the wrong parent repairs: a provably
      // parentless thread means the update was refused, and a refused attach
      // is unconfirmed — not something to hammer with retries.
      if (actual === null) break;
      if (thread.archivedAt !== null || thread.deletedAt !== null) break;
    }
    this.store.log(
      projectId,
      "worker",
      `Could not attach ${thread.id} to the coordinator natively; its completion notices route through Initiatives.`,
    );
  }

  /** Apply a confirmed create (spawn or fork), now or during reconciliation. */
  async confirmCreated(projectId: string, num: number, thread: ThreadDto) {
    const assignment = this.store.assignment(projectId, num)!;
    const worker = this.store.worker(projectId, assignment.workerNum)!;
    const cancelled =
      assignment.state === "cancelled" || assignment.cancelRequested;
    if (
      assignment.threadId === thread.id &&
      worker.threadId === thread.id &&
      (assignment.opState === "done" || cancelled)
    ) {
      // Already applied: for a cancelled op the only open question is
      // whether the created thread can still execute — the common verdict.
      if (cancelled && assignment.opState !== "done")
        await this.settleCancelledIfQuiet(assignment);
      return;
    }
    // The create response is positive evidence — record the thread binding,
    // accepted brief and (for a cancelled op) uncertain reservation BEFORE
    // the Stop await. While native I/O is in flight the ledger must already
    // show that a real thread exists, so a "never sent" settle can never
    // contradict a confirmed creation.
    this.store.tx(() => {
      this.store.updateWorker(projectId, worker.num, {
        threadId: thread.id,
        generation: assignment.generation,
        environmentId: thread.environmentId,
        providerId: assignment.profile.providerId,
        model: assignment.profile.model,
        reasoningLevel: assignment.profile.reasoningLevel,
        state: ["stopped", "cancelled"].includes(assignment.state)
          ? "idle"
          : "active",
        bbProjectId: thread.projectId,
        // A worker is a native child only when BB records this project's
        // coordinator as its parent.
        nativeParent:
          thread.parentThreadId !== null &&
          thread.parentThreadId ===
            this.store.project(projectId)?.coordinatorThreadId,
      });
      this.store.openGeneration(
        projectId,
        worker.num,
        assignment.generation,
        thread.id,
      );
      this.store.updateAssignment(projectId, num, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        state: ["reported", "accepted", "stopped", "cancelled"].includes(
          assignment.state,
        )
          ? assignment.state
          : "running",
        // The created thread exists whether or not the stop landed: a
        // cancelled op stays uncertain until positive native quiescence.
        opState: cancelled ? "uncertain" : "done",
        // Creation accepts the prompt; it does not prove provider execution.
        briefDelivered: true,
      });
    });
    // A fork cannot take a parent argument natively: its thread lands
    // wherever the fork left it, so a created managed child is attached under
    // the coordinator after confirmation. A receiptless attach keeps the
    // recorded flag false and reports route through Initiatives instead.
    await this.ensureCoordinatorParent(projectId, thread);
    if (cancelled || assignment.state === "stopped") {
      // Stop's {ok} acknowledges the request, not the execution — BB's route
      // can succeed while the host still runs. A refusal belongs to this
      // stop call alone; it must never surface as a dispatch rejection.
      await this.sdk.threads.stop({ threadId: thread.id }).catch((error) => {
        this.store.log(
          projectId,
          "delegate",
          `${assignment.ref}'s thread was created despite its cancellation, but its stop request failed (${errorMessage(error)}); the reservation holds until the native side is positively quiet.`,
        );
      });
    }
    // After the await, newer report/receipt/identity/cancellation evidence
    // wins — the common freshness comparison guards the settle below.
    if (cancelled)
      await this.settleCancelledIfQuiet(
        this.store.assignment(projectId, num)!,
      );
  }

  private async failDispatch(projectId: string, num: number, reason: string) {
    // A failed continue send may already have landed the staged rename's
    // optimistic native title — restore it once the staged identity drops.
    const staged = this.store.assignment(projectId, num)?.pendingIdentity;
    this.store.tx(() => {
      const assignment = this.store.updateAssignment(projectId, num, {
        state: "failed",
        opState: "failed",
        stopReason: reason,
        // A failed dispatch proves its brief never ran; a staged rename dies
        // with it so the worker keeps the identity its thread still carries.
        pendingIdentity: null,
      });
      for (const taskNum of assignment.taskNums) {
        const task = this.store.task(projectId, taskNum);
        if (task?.status === "in_progress")
          this.store.updateTask(projectId, taskNum, {
            status: "planned",
            progress: `Delegation failed: ${reason}`,
          });
      }
      const worker = this.store.worker(projectId, assignment.workerNum)!;
      if (!worker.threadId)
        this.store.updateWorker(projectId, worker.num, { state: "retired" });
      this.store.log(
        projectId,
        "delegate",
        `${assignmentRef(num)} failed: ${reason}`,
      );
    });
    if (staged)
      await this.syncWorkerTitle(
        projectId,
        this.store.assignment(projectId, num)!.workerNum,
      );
  }

  /**
   * The live native thread a pending start retained, when it still carries
   * this start's op: "ended" when it is archived, deleted or gone, null when
   * it cannot be read this sweep, "unknown" when its metadata does not prove
   * the op and a scan must look further.
   */
  private async retainedCoordinatorReceipt(
    start: PendingCoordinatorStart,
  ): Promise<ThreadDto | "ended" | "unknown" | null> {
    try {
      const thread = await this.sdk.threads.get({ threadId: start.thread_id! });
      // Only a well-formed archive/delete timestamp proves the receipt ended;
      // unreadable lifecycle fields prove nothing and are retried next sweep.
      if (
        !ProjectsService.lifecycleWellFormed(thread.archivedAt) ||
        !ProjectsService.lifecycleWellFormed(thread.deletedAt)
      )
        return null;
      if (thread.archivedAt !== null || thread.deletedAt !== null) return "ended";
      const metadata = await this.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: this.bb.pluginId });
      return metadata.op === start.op_id && metadata.projectId === start.project_id
        ? thread
        : "unknown";
    } catch (error) {
      if ((error as { status?: number }).status === 404) return "ended";
      // A failed read proves nothing; the start stays unconfirmed.
      return null;
    }
  }

  /** Confirm one located coordinator receipt once its own facts prove the home; returns the settled line. */
  private async reconcileCoordinatorReceipt(
    start: PendingCoordinatorStart,
    row: ThreadDto | ThreadListRow,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // The receipt is only confirmed once its own facts prove the
    // coordinator home; an unprovable landing keeps the start
    // unconfirmed with the native thread id retained for inspection.
    const project = this.store.project(start.project_id);
    const problem = project
      ? await this.coordinatorReceiptHomeProblem(project, row)
      : "the Initiative no longer exists";
    if (problem && project && checkoutNotYetReported(project, row)) return null;
    if (problem) {
      const recorded = this.store.db
        .prepare(
          "SELECT thread_id, reason FROM coordinator_starts WHERE project_id=? AND op_id=?",
        )
        .get(start.project_id, start.op_id) as
        | { thread_id: string | null; reason: string | null }
        | undefined;
      if (
        recorded?.thread_id !== row.id ||
        !recorded.reason?.includes("home unproven")
      ) {
        this.store.db
          .prepare(
            "UPDATE coordinator_starts SET thread_id=?, reason=? WHERE project_id=? AND op_id=? AND state IN ('pending','uncertain')",
          )
          .run(
            row.id,
            `${start.reason ?? "coordinator start"} — returned home unproven: ${problem}`,
            start.project_id,
            start.op_id,
          );
        this.store.log(
          start.project_id,
          "coordinator",
          `The unconfirmed coordinator receipt ${row.id} cannot be proven to run on the default checkout: ${problem} The start stays unconfirmed with the receipt retained for inspection.`,
          { threadId: row.id },
        );
      }
      return null;
    }
    // Rebind at the write: the start must still be unconfirmed, the
    // candidate the same, and the primary the home was proven against
    // still current — a mid-await change never confirms stale facts.
    if (!project) return null;
    const outcome = this.store.confirmCoordinatorReceipt(
      start.project_id,
      start.op_id,
      row.id,
      project.memberProjectIds[0]!,
      start.reason ?? "coordinator start confirmed",
    );
    if (outcome !== "confirmed") return null;
    // A receipt confirmed late still owes its predecessor the same
    // converge the settle path performs; failures leave it live for
    // the next sweep rather than aborting this reconcile.
    await this.convergeFormerCoordinators(start.project_id, signal).catch(
      () => undefined,
    );
    return `Coordinator confirmed: ${row.id}`;
  }

  /**
   * Settle uncertain creates and sends only on evidence: a positive receipt in
   * BB (thread metadata or the op marker in its input, or the marker in prompt
   * history or the queue). Absence from a listing proves nothing, so an
   * unconfirmed operation stays uncertain and visible until someone settles it.
   */
  async reconcile(signal?: AbortSignal) {
    const settled: string[] = [];
    const coordinatorStarts = this.store.db
      .prepare(
        "SELECT project_id, op_id, reason, thread_id, created_at FROM coordinator_starts WHERE state IN ('pending', 'uncertain')",
      )
      .all() as PendingCoordinatorStart[];
    // A start that retained its native receipt is read directly, so its cost
    // never grows with the number of Initiatives threads. Only a receipt that
    // was never recorded (or no longer carries this op) needs the scan. An
    // archived or deleted receipt can never confirm: it drops out of the
    // sweep and the start waits for an explicit settle.
    const unlocated: PendingCoordinatorStart[] = [];
    for (const start of coordinatorStarts) {
      if (signal?.aborted) return settled;
      if (this.endedReceipts.has(start.op_id)) continue;
      const receipt = start.thread_id
        ? await this.retainedCoordinatorReceipt(start)
        : "unknown";
      if (signal?.aborted) return settled;
      if (receipt === "unknown") unlocated.push(start);
      else if (receipt === "ended") this.endedReceipts.add(start.op_id);
      else if (receipt) {
        const confirmed = await this.reconcileCoordinatorReceipt(start, receipt, signal);
        if (confirmed) settled.push(confirmed);
      }
    }
    const pendingThreads = this.store.pendingProjectThreads();
    if (unlocated.length || pendingThreads.length) {
      // Archived rows, and rows created before the oldest pending operation,
      // cannot be a receipt to confirm and skip the metadata read (the slack
      // absorbs clock skew between op record and spawn).
      const since =
        Math.min(
          ...unlocated.map((start) => start.created_at),
          ...pendingThreads.map((thread) => thread.createdAt),
        ) - 60_000;
      let remaining = unlocated.length + pendingThreads.length;
      await this.scanLiveReceipts("reconcile", since, signal, async (row) => {
        const metadata = await this.sdk.threads.getPluginMetadata({ threadId: row.id, pluginId: this.bb.pluginId });
        if (signal?.aborted) return false;
        const start = unlocated.find(
          (s) => s.op_id === metadata.op && s.project_id === metadata.projectId,
        );
        if (start) {
          remaining--;
          const confirmed = await this.reconcileCoordinatorReceipt(start, row, signal);
          if (confirmed) settled.push(confirmed);
          return remaining === 0;
        }
        const adhoc =
          metadata.role === "adhoc"
            ? pendingThreads.find(
                (t) => t.opId === metadata.op && t.projectId === metadata.projectId,
              )
            : undefined;
        if (!adhoc) return false;
        remaining--;
        if (this.store.confirmProjectThread(adhoc.opId, row.id)) {
          this.store.log(
            adhoc.projectId,
            "thread",
            `"${adhoc.label}" was confirmed after an uncertain create`,
            { threadId: row.id },
          );
          settled.push(`Thread confirmed: ${row.id}`);
        }
        return remaining === 0;
      });
      if (signal?.aborted) return settled;
    }
    const ops = this.store.assignmentsWithOpState(["pending", "uncertain"]);
    // Ops settled by events or an explicit settle drop out of the sweep memory.
    const open = new Set(ops.map((assignment) => assignment.opId));
    for (const memory of [this.opRetries, this.parkedOps])
      for (const opId of memory.keys()) if (!open.has(opId)) memory.delete(opId);
    for (const assignment of ops) {
      if (signal?.aborted) return settled;
      if (
        this.parkedOps.has(assignment.opId) ||
        (this.opRetries.get(assignment.opId)?.nextAt ?? 0) > this.now()
      )
        continue;
      try {
        if (assignment.route === "continue") {
          const threadId = assignment.threadId!;
            const history = promptTexts(
            await this.sdk.threads.promptHistory({ threadId, limit: "50" }),
          );
          const queued = await this.sdk.threads.queuedMessages.list({
            threadId,
          });
          if (signal?.aborted) return settled;
          // The awaits above took real time: a dispatch confirmation, cancel
          // or report may have landed meanwhile. A stale queue or history
          // snapshot must never downgrade state or reattach a receipt, so the
          // only writes below happen when the record is still in this shape.
          const fresh = this.store.assignment(
            assignment.projectId,
            assignment.num,
          );
          if (
            !fresh ||
            fresh.opState !== assignment.opState ||
            fresh.state !== assignment.state ||
            fresh.threadId !== assignment.threadId ||
            fresh.queuedMessageId !== assignment.queuedMessageId ||
            fresh.briefDelivered !== assignment.briefDelivered ||
            fresh.cancelRequested !== assignment.cancelRequested ||
            // A newer report on an already-reported or cancelled assignment
            // changes the record without flipping null: compare content.
            JSON.stringify(fresh.report) !== JSON.stringify(assignment.report)
          )
            continue;
          const cancelled =
            fresh.state === "cancelled" || fresh.cancelRequested;
          const queuedRow = queued.find((row) =>
            JSON.stringify(row.content).includes(opMarker(assignment.opId)),
          );
          if (queuedRow) {
            if (cancelled) {
              // A cancelled send surfaced in the queue: delete it, but keep the
              // op uncertain until a later sweep proves nothing dispatched in
              // the race before the delete.
              try {
                await this.sdk.threads.queuedMessages.delete({
                  threadId,
                  queuedMessageId: queuedRow.id,
                });
                this.store.updateAssignment(
                  assignment.projectId,
                  assignment.num,
                  { queuedMessageId: null },
                );
                this.store.log(
                  assignment.projectId,
                  "delegate",
                  `Deleted ${assignment.ref}'s cancelled brief from the native queue; the reservation holds until a clean sweep or an explicit settle.`,
                );
              } catch (error) {
                this.store.log(
                  assignment.projectId,
                  "delegate",
                  `Could not delete ${assignment.ref}'s cancelled queued brief (${errorMessage(error)}); its reservation stays held.`,
                );
              }
            } else
              this.store.confirmAssignmentDelivery(
                fresh.projectId,
                fresh.num,
                queuedRow.id,
              );
          } else if (history.some((text) => text.includes(opMarker(assignment.opId)))) {
            if (cancelled) {
              // The cancelled brief provably dispatched: delivery is
              // confirmed, but the turn may still be executing. The op stays
              // outstanding and the reservation until that turn is observed
              // settled — never a reopened business state.
              this.store.updateAssignment(fresh.projectId, fresh.num, {
                queuedMessageId: null,
                briefDelivered: true,
              });
              if (!fresh.briefDelivered)
                this.store.log(
                  assignment.projectId,
                  "delegate",
                  `${assignment.ref}'s brief was accepted despite its cancellation; delivery alone does not prove execution, and the reservation holds until native settlement. Any late report stays evidence on the cancelled assignment.`,
                );
              await this.settleCancelledIfQuiet(
                this.store.assignment(assignment.projectId, assignment.num)!,
              );
            } else
              this.store.confirmAssignmentDelivery(
                fresh.projectId,
                fresh.num,
              );
          } else if (cancelled)
            // Absent from both bounded snapshots is not proof the send
            // never ran — the brief may have dispatched between them, and
            // recorded delivery/report evidence never regresses. The
            // reservation releases only on positive native quiescence.
            await this.settleCancelledIfQuiet(fresh);
        } else {
          const found = await this.findCreatedThread(assignment, signal);
          if (signal?.aborted) return settled;
          if (found)
            await this.confirmCreated(
              assignment.projectId,
              assignment.num,
              found,
            );
        }
        const after = this.store.assignment(
          assignment.projectId,
          assignment.num,
        )!;
        if (after.opState === "done") {
          settled.push(`${after.ref}: ${after.state}`);
          this.store.log(
            after.projectId,
            "delegate",
            `${after.ref} was confirmed after an uncertain dispatch (${after.state}).`,
          );
        } else if (this.now() - after.createdAt > RECONCILE_GRACE_MS) {
          if (after.opState !== "uncertain") {
            this.store.updateAssignment(after.projectId, after.num, {
              opState: "uncertain",
            });
            this.store.log(
              after.projectId,
              "delegate",
              `${after.ref} for ${workerRef(after.workerNum)} is still unconfirmed: BB neither accepted nor refused it. Do not delegate it again; inspect the threads, then settle it with initiative_task action "assignment-settle".`,
            );
          }
          await this.parkIfEnded(after);
        }
        this.opRetries.delete(assignment.opId);
      } catch (error) {
        if (signal?.aborted) return settled;
        if (!(await this.parkIfEnded(assignment)))
          this.retryOp(assignment, errorMessage(error));
      }
    }
    // A queued brief leaves the ledger's "queued" state when BB dispatches it.
    // The message.dispatched event is the primary signal; this is the fallback
    // after a restart that missed it. A cancelled assignment keeps its receipt
    // in this list: the native row is deleted under cancel intent, and the op
    // stays uncertain until a sweep sees the row positively gone with no
    // matching prompt in the thread's history.
    for (const assignment of this.store.assignmentsWithQueued()) {
      if (signal?.aborted) return settled;
      try {
        const queue = await this.sdk.threads.queuedMessages.list({
          threadId: assignment.threadId!,
        });
        if (signal?.aborted) return settled;
        const row = queue.find((r) => r.id === assignment.queuedMessageId);
        // The queue await took real time: a newer state, receipt or delivery
        // confirmation may have landed. A stale snapshot applies nothing.
        let current = this.store.assignment(
          assignment.projectId,
          assignment.num,
        );
        if (
          !current ||
          current.queuedMessageId !== assignment.queuedMessageId ||
          current.state !== assignment.state ||
          current.threadId !== assignment.threadId ||
          current.briefDelivered !== assignment.briefDelivered ||
          current.opState !== assignment.opState ||
          current.cancelRequested !== assignment.cancelRequested
        )
          continue;
        let cancelled =
          current.state === "cancelled" || current.cancelRequested;
        if (row) {
          // A runnable row still exists. For a live pending turn it is real
          // work; for a cancelled or already-reported assignment it is a
          // duplicate turn that must not dispatch.
          if (!cancelled && current.state !== "reported") continue;
          try {
            await this.sdk.threads.queuedMessages.delete({
              threadId: assignment.threadId!,
              queuedMessageId: row.id,
            });
          } catch (error) {
            // Keep the receipt: BB may still dispatch the row, and the tasks
            // stay reserved until a delete actually lands.
            this.store.log(
              assignment.projectId,
              "delegate",
              `Could not delete ${assignment.ref}'s queued brief (${errorMessage(error)}); its receipt and tasks stay reserved.`,
            );
            continue;
          }
          // The delete await took real time: re-read so a concurrent
          // dispatch, report or settle still wins over this receipt write.
          const afterDelete = this.store.assignment(
            assignment.projectId,
            assignment.num,
          );
          if (!afterDelete) continue;
          if (afterDelete.queuedMessageId === row.id)
            this.store.updateAssignment(assignment.projectId, assignment.num, {
              queuedMessageId: null,
            });
          cancelled =
            afterDelete.state === "cancelled" || afterDelete.cancelRequested;
          // For a reported assignment, removing the duplicate-turn row was
          // the whole job; its delivery is already proven.
          if (!cancelled || signal?.aborted) continue;
          current = afterDelete;
        }
        const history = promptTexts(
          await this.sdk.threads.promptHistory({
            threadId: assignment.threadId!,
            limit: "20",
          }),
        );
        if (signal?.aborted) return settled;
        // The history await took real time: a delayed dispatch event,
        // report or settle may have landed meanwhile. Re-read so the
        // limited page below never overrides newer evidence — a dispatch
        // between the queue snapshot and this read still counts.
        const again = this.store.assignment(
          assignment.projectId,
          assignment.num,
        );
        if (
          !again ||
          again.queuedMessageId !== current.queuedMessageId ||
          again.state !== current.state ||
          again.threadId !== current.threadId ||
          again.briefDelivered !== current.briefDelivered ||
          again.opState !== current.opState ||
          again.cancelRequested !== current.cancelRequested
        )
          continue;
        const ran = history.some((text) => text.includes(opMarker(assignment.opId)));
        if (cancelled) {
          if (ran) {
            // The cancelled brief provably dispatched: delivery is confirmed,
            // but the turn may still execute. The op stays outstanding and
            // the reservation until that turn is observed settled.
            this.store.updateAssignment(
              assignment.projectId,
              assignment.num,
              { queuedMessageId: null, briefDelivered: true },
            );
            if (!again.briefDelivered)
              this.store.log(
                assignment.projectId,
                "delegate",
                `${assignment.ref}'s brief was accepted despite its cancellation; delivery alone does not prove execution, and the reservation holds until native settlement. Any late report stays evidence on the cancelled assignment.`,
              );
            if (
              await this.settleCancelledIfQuiet(
                this.store.assignment(assignment.projectId, assignment.num)!,
              )
            )
              settled.push(`${assignment.ref}: cancelled brief dispatched`);
          } else if (
            // No queue row and no matching prompt in a bounded page is not
            // positive absence — the send may have raced the snapshots. The
            // reservation releases only on positive native quiescence.
            await this.settleCancelledIfQuiet(again)
          )
            settled.push(`${assignment.ref}: cancelled brief confirmed gone`);
          continue;
        }
        if (again.state === "queued" && ran)
          this.store.updateAssignment(assignment.projectId, assignment.num, {
            state: "running",
            queuedMessageId: null,
            briefDelivered: true,
          });
        else if (!row)
          // The receipt's row is gone and the turn already runs or ended:
          // the receipt is stale, so clear it and stop rechecking.
          this.store.updateAssignment(assignment.projectId, assignment.num, {
            queuedMessageId: null,
          });
      } catch (error) {
        this.store.log(
          assignment.projectId,
          "delegate",
          `Could not recheck the queued brief for ${assignment.ref}: ${errorMessage(error)}`,
        );
      }
    }
    return settled;
  }

  /**
   * Explicitly settle an uncertain operation after looking: either name the
   * thread that was created, or record that nothing started.
   */
  async settleUncertain(
    projectId: string,
    ref: string,
    outcome: { threadId: string } | { notSent: true },
  ) {
    const project = this.requireProject(projectId);
    const assignment = this.requireAssignment(project, ref);
    if (assignment.opState !== "uncertain" && assignment.opState !== "pending")
      throw new ProjectError(`${assignment.ref} is not uncertain.`);
    if ("threadId" in outcome) {
      if (assignment.route === "continue") {
        if (outcome.threadId !== assignment.threadId)
          throw new ProjectError(
            `${assignment.ref} was sent to ${assignment.threadId}.`,
          );
        if (assignment.state === "cancelled" || assignment.cancelRequested)
          // Delivery is confirmed, but the turn it started may still run:
          // the op stays outstanding and the reservation until it settles.
          this.store.updateAssignment(project.id, assignment.num, {
            briefDelivered: true,
            queuedMessageId: null,
          });
        else
          this.store.confirmAssignmentDelivery(project.id, assignment.num);
      } else
        await this.confirmCreated(
          project.id,
          assignment.num,
          await this.sdk.threads.get({ threadId: outcome.threadId }),
        );
    } else {
      const latest = this.store.assignment(project.id, assignment.num);
      if (latest?.report)
        throw new ProjectError(
          "A report proves execution. Confirm its receipt instead of settling it as never sent.",
        );
      // Recorded native delivery contradicts "never sent": a dispatch
      // confirmation, or a live queue receipt that may still dispatch. The
      // cancelled op settles by its native outcome instead.
      if (latest && (latest.briefDelivered || latest.queuedMessageId !== null))
        throw new ProjectError(
          `${assignment.ref}'s brief is recorded as delivered to BB${latest.queuedMessageId ? ` (queue receipt ${latest.queuedMessageId} is still live)` : ""}, so it cannot be settled as never sent. ${unsettledReason(latest)}`,
        );
      if (assignment.state === "cancelled") {
        // The cancelled send provably never landed: settle the operation and
        // release the reservation without touching the cancelled business state.
        const staged = assignment.pendingIdentity;
        this.store.tx(() => {
          this.store.updateAssignment(project.id, assignment.num, {
            opState: "failed",
            queuedMessageId: null,
            pendingIdentity: null,
          });
          this.releaseCancelledTasks(project.id, assignment, "never");
          this.store.log(
            project.id,
            "delegate",
            `${assignment.ref}'s cancelled send was settled as never delivered; its tasks are released.`,
          );
        });
        if (staged) await this.syncWorkerTitle(project.id, assignment.workerNum);
      } else {
        this.releaseCancelledTasks(project.id, assignment, "never");
        await this.failDispatch(
          project.id,
          assignment.num,
          "settled as never started",
        );
      }
    }
    return this.store.assignment(project.id, assignment.num)!;
  }

  /**
   * Release the tasks a cancelled assignment still holds in "blocked" state
   * once native evidence proves nothing can still execute for it: either the
   * queued brief never ran, or the dispatched turn has positively ended. Only
   * the rows this stop blocked move; the cancelled business state stays.
   */
  releaseCancelledTasks(
    projectId: string,
    assignment: AssignmentRecord,
    outcome: "never" | "settled",
  ) {
    for (const num of assignment.taskNums) {
      const task = this.store.task(projectId, num);
      if (task?.status !== "blocked" || !task.progress?.includes(assignment.ref))
        continue;
      this.store.updateTask(
        projectId,
        num,
        outcome === "settled"
          ? {
              status: "planned",
              progress: assignment.report
                ? `${assignment.ref}'s report proves work ran; its native side is now quiet or gone and the reservation is released. The cancelled state and report stay evidence.`
                : `${assignment.ref}'s native side is now quiet or gone; the reservation is released. ${assignment.briefDelivered ? "BB accepted its brief, but execution is not established by that receipt." : "Execution is not established; quiet settlement does not prove the brief was never delivered."}`,
            }
          : {
              status: "planned",
              progress: `${assignment.ref}'s brief was confirmed not delivered for execution; the reservation is released.`,
            },
      );
    }
  }

  /**
   * A cancelled assignment whose queued brief provably dispatched keeps its
   * reservation until the native turn that ran it ends: opState stays
   * "uncertain" and the tasks stay blocked. Call this when that turn is
   * observed finished — idle, failed, archived, deleted, or reported — so
   * the op settles and the reservation releases. The event's fresh native
   * snapshot must show no runnable queued or background work: a foreground
   * idle alone is not quiescence.
   */
  async settleCancelledExecutions(thread: ThreadDto) {
    if (ProjectsService.threadRunnable(thread)) return;
    const candidates = this.store
      .assignmentsWithOpState(["uncertain"])
      .filter(
        (assignment) =>
          assignment.threadId === thread.id &&
          assignment.state === "cancelled" &&
          assignment.briefDelivered &&
          assignment.queuedMessageId === null,
      );
    if (!candidates.length) return;
    // The event DTO predates this await and omits native commands/workflows;
    // the list row carries the fresher foreground status plus the complete
    // activity counters. One row verdict — the same the report and reconcile
    // paths compute — governs every candidate here. The row comes from the
    // thread's own project listing, as for every other end check (A207 R1).
    const verdict = ProjectsService.rowQuiescence(
      (await this.projectListRows(thread.projectId, new Set([thread.id]))).get(thread.id) ?? null,
    );
    if (verdict !== "ended") return;
    for (const candidate of candidates)
      await this.settleCancelledIfQuiet(candidate, "ended");
  }

  /**
   * Whether this native thread can still execute work: a busy or pending
   * foreground turn, runnable queued messages, or a native background
   * agent. Foreground idle alone is not quiescence. Archived/deleted
   * threads are quiet — their queue dies with them.
   */
  private static threadRunnable(thread: ThreadDto): boolean {
    if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
    return (
      BUSY_STATUSES.has(thread.status) ||
      thread.status === "pending" ||
      thread.queuedMessageCount > 0 ||
      thread.activeBackgroundAgentCount > 0
    );
  }

  /**
   * Positive native evidence about a thread's ability to still execute.
   * "ended" requires a positively quiet or positively missing thread (a
   * 404 is confirmation; any other lookup failure stays "unknown").
   * Bounded history/queue snapshots are deliberately not consulted here:
   * their absence of a marker never proves an operation's outcome.
   *
   * The GET DTO carries the foreground status, queued-message count and
   * background agents only — a foreground idle with zero agents can still
   * have native background commands or workflows running. Only the list DTO
   * exposes those counts, so a quiet verdict requires that fresher row too;
   * an unreadable or absent row is "unknown", never quiescence.
   */
  private async executionEvidence(
    threadId: string,
  ): Promise<"ended" | "running" | "unknown"> {
    return (await this.nativeEnd(threadId)).verdict;
  }

  /**
   * An unconfirmed op stays visible and is retried next sweep. The same
   * refusal again is not news: it is logged once and backs the op off; a
   * changed refusal logs again and retries on the next sweep.
   */
  private retryOp(assignment: AssignmentRecord, reason: string) {
    const previous = this.opRetries.get(assignment.opId);
    const repeat = previous?.reason === reason;
    const attempts = repeat ? previous.attempts + 1 : 1;
    this.opRetries.set(assignment.opId, {
      reason,
      attempts,
      nextAt:
        attempts === 1
          ? 0
          : this.now() +
            Math.min(FORMER_RETRY_BASE_MS * 2 ** (attempts - 2), FORMER_RETRY_MAX_MS),
    });
    if (!repeat)
      this.store.log(
        assignment.projectId,
        "delegate",
        `Could not reconcile ${assignment.ref} yet: ${reason}`,
      );
  }

  /**
   * A continuation sent to a thread that is now positively archived, deleted
   * or gone has nothing left to observe: the sweep stops re-reading it. The op
   * keeps its state for an explicit settle, and an unarchive makes it read
   * again. Unreadable lifecycle evidence keeps it in the sweep.
   */
  private async parkIfEnded(assignment: AssignmentRecord) {
    const threadId = assignment.threadId;
    if (assignment.route !== "continue" || !threadId) return false;
    const seen = this.unarchives.get(threadId) ?? 0;
    const overtaken = () => (this.unarchives.get(threadId) ?? 0) !== seen;
    let live: ThreadDto;
    try {
      live = await this.sdk.threads.get({ threadId });
    } catch (error) {
      if ((error as { status?: number }).status !== 404 || overtaken()) return false;
      this.parkedOps.set(assignment.opId, threadId);
      return true;
    }
    if (
      overtaken() ||
      !live ||
      !ProjectsService.lifecycleWellFormed(live.archivedAt) ||
      !ProjectsService.lifecycleWellFormed(live.deletedAt) ||
      (live.archivedAt === null && live.deletedAt === null)
    )
      return false;
    this.parkedOps.set(assignment.opId, threadId);
    return true;
  }

  /** An unarchived thread can receive its queued continuation again: read its ops next sweep. */
  threadUnarchived(threadId: string) {
    this.unarchives.set(threadId, (this.unarchives.get(threadId) ?? 0) + 1);
    for (const [opId, parked] of this.parkedOps)
      if (parked === threadId) this.parkedOps.delete(opId);
  }

  /**
   * The same verdict, plus what positively ended it. The quiet check reads the
   * thread's own row from its project listing (bounded, filter verified on the
   * installed server; A205 F2), never a truncated global scan.
   */
  private async nativeEnd(
    threadId: string,
  ): Promise<{ verdict: "ended" | "running" | "unknown"; seen: string }> {
    let live: ThreadDto;
    try {
      live = await this.sdk.threads.get({ threadId });
    } catch (error) {
      return (error as { status?: number }).status === 404
        ? { verdict: "ended", seen: "missing (404)" }
        : { verdict: "unknown", seen: "unreadable" };
    }
    // GET returns parsed JSON with no runtime DTO validation: an absent or
    // malformed lifecycle field is not positive end evidence — an omitted
    // archivedAt reads `undefined !== null` and would fake a confirmed end.
    if (
      !live ||
      !ProjectsService.lifecycleWellFormed(live.archivedAt) ||
      !ProjectsService.lifecycleWellFormed(live.deletedAt)
    )
      return { verdict: "unknown", seen: "unreadable" };
    if (live.deletedAt !== null) return { verdict: "ended", seen: "deleted" };
    if (live.archivedAt !== null) return { verdict: "ended", seen: "archived" };
    if (ProjectsService.threadRunnable(live)) return { verdict: "running", seen: "running" };
    const row = typeof live.projectId === "string" && live.projectId
      ? (await this.projectListRows(live.projectId, new Set([threadId]))).get(threadId)
      : undefined;
    const verdict = ProjectsService.rowQuiescence(row);
    return { verdict, seen: verdict === "ended" ? "quiet (idle, no background commands, workflows, agents or queued work)" : verdict === "running" ? "running" : "unreadable" };
  }

  /**
   * Native lifecycle timestamps are `number | null` on the wire. Anything
   * else — absent, NaN, a string — is unreadable evidence, never a positive
   * "archived/deleted" or "alive" verdict.
   */
  private static lifecycleWellFormed(value: unknown): boolean {
    return (
      value === null || (typeof value === "number" && Number.isFinite(value))
    );
  }

  /**
   * The single quiescence verdict for a thread's list row — the one DTO
   * carrying the fresher foreground status, the queue summary AND all native
   * background counters. "ended" requires either a positively gone row or a
   * fully valid quiet row; any missing, malformed or unreadable field stays
   * "unknown" — a partial activity object must never sum to quiet.
   */
  private static rowQuiescence(
    row: ThreadListRow | null | undefined,
  ): "ended" | "running" | "unknown" {
    return ProjectsService.rowEvidence(row).verdict;
  }

  /** The quiescence verdict plus what the row showed, in words a refusal can quote. */
  private static rowEvidence(
    row: ThreadListRow | null | undefined,
  ): { verdict: "ended" | "running" | "unknown"; seen: string } {
    const unknown = (seen: string) => ({ verdict: "unknown" as const, seen });
    if (!row) return unknown("its list row was not found");
    if (
      !ProjectsService.lifecycleWellFormed(row.archivedAt) ||
      !ProjectsService.lifecycleWellFormed(row.deletedAt)
    )
      return unknown("its lifecycle fields were unreadable");
    if (row.archivedAt !== null || row.deletedAt !== null)
      return { verdict: "ended", seen: row.deletedAt !== null ? "deleted" : "archived" };
    const status = row.status as string;
    if (
      !BUSY_STATUSES.has(status) &&
      !["pending", "idle", "error"].includes(status)
    )
      return unknown(`its status was unreadable (${String(status)})`);
    if (BUSY_STATUSES.has(status) || status === "pending")
      return { verdict: "running", seen: `turn ${status}` };
    const queuedWork = row.queuedWork as string;
    if (!["waiting", "failed", "none"].includes(queuedWork))
      return unknown("its queue state was unreadable");
    if (queuedWork !== "none")
      return {
        verdict: "running",
        seen: queuedWork === "waiting"
          ? "idle, with queued input waiting to start a turn"
          : "idle, with a queued message that failed to dispatch",
      };
    const activity = row.activity;
    if (!activity) return unknown("its background activity was missing");
    const counts = [
      activity.activeBackgroundAgentCount,
      activity.activeBackgroundCommandCount,
      activity.activeWorkflowCount,
    ];
    if (!counts.every((count) => Number.isFinite(count) && count >= 0))
      return unknown("its background counters were unreadable");
    const busy = [
      [counts[0], "background agent"],
      [counts[1], "background command"],
      [counts[2], "workflow"],
    ].filter(([count]) => (count as number) > 0)
      .map(([count, name]) => `${count} ${name}${count === 1 ? "" : "s"}`);
    return busy.length
      ? { verdict: "running", seen: `idle, with ${busy.join(", ")} active` }
      : { verdict: "ended", seen: "quiet" };
  }

  /**
   * T91: native evidence for hold candidates, read in one project-filtered list pass
   * (bounded pages and bytes, rows matched by id) plus a GET only for threads the pass
   * did not return, which can prove archived/deleted/404 but never quiet. A failed,
   * truncated or malformed read leaves a thread "unknown". Groups already held by
   * listed background work need no read.
   */
  private async holdEvidence(groups: HoldGroup[], rows: Map<string, ThreadListRow>) {
    const evidence = new Map<string, HoldEvidence>();
    const wanted = new Map(groups.filter(g => !g.background.length).map(g => [g.threadId, g.signature]));
    let gets = 0;
    for (const [threadId, signature] of wanted) {
      const row = rows.get(threadId);
      if (row) {
        evidence.set(threadId, { ...ProjectsService.rowEvidence(row), signature });
        continue;
      }
      if (gets++ >= HOLD_GET_CAP) {
        evidence.set(threadId, { verdict: "unknown", seen: "its list row was not found", signature });
        continue;
      }
      evidence.set(threadId, (await this.threadGone(threadId))
        ? { verdict: "ended", seen: "gone", signature }
        : { verdict: "unknown", seen: "its list row was not found", signature });
    }
    return evidence;
  }

  /** List rows of one BB project, matched by id; stops when all ids are found or the page/byte budget is spent. */
  private async projectListRows(bbProjectId: string, ids: Set<string>) {
    const rows = new Map<string, ThreadListRow>();
    let bytes = 0;
    try {
      for (let offset = 0; offset < LIST_SCAN_BUDGET && rows.size < ids.size && bytes < HOLD_LIST_BYTES; offset += LIST_PAGE) {
        const page = await this.sdk.threads.list({ projectId: bbProjectId, includeHidden: true, limit: LIST_PAGE, offset });
        bytes += JSON.stringify(page).length;
        for (const row of page) if (ids.has(row.id)) rows.set(row.id, row);
        if (page.length < LIST_PAGE) break;
      }
    } catch {
      // A failed page proves nothing; unmatched threads stay unknown.
    }
    return rows;
  }

  /**
   * Release a cancelled assignment's reservation only on positive evidence
   * that its native side can no longer execute — the thread is positively
   * gone, or quiet with no runnable queued message or background work. A
   * lookup failure or a still-runnable thread keeps the op uncertain and
   * the reservation held. Returns whether it settled.
   */
  private async settleCancelledIfQuiet(
    assignment: AssignmentRecord,
    evidence?: "ended" | "running" | "unknown",
  ): Promise<boolean> {
    if (!assignment.threadId || assignment.state === "accepted") return false;
    evidence ??= await this.executionEvidence(assignment.threadId);
    if (evidence === "running") return false;
    if (evidence === "unknown") {
      this.store.log(
        assignment.projectId,
        "assignment",
        `Could not confirm whether ${assignment.ref}'s thread can still execute; its reservation stays held until the native side is positively quiet or gone.`,
      );
      return false;
    }
    // The lookup took real time: a dispatch, report or settle may have
    // landed meanwhile. Newer evidence wins — only settle when the record
    // still has exactly this shape. A newer report on an already-reported
    // assignment changes content without flipping null, so reports compare
    // by value, not by presence.
    const current = this.store.assignment(
      assignment.projectId,
      assignment.num,
    );
    if (
      !current ||
      (current.state !== "cancelled" && !current.cancelRequested) ||
      current.state !== assignment.state ||
      current.cancelRequested !== assignment.cancelRequested ||
      current.opState !== assignment.opState ||
      current.threadId !== assignment.threadId ||
      current.queuedMessageId !== assignment.queuedMessageId ||
      current.briefDelivered !== assignment.briefDelivered ||
      JSON.stringify(current.report) !== JSON.stringify(assignment.report)
    )
      return false;
    const staged = current.pendingIdentity;
    this.store.tx(() => {
      this.store.updateAssignment(assignment.projectId, assignment.num, {
        opState: "done",
        queuedMessageId: null,
        // Drop any uncommitted rename. Quiet settlement does not establish
        // that a brief ran; confirmed delivery already committed its identity.
        pendingIdentity: null,
      });
      this.releaseCancelledTasks(
        assignment.projectId,
        current,
        "settled",
      );
      this.store.log(
        assignment.projectId,
        "assignment",
        `${assignment.ref}'s cancelled native side is positively quiet or gone; the task reservation is released.`,
      );
    });
    if (staged)
      await this.syncWorkerTitle(assignment.projectId, current.workerNum);
    return true;
  }

  private async findCreatedThread(
    assignment: AssignmentRecord,
    signal?: AbortSignal,
  ): Promise<ThreadDto | null> {
    let found: string | null = null;
    await this.scanLiveReceipts(
      `assignment:${assignment.opId}`,
      assignment.createdAt - 60_000,
      signal,
      async (row) => {
        const metadata = await this.sdk.threads.getPluginMetadata({ threadId: row.id, pluginId: this.bb.pluginId });
        if ((metadata as { op?: unknown }).op === assignment.opId) {
          found = row.id;
          return true;
        }
        if (signal?.aborted) return false;
        // The op marker is part of the thread's own first input, so it survives
        // even if the metadata seed did not.
        const history = promptTexts(
          await this.sdk.threads.promptHistory({
            threadId: row.id,
            limit: "5",
          }),
        );
        if (!history.some((text) => text.includes(opMarker(assignment.opId)))) return false;
        found = row.id;
        return true;
      },
    );
    return found ? this.sdk.threads.get({ threadId: found }) : null;
  }

  /**
   * Visit live threads this plugin created at or after `since`, a
   * bounded number of list pages per call. BB's listing order is not
   * creation order, so a receipt can sit anywhere: each call resumes where
   * the previous one for `key` stopped and wraps at the end, reaching every
   * row within a few sweeps. `visit` returning true ends the scan; an abort
   * stops before the next read and keeps the cursor on the unfinished page.
   */
  private async scanLiveReceipts(
    key: string,
    since: number,
    signal: AbortSignal | undefined,
    visit: (row: ThreadListRow) => Promise<boolean>,
  ) {
    // Only the current origin: no operation left unsettled at the rename,
    // so no open receipt can carry the former plugin ID.
    let offset = this.receiptCursors.get(key) ?? 0;
    for (let page = 0; page < RECEIPT_SCAN_PAGES; page++) {
      if (signal?.aborted) break;
      const rows = await this.sdk.threads.list({
        originPluginId: this.bb.pluginId,
        archived: false,
        includeHidden: true,
        limit: LIST_PAGE,
        offset,
      });
      for (const row of rows) {
        if (row.archivedAt !== null || row.createdAt < since) continue;
        if (signal?.aborted) break;
        if (await visit(row)) {
          this.receiptCursors.delete(key);
          return;
        }
      }
      if (signal?.aborted) break;
      offset = rows.length < LIST_PAGE ? 0 : offset + LIST_PAGE;
      if (offset === 0) break;
    }
    this.receiptCursors.set(key, offset);
  }

  // Worker lifecycle -------------------------------------------------------------

  /**
   * Persist and archive. Refuses while the worker runs, has open or
   * unconfirmed work, and never archives a thread with live native
   * descendants (archive cascades). Retiring is always this explicit call;
   * nothing infers it from idle threads or old assignments.
   */
  async retireWorker(projectId: string, ref: string, reason: string) {
    const project = this.requireProject(projectId);
    const worker = this.requireWorker(project, ref);
    if (worker.state === "retired") return worker;
    const unconfirmed = this.store
      .assignments(project.id)
      .filter(
        (a) =>
          a.workerNum === worker.num &&
          ["pending", "uncertain"].includes(a.opState),
      );
    if (unconfirmed.length)
      throw new ProjectError(
        `${worker.ref} cannot retire while an operation is unconfirmed. ${unconfirmed
          .slice(0, 3)
          .map(unsettledReason)
          .join(" ")}${unconfirmed.length > 3 ? ` ${unconfirmed.length - 3} more are listed in initiative_read {"view":"assignments"}.` : ""}`,
      );
    const open = this.store.openAssignment(project.id, worker.num);
    if (open)
      throw new ProjectError(
        `${worker.ref} still has ${open.ref} open (${open.state}). Wait for its report or stop it first.`,
      );
    if (worker.threadId) await this.retireThread(worker.threadId);
    return this.store.tx(() => {
      this.store.closeGeneration(
        project.id,
        worker.num,
        `retired: ${reason}`,
      );
      const updated = this.store.updateWorker(project.id, worker.num, {
        state: "retired",
        retention: null,
      });
      this.store.log(
        project.id,
        "worker",
        `${worker.ref} retired: ${reason}`,
      );
      return updated;
    });
  }

  /** Archive and release one thread, after proving nothing under it is still working. */
  private async retireThread(threadId: string) {
    const thread = await this.sdk.threads.get({ threadId });
    // Native archive and Stop are destructive: the root DTO must positively
    // prove the thread is quiet or already gone before either runs. A
    // lifecycle field that is merely well-formed-but-null is not proof of an
    // archive, and an absent or malformed field is not proof of anything —
    // unknown evidence can never authorize a native mutation.
    if (
      !thread ||
      !ProjectsService.lifecycleWellFormed(thread.archivedAt) ||
      !ProjectsService.lifecycleWellFormed(thread.deletedAt) ||
      !(
        typeof thread.status === "string" &&
        (BUSY_STATUSES.has(thread.status) ||
          thread.status === "pending" ||
          thread.status === "idle" ||
          thread.status === "error")
      ) ||
      !(
        Number.isFinite(thread.activeBackgroundAgentCount) &&
        thread.activeBackgroundAgentCount >= 0
      ) ||
      !(
        Number.isFinite(thread.queuedMessageCount) &&
        thread.queuedMessageCount >= 0
      )
    )
      throw new ProjectError(
        "its native thread returned unreadable execution evidence; refusing to archive it",
      );
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    if (BUSY_STATUSES.has(thread.status) || thread.status === "pending")
      throw new ProjectError("its thread is still running");
    if (thread.activeBackgroundAgentCount > 0)
      throw new ProjectError(
        "its thread still has native background agents running",
      );
    if (thread.queuedMessageCount > 0)
      throw new ProjectError(
        "its thread has queued messages that would start more work",
      );
    // The GET DTO has no background command or workflow counters; only the thread's
    // own list row proves it quiet before anything destructive is called (T91).
    const row = (await this.projectListRows(thread.projectId, new Set([threadId]))).get(threadId);
    const quiet = ProjectsService.rowQuiescence(row);
    if (quiet === "running")
      throw new ProjectError(
        "its thread still has native background commands, workflows, agents or queued work running",
      );
    if (quiet === "unknown")
      throw new ProjectError(
        "its thread could not be proven quiet: BB's list row for it was missing or unreadable",
      );
    const blockers = await this.liveDescendants(threadId);
    if (blockers.length)
      throw new ProjectError(
        `archiving cascades to its native descendants, and ${blockers.slice(0, 3).join("; ")}${blockers.length > 3 ? `; and ${blockers.length - 3} more` : ""}`,
      );
    await this.sdk.threads.archive({ threadId });
    await this.sdk.threads.stop({ threadId }).catch(() => undefined);
  }

  /**
   * Walk every native descendant (archived ones too, since a restored
   * grandchild can sit under an archived child) and describe anything that
   * archiving would cut off. Refuses conservatively past a node budget.
   */
  async liveDescendants(
    rootId: string,
    budget = DESCENDANT_BUDGET,
  ): Promise<string[]> {
    const blockers: string[] = [];
    const pending = [rootId];
    const seen = new Set<string>([rootId]);
    let visited = 0;
    while (pending.length) {
      const parentThreadId = pending.shift()!;
      for (const archived of [false, true]) {
        for (let offset = 0; ; offset += DESCENDANT_PAGE) {
          const page = await this.sdk.threads.list({
            parentThreadId,
            archived,
            includeHidden: true,
            limit: DESCENDANT_PAGE,
            offset,
          });
          for (const child of page) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            if (++visited > budget)
              return [
                `it has more than ${budget} descendant threads, too many to verify safely`,
              ];
            pending.push(child.id);
            const name = child.title ?? child.titleFallback ?? child.id;
            if (
              !ProjectsService.lifecycleWellFormed(child.archivedAt) ||
              !ProjectsService.lifecycleWellFormed(child.deletedAt)
            ) {
              blockers.push(`"${name}" returned unreadable lifecycle fields`);
              continue;
            }
            if (child.archivedAt !== null || child.deletedAt !== null) continue;
            const activity = child.activity;
            if (BUSY_STATUSES.has(child.status) || child.status === "pending")
              blockers.push(`"${name}" is ${child.status}`);
            else if (
              activity.activeBackgroundAgentCount +
                activity.activeBackgroundCommandCount +
                activity.activeWorkflowCount >
              0
            )
              blockers.push(`"${name}" has background work running`);
            else if (child.queuedWork === "waiting")
              blockers.push(`"${name}" has queued work waiting`);
            else if (child.hasPendingInteraction)
              blockers.push(`"${name}" is waiting for input`);
          }
          if (page.length < DESCENDANT_PAGE) break;
        }
      }
    }
    return blockers;
  }

  /**
   * Cancel an assignment and stop its thread. The business state becomes
   * terminal immediately, but the native side settles only on positive
   * evidence: a queued brief with a receipt is deleted directly, a failed or
   * lost delete keeps the receipt (BB may still run that row), and a send
   * whose response was lost has no receipt to target at all — reconcile finds
   * it by marker. While either is unresolved the assignment's tasks stay
   * reserved; nothing here is retried, resent or revived on its own.
   */
  async stopAssignment(projectId: string, ref: string, reason: string) {
    const project = this.requireProject(projectId);
    let assignment = this.requireAssignment(project, ref);
    if (assignment.state === "reported")
      throw new ProjectError(
        `${assignment.ref} is reported (${assignment.report?.outcome}); Stop applies only to running work. ${reportedRetryHint(assignment, assignment.taskNums.map((n) => `T${n}`).join(", "))}`,
      );
    if (
      !["dispatching", "queued", "running", "idle_no_report"].includes(
        assignment.state,
      )
    )
      throw new ProjectError(`${assignment.ref} is ${assignment.state}.`);
    const confirmedBeforeStop = assignment.opState === "done" &&
      assignment.threadId !== null && assignment.briefDelivered;
    assignment = this.store.updateAssignment(project.id, assignment.num, {
      cancelRequested: true,
    });
    // The send never got a response: a runnable queue row may exist without
    // a receipt, so this cannot be settled by id at all.
    let unsettled = ["pending", "uncertain"].includes(assignment.opState);
    // A delivered brief or a live thread also reads done, but threads.stop()
    // acknowledges only the request — BB's route can report ok while the
    // host still executes. Delivered work becomes uncertain BEFORE the Stop
    // request goes out; only the common positive-end evidence releases it.
    if (
      assignment.threadId &&
      (assignment.briefDelivered ||
        ["running", "idle_no_report"].includes(assignment.state))
    )
      unsettled = true;
    if (assignment.queuedMessageId && assignment.threadId) {
      try {
        await this.sdk.threads.queuedMessages.delete({
          threadId: assignment.threadId,
          queuedMessageId: assignment.queuedMessageId,
        });
        assignment = this.store.updateAssignment(project.id, assignment.num, {
          queuedMessageId: null,
        });
      } catch (error) {
        // Keep the receipt and mark the delivery op uncertain; reconcile
        // retries the delete and the tasks stay reserved until it lands. A
        // 404 is not positive absence either: the row is gone, but it may
        // have already dispatched rather than been deleted — a sweep must
        // check prompt history before the reservation can release.
        unsettled = true;
        assignment = this.store.updateAssignment(project.id, assignment.num, {
          opState: "uncertain",
        });
        this.store.log(
          project.id,
          "assignment",
          (error as { status?: number }).status === 404
            ? `${assignment.ref}'s queued brief was already gone from the native queue; it may have dispatched, so its receipt and tasks stay reserved until a sweep proves the outcome.`
            : `Could not delete ${assignment.ref}'s queued brief (${errorMessage(error)}); its receipt and tasks stay reserved until the native row is positively settled.`,
        );
      }
    }
    if (unsettled)
      assignment = this.store.updateAssignment(project.id, assignment.num, {
        opState: "uncertain",
      });
    if (
      assignment.threadId &&
      ["running", "dispatching"].includes(assignment.state)
    )
      // Best-effort: a Stop refusal or host failure is about the request,
      // never about execution still running — the cancellation and its
      // reservation stand either way.
      await this.sdk.threads
        .stop({ threadId: assignment.threadId })
        .catch((error) => {
          if ((error as { status?: number }).status === 404) return;
          this.store.log(
            project.id,
            "assignment",
            `Stop request for ${assignment.ref}'s thread failed (${errorMessage(error)}); the reservation holds until positive native end evidence.`,
          );
        });
    const stopped = this.store.tx(() => {
      const latest = this.store.assignment(project.id, assignment.num)!;
      if (latest.state === "accepted") return latest;
      const updated = this.store.updateAssignment(project.id, assignment.num, {
        state: "cancelled",
        stopReason: `Stopped: ${reason}`,
      });
      for (const num of assignment.taskNums) {
        const task = this.store.task(project.id, num);
        if (task && task.status === "in_progress")
          this.store.updateTask(project.id, num, {
            status: unsettled ? "blocked" : "planned",
            progress: unsettled
              ? `Stopped (${assignment.ref}) before its native side was positively settled; the reservation holds until reconcile or an explicit settle.`
              : `Stopped (${assignment.ref}): ${reason}`,
          });
      }
      this.store.log(
        project.id,
        "assignment",
        `${assignment.ref} stopped: ${reason}`,
      );
      return updated;
    });
    if (confirmedBeforeStop && stopped.state === "cancelled")
      await this.settleCancelledIfQuiet(stopped);
    return this.store.assignment(project.id, assignment.num)!;
  }

  private async assertAdoptionRole(
    thread: ThreadDto,
    role: Role | "coordinator",
  ) {
    const seen = new Set<string>();
    let current = thread;
    while (true) {
      if (seen.has(current.id) || seen.size >= 100)
        throw new ProjectError(
          "Cannot establish this thread's role lineage safely.",
        );
      seen.add(current.id);
      const historic = this.store.membership(current.id, true);
      if (historic?.worker && historic.worker.role !== role)
        throw new ProjectError(
          `This context descends from ${historic.worker.role} worker ${historic.worker.ref}. Its role is immutable, including after Initiative archival.`,
        );
      if (!current.sourceThreadId) return;
      current = await this.sdk.threads.get({
        threadId: current.sourceThreadId,
      });
    }
  }

  async adoptWorker(
    projectId: string,
    input: {
      threadId: string;
      role: Role;
      label: string;
      area?: string;
      tasks?: string[];
      detachNativeParent?: boolean;
    },
  ) {
    const project = this.requireProject(projectId);
    if (input.role === "review")
      throw new ProjectError(
        "Reviewers are always fresh threads spawned by delegation; an existing context cannot be adopted as a reviewer.",
      );
    const thread = await this.sdk.threads.get({ threadId: input.threadId });
    await this.assertAdoptionRole(thread, input.role);
    const existing = this.store.membership(thread.id, true);
    // A lightweight adhoc claim on this project upgrades to the explicit
    // membership; every other existing membership still wins.
    if (
      existing &&
      (existing.kind !== "adhoc" || existing.project.id !== project.id)
    )
      throw new ProjectError(
        `That thread already belongs to ${existing.project.name}.`,
      );
    if (!project.memberProjectIds.includes(thread.projectId))
      throw new ProjectError(
        `The thread's BB project (${thread.projectId}) is not a member of ${project.name}.`,
      );
    const tasks = (input.tasks ?? []).map((ref) =>
      this.requireTask(project, ref),
    );
    let nativeParent =
      thread.parentThreadId !== null &&
      thread.parentThreadId === project.coordinatorThreadId;
    if (nativeParent && input.detachNativeParent) {
      this.parentOpBegin(projectId, thread.parentThreadId);
      try {
        await this.sdk.threads.update({
          threadId: thread.id,
          parentThreadId: null,
        });
      } finally {
        this.parentOpEnd(projectId, thread.parentThreadId);
      }
      nativeParent = false;
    }
    const execution = await threadExecution(this.sdk, thread.id);
    const opId = newOpId();
    const result = this.store.tx(() => {
      // The attach/detach await took real time: the flag is evidence only
      // while it names the coordinator current at write time.
      const currentCoordinator =
        this.store.project(projectId)?.coordinatorThreadId ?? null;
      const attached =
        nativeParent && thread.parentThreadId === currentCoordinator;
      const worker = this.store.createWorker({
        projectId,
        role: input.role,
        label: input.label,
        area: input.area ?? thread.projectId,
        bbProjectId: thread.projectId,
        nativeParent: attached,
      });
      this.store.updateWorker(projectId, worker.num, {
        threadId: thread.id,
        generation: 1,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        model: execution?.model ?? null,
        reasoningLevel: execution?.reasoningLevel ?? null,
        state: BUSY_STATUSES.has(thread.status) ? "active" : "idle",
      });
      this.store.openGeneration(projectId, worker.num, 1, thread.id);
      let assignment: AssignmentRecord | null = null;
      if (tasks.length) {
        assignment = this.store.createAssignment({
          projectId,
          workerNum: worker.num,
          taskNums: tasks.map((task) => task.num),
          route: "continue",
          role: input.role,
          workKind: input.role === "work" ? tasks[0]!.workKind : null,
          threadId: thread.id,
          generation: 1,
          profile: {
            providerId: thread.providerId,
            model: execution?.model ?? "unknown",
            reasoningLevel: execution?.reasoningLevel ?? "high",
            ...(execution?.serviceTier ? { serviceTier: execution.serviceTier } : {}),
          },
          bbProjectId: thread.projectId,
          environmentId: thread.environmentId,
          state: BUSY_STATUSES.has(thread.status)
            ? "running"
            : "idle_no_report",
          opId,
          opState: "done",
          briefText: "(adopted existing thread)",
          reviewOf: null,
          rationale: "Adopted an existing thread",
        });
        for (const task of tasks)
          this.store.updateTask(projectId, task.num, {
            status: "in_progress",
            progress: `Adopted ${worker.ref}`,
          });
      }
      this.store.log(
        projectId,
        "worker",
        `Adopted ${thread.title ?? thread.id} as ${worker.ref}${attached ? " (keeps native notices to the coordinator)" : ""}`,
      );
      return { worker: this.store.worker(projectId, worker.num)!, assignment };
    });
    // A logical worker's home is the coordinator thread: attach the adopted
    // thread natively unless the caller asked to keep it detached, so a later
    // coordinator switch finds it where membership says it lives.
    if (!nativeParent && !input.detachNativeParent)
      await this.ensureCoordinatorParent(projectId, thread);
    await this.tagThread(thread.id, {
      role: "worker",
      projectId,
      worker: result.worker.num,
      assignment: result.assignment?.num ?? null,
    });
    return { ...result, note: await this.reloadToolsIfIdle(thread) };
  }

  // Worker reports ----------------------------------------------------------

  /**
   * Record a worker's outcome. The report is the canonical record; the
   * coordinator hears about it through the worker's native parent notice
   * when one exists, else through one best-effort direct message — never
   * through a plugin inbox. A failed or lost notify never loses the report.
   */
  async report(threadId: string, input: Report & { assignment?: string }) {
    const membership = this.workerOf(threadId);
    const { project, worker } = membership;
    const unsettled = this.store
      .assignments(project.id)
      .filter(
        (a) =>
          a.workerNum === worker.num &&
          [
            "running",
            "queued",
            "idle_no_report",
            "reported",
            "dispatching",
            "stopped",
          ].includes(a.state),
      );
    if (!input.assignment && unsettled.length > 1)
      throw new ProjectError(
        "Several assignments share this worker. Pass the assignment ref from your brief when reporting.",
      );
    let assignment = input.assignment
      ? this.requireAssignment(project, input.assignment)
      : (this.store.openAssignment(project.id, worker.num) ??
        this.store
          .assignments(project.id)
          .filter((a) => a.workerNum === worker.num)
          .at(-1) ??
        null);
    if (!assignment || assignment.workerNum !== worker.num)
      throw new ProjectError(
        `${worker.ref} has no assignment${input.assignment ? ` ${input.assignment}` : ""} to report on.`,
      );
    if (assignment.generation !== worker.generation)
      throw new ProjectError(
        `${assignment.ref} belongs to generation ${assignment.generation}; this context is generation ${worker.generation}.`,
      );
    if (assignment.state === "accepted")
      throw new ProjectError(`${assignment.ref} is already accepted.`);
    if (assignment.state === "rejected")
      throw this.closedReportError(project.id, assignment, threadId, input.pendingBackgroundWork ?? []);
    const execution = await threadExecution(this.sdk, threadId);
    const currentWorker = this.store.worker(project.id, worker.num)!;
    assignment = this.store.assignment(project.id, assignment.num)!;
    if (assignment.state === "accepted")
      throw new ProjectError(`${assignment.ref} is already accepted.`);
    if (assignment.state === "rejected")
      throw this.closedReportError(project.id, assignment, threadId, input.pendingBackgroundWork ?? []);
    if (
      currentWorker.threadId !== threadId ||
      currentWorker.generation !== assignment.generation
    )
      throw new ProjectError(
        "The worker context changed while recording its report.",
      );
    // Rejected assignments refuse late reports above (T92): the reviewed report stays frozen.
    // Cancelled, failed and stopped assignments are terminal: a late report —
    // first or repeated — preserves evidence without ever reopening the
    // business state, clearing its stop reason, or making the task await
    // acceptance again. The terminal check re-runs after the awaits below.
    const actualProfile =
      execution && worker.providerId
        ? {
            providerId: worker.providerId,
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
          }
        : null;
    const { assignment: _ref, ...reportInput } = input;
    // Parse once into canonical schema/key order before equality checks.
    // Transport JSON key order must not turn a retry into a second notice.
    const report = reportSchema.parse(reportInput);
    let sameReport = assignment.report !== null && JSON.stringify(report) === JSON.stringify(assignment.report);
    // An identical re-file is still a new filing (A207 R2): it takes a fresh report version,
    // so a scope release given for the earlier filing never covers it. State, notice, stop
    // reason and first filing time stay as they were, and the coordinator is not notified again.
    const refile = (a: AssignmentRecord) => this.store.updateAssignment(project.id, a.num, { report });
    if (sameReport && !assignment.checkpoint) {
      refile(assignment);
      const note = assignment.reportNotice?.state === "failed"
        ? await this.notifyReport(threadId, assignment, report, true)
        : `This report is already recorded on ${assignment.ref} (${assignment.state}).`;
      const saved = this.store.assignment(project.id, assignment.num)!;
      return { assignment: saved.ref, state: saved.state, notification: saved.reportNotice, note };
    }
    let notifyNote: string | null = null;
    // A report proves the worker ran. A still-queued brief for this
    // assignment must not dispatch a duplicate turn — but a failed delete
    // keeps the receipt and its reservation rather than swallowing the
    // failure and releasing a runnable row. A 404 is the same unknown: the
    // row is gone without proof it was deleted rather than dispatched.
    let receiptHeld = false;
    if (assignment.queuedMessageId && assignment.threadId) {
      try {
        await this.sdk.threads.queuedMessages.delete({
          threadId: assignment.threadId,
          queuedMessageId: assignment.queuedMessageId,
        });
      } catch (error) {
        receiptHeld = true;
        notifyNote =
          "The report is recorded, but its queued brief could not be deleted; its receipt and task reservation stay held until a sweep settles the native row.";
        this.store.log(
          project.id,
          "report",
          `${assignment.ref}'s report is recorded, but its queued brief could not be deleted (${errorMessage(error)}); its receipt and tasks stay reserved until the native row is positively settled.`,
        );
      }
    }
    // The delete await may have let a concurrent cancel, settle or report
    // land: re-read so terminal evidence always wins over this write. A
    // cancel in flight (cancelRequested, state not yet written) counts as
    // cancelled everywhere else, so it counts here too.
    assignment = this.store.assignment(project.id, assignment.num)!;
    if (assignment.state === "accepted")
      throw new ProjectError(`${assignment.ref} is already accepted.`);
    if (assignment.state === "rejected")
      throw this.closedReportError(project.id, assignment, threadId, report.pendingBackgroundWork);
    // A concurrent first report can commit during queued-brief deletion.
    // Canonical identity and its receipt belong to this fresh row.
    sameReport = assignment.report !== null && JSON.stringify(report) === JSON.stringify(assignment.report);
    if (sameReport && !assignment.checkpoint) {
      const saved = refile(assignment);
      return { assignment: saved.ref, state: saved.state, notification: saved.reportNotice,
        note: `This report is already recorded on ${saved.ref} (${saved.state}).` };
    }
    const terminalNow =
      ["cancelled", "failed", "stopped"].includes(assignment.state) ||
      assignment.cancelRequested;
    const cancelled =
      assignment.state === "cancelled" || assignment.cancelRequested;
    this.store.tx(() => {
      this.store.updateAssignment(project.id, assignment.num, {
        state: terminalNow ? assignment.state : "reported",
        report,
        ...(sameReport ? {} : { reportNotice: null }),
        // A worker-authored report supersedes coordinator attribution, even
        // when its canonical evidence body is identical to the checkpoint.
        checkpoint: null,
        reportedAt: this.now(),
        briefDelivered: true,
        // A report proves the work ran — but the turn it ran in may still be
        // active, so a cancelled assignment stays outstanding until native
        // quiescence: an idle/failed/archive event or a quiet sweep.
        opState: receiptHeld || cancelled ? "uncertain" : "done",
        actualProfile: actualProfile ?? assignment.actualProfile,
        queuedMessageId: receiptHeld ? assignment.queuedMessageId : null,
        ...(terminalNow ? {} : { stopReason: null }),
      });
      this.store.updateWorker(project.id, worker.num, {
        handoff: report.handoff,
      });
      if (!terminalNow) {
        const taskStatus =
          report.outcome === "succeeded" ? "awaiting_acceptance" : "blocked";
        for (const num of [...assignment.taskNums]) {
          const task = this.store.task(project.id, num);
          if (task && !["done", "cancelled"].includes(task.status)) {
            const waiting = this.store.decisions(project.id).find(d => d.status === "active" && d.humanAttention === "needs-opinion" && d.blocks.includes(num));
            this.store.updateTask(project.id, num, {
              status: waiting ? "blocked" : taskStatus,
              progress: waiting ? `Waiting for your opinion on ${waiting.ref}` : report.summary,
              nextCheckpoint: waiting ? `Answer ${waiting.ref}` :
                report.outcome === "succeeded"
                  ? "Coordinator acceptance"
                  : "Coordinator decision",
            });
          }
        }
      }
      const subject =
        assignment.role === "review"
          ? `review ${assignment.ref}`
          : `${assignment.taskNums.map(taskRef).join(", ")} (${assignment.ref})`;
      const checks = report.evidence.filter((item) => item.kind === "check");
      const failedChecks = checks.filter(
        (item) => item.result === "failed",
      ).length;
      const summary =
        report.outcome === "blocked"
          ? `${worker.ref} is blocked on ${subject}: ${report.blocker?.question ?? report.summary}`
          : `${worker.ref} reported ${report.outcome} on ${subject}: ${report.summary}${checks.length ? ` Checks: ${checks.length - failedChecks}/${checks.length} passed.` : ""}${report.pendingBackgroundWork.length ? ` Background work still running: ${report.pendingBackgroundWork.join("; ")}.` : ""}`;
      this.store.log(project.id, "report", summary, {
        assignment: assignment.num,
      });
    });
    const priorNotice = assignment.reportNotice;
    if (!sameReport || !priorNotice || priorNotice.state === "failed") {
      notifyNote = await this.notifyReport(threadId, this.store.assignment(project.id, assignment.num)!, report, sameReport && priorNotice?.state === "failed");
    }
    // A cancelled assignment reported on stays reserved while its thread can
    // still execute — the report is evidence, not quiescence. If the native
    // side is already quiet this settles now; an idle/failed/archive event or
    // a sweep settles it later. A held receipt never settles here: the queued
    // row could still dispatch.
    if (cancelled && !receiptHeld)
      await this.settleCancelledIfQuiet(
        this.store.assignment(project.id, assignment.num)!,
      );
    return {
      assignment: assignment.ref,
      notification: this.store.assignment(project.id, assignment.num)!.reportNotice,
      state: this.store.assignment(project.id, assignment.num)!.state,
      ...(notifyNote ? { note: notifyNote } : {}),
      ...(terminalNow
        ? {
            note: [
              `Report recorded on ${assignment.ref}, which stays ${assignment.state}. Accept or inspect it through the Initiative.`,
              notifyNote,
            ]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
    };
  }

  /**
   * T92: a rejected assignment is closed. Its reviewed report, its tasks and any successor
   * stay as they are, so a late report from its worker is refused without a write. The advice
   * matches what the caller can do: a continuation whose brief is not confirmed delivered is
   * only named, initiative_message is offered only when its own caller checks would admit this
   * thread, and a fork (whose turn endings reach no coordinator) is promised no delivery.
   */
  private closedReportError(projectId: string, assignment: AssignmentRecord, threadId: string, listed: readonly string[]) {
    const worker = this.store.worker(projectId, assignment.workerNum)!;
    const open = this.store.openAssignment(projectId, assignment.workerNum);
    const current = open && open.num !== assignment.num && open.state !== "stopped" && !open.cancelRequested ? open : null;
    const delivered = current && ["running", "idle_no_report"].includes(current.state) && current.briefDelivered && !current.queuedMessageId;
    const canMessage = messageCallerAdmitted(this.store, threadId);
    const jobs = `${listed.slice(0, 3).join("; ")}${listed.length > 3 ? `; ${listed.length - 3} more` : ""}`;
    return new ProjectError(
      `${assignment.ref} was rejected${assignment.stopReason ? ` (${assignment.stopReason})` : ""}; its report is closed and this report was not recorded. ` +
        (!current
          ? `${worker.ref} ${worker.state === "retired" ? "is retired and has no current assignment" : "has no other current assignment"}.`
          : delivered
            ? `Your current assignment is ${current.ref}; report only ${current.ref}'s own work on it, with "assignment":"${current.ref}".`
            : `Your next assignment ${current.ref}'s brief is not confirmed delivered to you yet: wait for it, and do not copy this ${assignment.ref} report onto ${current.ref}.`) +
        (canMessage
          ? " Send anything the coordinator should know with initiative_message." +
            (listed.length ? ` The background work it lists (${jobs}) is not recorded either: stop it before ending your turn, or send it to the coordinator with initiative_message.` : "")
          : worker.forkedFrom !== null
            ? (listed.length ? ` Stop the background work it lists (${jobs}) before ending your turn; it is not recorded either.` : "") +
              ` Your final reply stays only in this thread: as a fork, ${worker.ref}'s turn endings are not delivered to the coordinator by ordinary native completion.`
            : " Put anything the coordinator should know in your final reply: it stays in this thread, and if this thread is an ordinary native child, BB sends its native parent a completion notice when the turn ends." +
              (listed.length ? ` The background work it lists (${jobs}) is not recorded either: stop it before ending your turn and name it in your final reply.` : "")),
    );
  }

  /** One explicit notice attempt; a repeat can retry only a definite failed receipt. */
  private async notifyReport(threadId: string, assignment: AssignmentRecord, report: Report, retry = false): Promise<string> {
    const { project, worker } = this.workerOf(threadId);
    const current = this.store.assignment(project.id, assignment.num)!;
    if (current.generation !== worker.generation || current.threadId !== threadId || JSON.stringify(current.report) !== JSON.stringify(report))
      return "Report/context changed while checking notification; read the current assignment.";
    if (retry && current.reportNotice?.state !== "failed") return `Notification stays ${current.reportNotice?.state ?? "unrecorded"}; no duplicate send.`;
    const coordinatorId = this.store.project(project.id)?.coordinatorThreadId ?? null;
    if (!coordinatorId) return "Report recorded; no current coordinator for a fallback notification.";
    // Claim before the parent read/send await. Concurrent identical calls see
    // pending, and unknown/sent/queued receipts never authorize a retry.
    this.store.updateAssignment(project.id, assignment.num, { reportNotice: { state: "pending", coordinatorThreadId: coordinatorId } });
    let parent: string | null | undefined;
    let origin: ThreadDto["originKind"] | undefined;
    let ordinary = false;
    try { const native = await this.sdk.threads.get({ threadId }); parent = native.parentThreadId; origin = native.originKind; ordinary = origin === null; }
    catch { parent = undefined; }
    const fresh = this.store.assignment(project.id, assignment.num)!;
    if (JSON.stringify(fresh.report) !== JSON.stringify(report)) return "A newer report owns its notification; no stale send.";
    if (fresh.state !== current.state && ["accepted", "rejected"].includes(fresh.state)) {
      this.store.updateAssignment(project.id, assignment.num, { reportNotice: null });
      return "Assignment settled before notification; no stale send.";
    }
    const latestWorker = this.store.worker(project.id, worker.num)!;
    if (latestWorker.threadId !== threadId || latestWorker.generation !== fresh.generation) {
      this.store.updateAssignment(project.id, assignment.num, { reportNotice: { state: "failed", coordinatorThreadId: coordinatorId, detail: "Worker context changed before send; no notification sent." } });
      return "Worker context changed before notification; report is retained.";
    }
    const target = this.store.project(project.id)?.coordinatorThreadId ?? null;
    if (!target) {
      this.store.updateAssignment(project.id, assignment.num, { reportNotice: { state: "failed", coordinatorThreadId: coordinatorId, detail: "No current coordinator; no notification sent." } });
      return "Report recorded; no current coordinator for a fallback notification.";
    }
    if (parent === target && ordinary) {
      this.store.updateAssignment(project.id, assignment.num, { reportNotice: null });
      return "Report recorded; native completion goes to the current coordinator.";
    }
    this.store.updateAssignment(project.id, assignment.num, { reportNotice: { state: "pending", coordinatorThreadId: target } });
    const summary = report.outcome === "blocked" ? `${assignment.ref} is blocked: ${report.blocker?.question ?? report.summary}` : `${assignment.ref} reported ${report.outcome}: ${report.summary}`;
    try {
      const receipt = await this.sdk.threads.send({ threadId: target, senderThreadId: threadId,
        mode: report.outcome === "blocked" ? "steer-if-active" : "queue-if-active",
        input: textInput(`Initiative · ${project.name} · ${worker.ref}\n\n${summary}\n\nDetails: initiative_read view "assignments", ${assignment.ref}.`),
      });
      // A later distinct report may now own this row; don't attach an old
      // delivery result to its new evidence. BB still owns the actual receipt.
      if (JSON.stringify(this.store.assignment(project.id, assignment.num)!.report) === JSON.stringify(report))
        this.store.updateAssignment(project.id, assignment.num, { reportNotice: { state: receipt.delivery, coordinatorThreadId: target, ...(receipt.delivery === "queued" ? { queuedId: receipt.queuedMessage.id } : {}) } });
      this.store.log(project.id, "report", `${assignment.ref} coordinator notification ${receipt.delivery}`, { senderThreadId: threadId, coordinatorThreadId: target });
      return `Report recorded; coordinator notification ${receipt.delivery}${receipt.delivery === "queued" ? ` (${receipt.queuedMessage.id})` : ""}.${parent === undefined || origin === undefined ? " Native completion eligibility could not be confirmed; BB may also deliver a completion notice." : origin === "fork" ? " Genuine forks do not emit ordinary native completion notices." : parent ? ` Native completion goes to parent ${parent}.` : ""}`;
    } catch (error) {
      const state = isDefiniteRejection(error) ? "failed" : "uncertain";
      if (JSON.stringify(this.store.assignment(project.id, assignment.num)!.report) === JSON.stringify(report))
        this.store.updateAssignment(project.id, assignment.num, { reportNotice: { state, coordinatorThreadId: target, detail: errorMessage(error) } });
      this.store.log(project.id, "report", `${assignment.ref} coordinator notification ${state}: ${errorMessage(error)}`);
      return `Report recorded; coordinator notification ${state}: ${errorMessage(error)}. Inspect native receipts before another send.`;
    }
  }

  progress(threadId: string, input: { note: string; nextCheckpoint?: string }) {
    const { project, worker } = this.workerOf(threadId);
    const assignment = this.store.openAssignment(project.id, worker.num);
    if (!assignment)
      throw new ProjectError(`${worker.ref} has no open assignment.`);
    this.store.tx(() => {
      for (const num of assignment.taskNums)
        this.store.updateTask(project.id, num, {
          progress: input.note,
          ...(input.nextCheckpoint
            ? { nextCheckpoint: input.nextCheckpoint }
            : {}),
        });
      this.store.log(project.id, "progress", `${worker.ref}: ${input.note}`, {
        assignment: assignment.num,
      });
    });
    return { assignment: assignment.ref };
  }

  // Helpers -----------------------------------------------------------------

  private async tagThread(
    threadId: string,
    metadata: Record<string, string | number | null>,
  ) {
    await this.sdk.threads.updatePluginMetadata({
      threadId,
      pluginId: this.bb.pluginId,
      set: { ...metadata, v: METADATA_VERSION },
    });
  }

  /**
   * Tool sets load when a provider session starts. An adopted thread picks up
   * the project tools at its next natural session restart; the thread and its
   * history are untouched.
   */
  private async reloadToolsIfIdle(thread: ThreadDto): Promise<string | null> {
    return "Adopted without releasing its runtime. Initiative tools load at the next natural session restart; bb initiative works immediately.";
  }
}

export function slug(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 60) || "item"
  );
}
