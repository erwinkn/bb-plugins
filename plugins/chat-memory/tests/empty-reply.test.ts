import { describe, expect, it } from "vitest";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/builder";
import { responsesSummarizer } from "../lib/summarizer";
import { emptyViews, key } from "../lib/tree";

// W371: an empty summary reply is logged with what it was made of (types, reasons, counts), never its text.

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const SECRET = "SECRET-PROMPT-AND-REASONING-TEXT";
const usage = { input_tokens: 900, output_tokens: 230, output_tokens_details: { reasoning_tokens: 230 } };
const reply = (event: string, response: Record<string, unknown>) => [{ type: "response.created", response: {} }, { type: event, response: { usage, ...response } }];

const replies: Record<string, { events: unknown[]; shape: object }> = {
  "a completed reply of reasoning only": {
    events: reply("response.completed", { status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: SECRET }] }] }),
    shape: { event: "response.completed", status: "completed", incomplete: null, items: ["reasoning"], blocks: [], output: 230, reasoning: 230 },
  },
  "an incomplete reply cut at max_output_tokens": {
    events: reply("response.incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "" }] }] }),
    shape: { event: "response.incomplete", status: "incomplete", incomplete: "max_output_tokens", items: ["reasoning", "message"], blocks: ["output_text"], output: 230, reasoning: 230 },
  },
  "a reply that is a refusal": {
    events: reply("response.completed", { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: SECRET }] }] }),
    shape: { event: "response.completed", status: "completed", incomplete: null, items: ["message"], blocks: ["refusal"], output: 230, reasoning: 230 },
  },
};

function builder(messages: number, summarize: ReturnType<typeof responsesSummarizer>, logs: string[]) {
  const nodes = new Map<string, { text: string; how: NodeHow }>();
  const store: TreeStore = {
    messageCount: () => messages,
    message: (i) => (i < messages ? { kind: "user", text: `${SECRET} ${i}`.padEnd(700, "y") } : null),
    node: (l, i) => nodes.get(key(l, i))?.text ?? null,
    built: (l, from, to) => Array.from({ length: to - from }, (_, k) => from + k).filter((i) => nodes.has(key(l, i))),
    saveNode: (l, i, text, how) => void nodes.set(key(l, i), { text, how }),
    saveViews: () => {},
    recordCall: () => {},
  };
  return { nodes, builder: new TreeBuilder(store, emptyViews(), { summarize, instructions: () => SECRET, effort: () => "high", concurrency: () => 1, cacheKey: "k", log: (m) => logs.push(m) }) };
}

describe("W371 empty-reply telemetry", () => {
  for (const [name, { events, shape }] of Object.entries(replies)) {
    it(`logs each attempt and the fallback for ${name}, without any of its text`, async () => {
      const summarize = responsesSummarizer({ fetch: (async () => sse(events)) as never, url: () => "http://pool", headers: async () => ({}) });
      const logs: string[] = [];
      const { builder: b, nodes } = builder(1, summarize, logs);
      await b.run(new AbortController().signal);
      // Same rules as before: three empty replies, then the fallback line.
      expect(nodes.get(key(0, 0))!.how).toBe("fallback");
      expect(logs).toHaveLength(4);
      for (const line of logs.slice(0, 3)) {
        expect(line).toContain("got an empty reply (attempt 1, 0 characters before cleaning): ");
        expect(line.slice(line.indexOf("cleaning): ") + 11)).toBe(JSON.stringify(shape));
      }
      const fallback = logs[3]!;
      expect(fallback).toContain("built as a fallback (cut to fit) after 3 empty replies: ");
      expect(JSON.parse(fallback.slice(fallback.indexOf("replies: ") + 9))).toEqual([shape, shape, shape]);
      // No prompt, reply, refusal or reasoning text in any line.
      for (const line of logs) expect(line).not.toContain("SECRET");
    });
  }

  it("logs a single empty reply that a retry then fills, and keeps no state for it", async () => {
    const logs: string[] = [];
    let calls = 0;
    const { builder: b, nodes } = builder(
      1,
      (async () => (++calls === 1 ? { ok: true, text: "", usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 } : { ok: true, text: "a summary", usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, latencyMs: 0 })) as never,
      logs,
    );
    await b.run(new AbortController().signal);
    expect(nodes.get(key(0, 0))!.how).toBe("model");
    // One empty reply, no shape (a fake summarizer): logged as null; the fallback line never appears.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/got an empty reply \(attempt 1, 0 characters before cleaning\): null$/);
    expect((b as unknown as { empties: Map<string, unknown> }).empties.size).toBe(0);
  });
});
