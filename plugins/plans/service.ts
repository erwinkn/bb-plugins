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
  /**
   * Hold a BB interaction on the plan's thread while waiting, so the thread
   * shows as awaiting the user and the composer becomes the review prompt.
   */
  hold?: boolean;
}

export interface PlanServiceOptions {
  /** Whether to message the thread when no `wait` call is attached. Read per review. */
  notifyUnattended?: () => Promise<boolean>;
  /** Interaction lifetime per request; BB caps it at one hour. Tests shorten it. */
  interactionChunkMs?: number;
}

/** The frontend `pendingInteraction` slot that renders the review prompt. */
export const REVIEW_INTERACTION_RENDERER = "plan-review";

const WAIT_POLL_MS = 5_000;
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
  // Rows left by a previous generation that was disposed mid-wait.
  db.prepare("DELETE FROM waits WHERE expires_at <= ?").run(Date.now());
  type WaiterEvent = { kind: "decision"; decision: ReviewDecision } | { kind: "revised"; latestVersionId: string };
  const waiters = new Map<string, Set<(event: WaiterEvent) => void>>();
  const notifyWaiters = (planId: string, event: WaiterEvent) => {
    for (const listener of [...(waiters.get(planId) ?? [])]) listener(event);
  };
  const notifyUnattended = options.notifyUnattended ?? (async () => true);
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
    plan.comments.filter((item) => !item.resolved && item.sentAt === null && (action === "feedback" || item.kind === "looksGood"));
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
      : `Revise plan ${plan.id} with plans_submit (planId, expectedVersionId ${version.id}) or \`bb plans submit\`, then wait for review again. Do not implement yet.`,
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
  /** Waits on stored state and in-process events only; no BB interaction. */
  const waitLocal = ({ id, versionId, timeoutMs, signal }: WaitInput): Promise<WaitResult> => {
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
      db.prepare("INSERT INTO waits (id, plan_id, expires_at) VALUES (?, ?, ?)").run(waitId, plan.id, Date.now() + timeoutMs + WAIT_GRACE_MS);
      const cleanup = () => {
        set.delete(onEvent);
        if (set.size === 0) waiters.delete(plan.id);
        clearTimeout(timer);
        clearInterval(poller);
        signal?.removeEventListener("abort", onAbort);
        try { db.prepare("DELETE FROM waits WHERE id = ?").run(waitId); } catch { /* database closed on dispose */ }
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
  /**
   * The agent-facing wait. With `hold`, a BB interaction stays pending on the
   * thread for the whole wait: BB marks the thread as needing the user, and the
   * composer shows the plugin's review prompt. The decision made in the panel
   * aborts the interaction; the prompt's own buttons dismiss the wait instead.
   */
  const wait = async (input: WaitInput): Promise<WaitResult> => {
    const plan = get({ id: input.id });
    const version = input.versionId ? plan.versions.find((item) => item.id === input.versionId) : plan.versions.at(-1);
    if (!version) throw new Error("Version not found.");
    const settledAlready = storedDecision(plan.id, version.id) !== null || plan.versions.at(-1)!.id !== version.id;
    if (!input.hold || plan.threadId === null || settledAlready) return waitLocal(input);
    const threadId = plan.threadId;
    const deadline = Date.now() + input.timeoutMs;
    const chunk = Math.min(options.interactionChunkMs ?? INTERACTION_MAX_MS, INTERACTION_MAX_MS);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return waitLocal({ ...input, timeoutMs: 1 });
      const local = new AbortController();
      const prompt = new AbortController();
      const onOuterAbort = () => { local.abort(); prompt.abort(); };
      input.signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const decision = waitLocal({ ...input, timeoutMs: remaining, signal: local.signal })
          .then((result) => ({ kind: "decision" as const, result }));
        const interaction = bb.ui.requestInput({
          threadId,
          rendererId: REVIEW_INTERACTION_RENDERER,
          title: `Review plan: ${plan.title}`,
          payload: { planId: plan.id, versionId: version.id, title: plan.title, versionNumber: version.number },
          timeoutMs: Math.max(1, Math.min(chunk, remaining)),
        }, { signal: prompt.signal }).then(
          (result) => ({ kind: "interaction" as const, result }),
          (error: unknown) => ({ kind: "interaction-failed" as const, error }),
        );
        const first = await Promise.race([decision, interaction]);
        if (first.kind === "decision") {
          prompt.abort();
          await interaction;
          return first.result;
        }
        local.abort();
        await decision.catch(() => undefined);
        if (first.kind === "interaction-failed") {
          // The prompt could not be shown (thread archived, host limit). Keep
          // waiting without it rather than failing the agent's call.
          bb.log.warn(`Review prompt unavailable for plan ${plan.id}: ${first.error instanceof Error ? first.error.message : String(first.error)}`);
          return waitLocal({ ...input, timeoutMs: Math.max(1, deadline - Date.now()) });
        }
        const settled = first.result;
        if (settled.outcome === "submitted" || settled.reason === "user") {
          return { status: "dismissed", planId: plan.id, versionId: version.id,
            instruction: "The user dismissed the review prompt without deciding. Ask how to proceed; the plan stays open in Review plan and a later decision arrives as a message." };
        }
        if (settled.reason === "timeout") continue;
        return { status: "cancelled", planId: plan.id, versionId: version.id, reason: settled.reason,
          instruction: `Waiting stopped (${settled.reason}). Run \`bb plans wait ${plan.id} --version-id ${version.id}\` to resume; a decision made meanwhile is returned immediately.` };
      } finally {
        input.signal?.removeEventListener("abort", onOuterAbort);
      }
    }
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
    const open = plan.comments.filter((item) => !item.resolved);
    if (input.action === "approve" && open.some((item) => item.kind !== "looksGood" && (item.sentAt === null || item.versionId === version.id))) throw new Error("Send or delete pending comments, then review the next revision before approving.");
    const unsent = open.filter((item) => item.sentAt === null);
    if (input.action === "feedback" && !unsent.length && !input.note.trim()) throw new Error("Add a comment or a review note before sending feedback.");
    // Check the delivered state before sending. Receipt timestamps add bytes;
    // hitting the history limit must not strand a successfully sent review.
    serialize({ ...plan, status: input.action === "approve" ? "approved" : "revising",
      comments: plan.comments.map((item) => (input.action === "feedback" || item.kind === "looksGood") && !item.resolved && item.sentAt === null
        ? { ...item, sentAt: Date.now() } : item) });
    if (plan.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: plan.threadId });
      if (thread.deletedAt || thread.archivedAt) throw new Error("The linked thread is deleted or archived. Restore it before sending a review.");
    }
    // An agent blocked in `bb plans wait` gets the decision as its command
    // result. The thread message is only for agents that are not waiting; it
    // never repeats the plan text, which the agent already has or can fetch.
    const notify = plan.threadId !== null && !attended(plan.id) && (await notifyUnattended()) ? plan.threadId : null;
    const annotations = JSON.stringify(delivered(plan, input.action).map(({ versionId, quote, body, kind }) => ({ versionId, quote, body, kind: kind ?? "comment" })), null, 2);
    const fetchHint = `Run \`bb plans get ${plan.id} --version-id ${version.id}\` if the plan text is no longer in context.`;
    const text = input.action === "approve"
      ? `The user approved plan ${plan.id}, version ${version.number} (${version.id}), and asked you to start implementation. Implement that exact version. ${fetchHint} This does not authorize a merge or deployment.\n\nPositive annotations:\n${annotations}\n${ANNOTATION_GUIDE}\n\nUser note: ${input.note}`
      : `The user requests changes to plan ${plan.id}, version ${version.number} (${version.id}). Revise the plan using plans_submit with planId and expectedVersionId ${version.id}, then wait for review with \`bb plans wait\`. Do not start implementation. ${fetchHint}\n\nReview comments (each versionId identifies the reviewed snapshot):\n${annotations}\n${ANNOTATION_GUIDE}\n\nUser note: ${input.note}`;
    // The SDK preflight above yields. Recheck inside the synchronous transaction
    // so two browser windows cannot deliver the same plan at the same time.
    db.transaction(() => {
      const fresh = editable(plan.id);
      current(fresh, input.versionId);
      if (fresh.updatedAt !== plan.updatedAt || JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("The review changed. Refresh before sending.");
      db.prepare("INSERT INTO deliveries (id, plan_id, payload, state) VALUES (?, ?, ?, 'pending')").run(input.requestId, plan.id, JSON.stringify(input));
    })();
    if (notify !== null) {
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
      comments: plan.comments.filter((c) => c.versionId === item.id).map(({ id, quote, body, kind, resolved, sentAt }) => ({ id, quote, body, kind: kind ?? "comment", resolved, sent: sentAt !== null })),
    };
  };
  return {
    get, create, revise, submitReview, wait, version,
    list: ({ threadId, offset = 0 }: { threadId?: string; offset?: number }) => {
      const rows = db.prepare("SELECT body FROM plans WHERE (? IS NULL OR json_extract(body, '$.threadId') = ?) ORDER BY json_extract(body, '$.updatedAt') DESC, id LIMIT 10 OFFSET ?").all(threadId ?? null, threadId ?? null, offset) as { body: string }[];
      return rows.map(({ body }) => planSchema.parse(JSON.parse(body)))
        .map((p) => ({ ...p, versions: p.versions.slice(-1), comments: [] }));
    },
    addComment: (input: z.input<typeof addCommentSchema>) => {
      const { id, versionId, quote, body, kind } = addCommentSchema.parse(input);
      const plan = editable(id);
      if (!plan.versions.some((v) => v.id === versionId)) throw new Error("Version not found.");
      if (plan.status === "approved") throw new Error("Submit a new version before adding comments.");
      plan.comments.push({ id: randomUUID(), versionId, quote, body, ...(kind ? { kind } : {}), resolved: false, createdAt: Date.now(), sentAt: null });
      return save(plan);
    },
    resolveComment: ({ id, commentId, resolved }: { id: string; commentId: string; resolved: boolean }) => {
      const plan = editable(id);
      if (plan.status === "approved") throw new Error("Submit a new version before changing comments.");
      const item = comment(plan, commentId);
      item.resolved = resolved;
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
    remove: ({ id }: { id: string }) => {
      editable(id);
      db.transaction(() => {
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
