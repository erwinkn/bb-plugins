/** Read pending interactions in a form Ada can speak, and turn spoken answers into
 * the exact resolution each kind needs. Three kinds reach a call: BB approvals,
 * provider questions (a `user_question` such as Claude Code's AskUserQuestion), and
 * rounds of the Questions plugin, which are plugin interactions whose answers commit
 * only through that plugin's own RPCs.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { queryTokens, rank, resolveName, tokenize } from "./target-matching.ts";
import type { Interaction } from "./watches.ts";

export const QUESTIONS_PLUGIN_ID = "questions";
const ROUND_RENDERER = "round";

export interface OptionSpec { value: string; label: string; description?: string }
export interface QuestionSpec {
  id: string; prompt: string; help?: string | null;
  /** null: free text only. */
  select: "single" | "multiple" | null;
  options: OptionSpec[]; freeText: boolean; optional: boolean;
}
export interface InteractionSpec {
  id: string; threadId: string; status: string; createdAt: number;
  kind: "approval" | "question" | "round" | "other";
  title: string;
  /** Approvals keep their native payload so the prompt's approval rules still apply. */
  payload?: unknown; availableDecisions?: string[];
  roundId?: string; questions?: QuestionSpec[];
  /** Why this interaction cannot be answered by voice, when it cannot. */
  unanswerable?: string;
}
/** One spoken answer. `question` is an ID, a label, or words from the prompt; omit it when the interaction has one question. */
export const spokenAnswerSchema = z.object({
  question: z.string().max(400).optional(),
  choices: z.array(z.string().min(1).max(400)).max(30).optional().describe("Option labels as spoken."),
  text: z.string().max(16000).optional().describe("Free text, or the answer to a text-only question."),
}).strict();
export type SpokenAnswer = z.infer<typeof spokenAnswerSchema>;

const roundSchema = z.object({
  round: z.object({ id: z.string(), threadId: z.string(), number: z.number(), intro: z.string().nullable(),
    questions: z.array(z.object({ id: z.string(), title: z.string(), optional: z.boolean().optional(), help: z.string().nullable().optional(),
      select: z.enum(["single", "multiple"]).nullable(), options: z.array(z.object({ id: z.string(), label: z.string() })) })) }).nullable(),
  answers: z.array(z.object({ questionId: z.string(), version: z.number(), submitted: z.unknown().nullable() })),
});
const saveDraftSchema = z.object({ outcome: z.enum(["saved", "conflict"]), state: z.object({ questionId: z.string(), version: z.number() }) });
const submitSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("submitted"), submission: z.object({ id: z.string(), state: z.string() }) }),
  z.object({ outcome: z.literal("conflict"), questionIds: z.array(z.string()) }),
  z.object({ outcome: z.literal("rejected"), reason: z.string() }),
]).or(z.object({ outcome: z.string() }).passthrough());

type Bb = Pick<BbPluginApi, "sdk">;

