import { z } from "zod";
import { UiActionSchema } from "./ui-actions.ts";
import { WORKER_ROLES } from "./worker-profiles.ts";

const id = z.string().min(1).max(128);
/** These tools dispatch work, but never grant permissions or expose arbitrary commands. */
export const liveOperationSchema = z.discriminatedUnion("kind", [
  ...UiActionSchema.options,
  z.object({ kind: z.literal("send_message"), threadId: id,
    purpose: z.enum(["comment", "status", "instruction"]).default("instruction"),
    text: z.string().trim().min(1).max(8000).optional() }).strict(),
  z.object({ kind: z.literal("start_thread"), projectId: id, hostId: id.optional(),
    role: z.enum(WORKER_ROLES), title: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(8000).optional() }).strict(),
  z.object({ kind: z.literal("stop_thread"), threadId: id }).strict(),
]);
export type LiveOperation = z.infer<typeof liveOperationSchema>;
export const quickActionSchema = z.discriminatedUnion("kind", [
  ...liveOperationSchema.options,
  z.object({ kind: z.literal("group"), actions: z.array(liveOperationSchema).min(1).max(4) }).strict(),
]);
export type QuickAction = z.infer<typeof quickActionSchema>;
export const operationsOf = (action: QuickAction): LiveOperation[] => action.kind === "group" ? action.actions : [action];

/** Optional excerpts must preserve words. The full transcript is always sent as authority. */
export function quickMessageRefusal(action: Extract<LiveOperation, {kind:"send_message" | "start_thread"}>, original: string): string | null {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return action.text && !normalize(original).includes(normalize(action.text))
    ? "The selected excerpt does not match the transcript. Preserve the user's complete request instead of rewriting it." : null;
}
export function quickActionRefusal(action: QuickAction, original: string): string | null {
  for (const operation of operationsOf(action)) {
    if (operation.kind === "send_message" || operation.kind === "start_thread") {
      const refusal = quickMessageRefusal(operation, original);
      if (refusal) return refusal;
    }
  }
  return null;
}

export const QUICK_ACTION_TIMEOUT_MS = 20_000;
/** Limits observation, not the SDK side effect. A timed-out effect must not be repeated. */
export function waitForQuickAction<T>(work: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("Quick action cancelled.")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Quick action result timed out.")); }, Math.max(0, deadline - Date.now()));
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once:true});
  });
}
