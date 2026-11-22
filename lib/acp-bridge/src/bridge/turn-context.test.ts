import { describe, expect, it } from "vitest";
import {
  TURN_CONTEXT_RESTARTING,
  TURN_CONTEXT_TOOL_NAME,
  combineSystemPrompt,
  freshSessionInput,
  hasTurnContextTool,
  isTurnContextRestart,
  parseTurnContext,
  supportsSystemPromptAppend,
  turnInputText,
  withoutTurnContextTool,
} from "./turn-context.js";

const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object" },
});
const fresh = {
  session: "fresh",
  sessionId: "5a3c1c0e-8f0a-4e4b-9d61-0b8a4f1f2c3d",
  systemPrompt: "VIEW",
  input: "TAIL",
};

describe("turn context protocol 4", () => {
  it("finds and strips the hidden tool", () => {
    const tools = [tool("memory_read"), tool(TURN_CONTEXT_TOOL_NAME)];
    expect(hasTurnContextTool(tools)).toBe(true);
    expect(hasTurnContextTool(undefined)).toBe(false);
    expect(withoutTurnContextTool(tools).map((t) => t.name)).toEqual([
      "memory_read",
    ]);
  });

  it("reads `{}` as the resident session and a fresh answer as a new one", () => {
    expect(parseTurnContext({ content: "{}" })).toEqual({
      ok: true,
      context: null,
    });
    expect(parseTurnContext({ content: JSON.stringify(fresh) })).toEqual({
      ok: true,
      context: fresh,
    });
  });

  it.each([
    [{ content: "{", isError: false }, "the answer is not JSON"],
    [{ content: '{"ack":true}' }, "the answer is malformed"],
    [{ content: "[]" }, "the answer is malformed"],
    [
      { content: JSON.stringify({ ...fresh, input: "" }) },
      "the fresh session answer is malformed",
    ],
    [
      { content: JSON.stringify({ ...fresh, sessionId: "nope" }) },
      "the fresh session answer is malformed",
    ],
    [
      { content: JSON.stringify({ ...fresh, extra: 1 }) },
      "the fresh session answer is malformed",
    ],
    [{ content: "boom", isError: true }, "boom"],
    [{ content: "", isError: true }, "the tool call failed"],
  ])("fails closed on %j", (result, error) => {
    expect(parseTurnContext(result)).toEqual({ ok: false, error });
  });

  it("recognizes a reload of the plugin", () => {
    expect(isTurnContextRestart(`x ${TURN_CONTEXT_RESTARTING}`)).toBe(true);
    expect(
      isTurnContextRestart(`Unsupported tool: ${TURN_CONTEXT_TOOL_NAME}`),
    ).toBe(true);
    expect(isTurnContextRestart("memory broke")).toBe(false);
  });

  it("builds the fresh session's prompt and system prompt", () => {
    const input = [
      { type: "text", text: "hello", mentions: [] },
      { type: "localImage", path: "/a.png" },
      { type: "text", text: "again", mentions: [] },
    ] as Parameters<typeof turnInputText>[0];
    expect(turnInputText(input)).toBe("hello\n\nagain");
    expect(freshSessionInput({ ...fresh, session: "fresh" }, input)).toEqual([
      { type: "text", text: "TAIL" },
      { type: "localImage", path: "/a.png" },
    ]);
    expect(combineSystemPrompt("BASE", "VIEW")).toBe("BASE\n\nVIEW");
    expect(combineSystemPrompt(undefined, "VIEW")).toBe("VIEW");
    expect(combineSystemPrompt("BASE", "")).toBe("BASE");
    expect(combineSystemPrompt(undefined, "")).toBeUndefined();
  });

  it("detects Antigravity's system prompt hook", () => {
    expect(
      supportsSystemPromptAppend({
        _meta: { antigravity: { systemPrompt: { append: true } } },
      }),
    ).toBe(true);
    expect(supportsSystemPromptAppend({ loadSession: true })).toBe(false);
    expect(supportsSystemPromptAppend(undefined)).toBe(false);
  });
});
