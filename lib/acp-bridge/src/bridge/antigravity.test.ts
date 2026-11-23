import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_RUNTIME_INSTRUCTIONS,
  AntigravityBackgroundWork,
  isAntigravityAgent,
  withAntigravityRuntimeInstructions,
} from "./antigravity.js";

const tool = (
  sessionUpdate: "tool_call" | "tool_call_update",
  toolCallId: string,
  name: string,
  status?: string,
  rawInput?: unknown,
) => ({
  sessionUpdate,
  toolCallId,
  name,
  kind: name === "run_command" ? "execute" : "other",
  ...(status === undefined ? {} : { status }),
  ...(rawInput === undefined ? {} : { rawInput }),
});

describe("Antigravity background work", () => {
  it("tracks a run_command until a terminal status", () => {
    const work = new AntigravityBackgroundWork();
    work.observe(tool("tool_call", "a", "run_command", "in_progress"));
    work.observe(tool("tool_call", "b", "run_command", "pending"));
    work.observe(tool("tool_call", "c", "run_command", "in_progress"));
    expect(work.hasWork()).toBe(true);
    work.observe(tool("tool_call_update", "a", "run_command", "completed"));
    work.observe(tool("tool_call_update", "b", "run_command", "failed"));
    work.observe(tool("tool_call_update", "c", "run_command", "in_progress"));
    expect(work.hasWork()).toBe(true);
    work.observe(tool("tool_call_update", "c", "run_command", "cancelled"));
    expect(work.hasWork()).toBe(false);
  });

  it("recognizes tools by id when their updates omit the name and input", () => {
    const work = new AntigravityBackgroundWork();
    const update = (toolCallId: string, status: string) => ({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
    });
    work.observe(tool("tool_call", "c", "run_command", "in_progress"));
    work.observe(update("c", "in_progress"));
    expect(work.hasWork()).toBe(true);
    work.observe(update("c", "completed"));
    expect(work.hasWork()).toBe(false);

    work.observe(tool("tool_call", "s", "invoke_subagent", "in_progress"));
    work.observe(update("s", "completed"));
    expect(work.describe()).toBe("invoke_subagent");
    work.observe(
      tool("tool_call", "k", "manage_subagents", "in_progress", {
        Action: "kill_all",
      }),
    );
    work.observe(update("k", "completed"));
    expect(work.hasWork()).toBe(false);

    work.observe(tool("tool_call", "s2", "invoke_subagent", "in_progress"));
    work.observe(update("s2", "failed"));
    expect(work.hasWork()).toBe(false);
  });

  it("remembers work outstanding at agy's answer, and its wake, though both came after it", () => {
    const work = new AntigravityBackgroundWork();
    const chunk = { sessionUpdate: "agent_message_chunk" };
    work.promptSent();
    work.observe(tool("tool_call", "a", "run_command", "in_progress"));
    work.observe(chunk);
    work.promptAnswered();
    // Read in the same stdout chunk as the answer, before the turn loop looks.
    work.observe(tool("tool_call_update", "a", "run_command", "completed"));
    work.observe(chunk);
    expect(work.hasWork()).toBe(false);
    expect(work.takeAfterAnswer()).toEqual({ outstanding: true, woke: true });
    expect(work.takeAfterAnswer()).toEqual({ outstanding: true, woke: false });

    // Nothing outstanding at the answer: later chatter is not a wake.
    work.promptSent();
    work.promptAnswered();
    work.observe(chunk);
    expect(work.takeAfterAnswer()).toEqual({ outstanding: false, woke: false });
  });

  it("ignores updates of a command it never saw start, and other tools", () => {
    const work = new AntigravityBackgroundWork();
    work.observe(
      tool("tool_call_update", "late", "run_command", "in_progress"),
    );
    work.observe(tool("tool_call", "r", "read_file", "in_progress"));
    work.observe(tool("tool_call", "d", "define_subagent", "in_progress"));
    expect(work.hasWork()).toBe(false);
  });

  it("keeps launched subagents and timers outstanding past their completed launch", () => {
    const work = new AntigravityBackgroundWork();
    work.observe(tool("tool_call", "s", "invoke_subagent", "in_progress"));
    work.observe(tool("tool_call_update", "s", "invoke_subagent", "completed"));
    work.observe(tool("tool_call", "t", "schedule", "in_progress"));
    work.observe(tool("tool_call_update", "t", "schedule", "completed"));
    expect(work.describe()).toBe("invoke_subagent, schedule");
    work.observe(
      tool("tool_call", "k", "manage_subagents", "in_progress", {
        Action: "kill_all",
      }),
    );
    expect(work.describe()).toBe("invoke_subagent, schedule");
    work.observe(
      tool("tool_call_update", "k", "manage_subagents", "completed", {
        Action: "kill_all",
      }),
    );
    // kill_all stops subagents, not timers.
    expect(work.describe()).toBe("schedule");
    work.clear();
    expect(work.hasWork()).toBe(false);
  });

  it("drops a launch that failed, and keeps subagents past a kill of named ones", () => {
    const work = new AntigravityBackgroundWork();
    work.observe(tool("tool_call", "s", "invoke_subagent", "in_progress"));
    work.observe(tool("tool_call_update", "s", "invoke_subagent", "failed"));
    expect(work.hasWork()).toBe(false);
    work.observe(tool("tool_call", "s2", "invoke_subagent", "in_progress"));
    work.observe(
      tool("tool_call_update", "k", "manage_subagents", "completed", {
        Action: "kill",
        ConversationIds: ["x"],
      }),
    );
    expect(work.hasWork()).toBe(true);
  });

  it("tells agy's activity from its bookkeeping", () => {
    const work = new AntigravityBackgroundWork();
    for (const sessionUpdate of [
      "agent_message_chunk",
      "agent_thought_chunk",
      "plan",
    ]) {
      expect(work.observe({ sessionUpdate })).toBe(true);
    }
    expect(work.observe(tool("tool_call_update", "x", "read_file"))).toBe(true);
    for (const sessionUpdate of [
      "usage_update",
      "session_info_update",
      "available_commands_update",
      "current_mode_update",
    ]) {
      expect(work.observe({ sessionUpdate })).toBe(false);
    }
  });

  it("describes outstanding commands by their title", () => {
    const work = new AntigravityBackgroundWork();
    const started = {
      ...tool("tool_call", "a", "run_command", "in_progress"),
      title: "pnpm typecheck",
    };
    work.observe(started);
    expect(work.describe()).toBe('run_command "pnpm typecheck"');
  });
});

describe("Antigravity detection and instructions", () => {
  it("recognizes agy by its _meta.antigravity capabilities", () => {
    expect(
      isAntigravityAgent({
        loadSession: true,
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      }),
    ).toBe(true);
    expect(isAntigravityAgent({ loadSession: true })).toBe(false);
    expect(isAntigravityAgent({ _meta: { other: {} } })).toBe(false);
    expect(isAntigravityAgent({ _meta: { antigravity: true } })).toBe(false);
    expect(isAntigravityAgent(undefined)).toBe(false);
  });

  it("puts BB's runtime instructions after the thread's", () => {
    expect(withAntigravityRuntimeInstructions(undefined)).toBe(
      ANTIGRAVITY_RUNTIME_INSTRUCTIONS,
    );
    expect(withAntigravityRuntimeInstructions("")).toBe(
      ANTIGRAVITY_RUNTIME_INSTRUCTIONS,
    );
    expect(withAntigravityRuntimeInstructions("Be terse.")).toBe(
      `Be terse.\n\n${ANTIGRAVITY_RUNTIME_INSTRUCTIONS}`,
    );
  });
});
