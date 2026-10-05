import { z } from "zod";

/**
 * One flat initiative_decision input. Claude's bridge advertises only object
 * roots, so the published schema is this object; per-action rules live in
 * normalizeDecisionInput, which maps flat and legacy nested payloads onto the
 * existing nested command shapes. Nothing here defaults an owner or an answer.
 */
export const DECISION_ACTIONS = ["decision", "question", "answer", "cleanup", "decision-cleanup", "withdraw"] as const;
type Action = "decision" | "question" | "answer" | "cleanup" | "withdraw";

const text = (max: number) => z.string().max(max);
const optionSchema = z.union([text(200), z.object({ label: text(200), consequences: text(1000).optional() }).strict()]);
export const decisionToolSchema = z.object({
  action: z.enum(DECISION_ACTIONS).describe("decision: record a choice already made. question: ask the user an unresolved choice (coordinator only). answer: record the user's explicit answer to an open question. cleanup: current coordinator accepts/vetoes/removes an agent choice on the user's explicit request. withdraw: current coordinator withdraws its own open question with a reason; records no answer."),
  madeBy: z.enum(["user", "agent"]).optional().describe("decision: user for the user's explicit choice (any recorder), agent for your own significant fork. Never defaulted."),
  description: text(2000).optional().describe("decision: one or two sentences."),
  supersedes: text(80).optional().describe("decision: D# of an active decision this one replaces; history is kept."),
  topic: text(200).optional(),
  scope: text(80).optional(),
  question: text(1000).optional().describe("question: what the user must decide."),
  context: text(2000).optional().describe("question: plain-words background."),
  options: z.array(optionSchema).max(6).optional().describe("question: labels, or {label, consequences}."),
  recommendation: text(1000).optional().describe("question: your proposal, if any."),
  blocksTaskIds: z.array(text(40)).max(20).optional().describe("question: T# tasks that wait for the answer."),
  title: text(200).optional().describe("question: short title; defaults to the question."),
  ref: text(80).optional().describe("answer/cleanup/withdraw: target D#."),
  choice: text(200).nullable().optional().describe("answer: the option label the user picked, or null with a written note."),
  note: text(4000).optional().describe("answer: the user's words or detail."),
  notify: z.boolean().optional().describe("answer: false records quietly; workers notify the coordinator by default."),
  operation: z.enum(["accept", "veto", "remove"]).optional().describe("cleanup: what the user explicitly asked for."),
  reason: text(2000).optional().describe("cleanup: the user's request. withdraw: why the user no longer needs to answer (required)."),
}).strict();
export const decisionToolJsonSchema = z.toJSONSchema(decisionToolSchema, { io: "input" });

/** Minimal valid payloads appended to every error. */
export const DECISION_ERROR_EXAMPLES: Record<Action, object> = {
  decision: { action: "decision", madeBy: "user", description: "Erwin chose Base UI for the kit." },
  question: { action: "question", question: "Where is the Monolith repo?", context: "It is not under ~/Code.", options: ["Point me to it", "Skip Monolith tonight"] },
  answer: { action: "answer", ref: "D12", choice: "Skip Monolith tonight", note: "Erwin said so in this chat." },
  cleanup: { action: "cleanup", ref: "D13", operation: "accept", reason: "Erwin asked to mark all agent decisions OK." },
  withdraw: { action: "withdraw", ref: "D12", reason: "Settled by D15: Erwin chose Base UI in chat." },
};
const FIELDS: Record<Action, readonly string[]> = {
  decision: ["madeBy", "description", "supersedes", "topic", "scope"],
  question: ["question", "context", "options", "recommendation", "blocksTaskIds", "title", "humanAttention"],
  answer: ["ref", "choice", "note", "notify"],
  cleanup: ["ref", "operation", "reason"],
  withdraw: ["ref", "reason"],
};
// Likely meanings of common guesses; hints only, never silent aliases.
const HINTS: Record<Action, Record<string, string>> = {
  decision: { text: "description", summary: "description", body: "description", title: "description", outcome: "description", decidedBy: "madeBy", owner: "madeBy" },
  question: { description: "question or context", text: "question", body: "context", summary: "context", consequence: "consequences" },
  answer: { target: "ref", answer: "choice" },
  cleanup: { target: "ref", verdict: "operation" },
  withdraw: { target: "ref", note: "reason", choice: "action answer (only for the user's explicit answer)", answer: "action answer (only for the user's explicit answer)" },
};
// Question-only fields on a decision suggest the user may still have to choose. Only the
// explicit fields count; a decision's description is never interpreted.
const QUESTION_SIGNALS = ["humanAttention", "review", "question", "context", "options", "recommendation", "blocksTaskIds"];
const asksUser = (fields: Record<string, unknown>) =>
  QUESTION_SIGNALS.filter(key => key in fields && (key !== "review" || fields.review === "needs-opinion"));
