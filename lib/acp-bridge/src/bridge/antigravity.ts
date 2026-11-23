/**
 * Antigravity (`agy acp`) runs work in the background across its turns: a `run_command` that
 * outlives its `WaitMsBeforeAsync` (at most 10 s), an `invoke_subagent`, a `schedule` timer. Its
 * own system prompt tells the model to end its turn and wait to be notified. `session/prompt`
 * then answers `end_turn`, and when the work reports, agy wakes on its own and streams the rest
 * of the task as `session/update`s that no prompt asked for. BB closed the thread's turn at the
 * `end_turn` and drops those updates, so the thread sits idle while agy works on unseen.
 *
 * The bridge therefore holds the BB turn open while work agy started in the turn is outstanding
 * (see `holdForBackgroundWork` in bridge.ts), and tells the model how to work without it
 * (`ANTIGRAVITY_RUNTIME_INSTRUCTIONS`). Measured on agy 1.5.14:
 * - a backgrounded `run_command` stays `in_progress` past `end_turn`; its `completed` (or
 *   `failed`) `tool_call_update` comes when it exits, then agy wakes;
 * - `invoke_subagent` and `schedule` complete at once: nothing on the wire says when the
 *   subagent or the timer reports, only agy waking;
 * - a `session/prompt` sent while agy streams such a wake joins that wake and is answered when it
 *   ends, so it gives the wake a clean `stopReason`;
 * - `session/cancel` with no prompt pending is ignored: a wake cannot be cancelled.
 */
import { z } from "zod";
import type { PromptInput } from "../bb.js";

/**
 * Bounds of one held turn. With work outstanding and no update from agy for `idleMs`, the turn
 * ends (agy's own prompt has it set a wake-up of at most a few minutes before it waits, and a
 * subagent took 6.5 min to report in thread thr_5t2nmdec5s). `maxFollowUps` caps the prompts the
 * bridge sends on agy's wakes in one turn; past it the turn stays open without them until it
 * idles. `maxMs` ends a turn held that long in total, whatever happens (a recurring timer would
 * wake agy forever), prompts sent in the hold included: one that agy has not answered by then is
 * cancelled. Mutable for tests only.
 */
export const antigravityHoldLimits = {
  idleMs: 10 * 60_000,
  maxMs: 2 * 60 * 60_000,
  maxFollowUps: 10,
};

/** BB's instructions for every Antigravity session, after the thread's own. */
export const ANTIGRAVITY_RUNTIME_INSTRUCTIONS = `<bb_runtime>
You run inside BB. When you end your turn, BB marks this thread idle: work that reports after that (a \`run_command\` that went to the background, an \`invoke_subagent\` subagent, a \`schedule\` timer) may never reach the user.
- Do not end your turn while you wait on such work. Finish waiting in this turn.
- Run a command that may take longer than 10 s (the \`WaitMsBeforeAsync\` limit) with \`~/.bb/bin/bgjob <command>\` where that file exists: it runs outside your turn and BB messages this thread when it exits. Or run it in this turn and check it with \`manage_task\` until it is done.
- To be woken later, run \`bb thread tell "$BB_THREAD_ID" --mode queue --send-at <time or delay, e.g. 30m> "<what to do then>"\`, not \`schedule\`.
- Before you end your turn, wait for every subagent you started to report, or stop it with \`manage_subagents\`. Never leave one running.
</bb_runtime>`;

/** What the bridge sends when agy wakes during a held turn: the wake's `stopReason` ends it. */
export const ANTIGRAVITY_FOLLOW_UP_TEXT =
  "<bb_runtime>Background work you started reported while this turn is still open in BB. Continue from it; once nothing you wait on is still running, give your final answer.</bb_runtime>";

export function antigravityFollowUpInput(): PromptInput[] {
  return [{ type: "text", text: ANTIGRAVITY_FOLLOW_UP_TEXT } as PromptInput];
}

const antigravityCapabilitiesSchema = z.object({
  _meta: z.object({ antigravity: z.object({}).passthrough() }),
});

/** Whether `initialize`'s `agentCapabilities` are Antigravity's (`_meta.antigravity`). */
export function isAntigravityAgent(agentCapabilities: unknown): boolean {
  return antigravityCapabilitiesSchema.safeParse(agentCapabilities).success;
}

/** The thread's instructions with BB's Antigravity runtime instructions after them. */
export function withAntigravityRuntimeInstructions(
  instructions: string | undefined,
): string {
  return instructions === undefined || instructions.length === 0
    ? ANTIGRAVITY_RUNTIME_INSTRUCTIONS
    : `${instructions}\n\n${ANTIGRAVITY_RUNTIME_INSTRUCTIONS}`;
}

const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Tools whose completion only starts the work: it reports later, by waking agy. */
const WAKING_TOOLS: ReadonlySet<string> = new Set([
  "invoke_subagent",
  "schedule",
]);

/** Tools whose later updates the tracker must recognize by id alone. */
const TRACKED_TOOLS: ReadonlySet<string> = new Set([
  "run_command",
  "manage_subagents",
  ...WAKING_TOOLS,
]);

