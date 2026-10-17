import { describe, expect, it } from "vitest";
import type { TreeBuilder } from "../lib/builder";
import { SUMMARY_WAIT_MS } from "../lib/memory";
import { CLIP_KEEP, clipLine, turnView } from "../lib/turn";
import { fakeLuna, fixture, stuckLuna } from "./fixture";

/**
 * W503: an OptChat turn waits at most SUMMARY_WAIT_MS for the summaries of the messages before its
 * newest 32 KB, then shows the ones still without theirs clipped and marked; they show as summaries
 * on a later turn. Every turn that waited logs one line.
 */

const fresh = (answer: unknown) => answer as { session: "fresh"; sessionId: string; systemPrompt: string; input: string };
const P = "initiatives:prj_1";

async function coordinator() {
  const f = fixture();
  await f.attach("initiatives", "prj_1", f.thread("coord", { title: "Coordinator" }));
  const logs: string[] = [];
  f.memory["deps"].log = (m: string) => void logs.push(m);
  return { f, logs };
}

describe("W503 a turn waits at most a few seconds for its summaries", () => {
  it("waits about 3 s by default", () => {
    expect(SUMMARY_WAIT_MS).toBe(3_000);
    expect(fixture().memory.waits.summaries).toBeLessThan(fixture().memory.waits.turn);
  });

  it("shows summaries as before when they land within the wait, and logs the wait", async () => {
    const { f, logs } = await coordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.memory.useSummarizer(async (r) => (await gate, fakeLuna(r)));
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, "x".repeat(14_000));
    const turn = f.ask("coord", f.say("coord", "go on"), "go on");
    setTimeout(release, 200);
    const answer = fresh(await turn);
    expect(`${answer.systemPrompt}\n${answer.input}`).toContain("1+1|summary of 1");
    expect(answer.input).not.toContain("[clipped");
    expect(logs).toContainEqual(expect.stringMatching(/^initiatives:prj_1: turn of coord waited \d+ ms for the summaries of 1 message; 0 shown clipped$/));
  });

  it("shows a message still without its summary after the wait clipped and marked, answers within the wait, and shows its summary next turn", async () => {
    const { f, logs } = await coordinator();
    f.memory.useSummarizer(stuckLuna);
    f.memory.waits = { turn: 10_000, summaries: 300 };
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, `HEAD${"z".repeat(13_992)}TAIL`);
    const started = Date.now();
    const answer = fresh(await f.ask("coord", f.say("coord", "go"), "go"));
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1_000);
    // Message 1 is before the newest 32 KB: clipped, in the first message, never frozen.
    const clipped = `1+1|agent: [clipped, no summary yet: the middle 12,000 of 14,000 bytes is left out; memory_zoom {id:1, n:1} gives it whole] HEAD${"z".repeat(CLIP_KEEP - 4)}[… 12,000 bytes clipped …]${"z".repeat(CLIP_KEEP - 4)}TAIL`;
    expect(answer.input).toContain(`${clipped}\n`);
    expect(answer.systemPrompt).not.toContain("1+1|");
    // The newest 32 KB stay whole.
    expect(answer.input).toContain(`3+1|agent: HEAD${"z".repeat(13_992)}TAIL`);
    expect(answer.input).toContain(`5+1|agent: HEAD${"z".repeat(13_992)}TAIL`);
    expect(logs).toContainEqual(expect.stringMatching(/^initiatives:prj_1: turn of coord waited \d+ ms for the summaries of 1 message; 1 shown clipped$/));
    // The summarizer catches up meanwhile: the next turn shows the summary instead.
    f.memory.useSummarizer(fakeLuna);
    f.memory.dispose();
    f.memory.start();
    f.memory.build(P);
    await f.memory.settled();
    const next = fresh(await f.ask("coord", f.say("coord", "and now?"), "and now?"));
    expect(`${next.systemPrompt}\n${next.input}`).toContain("1+1|summary of 1");
    expect(next.input).not.toContain("[clipped");
  });

  it("waits on past the cap while too much would be clipped, and answers as soon as it fits", async () => {
    const { f, logs } = await coordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.memory.useSummarizer(async (r) => (await gate, fakeLuna(r)));
    f.memory.waits = { turn: 10_000, summaries: 200 };
    // The 50 replies before the newest 32 KB would be 100 KB clipped.
    for (let n = 0; n < 60; n++) f.turn("coord", `part ${n}`, "z".repeat(3_000));
    const started = Date.now();
    const turn = f.ask("coord", f.say("coord", "go"), "go");
    setTimeout(release, 600);
    const answer = fresh(await turn);
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(550);
    expect(ms).toBeLessThan(5_000);
    // At most CLIPPED_BYTES shown clipped (2 KB each), as many as the log line says.
    const clipped = answer.input.split("[clipped, no summary yet").length - 1;
    expect(clipped).toBeLessThanOrEqual(32);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^initiatives:prj_1: turn of coord waited \\d+ ms for the summaries of \\d+ messages; ${clipped} shown clipped$`)));
    f.memory.dispose();
  });

  it("still fails at once on a line whose summary failed (D458)", async () => {
    const { f, logs } = await coordinator();
    f.memory.useSummarizer(async () => ({ ok: false, reason: "failed", error: "400 rejected" }));
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, "w".repeat(14_000));
    await expect(f.ask("coord", f.say("coord", "go"), "go")).rejects.toThrow(/message 1 could not be summarized \(400 rejected\)/);
    expect(logs).toContainEqual(expect.stringMatching(/^initiatives:prj_1: turn of coord waited \d+ ms for the summaries of 1 message; the turn failed: OptChat memory unavailable for this turn: message 1 could not be summarized/));
  });

  it("never shows clipped a line that failed after the wait ended, before the view was made (D458)", async () => {
    const { f } = await coordinator();
    f.memory.useSummarizer(stuckLuna);
    f.memory.waits = { turn: 10_000, summaries: 100 };
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, "w".repeat(14_000));
    // Message 1's third try fails between the wait's end and the view.
    const memory = f.memory as unknown as { until: (...args: unknown[]) => Promise<boolean>; builders: Map<string, TreeBuilder> };
    const until = memory.until.bind(f.memory);
    memory.until = async (...args) => {
      const ready = await until(...args);
      if (ready) memory.builders.get(P)!["failed"].set("0:1", { node: [0, 1], error: "400 rejected", at: Date.now() });
      return ready;
    };
    await expect(f.ask("coord", f.say("coord", "go"), "go")).rejects.toThrow(/message 1 could not be summarized \(400 rejected\)/);
    f.memory.dispose();
  });

  it("counts the lines a just-loaded builder waits for once its recovery finds them", async () => {
    const { f, logs } = await coordinator();
    f.memory.useSummarizer(stuckLuna);
    f.memory.waits = { turn: 10_000, summaries: 100 };
    for (let n = 0; n < 3; n++) f.turn("coord", `part ${n}`, "w".repeat(14_000));
    fresh(await f.ask("coord", f.say("coord", "go"), "go"));
    // A reload: the next builder loads the saved views, message 1 fed and still without its line.
    f.memory.dispose();
    await f.memory.settled();
    f.memory.start();
    logs.length = 0;
    fresh(await f.ask("coord", f.say("coord", "again"), "again"));
    expect(logs).toContainEqual(expect.stringMatching(/^initiatives:prj_1: turn of coord waited \d+ ms for the summaries of 1 message; 1 shown clipped$/));
    f.memory.dispose();
  });

  it("logs nothing for a turn that did not wait", async () => {
    const { f, logs } = await coordinator();
    f.turn("coord", "hello");
    await f.idle("coord");
    fresh(await f.ask("coord", f.say("coord", "go"), "go"));
    expect(logs.filter((m) => m.includes("waited"))).toEqual([]);
  });
});

describe("W503 clipLine", () => {
  it("keeps the head and tail whole characters, marks where the middle was cut, and leaves a short message whole", () => {
    const text = `${"é".repeat(800)}${"x".repeat(5_000)}${"€".repeat(400)}`;
    const line = clipLine(7, { kind: "echo", text });
    expect(line.startsWith("7+1|echo: [clipped, no summary yet: the middle ")).toBe(true);
    expect(line).not.toContain("�");
    const [, head, tail] = /gives it whole\] (.*)\[… [\d,]+ bytes clipped …\](.*)$/s.exec(line)!;
    expect(Buffer.byteLength(head!)).toBeLessThanOrEqual(CLIP_KEEP);
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(CLIP_KEEP);
    expect(head!.startsWith("é")).toBe(true);
    expect(tail!.endsWith("€")).toBe(true);
    // In a view: before `whole` and longer than head and tail together, it is clipped; else whole.
    const message = (i: number) => ({ i, kind: "agent" as const, text: i === 0 ? "y".repeat(2 * CLIP_KEEP) : "y".repeat(3_000), size: 0, at: 0, threadId: null, seq: null });
    const view = turnView({ chat: [], fed: 0, nodes: new Map(), cut: 3, whole: 2, frozen: null, message });
    expect(view.clipped).toBe(1);
    expect(view.tailLines.map((l) => l.slice(0, 20))).toEqual(["0+1|agent: yyyyyyyyy", "1+1|agent: [clipped,", "2+1|agent: yyyyyyyyy"]);
  });
});
