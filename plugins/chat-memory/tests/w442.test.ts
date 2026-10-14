import { describe, expect, it } from "vitest";
import { TreeBuilder, type NodeHow, type TreeStore } from "../lib/builder";
import { cleanLine, messageText } from "../lib/prompt";
import type { SummarizerRequest, SummarizerResult } from "../lib/summarizer";
import { CUT, LIMIT, bytes, capLine, children, emptyViews, key, label, type NodeRef } from "../lib/tree";

// W442: every line is at most 512 bytes. A reply over it is asked again once, shorter; one still
// over is cut at a word boundary and ends in " [cut]". Nothing is ever cut without the marker.

type Message = { kind: "user" | "agent"; text: string };
function memoryStore(messages: Message[]) {
  const nodes = new Map<string, { text: string; how: NodeHow; tries: number }>();
  const store: TreeStore = {
    messageCount: () => messages.length,
    message: (i) => messages[i] ?? null,
    node: (l, i) => nodes.get(key(l, i))?.text ?? null,
    built: (l, from, to) => Array.from({ length: to - from }, (_, k) => from + k).filter((i) => nodes.has(key(l, i))),
    saveNode: (l, i, text, how, tries) => void nodes.set(key(l, i), { text, how, tries }),
    saveViews: () => {},
    recordCall: () => {},
  };
  return { store, nodes };
}
const usage = { input: 100, cached: 0, output: 10, reasoning: 0 };
const ok = (text: string): SummarizerResult => ({ ok: true, text, usage, latencyMs: 1 });
/** The node a task names, as its label. */
const target = (r: SummarizerRequest) => {
  const task = (r.input[0]!.content[1] as { text: string }).text;
  const compress = /compress message (\d+)/.exec(task);
  if (compress) return `${compress[1]}+1`;
  const merge = /merge lines (\d+)\+(\d+) and/.exec(task)!;
  return `${merge[1]}+${2 * Number(merge[2])}`;
};
/** Words of `word` repeated up to about `size` bytes, naming the node. */
const words = (name: string, size: number, word = "word") => `L${name}:` + ` ${word}`.repeat(Math.ceil(size / (bytes(word) + 1)));
const long = (n: number): Message[] => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? "agent" : "user", text: `message ${i} `.padEnd(700, "y") }));
const builder = (store: TreeStore, summarize: (r: SummarizerRequest) => Promise<SummarizerResult>, logs: string[] = []) =>
  new TreeBuilder(store, emptyViews(), { summarize, instructions: () => "system", effort: () => "high", concurrency: () => 4, cacheKey: "k", backoff: { min: 1, max: 2, unavailable: 2 }, log: (m) => logs.push(m) });

/** A text that is no line's whole: CUT at its end, and a start of `source` before it. */
const cutFrom = (line: string, source: string) => line.endsWith(CUT) && source.startsWith(line.slice(0, -CUT.length));