/** Describe a pending interaction. Never throws: an unreadable round is reported as unanswerable. */
export async function describeInteraction(bb: Bb, interaction: Interaction): Promise<InteractionSpec> {
  const base = { id: interaction.id, threadId: interaction.threadId, status: interaction.status, createdAt: interaction.createdAt };
  const payload = interaction.payload as Record<string, unknown> & { kind: string };
  if (payload.kind === "approval") {
    const p = payload as { reason?: string; subject?: unknown; availableDecisions?: string[] };
    return { ...base, kind: "approval", title: p.reason ?? "Approval", payload, availableDecisions: p.availableDecisions ?? [] };
  }
  if (payload.kind === "user_question") {
    const raw = Array.isArray(payload.questions) ? payload.questions as Record<string, unknown>[] : [];
    const questions: QuestionSpec[] = raw.map((q, i) => ({
      id: String(q.id ?? `question-${i + 1}`), prompt: String(q.prompt ?? q.question ?? q.title ?? `Question ${i + 1}`), help: typeof q.description === "string" ? q.description : null,
      select: (Array.isArray(q.options) && q.options.length) ? (q.multiSelect ? "multiple" : "single") : null,
      options: (Array.isArray(q.options) ? q.options as Record<string, unknown>[] : []).map(o => ({ value: String(o.value ?? o.id ?? o.label), label: String(o.label ?? o.value), ...(typeof o.description === "string" ? { description: o.description } : {}) })),
      freeText: !Array.isArray(q.options) || q.options.length === 0 || q.allowFreeText === true || q.freeText === true, optional: q.optional === true }));
    return { ...base, kind: "question", title: questions.map(q => q.prompt).join(" / ") || "Question", questions };
  }
  if (payload.kind === "plugin") {
    const origin = (interaction as { origin?: { pluginId?: string; rendererId?: string } }).origin;
    const data = (payload as { data?: { roundId?: unknown } }).data;
    const title = String((payload as { title?: unknown }).title ?? "Plugin prompt");
    if (origin?.pluginId !== QUESTIONS_PLUGIN_ID || origin.rendererId !== ROUND_RENDERER || typeof data?.roundId !== "string")
      return { ...base, kind: "other", title, unanswerable: `This prompt belongs to the ${origin?.pluginId ?? "unknown"} plugin and has no voice answer path. Answer it in the app.` };
    try {
      const result = await bb.sdk.plugins.callRpc({ pluginId: QUESTIONS_PLUGIN_ID, method: "questions_round", input: { threadId: interaction.threadId, roundId: data.roundId }, outputSchema: roundSchema });
      if (!result.round) return { ...base, kind: "round", title, roundId: data.roundId, unanswerable: "The Questions round no longer exists." };
      const submitted = new Set(result.answers.filter(a => a.submitted !== null).map(a => a.questionId));
      const questions: QuestionSpec[] = result.round.questions.filter(q => !submitted.has(q.id)).map(q => ({
        id: q.id, prompt: q.title, help: q.help ?? null, select: q.select, options: q.options.map(o => ({ value: o.id, label: o.label })), freeText: q.select === null, optional: q.optional === true }));
      return { ...base, kind: "round", title: result.round.intro ? `${title}: ${result.round.intro}` : title, roundId: data.roundId, questions };
    } catch (error) {
      return { ...base, kind: "round", title, roundId: data.roundId, unanswerable: `The Questions plugin could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ...base, kind: "other", title: String((payload as { title?: unknown }).title ?? payload.kind), unanswerable: "This interaction kind has no voice answer path. Answer it in the app." };
}

export interface ResolvedAnswer { question: QuestionSpec; selected: string[]; text: string }
/**
 * Map spoken answers onto the interaction's questions and options. Every failure names
 * the choices, and happens before any SDK call, so a mishearing never half-answers.
 */
export function resolveAnswers(spec: InteractionSpec, spoken: SpokenAnswer[]): ResolvedAnswer[] {
  const questions = spec.questions ?? [];
  if (spec.unanswerable) throw new Error(spec.unanswerable);
  if (!questions.length) throw new Error("This interaction has no open questions.");
  if (!spoken.length) throw new Error(`Give an answer for: ${questions.map(q => q.prompt).join("; ")}.`);
  const resolved = new Map<string, ResolvedAnswer>();
  for (const answer of spoken) {
    const question = pickQuestion(questions, answer.question, spoken.length);
    if (resolved.has(question.id)) throw new Error(`Two answers target the same question: "${question.prompt}".`);
    const labels = answer.choices ?? [];
    if (question.select === null && labels.length) throw new Error(`"${question.prompt}" takes free text only.`);
    if (question.select === "single" && labels.length > 1) throw new Error(`"${question.prompt}" takes one choice. Options: ${optionList(question)}.`);
    const selected = labels.map(label => {
      const option = pickOption(question, label);
      if (!option) throw new Error(`No option of "${question.prompt}" matches "${label}". Options: ${optionList(question)}.`);
      return option.value;
    });
    const text = (answer.text ?? "").trim();
    if (!selected.length && !text) throw new Error(question.select === null ? `"${question.prompt}" needs text.` : `"${question.prompt}" needs a choice. Options: ${optionList(question)}.`);
    if (text && !question.freeText && selected.length === 0) throw new Error(`"${question.prompt}" takes a choice, not text. Options: ${optionList(question)}.`);
    resolved.set(question.id, { question, selected: [...new Set(selected)], text });
  }
  const missing = questions.filter(q => !q.optional && !resolved.has(q.id));
  if (missing.length) throw new Error(`Still unanswered: ${missing.map(q => `"${q.prompt}"`).join(", ")}. Answer every required question in one call.`);
  return [...resolved.values()];
}
function optionList(question: QuestionSpec) { return question.options.map(o => o.label).join(", ") || "(free text)"; }
function pickQuestion(questions: QuestionSpec[], reference: string | undefined, answers: number): QuestionSpec {
  if (!reference) {
    if (questions.length === 1 || answers === 1 && questions.filter(q => !q.optional).length === 1) return questions.length === 1 ? questions[0] : questions.find(q => !q.optional)!;
    throw new Error(`Say which question each answer is for: ${questions.map(q => `"${q.prompt}"`).join(", ")}.`);
  }
  const exact = questions.find(q => q.id === reference);
  if (exact) return exact;
  const ordinal = /^(?:q(?:uestion)?\s*)?(\d+)$/i.exec(reference.trim());
  if (ordinal && questions[Number(ordinal[1]) - 1]) return questions[Number(ordinal[1]) - 1];
  const tokens = queryTokens(reference);
  const ranked = rank(questions, tokens.length ? tokens : tokenize(reference), q => `${q.id} ${q.prompt}`, () => 0, { threshold: 0.34, limit: 2 });
  if (ranked.length && (ranked.length === 1 || ranked[0].match > ranked[1].match)) return ranked[0].item;
  throw new Error(`No question matches "${reference}". Questions: ${questions.map(q => `"${q.prompt}"`).join(", ")}.`);
}
/** Spoken labels are approximate; ordinals ("the first one", "option two") and a unique best match both work. */
export function pickOption(question: QuestionSpec, label: string): OptionSpec | null {
  const exact = question.options.find(o => o.value === label || o.label === label);
  if (exact) return exact;
  const words = queryTokens(label);
  const ordinal = ORDINALS[words.join(" ")] ?? ORDINALS[tokenize(label).join(" ")] ?? (/^(?:option\s*)?(\d+)$/i.exec(label.trim())?.[1] ? Number(/(\d+)/.exec(label)![1]) : null);
  if (ordinal === -1) return question.options.at(-1) ?? null;
  if (ordinal && question.options[ordinal - 1]) return question.options[ordinal - 1];
  // Distinctive words first; if they tie ("merge" in two labels), every spoken word breaks the tie ("merge main").
  const attempts = [words, tokenize(label)].filter((t, i, all) => t.length && all.findIndex(o => o.join(" ") === t.join(" ")) === i);
  for (const tokens of attempts) {
    const found = resolveName(tokens.join(" "), question.options, o => o.label);
    if (found) return found;
  }
  for (const tokens of attempts) {
    const ranked = rank(question.options, tokens, o => `${o.label} ${o.description ?? ""}`, () => 0, { threshold: 0.34, limit: 2 });
    if (ranked.length && (ranked.length === 1 || ranked[0].match > ranked[1].match)) return ranked[0].item;
  }
  return null;
}
const ORDINALS: Record<string, number> = { "first": 1, "first one": 1, "one": 1, "second": 2, "second one": 2, "two": 2, "third": 3, "third one": 3, "three": 3, "fourth": 4, "fourth one": 4, "four": 4, "fifth": 5, "five": 5, "last": -1, "last one": -1 };

/** Submit resolved answers through the path the interaction kind requires. */
export async function submitAnswers(bb: Bb, spec: InteractionSpec, answers: ResolvedAnswer[]) {
  if (spec.kind === "question") {
    const resolution = { kind: "user_answer" as const, answers: Object.fromEntries(answers.map(a => [a.question.id, { selected: a.selected, ...(a.text ? { freeText: a.text } : {}) }])) };
    return { kind: "question" as const, interaction: await bb.sdk.threads.interactions.resolve({ threadId: spec.threadId, interactionId: spec.id, resolution }) };
  }
  if (spec.kind !== "round" || !spec.roundId) throw new Error(spec.unanswerable ?? "This interaction cannot be answered by voice.");
  // Drafts first, each with its version; then one submit of the whole round.
  const state = await bb.sdk.plugins.callRpc({ pluginId: QUESTIONS_PLUGIN_ID, method: "questions_round", input: { threadId: spec.threadId, roundId: spec.roundId }, outputSchema: roundSchema });
  const versions = new Map(state.answers.map(a => [a.questionId, a.version]));
  const items: { questionId: string; expectedVersion: number }[] = [];
  for (const answer of answers) {
    const draft = { selected: answer.selected, details: {}, text: answer.text, attachments: [], references: [], confidence: null };
    const saved = await bb.sdk.plugins.callRpc({ pluginId: QUESTIONS_PLUGIN_ID, method: "questions_save_draft", input: { threadId: spec.threadId, questionId: answer.question.id, draft, expectedVersion: versions.get(answer.question.id) ?? 0 }, outputSchema: saveDraftSchema });
    if (saved.outcome !== "saved") throw new Error(`"${answer.question.prompt}" changed in the app while you answered. Say the answer again.`);
    items.push({ questionId: answer.question.id, expectedVersion: saved.state.version });
  }
  const result = await bb.sdk.plugins.callRpc({ pluginId: QUESTIONS_PLUGIN_ID, method: "questions_submit", input: { threadId: spec.threadId, submissionId: globalThis.crypto.randomUUID(), items }, outputSchema: submitSchema });
  if (result.outcome !== "submitted") throw new Error(result.outcome === "conflict" ? "The round changed in the app while you answered. Say the answers again." : `The Questions plugin did not accept the answers: ${"reason" in result ? String(result.reason) : result.outcome}.`);
  return { kind: "round" as const, submissionId: (result as { submission: { id: string } }).submission.id };
}
