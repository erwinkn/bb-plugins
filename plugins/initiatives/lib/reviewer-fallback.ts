import { BUSY_STATUSES, errorMessage, textInput, type Sdk, type ThreadDto } from "./bb";
import { utcTime } from "./brief";
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
 *
 * W560: a switch also marks the reviewer profile out until its quota resets (the provider's
 * reset time, else an hour), so rounds stop failing on it one after another. While it is out,
 * briefs and work messages name the fallback first (reviewerCommand), every note to the worker
 * says until when, and a reviewer started on it anyway is switched as soon as it starts, before
 * it fails. The mark expires by itself; a turn that completes on the profile clears it early.
 */

/** Why a reviewer can't run: out of quota, its model is not available, or already marked out. */
export type ReviewerFailure = { reason: "quota" | "unavailable" | "out"; detail: string };

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
  /** When the latest of the snapshot's blocked windows resets. */
  resetsAtMs?: number | null;
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

/** How long a reviewer stays out when its error names no reset time. */
export const OUTAGE_DEFAULT_MS = 60 * 60_000;
/** A reset further out than this (a weekly window plus a day) is misread text: the default applies. */
const OUTAGE_MAX_MS = 8 * 24 * 60 * 60_000;
const OUTAGE_PREFIX = "reviewer-out:";
// The plugin_flags row's time is the reset time, not when it was set.
const outageKey = (profile: Pick<Profile, "providerId" | "model">) => `${OUTAGE_PREFIX}${profile.providerId}/${profile.model}`;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/gu;
const EPOCH_SECONDS = /\|(\d{10})\b/gu;
const RELATIVE = /\b(?:try again|resets?|retry) in ((?:\d+ ?(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[ ,]*(?:and )?)+)/giu;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/**
 * When a reviewer's quota comes back: the latest blocked rate-limit window's reset (the
 * provider's own account state), else the latest time the error names (an ISO time, Claude's
 * "|<epoch seconds>", "try again in 2 hours 5 minutes"), else an hour from now. A time already
 * past or over 8 days away is no reset.
 */
export function outageResetAt(text: string | null, windowResetMs: number | null = null, now = Date.now()): number {
  const valid = (at: number) => at > now && at <= now + OUTAGE_MAX_MS;
  if (windowResetMs !== null && valid(windowResetMs)) return windowResetMs;
  const times: number[] = [];
  for (const [iso] of (text ?? "").matchAll(ISO_TIME)) times.push(Date.parse(iso));
  for (const [, seconds] of (text ?? "").matchAll(EPOCH_SECONDS)) times.push(Number(seconds) * 1000);
  for (const [, span] of (text ?? "").matchAll(RELATIVE))
    times.push(now + [...span!.matchAll(/(\d+) ?([dhm])/giu)].reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit!.toLowerCase()]!, 0));
  const future = times.filter(valid);
  return future.length ? Math.max(...future) : now + OUTAGE_DEFAULT_MS;
}

/** Until when a reviewer profile is out, or null when it may run. */
export function reviewerOutUntil(store: Store, profile: Pick<Profile, "providerId" | "model">, now = Date.now()): number | null {
  const until = store.flagSetAt(outageKey(profile));
  return until !== null && until > now ? until : null;
}

/**
 * Marks a reviewer profile out until `until`; returns the mark's end. A blocked window's reset
 * (`fromWindow`) is the provider's account state and replaces the mark; a time read from text or
 * the default only lengthens it, so a failure that names no reset never shortens a known one.
 */
function markOut(store: Store, profile: Pick<Profile, "providerId" | "model">, until: number, fromWindow: boolean): number {
  const end = fromWindow ? until : Math.max(until, reviewerOutUntil(store, profile) ?? 0);
  store.upsertFlag(outageKey(profile), end);
  return end;
}

/** The profile a worker's brief names as its reviewer, by the worker's model family. */
export const reviewerProfileFor = (policy: Policy, worker: Pick<Profile, "providerId" | "model"> | null) =>
  profileFor(policy, seriesOf(worker) === "gpt" ? "reviewOfGpt" : "reviewOfClaude");

