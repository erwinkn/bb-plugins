import { describe, expect, it } from "vitest";
import type { MspApproval, MspItem } from "../src/protocol.js";
import {
  approvalPayload,
  availableDecisions,
  availableModels,
  callUsage,
  choiceFor,
  describeItem,
  describeTurnFailure,
  fileChangesFromPatch,
  itemStatus,
  modelDisplayName,
  museReasoningEffort,
  rateLimitState,
  splitMcpTool,
} from "../src/translate.js";

const ctx = { cwd: "/work", bbTools: new Map() };

function toolItem(fields: Partial<MspItem>): MspItem {
  return { itemId: "i1", kind: "toolCall", status: "completed", ...fields } as MspItem;
}

describe("item rows", () => {
  it("reads a completed bash envelope", () => {
    const row = describeItem(
      toolItem({
        tool: "bash",
        args: '{"command":"ls","cwd":"sub"}',
        visibleOutput: JSON.stringify({ exit_code: 2, output: "nope\n" }),
      }),
      ctx,
      true,
    );
    expect(row?.shape).toEqual({ type: "command", command: "ls", cwd: "/work/sub", aggregatedOutput: "nope\n", exitCode: 2 });
  });

  it("keeps raw output when bash has no envelope yet", () => {
    const row = describeItem(toolItem({ tool: "bash", args: '{"command":"ls"}', visibleOutput: "a\nb\n" }), ctx, true);
    expect(row?.shape).toMatchObject({ aggregatedOutput: "a\nb\n" });
  });

  it("tolerates partial streamed arguments", () => {
    const row = describeItem(toolItem({ tool: "bash", status: "inProgress", args: '{"command":"ec' }), ctx, false);
    expect(row?.shape).toEqual({ type: "command", command: "", cwd: "/work" });
  });

  it("maps search, web and unknown tools", () => {
    expect(describeItem(toolItem({ tool: "search", args: '{"pattern":"TODO","paths":["src"]}' }), ctx, false)?.shape).toEqual({
      type: "search",
      mode: "content",
      query: "TODO",
      path: "/work/src",
    });
    expect(describeItem(toolItem({ tool: "web_search", args: '{"query":"muse"}' }), ctx, false)?.shape).toEqual({
      type: "webSearch",
      queries: ["muse"],
    });
    expect(describeItem(toolItem({ tool: "web_fetch", args: '{"url":"https://x.dev"}' }), ctx, false)?.shape).toEqual({
      type: "webFetch",
      url: "https://x.dev",
      prompt: null,
      pattern: null,
    });
    const unknown = describeItem(
      toolItem({ tool: "cron_list", visibleOutput: "[]", displayLabel: { active: "Listing jobs", done: "Listed jobs" } }),
      ctx,
      true,
    );
    expect(unknown).toMatchObject({
      shape: { type: "tool", tool: "cron_list", result: "[]" },
      presentation: { label: { pending: "Listing jobs", completed: "Listed jobs" } },
    });
  });

  it("suppresses bookkeeping tools and names foreign MCP servers", () => {
    expect(describeItem(toolItem({ tool: "write_todos" }), ctx, false)?.presentation).toMatchObject({ suppress: true });
    expect(describeItem(toolItem({ tool: "mcp__linear__list_issues", args: "{}" }), ctx, true)?.shape).toMatchObject({
      type: "tool",
      tool: "list_issues",
      server: "linear",
    });
    expect(splitMcpTool("mcp__bb_bridge__memory_read")).toEqual({ server: "bb_bridge", tool: "memory_read" });
  });

  it("puts a failure on the row", () => {
    expect(
      describeItem(toolItem({ tool: "cron_list", status: "failed", failureReason: "denied by policy" }), ctx, true)?.shape,
    ).toMatchObject({ error: "denied by policy" });
  });

  it("models subagents as background delegations", () => {
    const row = describeItem(
      { itemId: "s1", kind: "subagent", status: "completed", childSessionId: "child-1", objective: "Check the tests", result: { summary: "All green" } } as MspItem,
      ctx,
      true,
    );
    expect(row?.shape).toEqual({ type: "delegation", childRef: "child-1", label: "Check the tests", background: true, summary: "All green" });
  });

  it("skips messages, reminders and user turns", () => {
    for (const kind of ["agentMessage", "reasoning", "userMessage", "reminderChild"]) {
      expect(describeItem({ itemId: "x", kind, status: "completed" } as MspItem, ctx, true)).toBeNull();
    }
  });

  it("reads statuses as bb's", () => {
    expect(itemStatus("inProgress")).toBeNull();
    expect(itemStatus("completed")).toBe("completed");
    expect(itemStatus("cancelled")).toBe("interrupted");
    expect(itemStatus("rejected")).toBe("failed");
    expect(itemStatus("somethingNew")).toBe("failed");
  });
});

