import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { MAX_ROWS, readTimeline, type TimelineRow } from "../server/timeline";
import { base, command, message, page, rows } from "./fixtures";

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
  it("drops system-initiated messages and image work; notes SDK output previews", async () => {
    const h = setup(); const user = rows[0]!;
    h.harness.sdk.stub("threads.timeline", async () => page([
      ...(user.kind === "conversation" && user.role === "user" ? [{ ...user, initiator: "system" as const }] : []),
      { ...base("image", 2), kind: "work", workKind: "image-view", status: "completed", callId: "i", path: "/private.png", completedAt: 5 },
      { ...command, output: "partial", outputPreview: { totalChars: 1000 } },
    ]));
    const result = await readTimeline(h.bb.sdk.threads, "t", true);
    expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ title: "npm test", output: "partial" }); expect(result.truncated).toBe(true);
  });
});
