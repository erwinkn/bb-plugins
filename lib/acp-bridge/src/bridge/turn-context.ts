/**
 * OptChat's per-turn context for ACP agents (turnContext protocol 4).
 *
 * BB's fork calls it "per-turn context from a hidden tool" (FORK.md): a plugin (Chat memory)
 * selects the hidden dynamic tool `claude_code_turn_context` for a thread, and a bridge that
 * advertises `turnContext: true` asks it before each new turn what the turn runs in. The answer
 * is `{}` (keep the session, send the turn's own text) or `{ session: "fresh", sessionId,
 * systemPrompt, input }` (a new session with that system prompt, sent `input` instead). Anything
 * else fails the turn (D458: a memory mode is never silently dropped).
 *
 * The protocol, its limits and its retry are those of the Claude Code bridge
 * (`~/Code/bb/plugins/provider-claude-code/src/bridge/turn-context.ts`), so one Chat memory
 * plugin serves both.
 */
import { z } from "zod";
import type { DynamicTool, PromptInput } from "../bb.js";

export const TURN_CONTEXT_TOOL_NAME = "claude_code_turn_context";
export const TURN_CONTEXT_PROTOCOL = 4;
export const TURN_CONTEXT_TIMEOUT_MS = 120_000;
/**
 * W570: the Chat memory plugin's fixed failure when a reload of the plugin cut its wait short.
 * The bridge asks again, with `elapsedMs`, while TURN_CONTEXT_RETRY_WINDOW_MS since its first ask
 * have not passed; the plugin ends its wait 90 s after that first ask.
 */
export const TURN_CONTEXT_RESTARTING =
  "OptChat memory unavailable for this turn: chat-memory is restarting. The message was not sent; send it again.";
/** The plugin's own wait: a retry later than this could not be answered within the timeout. */
export const TURN_CONTEXT_RETRY_WINDOW_MS = 90_000;
export const TURN_CONTEXT_RETRY_PAUSE_MS = 1_000;
/** How long after that window the bridge ends a retry the plugin has not answered (an older plugin). */
export const TURN_CONTEXT_RETRY_GRACE_MS = 2_000;
/** How long a fresh answer's new session may take to start (Claude Code's startup limit). */
export const FRESH_SESSION_TIMEOUT_MS = 30_000;

const freshSessionAnswerSchema = z
  .object({
    session: z.literal("fresh"),
    sessionId: z.string().uuid(),
    systemPrompt: z.string(),
    input: z.string().min(1),
  })
  .strict();

const residentAnswerSchema = z.object({}).strict();

export type TurnContext = z.infer<typeof freshSessionAnswerSchema>;

export type TurnContextAnswer =
  { ok: true; context: TurnContext | null } | { ok: false; error: string };

export function hasTurnContextTool(
  dynamicTools: readonly DynamicTool[] | undefined,
): boolean {
  return (dynamicTools ?? []).some(
    (tool) => tool.name === TURN_CONTEXT_TOOL_NAME,
  );
}

/** The tools the agent may see: the hook is the bridge's, never the model's. */
export function withoutTurnContextTool(
  dynamicTools: readonly DynamicTool[],
): DynamicTool[] {
  return dynamicTools.filter((tool) => tool.name !== TURN_CONTEXT_TOOL_NAME);
}

/**
 * Whether a failed answer came from a reload of the plugin that serves the tool: its fixed
 * restarting error, or BB's answer while no instance of it is loaded.
 */
export function isTurnContextRestart(error: string): boolean {
  return (
    error.includes(TURN_CONTEXT_RESTARTING) ||
    error.includes(`Unsupported tool: ${TURN_CONTEXT_TOOL_NAME}`)
  );
}

export function parseTurnContext(result: {
  content: string;
  isError?: boolean;
}): TurnContextAnswer {
  if (result.isError === true) {
    return { ok: false, error: result.content || "the tool call failed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.content);
  } catch {
    return { ok: false, error: "the answer is not JSON" };
  }
  if (typeof value === "object" && value !== null && "session" in value) {
    const fresh = freshSessionAnswerSchema.safeParse(value);
    if (!fresh.success) {
      return { ok: false, error: "the fresh session answer is malformed" };
    }
    return { ok: true, context: fresh.data };
  }
  if (!residentAnswerSchema.safeParse(value).success) {
    return { ok: false, error: "the answer is malformed" };
  }
  return { ok: true, context: null };
}

/** The turn's text as the hook reads it: its text blocks, attachments left out. */
export function turnInputText(input: readonly PromptInput[]): string {
  return input
    .flatMap((item) =>
      item.type === "text" && item.text.length > 0 ? [item.text] : [],
    )
    .join("\n\n");
}

/** A fresh session's first input: the answer's text, then the turn's attachments. */
export function freshSessionInput(
  context: TurnContext,
  input: readonly PromptInput[],
): PromptInput[] {
  return [
    { type: "text", text: context.input } as PromptInput,
    ...input.filter((item) => item.type !== "text"),
  ];
}

/** The system prompt of a fresh session: the thread's own instructions, then the answer's. */
export function combineSystemPrompt(
  base: string | undefined,
  extra: string,
): string | undefined {
  const parts = [base ?? "", extra].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

const antigravitySystemPromptAppendSchema = z.object({
  _meta: z.object({
    antigravity: z.object({
      systemPrompt: z.object({ append: z.literal(true) }),
    }),
  }),
});

/**
 * Whether the agent takes an appended system prompt on `session/new` (Antigravity's
 * `agentCapabilities._meta.antigravity.systemPrompt.append`). Other agents get it as
 * `<system_instructions>` in the session's first prompt.
 */
export function supportsSystemPromptAppend(
  agentCapabilities: unknown,
): boolean {
  return antigravitySystemPromptAppendSchema.safeParse(agentCapabilities)
    .success;
}

export function systemPromptAppendMeta(systemPrompt: string): {
  _meta: { antigravity: { systemPrompt: { append: string } } };
} {
  return { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } };
}