// Legacy needs-opinion payloads may still carry these; a question never needs them.
const TAKEN = ["outcome", "rationale", "tradeoff", "revisitReason", "deadline"];

export const decisionExample = (action: Action, problem: string) =>
  `${problem} Example: ${JSON.stringify(DECISION_ERROR_EXAMPLES[action])}. See bb initiative describe ${action === "cleanup" ? "decision-cleanup" : action}.`;

type Result = { ok: true; value: Record<string, unknown>; flat: boolean } | { ok: false; message: string };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Folds a legacy nested object into the flat fields; differing values are a conflict, never a silent pick. */
function merge(flat: Record<string, unknown>, nested: Record<string, unknown>, where: string) {
  const merged = { ...flat };
  for (const [key, value] of Object.entries(nested)) {
    if (key in flat && JSON.stringify(flat[key]) !== JSON.stringify(value))
      return `Conflicting ${key}: ${where}.${key} and top-level ${key} differ. Give it once.`;
    merged[key] = value;
  }
  return merged;
}

function unknownFields(action: Action, fields: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(fields).filter(key => !allowed.includes(key));
  if (!unknown.length) return null;
  const hints = unknown.filter(key => HINTS[action][key]).map(key => `${HINTS[action][key]} instead of ${key}`);
  return decisionExample(action, `Unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map(key => `"${key}"`).join(", ")} for action ${action}${hints.length ? ` (did you mean ${hints.join("; ")}?)` : ""}. Fields: ${allowed.filter(key => key !== "humanAttention").join(", ")}.`);
}

function target(action: Action, fields: Record<string, unknown>) {
  const { decision, ...rest } = fields;
  if (decision === undefined) return { fields: rest };
  if (typeof decision !== "string") return decisionExample(action, `${action} targets an existing record by ref ("D12").`);
  if (rest.ref !== undefined && rest.ref !== decision) return `Conflicting ref: decision "${decision}" and ref "${String(rest.ref)}" differ. Give the target once as ref.`;
  return { fields: { ...rest, ref: decision } };
}

const defaultTitle = (question: string) => {
  const single = question.replace(/\s+/g, " ").trim();
  return single.length <= 200 ? single : `${single.slice(0, 199).trimEnd()}…`;
};

