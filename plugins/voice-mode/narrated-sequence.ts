import { z } from "zod";
import { UiActionSchema } from "./ui-actions.ts";

/** An ordered script, not executable code. Each effect uses an existing UI capability. */
export const sequenceStepSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("action"), action:UiActionSchema}).strict(),
  z.object({kind:z.literal("speech"), text:z.string().trim().min(1).max(1200)}).strict(),
]);
export const narratedSequenceSchema = z.object({
  title:z.string().trim().min(1).max(160),
  steps:z.array(sequenceStepSchema).min(2).max(40),
}).strict().refine(plan => plan.steps.some(step => step.kind === "speech"), "A sequence needs speech");
export type NarratedSequence = z.infer<typeof narratedSequenceSchema>;
export const sequenceControlSchema = z.enum(["pause", "resume", "skip", "back", "stop"]);
export const sequenceStateSchema = z.object({
  replyId:z.string(), conversationId:z.string(), callNonce:z.string(),
  plan:narratedSequenceSchema, index:z.number().int().nonnegative(), revision:z.number().int().nonnegative(),
  phase:z.enum(["ready", "action", "speech", "paused", "complete", "cancelled"]),
  reason:z.string().nullable(), blocked:z.boolean(),
  completedDrafts:z.array(z.number().int().nonnegative()).max(40).default([]),
}).strict();
export type SequenceState = z.infer<typeof sequenceStateSchema>;
export const sequenceInputSchema = z.object({
  conversationId:z.string().min(1), callNonce:z.string().min(1), replyId:z.string().optional(),
  operation:z.enum(["sync", "next", "delivered", ...sequenceControlSchema.options]),
  revision:z.number().int().nonnegative().optional(), index:z.number().int().nonnegative().optional(),
  reason:z.string().max(200).optional(), restoreView:z.boolean().optional(),
}).strict();
export type SequenceInput = z.infer<typeof sequenceInputSchema>;
export const sequenceOutputSchema = z.object({state:sequenceStateSchema.nullable()}).strict();
export const sequenceCommandId = (s: Pick<SequenceState,"replyId"|"revision">) => `sequence:${s.replyId}:${s.revision}`;

/** Threads referred to by a speech step, inferred from the preceding view action. */
export function sequenceThreadIds(plan:NarratedSequence,index:number):string[] {
  for(let i=index-1;i>=0;i--) {
    const step=plan.steps[i];if(step.kind!=="action")continue;
    const action=step.action;
    if(action.kind==="open_thread")return [action.threadId];
    if(action.kind==="prepare_draft")return action.target.kind==="thread" ? [action.target.threadId] : [];
    if(action.kind==="open_project" || action.kind==="show_voice")return [];
  }
  return [];
}