describe("W442 capLine", () => {
  it("leaves a text within 512 bytes as it is, up to exactly 512", () => {
    for (const text of ["", "user: hi", "a".repeat(LIMIT), `${"é".repeat(255)}ab`]) expect(capLine(text)).toBe(text);
  });

  it("cuts at the last word boundary before 506 bytes and ends in [cut]", () => {
    const text = `user: ${"alpha ".repeat(120)}`;
    const line = capLine(text);
    expect(line.endsWith(" alpha [cut]")).toBe(true);
    expect(bytes(line)).toBeLessThanOrEqual(LIMIT);
    expect(bytes(line)).toBeGreaterThan(LIMIT - 12);
    expect(cutFrom(line, text)).toBe(true);
  });

  it("never splits a multi-byte character: 2-, 3- and 4-byte ones across the cut", () => {
    for (const ch of ["é", "日", "😀"]) {
      for (let pad = 0; pad < 4; pad++) {
        // One word of `ch` across byte 506: no space to back up to within reach, so a character boundary.
        const text = `${"a".repeat(470 + pad)}${ch.repeat(40)}`;
        const line = capLine(text);
        expect(line).not.toContain("�");
        expect(bytes(line)).toBeLessThanOrEqual(LIMIT);
        expect(cutFrom(line, text)).toBe(true);
        // Spaced words of `ch`: the cut lands right after a whole word.
        const spaced = `x${pad} ${`${ch.repeat(3)} `.repeat(200)}`;
        const cut = capLine(spaced);
        expect(cut).not.toContain("�");
        expect(bytes(cut)).toBeLessThanOrEqual(LIMIT);
        expect(cut.endsWith(`${ch.repeat(3)}${CUT}`)).toBe(true);
        expect(cutFrom(cut, spaced)).toBe(true);
      }
    }
  });

  it("cuts inside a word too long to back out of (a hash, a path)", () => {
    const text = `echo: sha ${"0123456789abcdef".repeat(40)}`;
    const line = capLine(text);
    expect(bytes(line)).toBe(LIMIT);
    expect(line.startsWith("echo: sha 0123")).toBe(true);
    expect(cutFrom(line, text)).toBe(true);
  });

  it("holds for any mix of ASCII, multi-byte characters and spaces", () => {
    const alphabet = ["a", "Z", "0", "/", " ", " ", "\n", "é", "日", "😀", "ß"];
    let seed = 442;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 500; n++) {
      const text = Array.from({ length: Math.floor(random() * 700) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      const line = capLine(text);
      expect(bytes(line)).toBeLessThanOrEqual(LIMIT);
      expect(line).not.toContain("�");
      if (bytes(text) <= LIMIT) expect(line).toBe(text);
      else expect(cutFrom(line, text)).toBe(true);
    }
  });
});

describe("W442 builder", () => {
  it("keeps a reply within budget as it is, in one call, with nothing logged", async () => {
    const { store, nodes } = memoryStore(long(1));
    const logs: string[] = [];
    let calls = 0;
    const reply = words("0+1", 480);
    await builder(store, async () => (calls++, ok(reply)), logs).run(new AbortController().signal);
    expect(calls).toBe(1);
    expect(nodes.get(key(0, 0))).toEqual({ text: reply, how: "model", tries: 1 });
    expect(logs).toEqual([]);
  });

  it("asks once more, for 384 bytes, and keeps a retry that fits whole", async () => {
    const { store, nodes } = memoryStore(long(1));
    const requests: SummarizerRequest[] = [];
    const logs: string[] = [];
    const retry = words("0+1", 380);
    await builder(store, async (r) => (requests.push(r), ok(requests.length === 1 ? words("0+1", 700) : retry)), logs).run(new AbortController().signal);
    expect(requests).toHaveLength(2);
    // The first ask states the budget; the retry gives the reply's size and a shorter one.
    expect((requests[0]!.input[0]!.content[1] as { text: string }).text).toContain(`at most ${LIMIT} bytes`);
    expect((requests[1]!.input[2]!.content[0] as { text: string }).text).toMatch(/^Too long: your line is \d+ bytes, over the 512-byte limit\. Write the whole line again for the same <input> in at most 384 bytes/);
    expect(nodes.get(key(0, 0))).toEqual({ text: retry, how: "model", tries: 2 });
    expect(logs).toEqual([]);
  });

  it("cuts the shorter of two replies still over budget at a multi-byte word boundary, with [cut], and logs it", async () => {
    const { store, nodes } = memoryStore(long(1));
    const logs: string[] = [];
    let calls = 0;
    const first = words("0+1", 900, "日本");
    const second = words("0+1", 640, "café");
    await builder(store, async () => ok(++calls === 1 ? first : second), logs).run(new AbortController().signal);
    expect(calls).toBe(2);
    const node = nodes.get(key(0, 0))!;
    expect(node).toMatchObject({ how: "model", tries: 2 });
    expect(bytes(node.text)).toBeLessThanOrEqual(LIMIT);
    expect(node.text).not.toContain("�");
    expect(node.text.endsWith(` café${CUT}`)).toBe(true);
    expect(cutFrom(node.text, second)).toBe(true);
    expect(logs).toEqual([`Memory line 0+1 cut to 512 bytes: its shortest reply in 2 tries was ${bytes(second)} bytes.`]);
  });

  it("leaves no path that saves a line over 512 bytes, or cut without [cut]", async () => {
    // One script per exit of a call: a refused, timed-out or empty retry after a reply over
    // budget, two replies over budget, three empty replies (the fallback, D500), and plain ones.
    const over = (name: string) => ok(words(name, 700, "señal"));
    const scripts: Record<string, SummarizerResult[]> = {
      "0+1": [over("0+1"), { ok: false, reason: "rate-limited", error: "429" }],
      "1+1": [over("1+1"), { ok: false, reason: "timeout", error: "no reply within 30 s" }],
      "2+1": [over("2+1"), ok("")],
      "3+1": [over("3+1"), over("3+1")],
      "4+1": [ok(""), ok(""), ok("")],
      "0+2": [over("0+2"), { ok: false, reason: "failed", error: "400" }],
      "4+2": [ok(""), ok(""), ok("")],
    };
    const replies = new Map<string, string[]>();
    const { store, nodes } = memoryStore(long(8));
    await builder(store, async (r) => {
      const name = target(r);
      const result = scripts[name]?.shift() ?? ok(words(name, 300));
      if (result.ok) replies.set(name, [...(replies.get(name) ?? []), cleanLine(result.text)]);
      return result;
    }).run(new AbortController().signal);
    expect(nodes.size).toBe(15);
    const byLabel = new Map<string, string>();
    for (const [k, { text, how }] of nodes) {
      const [l, i] = k.split(":").map(Number) as NodeRef;
      const name = label([l, i]);
      byLabel.set(name, text);
      // What the line could be made from: the replies, or its input whole (free, fallback).
      const input = l === 0 ? messageText(store.message(i)!) : children([l, i]).map((c) => nodes.get(key(...c))!.text).join("\n");
      const sources = [...(replies.get(name) ?? []), input];
      expect(bytes(text), name).toBeLessThanOrEqual(LIMIT);
      expect(sources.includes(text) || sources.some((s) => cutFrom(text, s)), name).toBe(true);
      if (!sources.includes(text)) expect(text.endsWith(CUT), name).toBe(true);
      if (name === "4+1" || name === "4+2") expect(how).toBe("fallback");
    }
    // Each scripted line was cut, and said so.
    for (const name of Object.keys(scripts)) expect(byLabel.get(name)!.endsWith(CUT), name).toBe(true);
  });
});
