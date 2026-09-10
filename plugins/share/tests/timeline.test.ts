import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { MAX_ROWS, OUTPUT_PREVIEW_OMITTED, readTimeline, rowToItem, type TimelineRow } from "../server/timeline";
import { renderPage } from "../lib/render";
import { base, command, message, NOW, page, rows } from "./fixtures";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
function setup() {
  const host = createFakePluginHost({ pluginId: "share", sdk: { threads: {
    get: async () => makeThreadResponse({ title: "Timeline fixture" }), timeline: async () => page(), timelineTurnSummaryDetails: async () => ({ rows: [command] }),
  } } }); hosts.push(host); return host;
}
describe("timeline reading", () => {
  it("pages backward with both cursor fields and sorts by source sequence", async () => {
    const h = setup();
    h.harness.sdk.stub("threads.timeline", async (args: { beforeAnchorId?: string }) => args.beforeAnchorId ? page([message(1), message(2)]) : page([message(2), message(3)], { anchorId: "older", anchorSeq: 2 }));
    const result = await readTimeline(h.bb.sdk.threads, "t", false);
    expect(result.items.map((item) => item.kind === "message" && item.text)).toEqual(["Message 1", "Message 2", "Message 3"]);
    expect(h.harness.inspection.sdk.callsTo("threads.timeline")[1]?.[0]).toEqual({ threadId: "t", includeNestedRows: "true", summaryOnly: "false", beforeAnchorId: "older", beforeAnchorSeq: "2" });
    expect(result.truncated).toBe(false);
  });
  it.each([false, true])("reads nested conversations and expands collapsed work only with tools=%s", async (tools) => {
    const h = setup();
    const collapsed: TimelineRow = { ...base("collapsed", 3), sourceSeqEnd: 4, kind: "turn", status: "completed", summaryCount: 1, completedAt: 5, children: null, turnId: "turn_1" };
    const nested: TimelineRow = { ...base("nested", 1), kind: "turn", status: "completed", summaryCount: 1, completedAt: 5, children: [rows[0]!, message(2)], turnId: "turn_1" };
    h.harness.sdk.stub("threads.timeline", async () => page([nested, collapsed]));
    const result = await readTimeline(h.bb.sdk.threads, "t", tools);
    expect(result.items.map((item) => item.kind)).toEqual(tools ? ["message", "message", "tool"] : ["message", "message"]);
    expect(h.harness.inspection.sdk.callsTo("threads.timelineTurnSummaryDetails")).toHaveLength(tools ? 1 : 0);
    if (tools) expect(h.harness.inspection.sdk.callsTo("threads.timelineTurnSummaryDetails")[0]?.[0]).toEqual({ threadId: "t", turnId: "turn_1", sourceSeqStart: "3", sourceSeqEnd: "4" });
  });
  it("caps even expanded rows at 5000 and flags truncation", async () => {
    const h = setup();
    const collapsed: TimelineRow = { ...base("collapsed", 1), sourceSeqEnd: MAX_ROWS + 1, kind: "turn", status: "completed", summaryCount: MAX_ROWS + 1, completedAt: 5, children: null, turnId: "turn_1" };
    h.harness.sdk.stub("threads.timeline", async () => page([collapsed]));
    h.harness.sdk.stub("threads.timelineTurnSummaryDetails", async () => ({ rows: Array.from({ length: MAX_ROWS + 1 }, (_, i) => message(i + 1)) }));
    const result = await readTimeline(h.bb.sdk.threads, "t", true);
    expect(result.items).toHaveLength(MAX_ROWS); expect(result.truncated).toBe(true);
    expect(result.items[0]).toMatchObject({ text: "Message 2" }); expect(result.items.at(-1)).toMatchObject({ text: `Message ${MAX_ROWS + 1}` });
  });
  it("stops repeated cursors without looping and reports incomplete data", async () => {
    const h = setup(); h.harness.sdk.stub("threads.timeline", async () => page([message(1)], { anchorId: "same", anchorSeq: 1 }));
    expect((await readTimeline(h.bb.sdk.threads, "t", false)).truncated).toBe(true);
    expect(h.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(2);
  });
  it.each(["nested", "expanded", "older page"])("keeps newer children of an early turn after collecting %s rows", async (source) => {
    const h = setup();
    const turn: TimelineRow = { ...base("early-turn", 1), sourceSeqEnd: 20, kind: "turn", status: "completed", summaryCount: 1, completedAt: NOW + 20, children: source === "expanded" ? null : [message(20)], turnId: "turn_1" };
    h.harness.sdk.stub("threads.timeline", async (args: { beforeAnchorId?: string }) => source === "older page"
      ? args.beforeAnchorId ? page([turn]) : page([message(10)], { anchorId: "older", anchorSeq: 1 })
      : page([message(10), turn]));
    h.harness.sdk.stub("threads.timelineTurnSummaryDetails", async () => ({ rows: [message(20)] }));
    const result = await readTimeline(h.bb.sdk.threads, "t", true, 1);
    expect(result.items).toEqual([{ kind: "message", role: "assistant", text: "Message 20", at: NOW + 20 }]);
    expect(result.truncated).toBe(true);
    expect(h.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(source === "older page" ? 2 : 1);
  });
  it("drops system-initiated messages and image work; notes SDK output previews", async () => {
    const h = setup(); const user = rows[0]!;
    h.harness.sdk.stub("threads.timeline", async () => page([
      ...(user.kind === "conversation" && user.role === "user" ? [{ ...user, initiator: "system" as const }] : []),
      { ...base("image", 2), kind: "work", workKind: "image-view", status: "completed", callId: "i", path: "/private.png", completedAt: 5 },
      { ...command, output: "partial", outputPreview: { totalChars: 1000 } },
    ]));
    const result = await readTimeline(h.bb.sdk.threads, "t", true);
    expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ title: "npm test", output: OUTPUT_PREVIEW_OMITTED }); expect(result.truncated).toBe(true);
  });
  it.each(["command", "tool"] as const)("omits incomplete %s output before it reaches rendered HTML", async (workKind) => {
    const h = setup();
    // BB retains the first 2000 and last 1000 characters. The missing middle
    // includes the footer, and also contains text that no redaction rule knows.
    const full = `-----BEGIN PRIVATE KEY-----\n${"Ab0+/".repeat(450)}\n-----END PRIVATE KEY-----\n${"private words. ".repeat(100)}`;
    const output = full.slice(0, 2000) + full.slice(-1000);
    const row = { ...command, workKind, toolName: "run_tests", toolArgs: { cwd: "/workspace" }, output, outputPreview: { totalChars: full.length } } satisfies TimelineRow;
    h.harness.sdk.stub("threads.timeline", async () => page([row]));
    const result = await readTimeline(h.bb.sdk.threads, "t", true);
    expect(result.truncated).toBe(true);
    expect(result.items).toEqual([{ kind: "tool", title: workKind === "command" ? "npm test" : "run_tests", detail: "/workspace", status: "completed", output: OUTPUT_PREVIEW_OMITTED, at: command.createdAt }]);
    const html = renderPage({ ...result, mode: "public", unverified: false, generatedAt: NOW });
    expect(html).toContain(OUTPUT_PREVIEW_OMITTED);
    expect(html).toContain("/workspace"); expect(html).toContain("completed");
    expect(html).not.toMatch(/BEGIN PRIVATE|Ab0\+\/|private words/);
    expect(rowToItem({ ...row, output: "", outputPreview: { totalChars: 1 } }, true)).toMatchObject({ output: OUTPUT_PREVIEW_OMITTED });
  });
  it("keeps complete output, including previews whose character count matches", async () => {
    const h = setup();
    h.harness.sdk.stub("threads.timeline", async () => page([{ ...command, outputPreview: { totalChars: command.output.length } }]));
    const result = await readTimeline(h.bb.sdk.threads, "t", true);
    expect(result.items[0]).toMatchObject({ output: command.output });
    expect(result.truncated).toBe(false);
    expect(rowToItem(command, true)).toMatchObject({ output: command.output });
  });
});
