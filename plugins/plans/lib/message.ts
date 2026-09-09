import type { Plan, PlanComment } from "../contract";
import { normalizeQuote, quoteLineRange } from "./line-map";

export type ReviewEvent =
  | { kind: "annotation"; annotationId: string; number: number; annotationKind: PlanComment["kind"]; quote: string; body: string; revision: number }
  | { kind: "edited"; annotationId: string; number: number; quote: string; body: string; revision: number }
  | { kind: "reply"; annotationId: string; replyId: string; number: number; quote: string; body: string }
  | { kind: "withdrawn"; annotationId: string; number: number }
  | { kind: "approved"; versionId: string; versionNumber: number }
  | { kind: "deliveryMode"; mode: Plan["deliveryMode"] };

export const BATCH_INSTRUCTION = "Answer each ask with plans_reply. Apply comments and redlines with\nplans_update and name the items in `resolves`. A looks good needs no change;\nif it answers an open question in the plan, fold the answer into the text.\nWhen you are done with this batch, call plans_handoff and end your turn.";
const kindWords = { comment: "comment", ask: "ask", redline: "redline", looksGood: "looks good" };
export function messageQuote(quote: string): string {
  return normalizeQuote(quote);
}
export function renderEvent(plan: Plan, event: ReviewEvent): string {
  if (event.kind === "withdrawn") return `withdrawn #${event.number}`;
  if (event.kind === "edited") return `edited #${event.number}\n> ${messageQuote(event.quote)}\n${event.body}`;
  if (event.kind === "deliveryMode") return `delivery mode: ${event.mode}`;
  if (event.kind === "approved") return `approved v${event.versionNumber}\nImplement plan ${plan.id} version ${event.versionNumber}.\nRun \`bb plans get ${plan.id} --version-id ${event.versionId}\` to read the approved version.`;
  const range = quoteLineRange(plan.versions.at(-1)!.markdown, event.quote);
  const location = range ? ` · L${range.start}${range.end === range.start ? "" : `–${range.end}`}` : "";
  const label = event.kind === "reply" ? `reply on #${event.number}` : `#${event.number} ${kindWords[event.annotationKind]}`;
  return `${label}${location}\n> ${messageQuote(event.quote)}${event.body ? `\n${event.body}` : ""}`;
}
export function renderMessage(plan: Plan, events: ReviewEvent[]): string {
  const header = `Plan "${plan.title}" (plan ${plan.id}, v${plan.versions.at(-1)!.number}) — ${events.length} new ${events.length === 1 ? "item" : "items"}`;
  const needsInstruction = events.some((event) => event.kind === "annotation" || event.kind === "edited" || event.kind === "reply") && !events.some((event) => event.kind === "approved");
  return [header, ...events.map((event) => renderEvent(plan, event)), ...(needsInstruction ? [BATCH_INSTRUCTION] : [])].join("\n\n");
}
