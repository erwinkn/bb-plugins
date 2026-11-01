import { describe, expect, it } from "vitest";
import { TreeBuilder, compactionInput, type NodeHow, type TreeStore } from "../lib/builder";
import type { InputItem, SummarizerRequest, SummarizerResult } from "../lib/summarizer";
import { emptyViews, key } from "../lib/tree";

// W565: since 2026-10-16 the Codex backend shares a cached prefix between different requests only
// through instructions and developer messages, so a compaction's older <chat> lines go in a
// developer message, in whole blocks of 4, and the rest of <chat> and the task in the user message.

const text = (item: InputItem) => item.content.map((c) => c.text).join("");
const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i}+1|line ${i}`);

describe("W565 compaction input", () => {
  it("puts whole blocks of 4 context lines in a developer message, the rest and the task in the user message", () => {
    const input = compactionInput(lines(9), "TASK");
    expect(input.map((m) => m.role)).toEqual(["developer", "user"]);
    expect(text(input[0]!)).toBe(`<chat>\n${lines(8).join("\n")}\n`);
    expect(text(input[1]!)).toBe("8+1|line 8\n</chat>\nTASK");
  });

  it("reads as the one user message did: the same text, split in two", () => {
    for (const n of [0, 1, 3, 4, 5, 8, 11]) {
      const input = compactionInput(lines(n), "TASK");
      expect(input.map(text).join("")).toBe(`<chat>\n${lines(n).map((l) => `${l}\n`).join("")}</chat>\nTASK`);
    }
  });

  it("sends no developer message under 4 lines", () => {
    expect(compactionInput([], "TASK")).toEqual([{ role: "user", content: [{ type: "input_text", text: "<chat>\n</chat>\nTASK" }] }]);
    expect(compactionInput(lines(3), "TASK").map((m) => m.role)).toEqual(["user"]);
  });

  it("gives the calls of one block the same developer message, and keeps it first in a retry", async () => {
    const nodes = new Map<string, string>();
    const store: TreeStore = {
      messageCount: () => 14,
      // Too long to keep whole: every message is a call.
      message: (i) => ({ kind: "user", text: `message ${i} `.padEnd(700, "y") }),
      node: (l, i) => nodes.get(key(l, i)) ?? null,
      built: (l, from, to) => Array.from({ length: to - from }, (_, k) => from + k).filter((i) => nodes.has(key(l, i))),
      saveNode: (l: number, i: number, t: string, _how: NodeHow) => void nodes.set(key(l, i), t),
      saveViews: () => {},
      recordCall: () => {},
    };
    const requests: SummarizerRequest[] = [];
    const usage = { input: 100, cached: 0, output: 10, reasoning: 0 };
    const summarize = async (r: SummarizerRequest): Promise<SummarizerResult> => {
      requests.push(r);
      const task = r.input.find((m) => m.role === "user")!.content[0]!.text;
      const name = /compress message (\d+)|merge lines (\d+\+\d+) and/.exec(task)!.slice(1).find(Boolean)!;
      // Message 12's first reply is too long: it is asked again, in the same conversation.
      const retried = requests.filter((q) => q.input.find((m) => m.role === "user")!.content[0]!.text === task).length > 1;
      return { ok: true, text: name === "12" && !retried ? "x".repeat(700) : `summary of ${name}`, usage, latencyMs: 1 };
    };
    await new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "i", effort: () => "high", concurrency: () => 1, cacheKey: "k" }).run(new AbortController().signal);

    const developer = requests.flatMap((r) => (r.input[0]!.role === "developer" ? [text(r.input[0]!)] : []));
    expect(developer.length).toBeGreaterThan(0);
    for (const d of developer) expect((d.match(/\n/g) ?? []).length - 1).toSatisfy((n: number) => n > 0 && n % 4 === 0);
    // Several calls with the same older blocks send the very same developer message: one cached prefix.
    expect(new Set(developer).size).toBeLessThan(developer.length);

    const retry = requests.find((r) => r.input.some((m) => m.role === "assistant"))!;
    const first = requests[requests.indexOf(retry) - 1]!;
    expect(retry.input.slice(0, first.input.length)).toEqual(first.input);
    expect(retry.input.map((m) => m.role)).toEqual([...first.input.map((m) => m.role), "assistant", "user"]);
  });
});
