import { BUSY_STATUSES, errorMessage, textInput, type Sdk, type ThreadDto } from "./bb";
import { fallbackDiffers, profileFor, seriesOf } from "./policy";
import type { Policy, Profile } from "./schema";
import type { Store } from "./store";

/**
 * W545: a worker's reviewer that a usage limit or an unavailable model stops before its verdict
 * is replaced by the plugin, not by the worker: the reviewer is stopped, its queued retries
 * deleted and the thread archived, and the same round starts on the fallback reviewer with the
 * same prompt, under the same worker. The worker hears it in its own thread.
 *
 * A reviewer is a direct child of a worker thread running the worker's reviewer profile
 * (provider and model): the profile the brief's reviewer command spawns. The fallback runs
 * another provider or model (`fallbackDiffers`, which also decides whether the brief shows a
 * fallback command), so it is never replaced in turn; when it fails too, the worker reports
 * blocked. A reviewer that ever finished a turn may have given its verdict (R8): the plugin
 * leaves it and tells the worker.
 */

/** Why a reviewer can't run: out of quota, or its model is not available. */
export type ReviewerFailure = { reason: "quota" | "unavailable"; detail: string };

/** The structured classification BB stores with a provider error (`provider/error.errorInfo`). */
export interface ErrorInfo {
  category: string;
  providerCode: string | null;
}

/** What the failure events tell beyond the stored error. */
export interface FailureHint {
  error?: string | null;
  errorInfo?: ErrorInfo | null;
  /** `turn.failed`'s rate-limit snapshot: a blocked window is a quota, not a passing 429. */
  rateLimitBlocked?: boolean;
  /** `thread.failed`'s DTO parent: a thread whose parent is no worker is dropped before any RPC. */
  parentThreadId?: string | null;
}

const QUOTA_CATEGORIES = new Set(["billing", "budget-exceeded"]);
// Provider phrasing for an exhausted subscription or balance (Muse, Claude Code, Codex), not a
// passing per-minute limit, Claude's server throttle ("… (not your usage limit)") or an
// unrelated quota ("Disk quota exceeded").
const QUOTA_TEXT = /(?<!not your )usage limit|(?:subscription|usage|account|plan) quota|quota (?:exhausted|has been exhausted)|exceeded your (?:current )?quota|hit your (?:(?:usage|session|weekly|daily|monthly|\d+-hour) )?limit|out of credits|insufficient (?:credits|balance|funds)|credit balance is too low|spend(?:ing)? limit/iu;
// A per-minute limit says so even when it borrows quota words ("You exceeded your current quota … per minute").
const PER_MINUTE_TEXT = /per[ -]minute/iu;
const UNAVAILABLE_TEXT = /model_not_found|unknown model|no such model|\bmodel\b[^\n]{0,60}\b(?:not found|does not exist|is not supported)/iu;

/**
 * Whether a failure keeps a reviewer from running at all. A provider's own category decides
 * first: billing or budget is quota; a rate limit is quota only when the window is blocked or
 * the text says the usage limit or quota is spent (a per-minute 429 passes); any other category
 * it names (overloaded, a dropped connection, an internal error) is transient and left to BB's
 * own retry. Without a category (or with "unknown" or "bad-request"), the text decides; text
 * that names neither is transient too.
 */
export function classifyReviewerFailure(errorInfo: ErrorInfo | null, message: string | null, rateLimitBlocked = false): ReviewerFailure | null {
  const detail = (message ?? errorInfo?.category ?? "").trim().replace(/\s+/gu, " ").slice(0, 300);
  const quotaText = !!message && QUOTA_TEXT.test(message) && !PER_MINUTE_TEXT.test(message);
  if (errorInfo && QUOTA_CATEGORIES.has(errorInfo.category)) return { reason: "quota", detail };
  if (errorInfo?.category === "rate-limit") return rateLimitBlocked || quotaText ? { reason: "quota", detail } : null;
  if (errorInfo?.providerCode === "model_not_found") return { reason: "unavailable", detail };
  if (errorInfo && errorInfo.category !== "unknown" && errorInfo.category !== "bad-request") return null;
  if (message && UNAVAILABLE_TEXT.test(message)) return { reason: "unavailable", detail };
  return quotaText ? { reason: "quota", detail } : null;
}

/** The profile a worker's brief names as its reviewer, by the worker's model family. */
export const reviewerProfileFor = (policy: Policy, worker: Pick<Profile, "providerId" | "model"> | null) =>
  profileFor(policy, seriesOf(worker) === "gpt" ? "reviewOfGpt" : "reviewOfClaude");

