import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { addAnnotationSchema, agentReplySchema, bodySchema, createSchema, deliveryModeSchema, idSchema, markdownSchema, planSchema, updateSchema, type Plan, type PlanComment } from "./contract";
import { createStore } from "./server/store";
import { createOutbox } from "./server/outbox";
import { LiveSession, type SessionOptions } from "./server/session";
import type { ReviewEvent } from "./lib/message";

export type PlanServiceOptions = SessionOptions;
export const handoffInstruction = "This tool returns at once by design. End your turn now. Feedback arrives as thread messages. Do not poll. Implement only after approval.";
const targetSchema = z.object({ id: idSchema, annotationId: idSchema });
const annotationEvent = (item: PlanComment): ReviewEvent => ({
  kind: "annotation", annotationId: item.id, number: item.number, annotationKind: item.kind, quote: item.quote, body: item.body, revision: item.revision ?? 0,
});

export function createPlanService(bb: BbPluginApi, options: PlanServiceOptions = {}) {
  const store = createStore(bb);
  const outbox = createOutbox(store);
  const sessions = new Map<string, LiveSession>();
  const session = (id: string) => {
    let value = sessions.get(id);
    if (!value) { value = new LiveSession(id, bb, store, outbox, options); sessions.set(id, value); }
    return value;
  };
  const get = ({ id }: { id: string }) => store.get(idSchema.parse(id));
  const open = (id: string) => {
    const plan = get({ id });
    if (plan.status === "approved") throw new Error("This plan is approved.");
    return plan;
  };
  const annotation = (plan: Plan, ref: string) => {
    const item = plan.comments.find((item) => item.id === ref || `#${item.number}` === ref);
    if (!item) throw new Error(`Annotation ${ref} not found.`);
    return item;
  };
  const mutate = (plan: Plan, work: () => void = () => {}) => {
    const saved = store.db.transaction(() => { work(); return store.save(plan); })();
    store.changed(plan.id); session(plan.id).schedule(); return saved;
  };
  const create = async (input: z.input<typeof createSchema>, source: "agent" | "user" = "user") => {
    const { title, markdown, threadId, sample = false } = createSchema.parse(input);
    if (sample && threadId) throw new Error("Sample plans cannot be linked to a thread.");
    if (!sample && !threadId) throw new Error("Choose a thread for this plan, or create a sample.");
    let projectId: string | null = null;
    let projectName: string | null = null;
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt) throw new Error("The selected thread does not exist.");
      projectId = thread.projectId;
      projectName = (await bb.sdk.projects.get({ projectId })).name;
    }
    const now = Date.now();
    const plan = mutate(planSchema.parse({
      id: randomUUID(), title, threadId: threadId ?? null, projectId, projectName, sample, status: "open",
      createdAt: now, updatedAt: now, versions: [{ id: randomUUID(), number: 1, markdown, createdAt: now, source }], comments: [],
    }));
    bb.realtime.publish("plan-submitted", { id: plan.id, threadId: plan.threadId });
    return plan;
  };
  const addAnnotation = (input: z.input<typeof addAnnotationSchema>) => {
    const { id, ...fields } = addAnnotationSchema.parse(input);
    const plan = open(id);
    const versionId = fields.versionId ?? plan.versions.at(-1)!.id;
    if (!plan.versions.some((version) => version.id === versionId)) throw new Error("Version not found on this plan.");
    const item: PlanComment = {
      ...fields, id: randomUUID(), number: Math.max(0, ...plan.comments.map((item) => item.number)) + 1,
      versionId, createdAt: Date.now(), deliveredAt: null, revision: 0,
      state: fields.kind === "looksGood" ? "addressed" : "open", replies: [],
    };
    plan.comments.push(item);
    return mutate(plan, () => { outbox.add(id, annotationEvent(item)); });
  };
  const update = (input: z.input<typeof updateSchema>) => {
    const { planId, edits, summary, resolves, markdown: replacement } = updateSchema.parse(input);
    const plan = open(planId);
    let markdown = plan.versions.at(-1)!.markdown;
    if (edits) {
      const failures: string[] = [];
      for (const [index, edit] of edits.entries()) {
        const start = markdown.indexOf(edit.old);
        if (start < 0 || markdown.indexOf(edit.old, start + 1) >= 0) {
          failures.push(`#${index + 1} (${JSON.stringify(edit.old.slice(0, 80))}): ${start < 0 ? "no match" : "multiple matches"}`);
        } else markdown = markdown.slice(0, start) + edit.new + markdown.slice(start + edit.old.length);
      }
      if (failures.length) throw new Error(`Each old must occur exactly once. Failing edits: ${failures.join("; ")}. No changes saved.`);
    } else markdown = replacement!;
    markdownSchema.parse(markdown);
    const addressed = resolves.map((ref) => annotation(plan, ref));
    for (const item of addressed) {
      if (item.state === "withdrawn") throw new Error(`Annotation #${item.number} was withdrawn.`);
      item.state = "addressed";
    }
    const version = { id: randomUUID(), number: plan.versions.at(-1)!.number + 1, markdown, summary, resolves: [...new Set(addressed.map((item) => item.id))], source: "agent" as const, createdAt: Date.now() };
    plan.versions.push(version); mutate(plan);
    return { planId, versionId: version.id, openAnnotations: plan.comments.filter((item) => item.state === "open").map(({ number, kind, quote, body }) => ({ number, kind, quote, body })) };
  };
  const reply = (input: z.input<typeof agentReplySchema>) => {
    const { planId, annotation: ref, body, resolve } = agentReplySchema.parse(input);
    const plan = open(planId);
    const item = annotation(plan, ref);
    if (item.state === "withdrawn") throw new Error("This annotation was withdrawn.");
    item.replies.push({ id: randomUUID(), author: "agent", body, createdAt: Date.now(), deliveredAt: null });
    if (resolve ?? item.kind === "ask") item.state = item.kind === "ask" ? "answered" : "addressed";
    mutate(plan);
    return { planId, annotationId: item.id, number: item.number, state: item.state };
  };
  const handoff = ({ planId }: { planId: string }) => {
    const plan = open(idSchema.parse(planId)); session(planId).hold();
    return { planId, openCount: plan.comments.filter((item) => item.state === "open").length, instruction: handoffInstruction };
  };
  const submit = async (input: z.input<typeof createSchema>) => {
    const plan = await create(input, "agent"); session(plan.id).hold();
    return { status: "submitted" as const, planId: plan.id, versionId: plan.versions.at(-1)!.id, instruction: handoffInstruction };
  };
  const withdrawAnnotation = (input: z.infer<typeof targetSchema>) => {
    const { id, annotationId } = targetSchema.parse(input);
    const plan = open(id); const item = annotation(plan, annotationId);
    if (item.state === "withdrawn") return plan;
    if (session(id).busy) throw new Error("Feedback is being delivered. Try again after delivery finishes.");
    item.state = "withdrawn";
    return mutate(plan, () => {
      if (item.deliveredAt !== null) outbox.add(id, { kind: "withdrawn", annotationId: item.id, number: item.number });
      else outbox.state(outbox.list(id).filter((row) => row.event.kind === "annotation" && row.event.annotationId === item.id).map((row) => row.id), "dropped");
    });
  };
  const resolveAnnotation = (input: z.infer<typeof targetSchema>) => {
    const { id, annotationId } = targetSchema.parse(input);
    const plan = get({ id }); const item = annotation(plan, annotationId);
    if (item.state === "withdrawn") throw new Error("This annotation was withdrawn.");
    item.state = "addressed"; return mutate(plan);
  };
  const replyToAnnotation = (input: z.infer<typeof targetSchema> & { body: string }) => {
    const { id, annotationId, body } = targetSchema.extend({ body: bodySchema }).parse(input);
    const plan = open(id); const item = annotation(plan, annotationId);
    if (item.state === "withdrawn") throw new Error("This annotation was withdrawn.");
    const reply = { id: randomUUID(), author: "user" as const, body, createdAt: Date.now(), deliveredAt: null };
    item.replies.push(reply);
    return mutate(plan, () => { outbox.add(id, { kind: "reply", annotationId: item.id, replyId: reply.id, number: item.number, quote: item.quote, body }); });
  };
  const updateAnnotation = (input: z.infer<typeof targetSchema> & { body: string }) => {
    const { id, annotationId, body } = targetSchema.extend({ body: bodySchema }).parse(input);
    const plan = open(id); const item = annotation(plan, annotationId);
    if (item.deliveredAt !== null || item.state === "withdrawn") throw new Error("Delivered or withdrawn annotations cannot be edited.");
    if (session(id).busy) throw new Error("Feedback is being delivered. Try again after delivery finishes.");
    item.body = body; item.revision = (item.revision ?? 0) + 1;
    return mutate(plan, () => {
      const rows = outbox.list(id).filter((row) => row.event.kind === "annotation" && row.event.annotationId === item.id && (row.state === "pending" || row.state === "queued"));
      if (!rows.length) outbox.add(id, annotationEvent(item));
      for (const row of rows) {
        outbox.replace(row, annotationEvent(item));
        if (row.state === "queued") outbox.state([row.id], "pending");
      }
    });
  };
  const approve = (input: { id: string; requestId: string; versionId: string }) => {
    const { id, requestId, versionId } = z.object({ id: idSchema, requestId: idSchema, versionId: idSchema }).parse(input);
    const plan = get({ id });
    if (plan.approvalRequestId === requestId) return plan;
    if (versionId !== plan.versions.at(-1)!.id) throw new Error("The plan changed. Review the latest version before approving.");
    if (plan.status === "approved") throw new Error("This plan is already approved.");
    plan.status = "approved"; plan.approvalRequestId = requestId;
    const version = plan.versions.at(-1)!;
    const saved = mutate(plan, () => { outbox.add(id, { kind: "approved", versionId: version.id, versionNumber: version.number }); });
    session(id).release(); return saved;
  };
  const setDeliveryMode = (input: { id: string; mode: Plan["deliveryMode"] }) => {
    const { id, mode } = z.object({ id: idSchema, mode: deliveryModeSchema }).parse(input);
    const plan = open(id); plan.deliveryMode = mode;
    return mutate(plan, () => { outbox.add(id, { kind: "deliveryMode", mode }); });
  };
  const remove = async ({ id }: { id: string }) => {
    get({ id }); const live = session(id);
    await live.pause();
    try {
      const plan = get({ id });
      // Delete a still-queued plugin message before deleting its delivery receipts.
      if (plan.delivery.queuedMessageId && plan.threadId) {
        try { await bb.sdk.threads.queuedMessages.delete({ threadId: plan.threadId, queuedMessageId: plan.delivery.queuedMessageId }); }
        catch (error) { if (!/not found|no longer|does not exist|404/i.test(String(error))) throw error; }
      }
      store.db.transaction(() => {
        store.db.prepare("DELETE FROM outbox WHERE plan_id = ?").run(id);
        store.db.prepare("DELETE FROM plans WHERE id = ?").run(id);
      })();
      await live.dispose();
      sessions.delete(id); store.changed(id); return { ok: true as const };
    } catch (error) { live.resume(); throw error; }
  };
  const deliveryStatus = ({ id }: { id: string }) => {
    get({ id });
    return outbox.list(id).filter((item) => item.state !== "delivered" || item.event.kind === "approved").map((item) => ({
      id: item.id, kind: item.event.kind, state: item.state === "dropped" || item.state === "delivered" ? item.state : item.attempts ? "failed" as const : "pending" as const, attempts: item.attempts, nextAttemptAt: item.nextAttemptAt,
    }));
  };
  const annotationDeliveryStatus = ({ id }: { id: string }) => {
    const pending = new Map(deliveryStatus({ id }).map((item) => [item.id, item]));
    return outbox.list(id).flatMap((item) => {
      const status = pending.get(item.id);
      return status && "annotationId" in item.event ? [{ ...status, annotationId: item.event.annotationId }] : [];
    });
  };
  const list = ({ threadId, offset = 0 }: { threadId?: string; offset?: number }) => {
    z.number().int().nonnegative().parse(offset);
    return store.all().filter((plan) => !threadId || plan.threadId === threadId).sort((a, b) => b.updatedAt - a.updatedAt).slice(offset, offset + 10);
  };
  const version = ({ id, versionId }: { id: string; versionId: string }) => {
    const plan = get({ id }); const version = plan.versions.find((item) => item.id === versionId);
    if (!version) throw new Error("Version not found.");
    return { planId: id, title: plan.title, status: plan.status, ...version, comments: plan.comments.filter((item) => item.versionId === versionId) };
  };
  bb.events.on("message.queued", ({ entry }) => {
    if (entry.waitingOn?.kind !== "interaction") return;
    for (const plan of store.all()) if (plan.threadId === entry.threadId) sessions.get(plan.id)?.release();
  });
  bb.events.on("message.dispatched", ({ entry }) => {
    for (const plan of store.all()) if (plan.threadId === entry.threadId) session(plan.id).dispatched(entry.id, entry.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
  });
  for (const plan of store.all()) session(plan.id).resume();
  bb.onDispose(async () => { await Promise.all([...sessions.values()].map((live) => live.dispose())); });
  const rpc = { list, get, create: (input: z.input<typeof createSchema>) => create(input), addAnnotation, withdrawAnnotation, resolveAnnotation, replyToAnnotation, updateAnnotation, approve, setDeliveryMode, remove, deliveryStatus, annotationDeliveryStatus };
  return { ...rpc, rpc, submit, update, reply, handoff, version };
}