describe("file changes", () => {
  it("turns Muse's tool_patch into per-file diffs", () => {
    expect(
      fileChangesFromPatch(
        {
          files: [
            { path: "a.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }] },
            { path: "/abs/new.txt", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hi"] }] },
            { path: "gone.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-bye"] }] },
          ],
        },
        "/work",
      ),
    ).toEqual([
      { path: "/work/a.txt", kind: "update", diff: "@@ -1,1 +1,1 @@\n-x\n+y\n" },
      { path: "/abs/new.txt", kind: "add", diff: "@@ -0,0 +1,1 @@\n+hi\n" },
      { path: "/work/gone.txt", kind: "delete", diff: "@@ -1,1 +0,0 @@\n-bye\n" },
    ]);
    expect(fileChangesFromPatch("nonsense", "/work")).toBeNull();
  });

  it("falls back to the printed diff when there is no patch document", () => {
    const row = describeItem(
      toolItem({ tool: "edit_file", args: '{"path":"n.txt","find":"a","replace":"b"}', visibleOutput: "edited\n--- original\n+++ updated\n-a\n+b\n" }),
      ctx,
      true,
    );
    expect(row?.shape).toEqual({
      type: "fileChange",
      changes: [{ path: "/work/n.txt", kind: "update", diff: "--- original\n+++ updated\n-a\n+b\n" }],
    });
  });
});

describe("usage", () => {
  it("splits Muse's inclusive prompt count the Claude way", () => {
    expect(
      callUsage({
        sessionId: "s",
        promptTokens: 29771,
        usage: { inputTokens: 29771, outputTokens: 57, cachedTokens: 29428, cacheReadTokens: 29428, cacheWriteTokens: 0, reasoningTokens: 4 },
      }),
    ).toEqual({
      inputTokens: 343,
      cachedInputTokens: 29428,
      cacheReadInputTokens: 29428,
      cacheWriteInputTokens: 0,
      outputTokens: 57,
      reasoningOutputTokens: 4,
      totalTokens: 29828,
    });
  });

  it("leaves unreported cache counts absent", () => {
    const usage = callUsage({ sessionId: "s", promptTokens: 10, usage: { outputTokens: 2 } });
    expect(usage).not.toHaveProperty("cacheReadInputTokens");
    expect(usage).toMatchObject({ inputTokens: 10, cachedInputTokens: 0, totalTokens: 12 });
  });

  it("warns near a subscription limit and blocks at it", () => {
    expect(rateLimitState({ window: { usedPercent: 85, windowDurationMins: 300 }, weekly: { usedPercent: 10 } })).toMatchObject({
      status: "warning",
      windows: [{ label: "5-hour window", status: "warning" }, { label: "Weekly", status: "allowed" }],
      reachedReason: null,
    });
    expect(rateLimitState({ weekly: { usedPercent: 104, resetsAtMs: 5 } })).toMatchObject({
      status: "blocked",
      reachedReason: "Muse weekly limit reached",
      windows: [{ resetsAtMs: 5 }],
    });
    expect(rateLimitState({})).toBeNull();
  });
});

describe("approvals", () => {
  const choices = [
    { choiceId: "persist", decision: "approvedPolicyAmendment", scope: "localPersistent" },
    { choiceId: "session", decision: "approvedPolicyAmendment", scope: "session" },
    { choiceId: "once", decision: "approved", scope: "once" },
    { choiceId: "abort", decision: "abort", scope: "once" },
    { choiceId: "deny", decision: "denied", scope: "once" },
  ];

  it("picks the narrowest choice for each bb decision", () => {
    expect(choiceFor(choices, "allow_once")?.choiceId).toBe("once");
    expect(choiceFor(choices, "allow_for_session")?.choiceId).toBe("session");
    expect(choiceFor(choices, "deny")?.choiceId).toBe("deny");
    expect(choiceFor([{ choiceId: "abort", decision: "abort" }], "deny")?.choiceId).toBe("abort");
    expect(availableDecisions([{ choiceId: "persist", decision: "approvedPolicyAmendment", scope: "localPersistent" }])).toEqual([]);
  });

  const base = { approvalId: "a1", sessionId: "s", itemId: "item-1", currentRequirementId: null, availableChoices: choices } as unknown as MspApproval;

  it("shows a network request as a tool use with its host", () => {
    const payload = approvalPayload({ ...base, toolName: "bash", subject: { kind: "network", host: "example.com" } }, "/work");
    expect(payload).toMatchObject({
      kind: "approval",
      subject: {
        kind: "tool_use",
        itemId: "item-1",
        tool: "bash",
        presentation: { label: { pending: "Use the network" }, detail: "host `example.com`" },
      },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });
  });

  it("shows a protected write as a file change", () => {
    expect(approvalPayload({ ...base, subject: { kind: "fileAccess", access: "write", path: "/work/.git/config" } }, "/work")).toMatchObject({
      subject: { kind: "file_change", itemId: "item-1", writeScope: "/work/.git/config" },
    });
  });
});

describe("models", () => {
  it("names models and keeps the efforts bb knows", () => {
    expect(modelDisplayName("muse-spark-1.3")).toBe("Muse Spark 1.3");
    const [model] = availableModels({
      models: [{ modelId: "muse-x", variants: ["minimal", "low", "ultra"], defaultReasoningEffort: "minimal" }],
    });
    expect(model).toMatchObject({
      id: "muse-x",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
      defaultReasoningEffort: "ultra",
    });
    expect(museReasoningEffort("ultracode")).toBe("max");
    expect(museReasoningEffort("bogus")).toBeUndefined();
  });
});

describe("turn failures", () => {
  it("classifies quota, auth and plain failures", () => {
    expect(describeTurnFailure({ kind: "modelError", message: "429 quota exceeded" }, null)).toMatchObject({
      errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
      recovery: "rateLimited",
    });
    expect(describeTurnFailure({ kind: "authRequired", message: "token expired" }, null)).toMatchObject({
      recovery: "authRequired",
      message: expect.stringContaining("muse login"),
    });
    expect(describeTurnFailure(null, "crash")).toEqual({ message: "crash", errorInfo: null, recovery: null });
  });
});