const profileName = (profile: Profile) => `${profile.model} ${profile.reasoningLevel}`;
const REASONS = { quota: "out of quota (usage limit)", unavailable: "its model is unavailable" } as const;
/** The plugin flag that claims one failed reviewer, so the two failure events act once. */
export const fallbackFlag = (threadId: string) => `reviewer-fallback:${threadId}`;
/** Set once a claimed reviewer's outcome reached its worker (or was handed back after a reload). */
const doneFlag = (threadId: string) => `reviewer-fallback-done:${threadId}`;
/** The pluginMetadata role of a fallback reviewer the plugin started. */
export const FALLBACK_ROLE = "fallback-reviewer";

interface EventRow { seq: number; type: string; data: unknown }

export class ReviewerFallback {
  /** Per thread, the call running: a second event waits for it, then sees the flag or its own hint. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      sdk: Sdk;
      store: Store;
      /** The Adventure's policy with the global profiles under it. */
      policy: (projectId: string) => Promise<Policy>;
      warn: (message: string) => void;
    },
  ) {}

  /**
   * A thread failed (`thread.failed`, `turn.failed`): replace it when it is a worker's reviewer
   * that can't run. Both events call this; the failed thread's flag makes the second a no-op.
   */
  onFailed(threadId: string, hint: FailureHint = {}): Promise<void> {
    const next = (this.running.get(threadId) ?? Promise.resolve())
      .then(() => (this.deps.store.hasFlag(fallbackFlag(threadId)) ? undefined : this.handle(threadId, hint)))
      .catch((error) => this.deps.warn(`Reviewer fallback for ${threadId} failed: ${errorMessage(error)}`));
    this.running.set(threadId, next);
    void next.then(() => {
      if (this.running.get(threadId) === next) this.running.delete(threadId);
    });
    return next;
  }

  private async handle(threadId: string, hint: FailureHint) {
    const { sdk, store } = this.deps;
    if (hint.parentThreadId !== undefined && !this.workerParent(hint.parentThreadId)) return;
    const thread = (await sdk.threads.get({ threadId })) as ThreadDto;
    // A reviewer running again (a retry already dispatched) is left to that run; a queued retry is not.
    if (thread.archivedAt !== null || thread.deletedAt !== null || BUSY_STATUSES.has(thread.status) || !thread.parentThreadId) return;
    const membership = this.workerParent(thread.parentThreadId);
    if (!membership) return;
    const { project, worker } = membership;
    const policy = await this.deps.policy(project.id);
    const assignment = store.openAssignment(project.id, worker.num);
    const reviewer = reviewerProfileFor(policy, assignment?.profile ?? (worker.providerId && worker.model ? { providerId: worker.providerId, model: worker.model } : null));
    const fallback = profileFor(policy, "reviewFallback");
    // The reviewer command titles it "Review r<N> …"; a worker's own helper on that model is no reviewer.
    if (!fallbackDiffers(reviewer, fallback) || thread.providerId !== reviewer.providerId || !/\breview/iu.test(thread.title ?? "")) return;
    // Unreadable execution is no evidence that this is the reviewer: leave it (the brief's way out).
    const execution = await sdk.threads.defaultExecutionOptions({ threadId });
    if (!execution || execution.model !== reviewer.model) return;

    // The failed turn's own error: after its request, not a retry notice the turn outlived.
    const [request] = await this.events(threadId, ["client/turn/requested"], "desc", 1);
    const stored = (await this.events(threadId, ["provider/error"], "desc", 20, request?.seq))
      .map((row) => row.data as { message?: unknown; detail?: unknown; errorInfo?: ErrorInfo; willRetry?: unknown })
      .find((data) => data.willRetry !== true);
    // Claude Code and Codex store "Provider error" as the message and the provider's words in `detail`.
    const text = [stored?.detail, stored?.message].find((value): value is string => typeof value === "string" && value.trim() !== "");
    // A stored row is the failed turn's own account; turn.failed's errorInfo (which may come from
    // a retry notice) only stands in when the turn wrote none, as for a request refused at the door.
    const failure = classifyReviewerFailure(
      stored ? (stored.errorInfo ?? null) : (hint.errorInfo ?? null),
      text ?? hint.error ?? null,
      hint.rateLimitBlocked,
    );
    if (!failure) return;
    // Claimed before any write: a later event, or a restart, never acts on this thread again.
    // From here every outcome reaches the worker; a claim a reload cut short, through recover().
    store.setFlag(fallbackFlag(threadId));
    try {
      await this.replace(thread, failure, { project, worker, reviewer, fallback, execution });
    } finally {
      store.setFlag(doneFlag(threadId));
    }
  }

  /**
   * On load: a claim the previous load never finished (a reload or crash between the claim and
   * the worker's last note) is handed back to the worker, which may be waiting on it.
   */
  async recover() {
    const { sdk, store } = this.deps;
    for (const threadId of store.unfinishedClaims(fallbackFlag(""), doneFlag(""))) {
      if (this.running.has(threadId)) continue;
      store.setFlag(doneFlag(threadId));
      const thread = (await sdk.threads.get({ threadId }).catch(() => null)) as ThreadDto | null;
      const membership = thread?.parentThreadId ? store.membership(thread.parentThreadId) : null;
      if (!membership?.worker?.threadId || membership.former) continue;
      store.log(membership.project.id, "worker", `${membership.worker.ref}'s reviewer ${threadId}: the plugin restarted while rerunning it on the fallback; ${membership.worker.ref} was asked to check.`);
      await sdk.threads
        .send({ threadId: membership.worker.threadId, mode: "steer-if-active", input: textInput(`Adventures · ${membership.project.name} · Reviewer fallback\n\nThe plugin restarted while rerunning your reviewer ${threadId} (${thread!.title ?? "a review round"}) on the fallback reviewer. If no fallback reviewer for that round is running among your child threads, run the round again with the fallback reviewer command from your brief.`) })
        .catch((cause) => this.deps.warn(`Reviewer fallback recovery for ${threadId} could not reach ${membership.worker!.ref}: ${errorMessage(cause)}`));
    }
  }

  private async replace(
    thread: ThreadDto,
    failure: ReviewerFailure,
    { project, worker, reviewer, fallback, execution }: { project: { id: string; name: string }; worker: { ref: string; num: number; threadId: string | null }; reviewer: Profile; fallback: Profile; execution: { permissionMode?: string } },
  ) {
    const { sdk, store } = this.deps;
    const threadId = thread.id;

    const round = /\br(\d+)\b/iu.exec(thread.title ?? "")?.[1];
    const name = `${round ? `round ${round}` : "a review round"} (${thread.title ?? threadId}, ${threadId})`;
    const stopped = `Your reviewer for ${name} is ${REASONS[failure.reason]}: ${failure.detail}`;
    const notes: string[] = [];
    const tell = (text: string) =>
      sdk.threads
        .send({ threadId: worker.threadId!, mode: "steer-if-active", input: textInput(`Adventures · ${project.name} · Reviewer fallback\n\n${text}`) })
        .catch((cause) => store.log(project.id, "worker", `${worker.ref} could not be told about its reviewer ${threadId}: ${errorMessage(cause)}`));
    const runIt = (why: string) => {
      store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId} is ${REASONS[failure.reason]}; ${why}`);
      return tell(`${stopped}\n\n${why[0]!.toUpperCase()}${why.slice(1)} Run the round again with the fallback reviewer command from your brief; if it can't run either, report blocked.`);
    };

    let spawned: ThreadDto;
    try {
      // R8: a reviewer that finished a turn may have given its verdict, which is never redone.
      const finished = (await this.events(threadId, ["turn/completed"], "desc", 100)).some(
        (row) => (row.data as { status?: unknown } | null)?.status === "completed",
      );
      if (finished) {
        store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId} is ${REASONS[failure.reason]} after finishing a turn; not rerun on the fallback (R8).`);
        await tell(`${stopped}\n\nIt had already finished a turn, so the plugin left it: a round that gave a verdict or findings stands. If it gave neither, run the round again with the fallback reviewer command from your brief.`);
        return;
      }
      const [first] = await this.events(threadId, ["client/turn/requested"], "asc", 1);
      const input = (first?.data as { input?: unknown } | undefined)?.input;
      if (!Array.isArray(input) || !input.length) {
        await runIt("the plugin could not read its prompt, so it did not rerun it.");
        return;
      }
      // Stop it first: a provider may still wake it (Muse resumes a turn when its background
      // work ends). The archive is what retires a queued retry for good: BB neither sends a
      // queued row nor retries a turn on an archived thread; deleting the rows tidies the card.
      const cleanup: string[] = [];
      const attempt = async <T>(what: string, step: () => Promise<T>): Promise<T | null> => {
        try {
          return await step();
        } catch (cause) {
          cleanup.push(`${what} (${errorMessage(cause)})`);
          return null;
        }
      };
      // A stop that fails on a thread that is not running anyway left nothing to wake: no note.
      try {
        await sdk.threads.stop({ threadId });
      } catch (cause) {
        const now = (await sdk.threads.get({ threadId }).catch(() => null)) as ThreadDto | null;
        if (!now || BUSY_STATUSES.has(now.status)) cleanup.push(`stopping it (${errorMessage(cause)})`);
      }
      for (const row of (await attempt("listing its queue", () => sdk.threads.queuedMessages.list({ threadId }))) ?? [])
        await attempt(`deleting queued ${row.id}`, () => sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id }));
      await sdk.threads.archive({ threadId });
      if (cleanup.length) {
        store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId}: archived, but ${cleanup.join("; ")} failed. Don't unarchive it: a queued retry would run it again.`);
        notes.push(`It is archived, but ${cleanup.join("; ")} failed: don't unarchive it, or a queued retry would run it again.`);
      }
      // A worker on an older brief replaces it by hand; one fallback per round.
      // An unreadable listing is no proof that it started none: the outer catch hands the round over.
      // The fallback's model too: by default the reviewer of GPT work shares its provider.
      const candidates = (await sdk.threads.list({ parentThreadId: thread.parentThreadId!, includeHidden: true } as never)).filter(
        (child) => child.id !== threadId && child.archivedAt === null && child.providerId === fallback.providerId && child.createdAt >= thread.createdAt && /\breview/iu.test(child.title ?? ""),
      );
      let own: (typeof candidates)[number] | undefined;
      for (const child of candidates)
        if ((await sdk.threads.defaultExecutionOptions({ threadId: child.id }).catch(() => null))?.model === fallback.model) own = child;
      if (own) {
        store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId} is ${REASONS[failure.reason]}; archived, and ${worker.ref} had already started ${own.id} on the fallback.`);
        await tell([`Your reviewer ${threadId} is archived. You already started ${own.id} on the fallback, so the plugin started none: that is this round's reviewer.`, ...notes].join("\n"));
        return;
      }
      spawned = (await sdk.threads.spawn({
        projectId: thread.projectId,
        environment: thread.environmentId ? { type: "reuse", environmentId: thread.environmentId } : { type: "project-default" },
        parentThreadId: thread.parentThreadId,
        // Our BB fork (as `bb thread spawn --lifecycle-owner-thread`): archived with the worker.
        lifecycleOwnerThreadId: thread.parentThreadId,
        providerId: fallback.providerId,
        model: fallback.model,
        reasoningLevel: fallback.reasoningLevel,
        ...(fallback.serviceTier ? { serviceTier: fallback.serviceTier } : {}),
        ...(execution.permissionMode ? { permissionMode: execution.permissionMode } : {}),
        title: `${thread.title ?? "Review"} (fallback)`.slice(0, 120),
        input,
        pluginMetadata: { role: FALLBACK_ROLE, projectId: project.id, worker: worker.num, replaces: threadId },
      } as Parameters<Sdk["threads"]["spawn"]>[0])) as ThreadDto;
    } catch (cause) {
      await runIt(`the plugin could not rerun it on the fallback reviewer (${profileName(fallback)}): ${errorMessage(cause)}.`);
      return;
    }
    store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId} (${profileName(reviewer)}) is ${REASONS[failure.reason]}: ${round ? `round ${round}` : "the round"} rerun on ${profileName(fallback)} in ${spawned.id}.`, { worker: worker.num, failed: threadId, fallback: spawned.id });
    await tell(`${profileName(reviewer)} is ${REASONS[failure.reason]} → ${round ? `round ${round}` : "the round"} rerun on ${profileName(fallback)}.\n\n${stopped}\nThe plugin archived it and started the same prompt on the fallback reviewer: @thread:${spawned.id}. Its verdict comes back to you like any reviewer's; don't start another reviewer for this round. Name it as a fallback round in your report; if the fallback fails too, report blocked.${notes.length ? `\n${notes.join("\n")}` : ""}`);
  }

  /** The current work worker whose thread is `parentThreadId`, or null. */
  private workerParent(parentThreadId: string | null) {
    const membership = parentThreadId ? this.deps.store.membership(parentThreadId) : null;
    return membership?.worker && !membership.former && membership.worker.role === "work" && membership.worker.threadId
      ? { project: membership.project, worker: membership.worker }
      : null;
  }

  private async events(threadId: string, types: [string, ...string[]], order: "asc" | "desc", limit: number, afterSeq?: number): Promise<EventRow[]> {
    return (await this.deps.sdk.threads.events.list({ threadId, types, order, limit: String(limit), ...(afterSeq !== undefined ? { afterSeq: String(afterSeq) } : {}) } as never)) as EventRow[];
  }
}