/** Updates that say agy is working, as opposed to its bookkeeping (usage, title, commands). */
const ACTIVITY_UPDATES: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

const toolUpdateSchema = z.object({
  sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
  toolCallId: z.string(),
  name: z.string().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  rawInput: z.unknown().optional(),
});

const manageSubagentsInputSchema = z.object({ Action: z.string() });

/**
 * The work agy started in the open BB turn that may still report: `run_command`s with no terminal
 * status yet, and the subagents and timers it launched (outstanding until `manage_subagents`
 * kills them all, since agy reports neither their end nor their ids). Cleared when the turn ends.
 */
export class AntigravityBackgroundWork {
  private readonly commands = new Map<string, string>();
  private readonly launches = new Map<string, string>();
  /**
   * The name and input of each tracked tool call by id: a `tool_call_update` may carry only its
   * id and new status, so its identity comes from the updates before it.
   */
  private readonly toolCalls = new Map<
    string,
    { name?: string; rawInput?: unknown }
  >();
  /** No prompt is pending: agy answered the last one. */
  private answered = true;
  /** Work was outstanding when agy answered. */
  private outstandingAtAnswer = false;
  /** agy showed activity since that answer: the work reported and woke it. */
  private wokeAfterAnswer = false;

  /** Notes one `session/update`; returns whether it shows agy working. */
  observe(update: { sessionUpdate: string }): boolean {
    const tool = toolUpdateSchema.safeParse(update);
    if (tool.success) {
      this.noteTool(tool.data);
    }
    const activity = ACTIVITY_UPDATES.has(update.sessionUpdate);
    if (activity && this.answered && this.outstandingAtAnswer) {
      this.wokeAfterAnswer = true;
    }
    return activity;
  }

  promptSent(): void {
    this.answered = false;
    this.outstandingAtAnswer = false;
    this.wokeAfterAnswer = false;
  }

  /**
   * Called as agy's answer is read, before the updates read with it: one stdout chunk can hold
   * the `end_turn`, the command's completion and the start of the wake it causes.
   */
  promptAnswered(): void {
    this.answered = true;
    this.outstandingAtAnswer = this.hasWork();
    this.wokeAfterAnswer = false;
  }

  /**
   * What agy's last answer left: whether work is (or was, at the answer) outstanding, and whether
   * agy woke for it since. Reading it consumes the wake.
   */
  takeAfterAnswer(): { outstanding: boolean; woke: boolean } {
    const state = {
      outstanding: this.outstandingAtAnswer || this.hasWork(),
      woke: this.wokeAfterAnswer,
    };
    this.wokeAfterAnswer = false;
    return state;
  }

  hasWork(): boolean {
    return this.commands.size > 0 || this.launches.size > 0;
  }

  /** A short description of the outstanding work, for logs. */
  describe(): string {
    const parts = [
      ...[...this.commands.values()].map((title) => `run_command ${title}`),
      ...this.launches.values(),
    ];
    return parts.join(", ");
  }

  clear(): void {
    this.commands.clear();
    this.launches.clear();
    this.toolCalls.clear();
    this.answered = true;
    this.outstandingAtAnswer = false;
    this.wokeAfterAnswer = false;
  }

  private noteTool(update: z.infer<typeof toolUpdateSchema>): void {
    const known = this.toolCalls.get(update.toolCallId);
    const tool = {
      ...update,
      name: update.name ?? known?.name,
      rawInput: update.rawInput ?? known?.rawInput,
    };
    const terminal =
      tool.status !== undefined && TERMINAL_TOOL_STATUSES.has(tool.status);
    if (tool.name !== undefined && TRACKED_TOOLS.has(tool.name)) {
      if (terminal) {
        this.toolCalls.delete(tool.toolCallId);
      } else if (known !== undefined || tool.sessionUpdate === "tool_call") {
        this.toolCalls.set(tool.toolCallId, {
          name: tool.name,
          rawInput: tool.rawInput,
        });
      }
    }
    if (tool.name === "run_command") {
      if (terminal) {
        this.commands.delete(tool.toolCallId);
      } else if (tool.sessionUpdate === "tool_call") {
        this.commands.set(
          tool.toolCallId,
          JSON.stringify((tool.title ?? "").slice(0, 80)),
        );
      }
      return;
    }
    if (tool.name !== undefined && WAKING_TOOLS.has(tool.name)) {
      // Its `completed` means launched; only a failed launch never reports.
      if (tool.status === "failed" || tool.status === "cancelled") {
        this.launches.delete(tool.toolCallId);
      } else if (tool.sessionUpdate === "tool_call") {
        this.launches.set(tool.toolCallId, tool.name);
      }
      return;
    }
    if (tool.name === "manage_subagents" && tool.status === "completed") {
      const input = manageSubagentsInputSchema.safeParse(tool.rawInput);
      if (input.success && input.data.Action === "kill_all") {
        for (const [id, name] of this.launches) {
          if (name === "invoke_subagent") this.launches.delete(id);
        }
      }
    }
  }
}