export function normalizeDecisionInput(raw: unknown): Result {
  if (!isObject(raw)) return { ok: false, message: decisionExample("decision", "Pass one JSON object with an action.") };
  const { action: rawAction, ...input } = raw;
  if (!(DECISION_ACTIONS as readonly unknown[]).includes(rawAction))
    return { ok: false, message: `Unknown initiative_decision action ${JSON.stringify(rawAction ?? null)}. Use decision, question, answer or cleanup (withdraw retracts your own open question), for example ${JSON.stringify(DECISION_ERROR_EXAMPLES.decision)}. See bb initiative describe for each action.` };
  const action: Action = rawAction === "decision-cleanup" ? "cleanup" : rawAction as Action;
  const fail = (message: string): Result => ({ ok: false, message });

  if (action === "decision") {
    let fields: Record<string, unknown> | string = input;
    const flat = !isObject(input.decision);
    if (typeof input.decision === "string") return fail(decisionExample("decision", "A decision is recorded with madeBy and description; D# targets belong to answer or cleanup ref, or supersedes."));
    if (isObject(input.decision)) {
      const { decision, ...rest } = input;
      fields = merge(rest, decision, "decision");
      if (typeof fields === "string") return fail(fields);
    }
    const asks = asksUser(fields);
    if (asks.length) {
      const others = Object.keys(fields).filter(key => !FIELDS.decision.includes(key) && !asks.includes(key));
      return fail(decisionExample("question", `${asks.map(key => `"${key}"`).join(", ")} ${asks.length > 1 ? "belong" : "belongs"} to a question, not a decision${others.length ? `; also unknown: ${others.map(key => `"${key}"`).join(", ")}` : ""}. If the user still has to choose, the coordinator asks with action question (workers pass the question to the coordinator). If you already made a significant choice that only awaits the user's review, record it without ${asks.length > 1 ? "them" : "it"} as madeBy "agent"; agent choices reach the user's Inbox for Okay/Not okay.`));
    }
    const unknown = unknownFields("decision", fields, FIELDS.decision);
    if (unknown) return fail(unknown);
    if (fields.madeBy !== "user" && fields.madeBy !== "agent")
      return fail(decisionExample("decision", `madeBy must be "user" (the user's explicit choice, whoever records it) or "agent" (your own significant fork); it is never defaulted.`));
    const { madeBy, description, ...rest } = fields;
    return { ok: true, flat, value: { action, decision: { description, madeBy }, ...rest } };
  }

  if (action === "question") {
    let fields: Record<string, unknown> | string = input;
    const legacy = isObject(input.question);
    if (legacy) {
      const { question, ...rest } = input;
      fields = merge(rest, question as Record<string, unknown>, "question");
      if (typeof fields === "string") return fail(fields);
    }
    const { humanAttention } = fields;
    if (humanAttention !== undefined && humanAttention !== "needs-opinion")
      return fail(decisionExample("question", `A question is always an open choice for the user; omit humanAttention (got ${JSON.stringify(humanAttention)}).`));
    const taken = TAKEN.filter(key => key in fields);
    // Old callers that said needs-opinion explicitly keep their accepted optional fields.
    if (taken.length && !(legacy && humanAttention === "needs-opinion"))
      return fail(decisionExample("question", `A question records a choice the user has not made, so it takes no ${taken.join("/")}. Put your proposal in recommendation and the background in context.`));
    const unknown = unknownFields("question", fields, [...FIELDS.question, ...taken]);
    if (unknown) return fail(unknown);
    if (typeof fields.question !== "string" || !fields.question.trim())
      return fail(decisionExample("question", `question is required: what the user must decide${fields.title === undefined ? "" : "; title is only a short label"}.`));
    let options = fields.options;
    if (Array.isArray(options)) {
      const bad = options.find(option => isObject(option) && Object.keys(option).some(key => !["label", "consequences"].includes(key)));
      if (bad) return fail(decisionExample("question", `Options are labels or {label, consequences}; ${JSON.stringify(Object.keys(bad as object).filter(key => !["label", "consequences"].includes(key)))} is not an option field.`));
      options = options.map(option => typeof option === "string" ? { label: option, consequences: "" } : isObject(option) ? { consequences: "", ...option } : option);
    }
    const title = typeof fields.title === "string" && fields.title.trim() ? fields.title : defaultTitle(fields.question);
    return { ok: true, flat: !legacy, value: { action, question: { ...fields, title, humanAttention: "needs-opinion", ...(options === undefined ? {} : { options }) } } };
  }

  const resolved = target(action, input);
  if (typeof resolved === "string") return fail(resolved);
  const unknown = unknownFields(action, resolved.fields, FIELDS[action]);
  if (unknown) return fail(unknown);
  const { ref, ...rest } = resolved.fields;
  if (action === "answer") {
    const choice = rest.choice === undefined ? null : rest.choice;
    if (choice === null && !(typeof rest.note === "string" && rest.note.trim()))
      return fail(decisionExample("answer", "Pick an option or write an answer: the user's choice (an option label) or their written answer in note."));
    return { ok: true, flat: true, value: { action, decision: ref, ...rest, choice } };
  }
  if (action === "withdraw") return { ok: true, flat: true, value: { action: "question-withdraw", decision: ref, ...rest } };
  return { ok: true, flat: true, value: { action: "decision-cleanup", decision: ref, ...rest } };
}

/** Formats nested-schema issues in the caller's own field names, with an example. */
export function decisionIssues(action: string, error: z.ZodError, flat: boolean) {
  const named: Action = action === "decision-cleanup" ? "cleanup" : action === "question-withdraw" ? "withdraw" : action as Action;
  const issues = error.issues.map(issue => {
    let path = issue.path.map(String);
    if (flat && (named === "decision" || named === "question") && path[0] === named) path = path.slice(1);
    if (named === "answer" || named === "cleanup" || named === "withdraw") path = path.map(key => key === "decision" ? "ref" : key);
    return `${path.join(".") || "input"}: ${issue.message.replace(/\.+$/, "")}`;
  });
  return decisionExample(named, `Invalid ${named}: ${issues.join("; ")}.`);
}