const profileName = (profile: Profile) => `${profile.model} ${profile.reasoningLevel}`;
const REASONS = { quota: "out of quota (usage limit)", unavailable: "its model is unavailable", out: "out (an earlier round hit a usage limit or an unavailable model)" } as const;
/** The plugin flag that claims one failed reviewer, so the two failure events act once. */
export const fallbackFlag = (threadId: string) => `reviewer-fallback:${threadId}`;
/** Set once a claimed reviewer's outcome reached its worker (or was handed back after a reload). */
const doneFlag = (threadId: string) => `reviewer-fallback-done:${threadId}`;
/** The pluginMetadata role of a fallback reviewer the plugin started. */
export const FALLBACK_ROLE = "fallback-reviewer";

interface EventRow { seq: number; type: string; data: unknown }

/** A reviewer the plugin switches: its worker, profiles, execution, and until when its profile is out. */
interface Switch {
  project: { id: string; name: string };
  worker: { ref: string; num: number; threadId: string | null };
  reviewer: Profile;
  fallback: Profile;
  execution: { permissionMode?: string };
  until: number;
}

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
    const resets = hint.resetsAtMs;
    // The other event may have claimed it first without the snapshot's reset: that still applies.
    return this.once(threadId, () => this.handle(threadId, hint), resets ? () => this.extend(threadId, resets) : undefined);
  }

  /** W560: a thread started (`thread.active`): a worker's reviewer on a profile marked out is switched now. */
  onStarted(thread: ThreadDto): Promise<void> {
    if (!this.outMarks(thread.providerId).length || !this.workerParent(thread.parentThreadId)) return Promise.resolve();
    return this.once(thread.id, () => this.switchEarly(thread));
  }

  /** W560: a thread went idle (`thread.idle`): a turn that completed on a profile marked out clears it. */
  async onIdle(thread: ThreadDto): Promise<void> {
    const { sdk, store } = this.deps;
    const marks = this.outMarks(thread.providerId);
    if (!marks.length) return;
    try {
      const model = (await sdk.threads.defaultExecutionOptions({ threadId: thread.id }))?.model;
      const mark = model ? marks.find((candidate) => candidate.key === outageKey({ providerId: thread.providerId, model })) : undefined;
      if (!mark) return;
      // A stop (the plugin's own switch included) also ends idle: only the latest request's turn,
      // completed, proves it runs; an older success behind a request stopped early does not.
      const [last] = await this.events(thread.id, ["client/turn/requested", "turn/completed"], "desc", 1);
      if (last?.type !== "turn/completed" || (last.data as { status?: unknown } | null)?.status !== "completed") return;
      // A failure that marked it again meanwhile is newer news: kept.
      store.clearFlagAt(mark.key, mark.at);
      this.deps.warn(`Reviewer ${thread.providerId}/${model} completed a turn in ${thread.id}: no longer marked out.`);
    } catch (error) {
      this.deps.warn(`Reviewer outage check for ${thread.id} failed: ${errorMessage(error)}`);
    }
  }

  /** The provider's profiles marked out now: a store read, so most events cost no BB call. */
  private outMarks(providerId: string) {
    const now = Date.now();
    return this.deps.store.flagsWithPrefix(`${OUTAGE_PREFIX}${providerId}/`).filter((mark) => mark.at > now);
  }

  /** Runs `work` for a thread after any call still running on it; `claimed` instead once the thread is claimed. */
  private once(threadId: string, work: () => Promise<void>, claimed?: () => Promise<void>): Promise<void> {
    const next = (this.running.get(threadId) ?? Promise.resolve())
      .then(() => (this.deps.store.hasFlag(fallbackFlag(threadId)) ? claimed?.() : work()))
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
    if (thread.archivedAt !== null || thread.deletedAt !== null || BUSY_STATUSES.has(thread.status)) return;
    const found = await this.reviewerOf(thread);
    if (!found) return;

    // The failed turn's own error: after its request, not a retry notice the turn outlived.
    const [request] = await this.events(threadId, ["client/turn/requested"], "desc", 1);
    const stored = (await this.events(threadId, ["provider/error"], "desc", 20, request?.seq))
      .map((row) => row.data as { message?: unknown; detail?: unknown; errorInfo?: ErrorInfo; willRetry?: unknown })
      .find((data) => data.willRetry !== true);
    // Claude Code and Codex store "Provider error" as the message and the provider's words in `detail`.
    const text = [stored?.detail, stored?.message].find((value): value is string => typeof value === "string" && value.trim() !== "") ?? hint.error ?? null;
    // A stored row is the failed turn's own account; turn.failed's errorInfo (which may come from
    // a retry notice) only stands in when the turn wrote none, as for a request refused at the door.
    const failure = classifyReviewerFailure(stored ? (stored.errorInfo ?? null) : (hint.errorInfo ?? null), text, hint.rateLimitBlocked);
    if (!failure) return;
    // W560: later rounds start on the fallback until the reset, whatever happens to this one.
    const window = hint.resetsAtMs ?? null;
    const reset = outageResetAt(text, window);
    const until = markOut(store, found.reviewer, reset, reset === window);
    await this.claim(thread, failure, { ...found, until });
  }

  /**
   * W560: a claimed reviewer's later failure event carries a blocked window's reset: its mark ends
   * then, and the worker, told the earlier deadline, hears the new one.
   */
  private async extend(threadId: string, resetsAtMs: number) {
    const { sdk, store } = this.deps;
    if (outageResetAt(null, resetsAtMs) !== resetsAtMs) return;
    const found = await this.reviewerOf((await sdk.threads.get({ threadId })) as ThreadDto);
    const before = found && reviewerOutUntil(store, found.reviewer);
    if (!found || !before) return;
    markOut(store, found.reviewer, resetsAtMs, true);
    // The worker reads minutes: a change within the announced minute needs no note.
    if (utcTime(before) === utcTime(resetsAtMs)) return;
    const { project, worker, reviewer } = found;
    store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId}: ${profileName(reviewer)} is out until ${utcTime(resetsAtMs)} (its provider's window), not ${utcTime(before)}.`);
    await sdk.threads
      .send({ threadId: worker.threadId!, mode: "steer-if-active", input: textInput(`Adventures · ${project.name} · Reviewer fallback\n\nCorrection: ${profileName(reviewer)} is out until ${utcTime(resetsAtMs)} (its provider's rate-limit window), not ${utcTime(before)}. Until ${utcTime(resetsAtMs)}, start each new round with the fallback reviewer command from your brief; from then on, with the reviewer command again.`) })
      .catch((cause) => store.log(project.id, "worker", `${worker.ref} could not be told its reviewer's new deadline: ${errorMessage(cause)}`));
  }

  /** W560: a reviewer that starts on a profile marked out moves to the fallback before it fails. */
  private async switchEarly(thread: ThreadDto) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    const found = await this.reviewerOf(thread);
    const until = found && reviewerOutUntil(this.deps.store, found.reviewer);
    if (!found || !until) return;
    // A reviewer given more work after a finished turn may hold a verdict (R8): left to run.
    if (await this.finishedTurn(thread.id)) return;
    await this.claim(thread, { reason: "out", detail: `the plugin keeps it out until ${utcTime(until)}` }, { ...found, until });
  }

  /**
   * The worker reviewer `thread` is, with its profiles and execution, or null: a direct child of a
   * current work worker, on the worker's reviewer profile, titled as a review, when a fallback differs.
   */
  private async reviewerOf(thread: ThreadDto) {
    const { sdk, store } = this.deps;
    const membership = this.workerParent(thread.parentThreadId);
    if (!membership) return null;
    const { project, worker } = membership;
    const policy = await this.deps.policy(project.id);
    const assignment = store.openAssignment(project.id, worker.num);
    const reviewer = reviewerProfileFor(policy, assignment?.profile ?? (worker.providerId && worker.model ? { providerId: worker.providerId, model: worker.model } : null));
    const fallback = profileFor(policy, "reviewFallback");
    // The reviewer command titles it "Review r<N> …"; a worker's own helper on that model is no reviewer.
    if (!fallbackDiffers(reviewer, fallback) || thread.providerId !== reviewer.providerId || !/\breview/iu.test(thread.title ?? "")) return null;
    // Unreadable execution is no evidence that this is the reviewer: leave it (the brief's way out).
    const execution = await sdk.threads.defaultExecutionOptions({ threadId: thread.id });
    if (!execution || execution.model !== reviewer.model) return null;
    return { project, worker, reviewer, fallback, execution };
  }

  /** Claims `thread` before any write: a later event, or a restart, never acts on it again. */
  private async claim(thread: ThreadDto, failure: ReviewerFailure, context: Switch) {
    // From here every outcome reaches the worker; a claim a reload cut short, through recover().
    this.deps.store.setFlag(fallbackFlag(thread.id));
    try {
      await this.replace(thread, failure, context);
    } finally {
      this.deps.store.setFlag(doneFlag(thread.id));
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
    { project, worker, reviewer, fallback, execution, until }: Switch,
  ) {
    const { sdk, store } = this.deps;
    const threadId = thread.id;

    const round = /\br(\d+)\b/iu.exec(thread.title ?? "")?.[1];
    const name = `${round ? `round ${round}` : "a review round"} (${thread.title ?? threadId}, ${threadId})`;
    const stopped = `Your reviewer for ${name} is ${REASONS[failure.reason]}: ${failure.detail}`;
    const notes: string[] = [];
    // W560: the worker's brief may still name the reviewer first.
    const keep = `Until ${utcTime(until)}, start each new round with the fallback reviewer command from your brief, not the reviewer command; from then on, with the reviewer command again.`;
    const tell = (text: string) =>
      sdk.threads
        .send({ threadId: worker.threadId!, mode: "steer-if-active", input: textInput(`Adventures · ${project.name} · Reviewer fallback\n\n${text}\n\n${keep}`) })
        .catch((cause) => store.log(project.id, "worker", `${worker.ref} could not be told about its reviewer ${threadId}: ${errorMessage(cause)}`));
    const runIt = (why: string) => {
      store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId} is ${REASONS[failure.reason]}; ${why}`);
      return tell(`${stopped}\n\n${why[0]!.toUpperCase()}${why.slice(1)} Run the round again with the fallback reviewer command from your brief; if it can't run either, report blocked.`);
    };

    let spawned: ThreadDto;
    try {
      // R8: a reviewer that finished a turn may have given its verdict, which is never redone.
      if (await this.finishedTurn(threadId)) {
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
      // R8: a reviewer switched as it started may have finished before the stop landed.
      if (failure.reason === "out" && (await this.finishedTurn(threadId))) {
        store.log(project.id, "worker", `${worker.ref}'s reviewer ${threadId} finished a turn before the plugin could switch it; not rerun on the fallback (R8).`);
        await tell(`Your reviewer for ${name} started on ${profileName(reviewer)} while it is marked out, but finished a turn before the plugin could switch it, so the plugin left it: a round that gave a verdict or findings stands. If it gave neither, run the round again with the fallback reviewer command from your brief.`);
        return;
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

  private async finishedTurn(threadId: string) {
    return (await this.events(threadId, ["turn/completed"], "desc", 100)).some((row) => (row.data as { status?: unknown } | null)?.status === "completed");
  }

  private async events(threadId: string, types: [string, ...string[]], order: "asc" | "desc", limit: number, afterSeq?: number): Promise<EventRow[]> {
    return (await this.deps.sdk.threads.events.list({ threadId, types, order, limit: String(limit), ...(afterSeq !== undefined ? { afterSeq: String(afterSeq) } : {}) } as never)) as EventRow[];
  }
}
