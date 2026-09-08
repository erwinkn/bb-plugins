import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { addCommentSchema, createSchema, planSchema, reviseSchema, reviewSchema, type Plan, type PlanComment } from "./contract";
import type { z } from "zod";

/** What a waiting agent receives once the reviewer decides on a version. */
export interface ReviewDecision {
  status: "feedback" | "approved";
  planId: string;
  versionId: string;
  versionNumber: number;
  note: string;
  comments: Array<Pick<PlanComment, "quote" | "body"> & { kind: NonNullable<PlanComment["kind"]>; versionId: string }>;
  receipt: string;
  instruction: string;
}

export type WaitResult =
  | ReviewDecision
  | { status: "pending"; planId: string; versionId: string; instruction: string }
  | { status: "superseded"; planId: string; versionId: string; latestVersionId: string; instruction: string }
  | { status: "dismissed"; planId: string; versionId: string; instruction: string }
  | { status: "cancelled"; planId: string; versionId: string; reason: string; instruction: string };

export interface WaitInput {
  id: string;
  versionId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PlanServiceOptions {
  /** Interaction lifetime per request; BB caps it at one hour. Tests shorten it. */
  interactionChunkMs?: number;
  /** Delay before a detached hold retries a prompt the thread could not show. */
  holdRetryMs?: number;
}

/** The frontend `pendingInteraction` slot that renders the review prompt. */
export const REVIEW_INTERACTION_RENDERER = "plan-review";

const WAIT_POLL_MS = 5_000;
const HOLD_RETRY_MS = 15_000;
/** How long past its timeout a wait row still counts as attended. */
const WAIT_GRACE_MS = 15_000;
const INTERACTION_MAX_MS = 60 * 60 * 1000;

const ANNOTATION_GUIDE = "Annotation kinds: redline requests removal of the quoted text; looksGood records that the passage needs no change; comment contains the user's requested change or question.";

export function createPlanService(bb: BbPluginApi, options: PlanServiceOptions = {}) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE plans (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE deliveries (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL)",
    "ALTER TABLE deliveries ADD COLUMN decision TEXT",
    "CREATE TABLE waits (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  ]);
  // A reload disposes every in-process waiter, so no row can still be attended.
  // Leaving them would make the next decision skip the thread message.
  db.prepare("DELETE FROM waits").run();
  type WaiterEvent = { kind: "decision"; decision: ReviewDecision } | { kind: "revised"; latestVersionId: string };
  const waiters = new Map<string, Set<(event: WaiterEvent) => void>>();
  const notifyWaiters = (planId: string, event: WaiterEvent) => {
    for (const listener of [...(waiters.get(planId) ?? [])]) listener(event);
  };
  const get = ({ id }: { id: string }): Plan => {
    const row = db.prepare("SELECT body FROM plans WHERE id = ?").get(id) as { body: string } | undefined;
    if (!row) throw new Error("Plan not found.");
    return planSchema.parse(JSON.parse(row.body));
  };
  const serialize = (plan: Plan) => {
    const body = JSON.stringify(planSchema.parse(plan));
    if (Buffer.byteLength(body) > 2_000_000) throw new Error("This plan has reached the history limit. Create a new plan to continue.");
    return body;
  };
  const save = (plan: Plan) => {
    plan.updatedAt = Date.now();
    const body = serialize(plan);
    db.prepare("INSERT INTO plans (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").run(plan.id, body);
    bb.realtime.publish("plans-changed", { id: plan.id });
    return plan;
  };
  const pending = (id: string) => db.prepare("SELECT id FROM deliveries WHERE plan_id = ? AND state = 'pending'").get(id);
  const editable = (id: string) => {
    if (pending(id)) throw new Error("A review delivery is pending or could not be confirmed. Check the thread before sending again. Use bb plans delivery to inspect it.");
    return get({ id });
  };
  const current = (plan: Plan, versionId: string) => {
    const version = plan.versions.at(-1)!;
    if (version.id !== versionId) throw new Error("The plan changed. Open the latest version before continuing.");
    return version;
  };
  const comment = (plan: Plan, commentId: string) => {
    const item = plan.comments.find((item) => item.id === commentId);
    if (!item) throw new Error("Comment not found.");
    return item;
  };
  const create = async (input: z.infer<typeof createSchema>) => {
    const { title, markdown, threadId, sample = false } = createSchema.parse(input);
    if (sample && threadId) throw new Error("Sample plans cannot be linked to a thread.");
    if (!sample && !threadId) throw new Error("Choose a thread for this plan, or create a sample.");
    let projectId: string | null = null;
    let projectName: string | null = null;
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread || thread.deletedAt) throw new Error("The selected thread does not exist.");
      projectId = thread.projectId;
      const project = await bb.sdk.projects.get({ projectId });
      projectName = project.name;
    }
    const now = Date.now();
    const plan = save({ id: randomUUID(), title, threadId: threadId ?? null, projectId, projectName, sample,
      status: "review", createdAt: now, updatedAt: now,
      versions: [{ id: randomUUID(), number: 1, markdown, createdAt: now }], comments: [] });
    if (plan.threadId) bb.realtime.publish("plan-submitted", { id: plan.id, threadId: plan.threadId });
    return plan;
  };
  const revise = (input: z.infer<typeof reviseSchema>) => {
    const { id, markdown, expectedVersionId } = reviseSchema.parse(input);
    const plan = editable(id);
    const previous = current(plan, expectedVersionId);
    if (previous.markdown === markdown && plan.status !== "revising") return plan;
    const next = { id: randomUUID(), number: previous.number + 1, markdown, createdAt: Date.now() };
    plan.versions.push(next);
    plan.status = "review";
    const saved = save(plan);
    if (plan.threadId) bb.realtime.publish("plan-submitted", { id: plan.id, threadId: plan.threadId });
    notifyWaiters(plan.id, { kind: "revised", latestVersionId: next.id });
    return saved;
  };
  /** Comments a review delivers: every unsent one for feedback, positives only for approval. */
  const delivered = (plan: Plan, action: "feedback" | "approve") =>
    plan.comments.filter((item) => item.sentAt === null && (action === "feedback" || item.kind === "looksGood"));
  const decisionFor = (plan: Plan, version: Plan["versions"][number], input: z.infer<typeof reviewSchema>): ReviewDecision => ({
    status: input.action === "approve" ? "approved" : "feedback",
    planId: plan.id,
    versionId: version.id,
    versionNumber: version.number,
    note: input.note,
    comments: delivered(plan, input.action).map(({ quote, body, kind, versionId }) => ({ quote, body, kind: kind ?? "comment", versionId })),
    receipt: input.requestId,
    instruction: input.action === "approve"
      ? `Implement plan ${plan.id} version ${version.number} exactly. Run \`bb plans get ${plan.id} --version-id ${version.id}\` if it is no longer in context. This does not authorize a merge or deployment.`
      : `Revise plan ${plan.id} with plans_submit (planId, expectedVersionId ${version.id}) or \`bb plans submit\` and follow its result. Do not implement yet.`,
  });
  const storedDecision = (planId: string, versionId: string): ReviewDecision | null => {
    const rows = db.prepare("SELECT decision FROM deliveries WHERE plan_id = ? AND state = 'sent' AND decision IS NOT NULL").all(planId) as { decision: string }[];
    for (const { decision } of rows) {
      const parsed = JSON.parse(decision) as ReviewDecision;
      if (parsed.versionId === versionId) return parsed;
    }
    return null;
  };
  const completeDelivery = (input: z.infer<typeof reviewSchema>) => {
    const plan = get({ id: input.id });
    const version = current(plan, input.versionId);
    const decision = decisionFor(plan, version, input);
    plan.status = input.action === "approve" ? "approved" : "revising";
    for (const item of delivered(plan, input.action)) item.sentAt = Date.now();
    const result = db.transaction(() => {
      const saved = save(plan);
      db.prepare("UPDATE deliveries SET state = 'sent', decision = ? WHERE id = ?").run(JSON.stringify(decision), input.requestId);
      return saved;
    })();
    notifyWaiters(plan.id, { kind: "decision", decision });
    return result;
  };
  /**
   * Waits on stored state and in-process events only; no BB interaction.
   * `attend` records the wait so a decision skips the thread message; a
   * detached hold passes false because the message is how its agent hears.
   */
  const waitLocal = ({ id, versionId, timeoutMs, signal }: WaitInput, attend = true): Promise<WaitResult> => {
    const plan = get({ id });
    const latest = plan.versions.at(-1)!;
    const version = versionId ? plan.versions.find((item) => item.id === versionId) : latest;
    if (!version) throw new Error("Version not found.");
    const done = storedDecision(plan.id, version.id);
    if (done) return Promise.resolve(done);
    if (version.id !== latest.id) {
      return Promise.resolve({ status: "superseded", planId: plan.id, versionId: version.id, latestVersionId: latest.id,
        instruction: `Version ${version.number} was replaced without a review. Wait on the latest version ${latest.id} instead.` });
    }
    if (signal?.aborted) throw new Error("Wait cancelled.");
    const waitId = randomUUID();
    const superseded = (latestVersionId: string): WaitResult => ({
      status: "superseded", planId: plan.id, versionId: version.id, latestVersionId,
      instruction: `Version ${version.number} was replaced. Wait on version ${latestVersionId} instead.`,
    });
    return new Promise<WaitResult>((resolve, reject) => {
      const set = waiters.get(plan.id) ?? new Set();
      waiters.set(plan.id, set);
      // Attendance lives in SQLite so a review that lands after a plugin reload
      // still knows an agent is waiting and skips the thread message.
      if (attend) db.prepare("INSERT INTO waits (id, plan_id, expires_at) VALUES (?, ?, ?)").run(waitId, plan.id, Date.now() + timeoutMs + WAIT_GRACE_MS);
      const cleanup = () => {
        set.delete(onEvent);
        if (set.size === 0) waiters.delete(plan.id);
        clearTimeout(timer);
        clearInterval(poller);
        signal?.removeEventListener("abort", onAbort);
        if (attend) try { db.prepare("DELETE FROM waits WHERE id = ?").run(waitId); } catch { /* database closed on dispose */ }
      };
      const onEvent = (event: WaiterEvent) => {
        cleanup();
        const latestVersionId = event.kind === "decision" ? event.decision.versionId : event.latestVersionId;
        resolve(event.kind === "decision" && latestVersionId === version.id ? event.decision : superseded(latestVersionId));
      };
      const onAbort = () => { cleanup(); reject(new Error("Wait cancelled.")); };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ status: "pending", planId: plan.id, versionId: version.id,
          instruction: `No review yet. Run \`bb plans wait ${plan.id} --version-id ${version.id}\` again to keep waiting.` });
      }, timeoutMs);
      // A decision written by another plugin generation (after a reload) never
      // reaches this process's waiters; the poll catches it.
      const poller = setInterval(() => {
        try {
          const decision = storedDecision(plan.id, version.id);
          if (decision) return onEvent({ kind: "decision", decision });
          const latestVersionId = get({ id: plan.id }).versions.at(-1)!.id;
          if (latestVersionId !== version.id) onEvent({ kind: "revised", latestVersionId });
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, WAIT_POLL_MS);
      set.add(onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const attended = (planId: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM waits WHERE plan_id = ? AND expires_at > ?").get(planId, Date.now()) as { n: number }).n > 0;
  const locate = (id: string, versionId?: string) => {
    const plan = get({ id });
    const version = versionId ? plan.versions.find((item) => item.id === versionId) : plan.versions.at(-1);
    if (!version) throw new Error("Version not found.");
    const settled = storedDecision(plan.id, version.id) !== null || plan.versions.at(-1)!.id !== version.id;
    return { plan, version, settled };
  };
  type PromptOutcome =
    | { kind: "decision"; result: WaitResult }
    | { kind: "timeout" }
    | { kind: "dismissed" }
    | { kind: "stopped"; reason: string }
    | { kind: "unavailable"; error: unknown };
  /**
   * One prompt chunk: a BB interaction pending on the thread (so BB marks it as
   * needing the user and the composer shows the review prompt) raced against
   * the local wait for a decision. BB caps an interaction at an hour; callers
   * loop on `timeout` to keep the prompt up. `attend` is passed to the local wait.
   */
  const promptChunk = async (
    plan: Plan, version: Plan["versions"][number], threadId: string,
    { timeoutMs, signal, attend }: { timeoutMs: number; signal?: AbortSignal; attend: boolean },
  ): Promise<PromptOutcome> => {
    if (signal?.aborted) throw new Error("Wait cancelled.");
    const local = new AbortController();
    const prompt = new AbortController();
    const onAbort = () => { local.abort(); prompt.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const decision = Promise.resolve()
        .then(() => waitLocal({ id: plan.id, versionId: version.id, timeoutMs, signal: local.signal }, attend))
        .then((result) => ({ kind: "decision" as const, result }), (error: unknown) => ({ kind: "failed" as const, error }));
      const interaction = bb.ui.requestInput({
        threadId,
        rendererId: REVIEW_INTERACTION_RENDERER,
        title: `Review plan: ${plan.title}`,
        payload: { planId: plan.id, versionId: version.id, title: plan.title, versionNumber: version.number },
        timeoutMs,
      }, { signal: prompt.signal }).then(
        (result) => ({ kind: "interaction" as const, result }),
        (error: unknown) => ({ kind: "unavailable" as const, error }),
      );
      const first = await Promise.race([decision, interaction]);
      if (first.kind === "decision" || first.kind === "failed") {
        // Never leave the prompt up without a wait behind it.
        prompt.abort();
        await interaction;
        if (first.kind === "failed") throw first.error instanceof Error ? first.error : new Error(String(first.error));
        return first.result.status === "pending" ? { kind: "timeout" } : first;
      }
      local.abort();
      await decision;
      if (first.kind === "unavailable") return first;
      const settled = first.result;
      if (settled.outcome === "submitted" || settled.reason === "user") return { kind: "dismissed" };
      if (settled.reason === "timeout") return { kind: "timeout" };
      return { kind: "stopped", reason: settled.reason };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const chunkMs = () => Math.min(options.interactionChunkMs ?? INTERACTION_MAX_MS, INTERACTION_MAX_MS);
  /**
   * The attached wait: an agent blocks on it (tool call or `bb plans wait`)
   * and receives the decision as its result, so no thread message is sent.
   */
  const wait = async (input: WaitInput): Promise<WaitResult> => {
    const { plan, version, settled } = locate(input.id, input.versionId);
    if (plan.threadId === null || settled) return waitLocal(input);
    const deadline = Date.now() + input.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return waitLocal({ ...input, timeoutMs: 1 });
      const outcome = await promptChunk(plan, version, plan.threadId, { timeoutMs: Math.min(chunkMs(), remaining), signal: input.signal, attend: true });
      switch (outcome.kind) {
        case "decision": return outcome.result;
        case "timeout": continue;
        case "dismissed":
          return { status: "dismissed", planId: plan.id, versionId: version.id,
            instruction: "The user dismissed the review prompt without deciding. Ask how to proceed; the plan stays open in Review plan and a later decision arrives as a message." };
        case "stopped":
          return { status: "cancelled", planId: plan.id, versionId: version.id, reason: outcome.reason,
            instruction: `Waiting stopped (${outcome.reason}). Run \`bb plans wait ${plan.id} --version-id ${version.id}\` to resume; a decision made meanwhile is returned immediately.` };
        case "unavailable":
          // The prompt could not be shown (thread archived, another prompt
          // pending). Keep waiting without it rather than failing the call.
          bb.log.warn(`Review prompt unavailable for plan ${plan.id}: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
          return waitLocal({ ...input, timeoutMs: Math.max(1, deadline - Date.now()) });
      }
    }
  };
  const holds = new Map<string, () => Promise<void>>();
  const release = async (planId: string) => {
    await holds.get(planId)?.();
  };
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => { signal.removeEventListener("abort", done); resolve(); }, ms);
      const done = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener("abort", done, { once: true });
    });
  /**
   * The detached hold, for providers whose tool calls cannot stay open
   * (Cursor): the same prompt, with no agent attached, so the decision goes
   * out as the thread message that starts the agent's next turn. Ends with
   * the decision, a newer version, the user skipping the prompt, deletion of
   * the plan, or a plugin reload (the prompt is not re-established afterwards).
   * A prompt the thread cannot show yet (another interaction is pending) is
   * retried, since no agent is left to notice the failure.
   */
  const hold = ({ id, versionId }: { id: string; versionId?: string }): void => {
    const { plan, version, settled } = locate(id, versionId);
    if (plan.threadId === null) throw new Error("Only plans linked to a thread can hold a review prompt.");
    if (settled) return;
    const threadId = plan.threadId;
    const stop = new AbortController();
    const previous = holds.get(plan.id);
    const run = (async () => {
      await previous?.();
      while (!stop.signal.aborted) {
        let outcome: PromptOutcome;
        try {
          outcome = await promptChunk(plan, version, threadId, { timeoutMs: chunkMs(), signal: stop.signal, attend: false });
        } catch (error) {
          // The plan was deleted or the hold was released mid-chunk; nothing to prompt for.
          if (!stop.signal.aborted) bb.log.warn(`Review hold for plan ${plan.id} ended: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (outcome.kind === "timeout") continue;
        if (outcome.kind === "unavailable") {
          bb.log.warn(`Review prompt unavailable for plan ${plan.id}, retrying: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
          await sleep(options.holdRetryMs ?? HOLD_RETRY_MS, stop.signal);
          if (stop.signal.aborted) return;
          try {
            if (locate(plan.id, version.id).settled) return;
          } catch {
            return;
          }
          continue;
        }
        return;
      }
    })().finally(() => {
      if (holds.get(plan.id) === releaseThis) holds.delete(plan.id);
    });
    const releaseThis = async () => {
      stop.abort();
      await run.catch(() => undefined);
    };
    holds.set(plan.id, releaseThis);
  };
  const submitReview = async (input: z.infer<typeof reviewSchema>) => {
    input = reviewSchema.parse(input);
    const previous = db.prepare("SELECT payload, state FROM deliveries WHERE id = ?").get(input.requestId) as { payload: string; state: string } | undefined;
    if (previous) {
      if (previous.payload !== JSON.stringify(input)) throw new Error("This request ID belongs to a different review.");
      if (previous.state === "sent") return get({ id: input.id });
      throw new Error("Delivery could not be confirmed. Check the linked thread; do not submit the review again. Use bb plans delivery to inspect it.");
    }
    const plan = editable(input.id);
    const version = current(plan, input.versionId);
    if (plan.status === "approved") throw new Error("This version is already approved.");
    if (input.action === "approve" && plan.status === "revising") throw new Error("Review the next revision before approving. Feedback has been sent for this version.");
    const open = plan.comments;
    if (input.action === "approve" && open.some((item) => item.kind !== "looksGood" && (item.sentAt === null || item.versionId === version.id))) throw new Error("Send or delete pending comments, then review the next revision before approving.");
    const unsent = open.filter((item) => item.sentAt === null);
    if (input.action === "feedback" && !unsent.length && !input.note.trim()) throw new Error("Add a comment or a review note before sending feedback.");
    // Check the delivered state before sending. Receipt timestamps add bytes;
    // hitting the history limit must not strand a successfully sent review.
    serialize({ ...plan, status: input.action === "approve" ? "approved" : "revising",
      comments: plan.comments.map((item) => (input.action === "feedback" || item.kind === "looksGood") && item.sentAt === null
        ? { ...item, sentAt: Date.now() } : item) });
    if (plan.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: plan.threadId });
      if (thread.deletedAt || thread.archivedAt) throw new Error("The linked thread is deleted or archived. Restore it before sending a review.");
    }
    // An agent blocked in `bb plans wait` gets the decision as its command
    // result. The thread message is only for agents that are not waiting; it
    // never repeats the plan text, which the agent already has or can fetch.
    const notify = plan.threadId !== null && !attended(plan.id) ? plan.threadId : null;
    const annotations = JSON.stringify(delivered(plan, input.action).map(({ versionId, quote, body, kind }) => ({ versionId, quote, body, kind: kind ?? "comment" })), null, 2);
    const fetchHint = `Run \`bb plans get ${plan.id} --version-id ${version.id}\` if the plan text is no longer in context.`;
    const text = input.action === "approve"
      ? `The user approved plan ${plan.id}, version ${version.number} (${version.id}), and asked you to start implementation. Implement that exact version. ${fetchHint} This does not authorize a merge or deployment.\n\nPositive annotations:\n${annotations}\n${ANNOTATION_GUIDE}\n\nUser note: ${input.note}`
      : `The user requests changes to plan ${plan.id}, version ${version.number} (${version.id}). Revise the plan using plans_submit with planId and expectedVersionId ${version.id} and follow its result. Do not start implementation. ${fetchHint}\n\nReview comments (each versionId identifies the reviewed snapshot):\n${annotations}\n${ANNOTATION_GUIDE}\n\nUser note: ${input.note}`;
    // The SDK preflight above yields. Recheck inside the synchronous transaction
    // so two browser windows cannot deliver the same plan at the same time.
    db.transaction(() => {
      const fresh = editable(plan.id);
      current(fresh, input.versionId);
      if (fresh.updatedAt !== plan.updatedAt || JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("The review changed. Refresh before sending.");
      db.prepare("INSERT INTO deliveries (id, plan_id, payload, state) VALUES (?, ?, ?, 'pending')").run(input.requestId, plan.id, JSON.stringify(input));
    })();
    if (notify !== null) {
      // Clear the held prompt first so the message reaches a free thread.
      await release(plan.id);
      try {
        await bb.sdk.threads.send({ threadId: notify, mode: "queue-if-active", input: [{ type: "text", text: `${text}\n\nReview receipt: ${input.requestId}`, mentions: [] }] });
      } catch (error) {
        bb.log.error(`Review delivery ${input.requestId} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error(`Delivery could not be confirmed. Check the linked thread for review receipt ${input.requestId} before retrying. Use bb plans delivery ${input.requestId} to inspect and resolve the delivery.`);
      }
    }
    return completeDelivery(input);
  };
  /** One version with its comments: what an agent needs after context loss. */
  const version = ({ id, versionId }: { id: string; versionId?: string }) => {
    const plan = get({ id });
    const item = versionId ? plan.versions.find((v) => v.id === versionId) : plan.versions.at(-1);
    if (!item) throw new Error("Version not found.");
    return {
      planId: plan.id, title: plan.title, status: plan.status, threadId: plan.threadId,
      latestVersionId: plan.versions.at(-1)!.id,
      version: item,
      comments: plan.comments.filter((c) => c.versionId === item.id).map(({ id, quote, body, kind, sentAt }) => ({ id, quote, body, kind: kind ?? "comment", sent: sentAt !== null })),
    };
  };
  return {
    get, create, revise, submitReview, wait, hold, version,
    list: ({ threadId, offset = 0 }: { threadId?: string; offset?: number }) => {
      const rows = db.prepare("SELECT body FROM plans WHERE (? IS NULL OR json_extract(body, '$.threadId') = ?) ORDER BY json_extract(body, '$.updatedAt') DESC, id LIMIT 10 OFFSET ?").all(threadId ?? null, threadId ?? null, offset) as { body: string }[];
      return rows.map(({ body }) => planSchema.parse(JSON.parse(body)))
        .map((p) => ({ ...p, versions: p.versions.slice(-1), comments: [] }));
    },
    addComment: (input: z.input<typeof addCommentSchema>) => {
      const { id, versionId, quote, body, kind, prefix, suffix, position } = addCommentSchema.parse(input);
      const plan = editable(id);
      if (!plan.versions.some((v) => v.id === versionId)) throw new Error("Version not found.");
      if (plan.status === "approved") throw new Error("Submit a new version before adding comments.");
      plan.comments.push({
        id: randomUUID(), versionId, quote, body, ...(kind ? { kind } : {}),
        ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}), ...(position !== undefined ? { position } : {}),
        createdAt: Date.now(), sentAt: null,
      });
      return save(plan);
    },
    updateComment: ({ id, commentId, body }: { id: string; commentId: string; body: string }) => {
      const plan = editable(id);
      if (plan.status === "approved") throw new Error("Submit a new version before changing comments.");
      const item = comment(plan, commentId);
      if (item.sentAt !== null) throw new Error("Sent comments cannot be edited.");
      item.body = body;
      return save(plan);
    },
    removeComment: ({ id, commentId }: { id: string; commentId: string }) => {
      const plan = editable(id);
      if (plan.status === "approved") throw new Error("Submit a new version before changing comments.");
      if (comment(plan, commentId).sentAt !== null) throw new Error("Sent comments cannot be deleted.");
      plan.comments = plan.comments.filter((item) => item.id !== commentId);
      return save(plan);
    },
    remove: async ({ id }: { id: string }) => {
      editable(id);
      // Drop the review prompt before the plan it points at disappears.
      await release(id);
      db.transaction(() => {
        // A review may have been sent while the hold was releasing; its receipt
        // must not be deleted from under the agent. Re-check inside the transaction.
        editable(id);
        db.prepare("DELETE FROM plans WHERE id = ?").run(id);
        db.prepare("DELETE FROM deliveries WHERE plan_id = ?").run(id);
      })();
      bb.realtime.publish("plans-changed", { id });
      return { ok: true as const };
    },
    delivery: (id: string, resolution?: "sent" | "not-sent") => {
      const row = db.prepare("SELECT payload, state FROM deliveries WHERE id = ?").get(id) as { payload: string; state: string } | undefined;
      if (!row) throw new Error("Review receipt not found.");
      if (resolution && row.state === "pending") {
        if (resolution === "sent") completeDelivery(reviewSchema.parse(JSON.parse(row.payload)));
        else db.prepare("DELETE FROM deliveries WHERE id = ?").run(id);
      }
      return { requestId: id, state: resolution ?? row.state, review: JSON.parse(row.payload) };
    },
  };
}
