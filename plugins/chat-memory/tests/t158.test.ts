import { describe, expect, it } from "vitest";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/builder";
import { emptyViews, key } from "../lib/tree";

// T158 (D500): the placeholder fallback is for lines whose every try came back empty. Any error or
// timeout among the tries keeps the failure visible: logged, the line unbuilt.

const u = { input: 1, cached: 0, output: 1, reasoning: 0 };
type Step = "error" | "timeout" | "empty";
const step = (s: Step) =>
  s === "empty" ? { ok: true, text: "", usage: u, latencyMs: 0 } : { ok: false, reason: s === "error" ? "failed" : "timeout", error: s === "error" ? "boom 500" : "timed out", usage: u, latencyMs: 0 };

async function run(steps: Step[]) {
  const nodes = new Map<string, { text: string; how: NodeHow }>();
  const logs: string[] = [];
  let calls = 0;
  const store: TreeStore = {
    messageCount: () => 1,
    message: () => ({ kind: "user", text: "x".padEnd(700, "y") }),
    node: (l, i) => nodes.get(key(l, i))?.text ?? null,
    built: (l, from, to) => Array.from({ length: to - from }, (_, k) => from + k).filter((i) => nodes.has(key(l, i))),
    saveNode: (l, i, text, how) => void nodes.set(key(l, i), { text, how }),
    saveViews: () => {},
    recordCall: () => {},
  };
  const summarize = (async () => step(steps[calls++] ?? "empty")) as never;
  const b = new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "i", effort: () => "high", concurrency: () => 1, cacheKey: "k", log: (m) => logs.push(m) });
  await b.run(new AbortController().signal);
  return { nodes, logs, calls };
}

describe("T158 mixed error and empty tries", () => {
  const visible: [string, Step[]][] = [
    ["error, error, empty", ["error", "error", "empty"]],
    ["empty, error, error", ["empty", "error", "error"]],
    ["error, empty, empty", ["error", "empty", "empty"]],
    ["timeout, empty, empty", ["timeout", "empty", "empty"]],
  ];
  for (const [name, steps] of visible) {
    it(`${name}: no fallback, the failure is logged and the line stays unbuilt`, async () => {
      const { nodes, logs, calls } = await run(steps);
      expect(calls).toBe(3);
      expect(nodes.size).toBe(0);
      expect(logs.some((l) => l.includes("built as a fallback"))).toBe(false);
      expect(logs.some((l) => l.includes("failed 3 times") && l.includes("stays unsummarized"))).toBe(true);
    });
  }

  it("error, error, empty names the real error, not the empty reply", async () => {
    const { logs } = await run(["error", "error", "empty"]);
    expect(logs.find((l) => l.includes("failed 3 times"))).toContain("(boom 500)");
  });

  it("empty, empty, empty: still the fallback", async () => {
    const { nodes, logs } = await run(["empty", "empty", "empty"]);
    expect(nodes.get(key(0, 0))!.how).toBe("fallback");
    expect(logs.some((l) => l.includes("built as a fallback (cut to fit) after 3 empty replies"))).toBe(true);
  });
});
