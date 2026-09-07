import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { addCommentSchema, createSchema, planSchema, reviseSchema, reviewSchema, type Plan } from "./contract";
import type { z } from "zod";

export function createPlanService(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE plans (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE deliveries (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL)",
  ]);
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
    plan.versions.push({ id: randomUUID(), number: previous.number + 1, markdown, createdAt: Date.now() });
    plan.status = "review";
    const saved = save(plan);
    if (plan.threadId) bb.realtime.publish("plan-submitted", { id: plan.id, threadId: plan.threadId });
    return saved;
  };
  const completeDelivery = (input: z.infer<typeof reviewSchema>) => {
    const plan = get({ id: input.id });
    current(plan, input.versionId);
    plan.status = input.action === "approve" ? "approved" : "revising";
    for (const item of plan.comments) {
      if (!item.resolved && item.sentAt === null && (input.action === "feedback" || item.kind === "looksGood")) item.sentAt = Date.now();
    }
    return db.transaction(() => {
      const result = save(plan);
      db.prepare("UPDATE deliveries SET state = 'sent' WHERE id = ?").run(input.requestId);
      return result;
    })();
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
    const annotations = JSON.stringify(unsent.map(({ id, versionId, quote, body, kind }) => ({ id, versionId, quote, body, kind: kind ?? "comment" })), null, 2);
    const annotationGuide = "Annotation kinds: redline requests removal of the quoted text; looksGood records that the passage needs no change; comment contains the user's requested change or question.";
    const text = input.action === "approve"
      ? `The user approved plan ${plan.id}, version ${version.number} (${version.id}), and asked you to start implementation. Implement this exact plan. This does not authorize a merge or deployment.\n\n${version.markdown}\n\nPositive annotations:\n${annotations}\n${annotationGuide}\n\nUser note: ${input.note}`
      : `The user requests changes to plan ${plan.id}, version ${version.number} (${version.id}). Revise the plan using plans_submit with planId and expectedVersionId ${version.id}, then stop for review. Do not start implementation.\n\nReview comments (each versionId identifies the reviewed snapshot):\n${annotations}\n${annotationGuide}\n\nUser note: ${input.note}\n\nCurrent plan:\n${version.markdown}`;
    // The SDK preflight above yields. Recheck inside the synchronous transaction
    // so two browser windows cannot deliver the same plan at the same time.
    db.transaction(() => {
      const fresh = editable(plan.id);
      current(fresh, input.versionId);
      if (fresh.updatedAt !== plan.updatedAt || JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("The review changed. Refresh before sending.");
      db.prepare("INSERT INTO deliveries (id, plan_id, payload, state) VALUES (?, ?, ?, 'pending')").run(input.requestId, plan.id, JSON.stringify(input));
    })();
    if (plan.threadId) {
      try {
        await bb.sdk.threads.send({ threadId: plan.threadId, mode: "queue-if-active", input: [{ type: "text", text: `${text}\n\nReview receipt: ${input.requestId}`, mentions: [] }] });
      } catch (error) {
        bb.log.error(`Review delivery ${input.requestId} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error(`Delivery could not be confirmed. Check the linked thread for review receipt ${input.requestId} before retrying. Use bb plans delivery ${input.requestId} to inspect and resolve the delivery.`);
      }
    }
    return completeDelivery(input);
  };
  return {
    get, create, revise, submitReview,
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
