import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema, type Plan } from "../contract";
import type { PlanStore } from "./store";

/**
 * Thread plugin metadata pointer for the `plans` namespace.
 * `{ activePlanId, status, version }` names the plan that was last submitted,
 * updated, or approved for the thread. The database stays authoritative: a
 * reader validates the shape and then confirms the plan exists and belongs to
 * the thread. Metadata is untrusted input; any client can write it.
 */
export const POINTER_KEYS = ["activePlanId", "status", "version"] as const;
export const pointerSchema = z.object({
  activePlanId: idSchema, status: z.enum(["open", "approved"]), version: z.number().int().positive(),
});
export type PlanPointer = z.infer<typeof pointerSchema>;
export const pointerFor = (plan: Plan): PlanPointer => ({
  activePlanId: plan.id, status: plan.status, version: plan.versions.at(-1)!.number,
});

export function createMetadata(bb: BbPluginApi, store: PlanStore) {
  // One write chain per thread keeps the pointer at the newest state.
  const chains = new Map<string, Promise<void>>();
  const run = (threadId: string, work: () => Promise<void>) => {
    const next = (chains.get(threadId) ?? Promise.resolve()).then(work).catch((error) => {
      bb.log.warn(`Plan metadata for thread ${threadId} not updated: ${String(error)}`);
    });
    chains.set(threadId, next);
    // Drop the entry once the chain drains; a newer write for the thread has
    // already replaced it, so only delete when this is still the current one.
    void next.then(() => { if (chains.get(threadId) === next) chains.delete(threadId); });
    return next;
  };
  /** Point the thread at this plan. Best effort; the plan document is already saved. */
  const sync = (planId: string) => {
    let threadId: string | null;
    try { threadId = store.get(planId).threadId; } catch { return Promise.resolve(); }
    if (!threadId) return Promise.resolve();
    const target = threadId;
    return run(target, async () => {
      let plan: Plan;
      try { plan = store.get(planId); } catch { return; }
      if (plan.threadId !== target) return;
      await bb.sdk.threads.updatePluginMetadata({ threadId: target, set: pointerFor(plan) });
    });
  };
  /** After a plan is deleted: point at the newest remaining plan or clear the keys. */
  const clear = (threadId: string, planId: string) => run(threadId, async () => {
    const remaining = store.all().filter((plan) => plan.threadId === threadId && plan.id !== planId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (remaining) await bb.sdk.threads.updatePluginMetadata({ threadId, set: pointerFor(remaining) });
    else await bb.sdk.threads.updatePluginMetadata({ threadId, remove: [...POINTER_KEYS] });
  });
  /** The plan the pointer names, only when the database confirms it belongs to the thread. */
  const read = async (threadId: string): Promise<Plan | null> => {
    const parsed = pointerSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }));
    if (!parsed.success) return null;
    try {
      const plan = store.get(parsed.data.activePlanId);
      return plan.threadId === threadId ? plan : null;
    } catch { return null; }
  };
  const settled = () => Promise.all(chains.values()).then(() => undefined);
  return { sync, clear, read, settled };
}
export type PlanMetadata = ReturnType<typeof createMetadata>;
