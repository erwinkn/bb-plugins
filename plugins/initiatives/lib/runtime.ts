import { addAbortListener } from "node:events";
import {
  BUSY_STATUSES,
  errorMessage,
  promptTexts,
  threadExecution,
  type ThreadDto,
} from "./bb";
import { contextUsedTokens } from "./compaction";
import { foldUsage } from "./policy";
import { type ProjectsService } from "./service";
import { zeroTotals, type Membership, type UsageRecord } from "./store";

export const SWEEP_INTERVAL_MS = 30_000;

/**
 * Observes native lifecycle events into the ledger and runs the periodic
 * reconcile. It owns nothing of its own: BB dispatches queued briefs, owns
 * Stop semantics, and delivers parent-to-coordinator completion notices;
 * no plugin inbox, wake delivery, retention or archive-on-idle machinery.
 */
export class Runtime {
  private disposed = false;
  // The running sweep service's signal. BB keeps delivering events to an
  // instance whose service it stopped, until dispose finishes; once this
  // aborts, idle events stop starting handovers and convergence.
  private stopSignal?: AbortSignal;
  private usageSamples = new Map<string, Promise<void>>();
  private compactions = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly service: ProjectsService) {}

  private get store() {
    return this.service.store;
  }
  private get sdk() {
    return this.service.sdk;
  }
  private get log() {
    return this.service.bb.log;
  }

  dispose() {
    this.disposed = true;
    for (const { abort } of this.compactions.values()) abort.abort();
    this.service.memory.dispose();
  }

  start(signal?: AbortSignal) {
    this.disposed = false;
    this.stopSignal = signal;
    this.service.memory.start(signal);
  }

  // BB lifecycle events ----------------------------------------------------------

  async onThreadIdle(thread: ThreadDto) {
    // T136: a handover writer finished; its final message is the handover.
    if (await this.service.finishHandoverDraft(thread.id)) return;
    let membership = this.store.membership(thread.id);
    if (!membership) {
      // An unclaimed thread whose live parent is a coordinator generation is
      // an ordinary native child: associate it so it surfaces in the project.
      this.service.associateNativeChild(thread);
      membership = this.store.membership(thread.id);
      if (!membership) return;
    }
    void this.sampleUsage(membership, thread.id).catch((error) =>
      this.log.warn(`Usage sampling failed: ${errorMessage(error)}`),
    );
    // A cancelled assignment whose brief provably dispatched keeps its
    // reservation while the turn can run: this idle is its positive settle
    // only when no queued or background native work can still execute.
    if (membership.workerNum > 0) {
      await this.service.settleCancelledExecutions(thread);
      // T136: the turn's final message is the worker's report.
      await this.service.captureFinalMessage(thread).catch((error) =>
        this.log.warn(`Final-message capture failed: ${errorMessage(error)}`),
      );
    }
    // D431: a coordinator's turn ended: its messages join the Initiative's memory log.
    if (membership.workerNum === 0) this.service.memory.kick(membership.project.id);
    // A former coordinator generation going quiet may be the last blocker a
    // pending parenting transfer was waiting on.
    if (membership.workerNum === 0 && membership.former) {
      await this.service
        .convergeFormerCoordinators(membership.project.id, this.stopSignal)
        .catch((error) =>
          this.log.warn(
            `Former-coordinator convergence failed: ${errorMessage(error)}`,
          ),
        );
      return;
    }
    // The coordinator's natural idle boundary is where a recorded handover
    // drains. Workers need no idle bookkeeping: an open assignment on an idle
    // thread reads as "awaiting its report" in the overview.
    if (membership.workerNum !== 0 || membership.former) return;
    await this.service.drainHandover(membership.project.id, this.stopSignal);
    this.compactAfterIdle(membership.project.id, thread.id);
  }

  /**
   * W215: a large coordinator context is compacted between turns. The check reads BB's
   * events, so it runs detached from the idle handler, owned here: dispose and the service
   * signal abort it, and one runs per thread at a time.
   */
  private compactAfterIdle(projectId: string, threadId: string) {
    const stop = this.stopSignal;
    if (this.disposed || stop?.aborted || this.compactions.has(threadId) || !this.service.compaction.enabled(projectId)) return;
    const abort = new AbortController();
    const link = stop ? addAbortListener(stop, () => abort.abort(stop.reason)) : null;
    const done = this.service.compaction
      .afterIdle(projectId, threadId, abort.signal)
      .then(
        () => {},
        (error) => {
          if (!abort.signal.aborted) this.log.warn(`Coordinator compaction failed: ${errorMessage(error)}`);
        },
      )
      .finally(() => {
        link?.[Symbol.dispose]();
        this.compactions.delete(threadId);
      });
    this.compactions.set(threadId, { abort, done });
  }

  /**
   * D431: BB's per-thread event signal (at most once a second). A hybrid coordinator's log is
   * read as it works, not only when its turn ends; a regular one waits for its idle.
   */
  onThreadEvents(threadId: string) {
    if (this.disposed || this.stopSignal?.aborted) return;
    const projectId = this.service.memory.projectOfCoordinator(threadId);
    if (projectId && this.service.memory.building(projectId)) this.service.memory.kick(projectId);
  }

  /** Resolves once every compaction check this runtime started has finished. */
  async compactionsSettled() {
    await Promise.all([...this.compactions.values()].map(({ done }) => done));
  }

  async onThreadFailed(thread: ThreadDto, error: string | null) {
    if (await this.service.finishHandoverDraft(thread.id, `the writer failed (${error ?? "unknown error"})`)) return;
    const membership = this.store.membership(thread.id);
    if (!membership) {
      this.service.associateNativeChild(thread);
      return;
    }
    // A failed turn is a positive settle for a cancelled-and-dispatched
    // brief just like idle — subject to the same queued/background check.
    if (membership.workerNum > 0) {
      await this.service.settleCancelledExecutions(thread);
      // A failed turn ends any short report's wait for its final message.
      await this.service.captureFinalMessage(thread).catch((error) =>
        this.log.warn(`Final-message capture failed: ${errorMessage(error)}`),
      );
    }
    if (!membership.worker || membership.former) return;
    const { project, worker } = membership;
    const assignment = this.store.openAssignment(project.id, worker.num);
    if (
      !assignment ||
      assignment.threadId !== thread.id ||
      !["running", "idle_no_report"].includes(assignment.state)
    )
      return;
    // The ledger keeps the assignment open — the worker may still report —
    // and records the native cause once. The overview derives liveness from
    // the thread's own status.
    const cause = (error ?? "unknown error").trim().replace(/[.!?]+$/, "");
    const stopReason = `Native thread failed: ${cause}.`;
    if (assignment.stopReason === stopReason) return;
    this.store.tx(() => {
      this.store.updateAssignment(project.id, assignment.num, { stopReason });
      this.store.log(
        project.id,
        "worker",
        `${worker.ref}'s native thread failed on ${assignment.ref}: ${cause}. This event does not establish that a turn started. No recovery has been confirmed.`,
      );
    });
  }

  onThreadArchived(thread: ThreadDto) {
    const membership = this.store.membership(thread.id);
    if (
      !membership?.worker ||
      membership.former ||
      membership.worker.state === "retired"
    )
      return;
    const { project, worker } = membership;
    this.store.tx(() => {
      const affected = this.store
        .assignments(project.id)
        .filter(
          (a) =>
            a.threadId === thread.id &&
            ([
              "dispatching",
              "queued",
              "running",
              "idle_no_report",
              "stopped",
            ].includes(a.state) ||
              // A cancelled assignment can still hold a queue receipt or an
              // unresolved send: the archived thread's queue is gone with it,
              // so the op is positively settled here too.
              (a.state === "cancelled" &&
                (a.queuedMessageId !== null ||
                  ["pending", "uncertain"].includes(a.opState)))),
        );
      for (const open of affected) {
        this.store.updateAssignment(project.id, open.num, {
          state: open.state === "cancelled" ? "cancelled" : open.report ? "reported" : "cancelled",
          opState: "done",
          queuedMessageId: null,
          stopReason:
            open.state === "cancelled"
              ? open.stopReason
              : "Thread archived or deleted outside Initiatives",
        });
        for (const num of open.taskNums) {
          const task = this.store.task(project.id, num);
          if (task?.status === "in_progress")
            this.store.updateTask(project.id, num, {
              status: "planned",
              progress:
                "Its native thread was archived or deleted; needs a new assignment",
            });
        }
        if (open.state === "cancelled")
          this.service.releaseCancelledTasks(
            project.id,
            open,
            "settled",
          );
      }
      this.store.closeGeneration(
        project.id,
        worker.num,
        "archived outside Initiatives",
      );
      this.store.updateWorker(project.id, worker.num, { state: "retired" });
      this.store.log(
        project.id,
        "worker",
        `${worker.ref}'s thread was archived or deleted outside Initiatives; ${affected.length} unfinished assignments settled.`,
      );
    });
  }

  /** BB dispatched a natively queued brief; the ledger follows it. */
  onMessageDispatched(queuedMessageId: string) {
    const assignment = this.store.assignmentByQueuedMessage(queuedMessageId);
    if (!assignment) return;
    if (assignment.state === "queued") {
      this.store.updateAssignment(assignment.projectId, assignment.num, {
        state: "running",
        briefDelivered: true,
        queuedMessageId: null,
      });
      return;
    }
    if (assignment.state === "cancelled" || assignment.cancelRequested) {
      // Dispatch is delivery, not settlement: the turn may still execute,
      // so the op stays outstanding and the reservation until the native
      // side proves it quiet. The cancelled business state is preserved.
      this.store.tx(() => {
        this.store.updateAssignment(assignment.projectId, assignment.num, {
          briefDelivered: true,
          queuedMessageId: null,
        });
        this.store.log(
          assignment.projectId,
          "assignment",
          `${assignment.ref}'s queued brief was dispatched despite its cancellation; delivery alone does not prove execution, and the reservation holds until native settlement. A late report stays evidence on the cancelled assignment`,
        );
      });
    }
  }

  /** The user removed a queued brief; the assignment never ran. */
  onMessageCancelled(queuedMessageId: string) {
    const assignment = this.store.assignmentByQueuedMessage(queuedMessageId);
    if (!assignment) return;
    if (assignment.state === "cancelled" || assignment.cancelRequested) {
      const staged = this.store.assignment(
        assignment.projectId,
        assignment.num,
      )?.pendingIdentity;
      let dropped = false;
      this.store.tx(() => {
        const current = this.store.assignment(
          assignment.projectId,
          assignment.num,
        );
        // A late event must not clear a different, newer receipt.
        if (!current || current.queuedMessageId !== queuedMessageId) return;
        this.store.updateAssignment(assignment.projectId, assignment.num, {
          queuedMessageId: null,
        });
        if (current.briefDelivered || current.report !== null) {
          // The removed row proves only that queued delivery will not
          // happen — it cannot end execution already established by a
          // report or dispatch. That stays for the common settlement.
          this.store.log(
            assignment.projectId,
            "assignment",
            `${assignment.ref}'s leftover queued brief was removed after its cancellation; its recorded delivery/report evidence stands and the reservation holds until the native side is positively quiet.`,
          );
          return;
        }
        // Positive settlement of a cancel we already recorded: BB removed
        // the row and nothing ever ran, so the brief is gone for good.
        this.store.updateAssignment(assignment.projectId, assignment.num, {
          opState: "done",
          pendingIdentity: null,
        });
        dropped = true;
        this.service.releaseCancelledTasks(
          assignment.projectId,
          assignment,
          "never",
        );
        this.store.log(
          assignment.projectId,
          "assignment",
          `${assignment.ref}'s queued brief was removed after its cancellation; the reservation is released`,
        );
      });
      if (dropped && staged)
        void this.service.syncWorkerTitle(
          assignment.projectId,
          assignment.workerNum,
        );
      return;
    }
    if (assignment.state !== "queued") return;
    const staged = assignment.pendingIdentity;
    this.store.tx(() => {
      this.store.updateAssignment(assignment.projectId, assignment.num, {
        state: "cancelled",
        queuedMessageId: null,
        stopReason: "The queued brief was removed by the user",
        // The removed brief provably never ran: its staged rename dies with
        // it and the native title reverts to the ledger identity.
        pendingIdentity: null,
      });
      for (const num of assignment.taskNums) {
        const task = this.store.task(assignment.projectId, num);
        if (task?.status === "in_progress")
          this.store.updateTask(assignment.projectId, num, {
            status: "planned",
            progress: "Queued brief removed by you",
          });
      }
      this.store.log(
        assignment.projectId,
        "assignment",
        `${assignment.ref} cancelled: its queued brief was removed`,
      );
    });
    if (staged)
      void this.service.syncWorkerTitle(
        assignment.projectId,
        assignment.workerNum,
      );
  }

  // Periodic pass -----------------------------------------------------------

  /**
   * Reconcile unconfirmed operations against native receipts and drain any
   * recorded handover whose predecessor went quiet without an idle event
   * reaching this runtime. Nothing here delivers, retries or retires work.
   * After `service` aborts no new unit of work starts; a native call already
   * issued still settles with its receipt, and the ledger keeps every
   * unconfirmed op for the next sweep.
   *
   * Each pass runs on its own short-lived signal (W193): the BB SDK wraps every
   * signal it receives in AbortSignal.any with a 75 s timeout, and composites
   * built on the long-lived service signal stay recorded on it, so hundreds of
   * list calls per pass made every GC walk them. The pass signal is linked to the
   * service signal by one listener, removed and aborted when the pass ends.
   */
  async sweep(service?: AbortSignal) {
    const pass = new AbortController();
    const link = service ? addAbortListener(service, () => pass.abort(service.reason)) : null;
    if (service?.aborted) pass.abort(service.reason);
    try {
      await this.sweepPass(pass.signal);
    } finally {
      link?.[Symbol.dispose]();
      pass.abort();
    }
  }

  private async sweepPass(signal: AbortSignal) {
    await this.service.reconcile(signal);
    // Discover coordinator children the thread events did not reach: spawns
    // that happened while the plugin was down, and threads an adopted
    // coordinator brought with it.
    for (const project of this.store.projects()) {
      if (signal?.aborted) return;
      if (project.archivedAt !== null) continue;
      await this.service
        .associateNativeChildren(project.id, signal)
        .catch((error) => {
          if (!signal?.aborted)
            this.log.warn(
              `Native-child association for ${project.id} failed: ${errorMessage(error)}`,
            );
        });
    }
    await this.service.flagStuckWorkers().catch((error) =>
      this.log.warn(`Stuck-worker check failed: ${errorMessage(error)}`),
    );
    await this.service.pumpHandoverWriters().catch((error) =>
      this.log.warn(`Handover writer start failed: ${errorMessage(error)}`),
    );
    await this.service.sweepHandoverDrafts().catch((error) =>
      this.log.warn(`Handover writer sweep failed: ${errorMessage(error)}`),
    );
    for (const projectId of this.store.pendingHandoverProjects()) {
      if (signal?.aborted) return;
      await this.service.drainHandover(projectId, signal).catch((error) =>
        this.log.warn(
          `Handover drain for ${projectId} failed: ${errorMessage(error)}`,
        ),
      );
    }
    // Former coordinators left live by a partial transfer or a missed
    // post-switch archive converge here: children reparent to the incumbent,
    // then the empty quiet predecessor archives.
    for (const project of this.store.projects()) {
      if (signal?.aborted) return;
      if (project.archivedAt !== null) continue;
      await this.service
        .convergeFormerCoordinators(project.id, signal, { backoff: true })
        .catch((error) =>
          this.log.warn(
            `Former-coordinator convergence for ${project.id} failed: ${errorMessage(error)}`,
          ),
        );
    }
    // D431: Initiatives whose memory log no idle event refreshed lately, and first logs. Last,
    // and detached: reading a log never delays the pass's own work.
    if (!signal.aborted) this.service.memory.sweep();
  }

  // Usage --------------------------------------------------------------------------

  sampleUsage(membership: Membership, threadId: string): Promise<void> {
    const pending = this.usageSamples.get(threadId);
    if (pending) return pending;
    const sample = this.collectUsage(membership, threadId).finally(() => {
      this.usageSamples.delete(threadId);
    });
    this.usageSamples.set(threadId, sample);
    return sample;
  }

  private async collectUsage(membership: Membership, threadId: string) {
    await this.sampleTokens(membership, threadId);
    const cursor = this.store.turnCursor(threadId);
    const turns = await this.sdk.threads.events.list({
      threadId, afterSeq: String(cursor?.lastSeq ?? 0),
      types: ["turn/started", "turn/completed"],
      order: cursor ? "asc" : "desc", limit: "50",
    });
    this.store.observeTurns(membership.project.id, threadId, turns);
  }

  private async sampleTokens(membership: Membership, threadId: string) {
    const existing = this.store.usage(threadId);
    let record: Omit<UsageRecord, "updatedAt"> = existing ?? {
      threadId,
      projectId: membership.project.id,
      workerNum: membership.workerNum,
      lastSeq: 0,
      providerThreadId: null,
      sessionTotals: null,
      closedTotals: zeroTotals(),
      resets: 0,
      lastReportAt: null,
      contextUsed: null,
      contextWindow: null,
      model: null,
    };
    // BB caps one events.list response at 100 rows and counts `limit` per
    // requested type: the four usage types share a 25-row page each. The
    // saved cursor still paginates forward; a short first page just takes an
    // extra idle cycle to catch up.
    const types = [
      "thread/tokenUsage/updated",
      "thread/contextWindowUsage/updated",
      "thread/compacted",
      "thread/context/cleared",
    ] as const;
    const rows = await this.sdk.threads.events.list({
      threadId,
      afterSeq: String(record.lastSeq),
      types,
      order: existing ? "asc" : "desc",
      limit: String(Math.floor(100 / types.length)),
    });
    const unseen = rows.filter(row => row.seq > record.lastSeq);
    if (!unseen.length) return;
    // Initial adoption observes the recent tail, not every historical turn.
    // Following samples advance from the saved cursor in chronological order.
    for (const row of [...unseen].sort((a, b) => a.seq - b.seq)) {
      if (!existing) record.firstObservedAt ??= row.createdAt;
      record.lastObservedAt = row.createdAt;
      const data = row.data as Record<string, unknown>;
      if (row.type === "thread/tokenUsage/updated") {
        const tokenUsage = data.tokenUsage as {
          total: Record<string, number>;
          last?: Record<string, number>;
        };
        if (!tokenUsage?.total) { record.lastSeq = row.seq; continue; }
        const total = tokenUsage.total;
        const folded = foldUsage(record, {
          seq: row.seq,
          at: row.createdAt,
          providerThreadId: typeof data.providerThreadId === "string" ? data.providerThreadId : null,
          ...(tokenUsage.last
            ? {
                last: {
                  input: tokenUsage.last.inputTokens ?? null,
                  cachedInput: tokenUsage.last.cachedInputTokens ?? null,
                  output: tokenUsage.last.outputTokens ?? null,
                  reasoningOutput: tokenUsage.last.reasoningOutputTokens ?? null,
                  total: tokenUsage.last.totalTokens ?? null,
                },
              }
            : {}),
          total: {
            input: total.inputTokens ?? null,
            cachedInput: total.cachedInputTokens ?? null,
            output: total.outputTokens ?? null,
            reasoningOutput: total.reasoningOutputTokens ?? null,
            total: total.totalTokens ?? null,
          },
        });
        const { reset: _reset, ...rest } = folded;
        record = {
          ...record,
          ...rest,
          lastReportAt: folded.lastReportAt ?? record.lastReportAt,
        };
      } else if (row.type === "thread/contextWindowUsage/updated") {
        const usage = data.contextWindowUsage as {
          snapshot?: {
            usedTokens: number | null;
            contextWindowTokens: number | null;
            estimated: boolean;
          };
          usedTokens?: number;
          modelContextWindow?: number;
          estimated?: boolean;
        };
        record = {
          ...record,
          lastSeq: row.seq,
          contextUsed: contextUsedTokens(data),
          contextObservedAt: row.createdAt,
          contextWindow: usage.snapshot
            ? usage.snapshot.contextWindowTokens
            : usage.modelContextWindow ?? null,
          contextEstimated:
            usage.snapshot?.estimated ?? usage.estimated ?? null,
        };
      } else {
        record = {
          ...record,
          lastSeq: row.seq,
          contextChangedAt: row.createdAt,
        };
        this.store.log(
          membership.project.id,
          "cache",
          `${membership.workerNum === 0 ? "Coordinator" : membership.workerNum === -1 ? "Thread" : `W${membership.workerNum}`} context ${row.type === "thread/compacted" ? "compacted" : "cleared"} natively`,
        );
      }
    }
    // Effective settings are observation provenance, never a historical token identity.
    let providerId: string | null = null;
    try {
      providerId = (await this.sdk.threads.get({ threadId })).providerId ?? null;
    } catch (error) {
      this.log.warn(`Usage profile unavailable: ${errorMessage(error)}`);
    }
    const execution = await threadExecution(this.sdk, threadId);
    const profile = {
      providerId, model: execution?.model ?? null,
      at: this.store.now(),
    };
    const previous = record.profileObservation;
    record.profileObservation = {
      first: previous?.first ?? profile,
      last: profile,
      mixed: previous?.mixed === true || !!previous &&
        [previous.first, previous.last].some(known =>
          (known.providerId !== null && profile.providerId !== null && known.providerId !== profile.providerId) ||
          (known.model !== null && profile.model !== null && known.model !== profile.model)),
    };
    record.model = profile.model ?? record.model;
    if ((this.store.usage(threadId)?.lastSeq ?? -1) >= record.lastSeq) return;
    this.store.saveUsage(record);
  }
}
