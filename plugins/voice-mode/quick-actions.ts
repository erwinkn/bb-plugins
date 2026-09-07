import { z } from "zod";
import { navigationActionSchemas } from "./ui-actions.ts";

/** No destructive operations, draft submission, or arbitrary tool names. */
export const quickActionSchema = z.discriminatedUnion("kind", [
  ...navigationActionSchemas,
  z.object({ kind: z.literal("send_message"), threadId: z.string().min(1).max(128),
    purpose: z.enum(["comment", "status"]), text: z.string().min(1).max(1000) }).strict(),
]);
export type QuickAction = z.infer<typeof quickActionSchema>;

/** Conservative admission, not a general natural-language safety classifier. */
export function quickMessageRefusal(action: Extract<QuickAction, {kind:"send_message"}>, original: string): string | null {
  if (original.length > 1200 || !original.includes(action.text)) return "The message must be a short, verbatim part of the spoken request.";
  if (/\b(archive|delete|remove|stop|interrupt|steer|cancel|merge|push|deploy|publish|install|restart|reload|reset|rebase|revert|implement|fix|edit|modify|change|execute|run|command|shell|approve|permission|credential|secret)\b/i.test(original) || /[\n\r`]|&&|\|\||;/.test(original)) return "This request needs the coordinator.";
  return null;
}


export const QUICK_ACTION_TIMEOUT_MS = 20_000;

/** Bound SDK calls that have no cancellation parameter; never retry their effects. */
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
