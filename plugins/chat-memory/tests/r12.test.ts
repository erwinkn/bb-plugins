import { describe, expect, it } from "vitest";
import { UNAVAILABLE } from "../lib/log";
import { PENDING, TARGET_BYTES, VIEW_BYTES, pendingLine } from "../lib/tree";
import { CEILING_BYTES, turnView } from "../lib/turn";
import { fakeLuna, fixture, stuckLuna } from "./fixture";

/**
 * R12 (Erwin, 2026-11-03): an OptChat turn waits a few seconds at most for its earlier messages'
 * summaries and never for merges; a message still without one shows its start, cut, then "(not
 * summarized yet: zoom it)". Only a view past its ceiling waits, and fails visibly at the deadline.
 */
type Fresh = { session: "fresh"; systemPrompt: string; input: string };
const lines = (a: Fresh) => `${a.systemPrompt}\n${a.input}`.split("\n").filter((l) => /^\d+\+\d+\|/.test(l));
const viewSize = (a: Fresh) => lines(a).reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
const since = (start: number) => Date.now() - start;

async function worker() {
  const f = fixture();
  const scope = await f.attach("initiatives", "p:worker:1", f.thread("w"));
  return { f, scope };
}

/** A tree of `n` built 576-byte lines whose merges have not started: its chat view is past 128 KB. */
async function lagging(n: number) {
  const { f, scope } = await worker();
  f.store.append("w", Array.from({ length: n }, (_, i) => ({ kind: "agent" as const, text: `source ${i} `.repeat(100), at: i, threadId: "w", seq: i + 1 })), n);
  const tree = f.store.tree(scope);
  for (let i = 0; i < n; i++) tree.saveNode(0, i, `line ${i} `.padEnd(576, "x"), "model", 1);
  tree.saveViews({ fed: n, chat: Array.from({ length: n }, (_, i) => [0, i]), compaction: [], merging: true });
  f.memory.dispose();
  await f.memory.settled();
  f.memory.start();
  return { f, scope };
}

describe("R12 the short wait", () => {
  it("waits for a summary still being written, while it comes within the wait", async () => {
    const { f } = await worker();
    f.memory.useSummarizer(async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fakeLuna(r);
    });
    f.turn("w", "the deploy plan", "y".repeat(5_000));
    const start = Date.now();
    const answer = (await f.ask("w", f.say("w", "go"), "go")) as Fresh;
    expect(since(start)).toBeGreaterThanOrEqual(150);
    expect(since(start)).toBeLessThan(900);
    // A message that fits in a line is its own line, built at once; the long reply needs a summary.
    expect(lines(answer)).toEqual(["0+1|user: the deploy plan", "1+1|summary of 1"]);
  });

  it("waits no longer than its few seconds: then the turn goes, each message without a summary shown by its start", async () => {
    const { f } = await worker();
    f.memory.useSummarizer(stuckLuna);
    f.turn("w", "the deploy plan", "y".repeat(5_000));
    const start = Date.now();
    const answer = (await f.ask("w", f.say("w", "go"), "go")) as Fresh;
    // The fixture's short wait is 1 s, its turn's deadline 1.5 s.
    expect(since(start)).toBeGreaterThanOrEqual(950);
    expect(since(start)).toBeLessThan(1_400);
    expect(lines(answer)).toEqual(["0+1|user: the deploy plan", expect.stringMatching(/^1\+1\|agent: y+… \(not summarized yet: zoom it\)$/)]);
    // One word longer than a line is cut inside it, to the line's full 512 bytes.
    expect(Buffer.byteLength(lines(answer)[1]!.slice("1+1|".length))).toBe(TARGET_BYTES);
  });

  it("does not wait at all when every line it needs has its summary, nor gates the dispatch", async () => {
    const { f, scope } = await worker();
    f.turn("w", "first");
    await f.idle("w");
    f.memory.useSummarizer(stuckLuna);
    expect(await f.dispatch("w")).toEqual({ action: "proceed" });
    const start = Date.now();
    await f.ask("w", f.say("w", "go"), "go");
    expect(since(start)).toBeLessThan(300);
    // A message without its summary does not hold the dispatch either: the turn shows its start.
    f.turn("w", "second", "z".repeat(3_000));
    await f.memory.ingest("w");
    expect(await f.dispatch("w")).toEqual({ action: "proceed" });
    expect((await f.memory.status(scope)).tree.ready).toBe(true);
  });
});

describe("R12 lines without a summary", () => {
  it("is the start of the message on one line, cut at a word, in a summary's 512 bytes; memory_zoom gives the whole message", async () => {
    const { f, scope } = await worker();
    f.memory.useSummarizer(stuckLuna);
    const long = `Please check the migration.\n\nSteps:\n${Array.from({ length: 200 }, (_, k) => `step ${k} ok`).join("\n")}\nEND-OF-MESSAGE`;
    f.turn("w", long, "short reply");
    const answer = (await f.ask("w", f.say("w", "go"), "go")) as Fresh;
    const [first, second] = lines(answer);
    expect(first).toMatch(/^0\+1\|user: Please check the migration\. Steps: step 0 ok step 1 ok .* step \d+( ok)?… \(not summarized yet: zoom it\)$/);
    expect(Buffer.byteLength(first!.slice("0+1|".length))).toBeLessThanOrEqual(TARGET_BYTES);
    expect(first).not.toContain("END-OF-MESSAGE");
    // A reply that fits in a line is its own line at once.
    expect(second).toBe("1+1|agent: short reply");
    const zoom = (await f.harness.behavior.callAgentTool("memory_zoom", { id: 0, n: 1 }, { threadId: "w" })) as string;
    expect(JSON.stringify(zoom)).toContain("END-OF-MESSAGE");
    expect(await f.memory.zoomText(scope, 0, 1)).toContain("step 199 ok\nEND-OF-MESSAGE");
  });

  it("stays out of the frozen prefix, the cached part of the prompt, so its summary landing later changes no cached line", async () => {
    const { f } = await worker();
    f.turn("w", "old ".repeat(200));
    await f.idle("w");
    let gate!: () => void;
    const held = new Promise<void>((resolve) => (gate = resolve));
    f.memory.useSummarizer(async (r) => {
      await held;
      return fakeLuna(r);
    });
    f.turn("w", "new ".repeat(200), "fresh reply ".repeat(100));
    const a = (await f.ask("w", f.say("w", "go"), "go")) as Fresh;
    expect(a.systemPrompt).toContain("0+1|summary of 0");
    expect(a.systemPrompt).not.toContain("not summarized yet");
    expect(a.input).toMatch(/3\+1\|agent: fresh reply fresh .*… \(not summarized yet: zoom it\)/);
    gate();
    await f.memory.settled();
    const b = (await f.ask("w", f.say("w", "again"), "again")) as Fresh;
    expect(b.systemPrompt).toBe(a.systemPrompt);
    expect(b.input).toContain("3+1|summary of 3");
  });
});

describe("R12 merges", () => {
  it("never waits for them: a view over its 128 KB target goes as it is, at once", async () => {
    const { f } = await lagging(300);
    f.memory.useSummarizer(stuckLuna);
    expect(await f.dispatch("w")).toEqual({ action: "proceed" });
    f.history.push({ threadId: "w", seq: 10_000, type: "client/turn/requested", data: { requestId: "r", input: [{ type: "text", text: "go" }] } });
    const start = Date.now();
    const answer = (await f.ask("w", "r", "go")) as Fresh;
    expect(since(start)).toBeLessThan(300);
    expect(viewSize(answer)).toBeGreaterThan(VIEW_BYTES.chat[0]);
    expect(viewSize(answer)).toBeLessThanOrEqual(CEILING_BYTES);
    expect(lines(answer)).toHaveLength(300);
  });

  it("past the ceiling, the turn waits for the merges that bring its view back under, and goes", async () => {
    const { f } = await lagging(500);
    f.memory.useSummarizer(fakeLuna);
    f.memory.waits.turn = 30_000;
    f.history.push({ threadId: "w", seq: 10_000, type: "client/turn/requested", data: { requestId: "r", input: [{ type: "text", text: "go" }] } });
    const answer = (await f.ask("w", "r", "go")) as Fresh;
    expect(viewSize(answer)).toBeLessThanOrEqual(CEILING_BYTES);
    expect(lines(answer).some((l) => /^\d+\+[2-9]\d*\|summary of/.test(l))).toBe(true);
  });

  it("past the ceiling with merges that never come, fails visibly at the deadline; the dispatch waits rather than proceeds", async () => {
    const { f } = await lagging(500);
    f.memory.useSummarizer(stuckLuna);
    expect(await f.dispatch("w")).toMatchObject({ action: "wait" });
    f.history.push({ threadId: "w", seq: 10_000, type: "client/turn/requested", data: { requestId: "r", input: [{ type: "text", text: "go" }] } });
    const start = Date.now();
    await expect(f.ask("w", "r", "go")).rejects.toThrow(
      `${UNAVAILABLE}: its view of the history is over its ${CEILING_BYTES.toLocaleString("en-US")}-byte ceiling and waits for summaries that bring it back under: the summarizer is still writing them. The message was not sent; send it again.`,
    );
    expect(since(start)).toBeGreaterThanOrEqual(1_450);
  });
});

describe("R12 and D502", () => {
  it("leaves the message of a turn that failed past the ceiling out of memory, and logs it once when sent again", async () => {
    const { f, scope } = await worker();
    // Its summary fails: past the ceiling, nothing more can bring the view under, so the turn fails at once.
    f.memory.useSummarizer(async () => ({ ok: false, reason: "failed", error: "400 rejected" }));
    f.turn("w", "earlier", "x".repeat(3_000));
    await f.idle("w");
    f.memory.ceiling = 300;
    const failure = (await f.ask("w", f.say("w", "deploy it"), "deploy it").catch((error: Error) => error)) as Error;
    expect(failure.message).toBe(`${UNAVAILABLE}: the history view is over its 300-byte ceiling and needs lines that could not be summarized (1+1: 400 rejected); they are tried again within 30 minutes. The message was not sent; send it again.`);
    f.providerError("w", `Claude Code could not get the turn's memory context: Tool "claude_code_turn_context" failed: ${failure.message}`);
    f.done("w", "failed");
    await f.failed("w");
    expect(f.log(scope)).toEqual(["user: earlier", `agent: ${"x".repeat(3_000)}`]);
    // Under the ceiling again, the message sent again goes with the earlier reply shown by its start.
    f.memory.ceiling = CEILING_BYTES;
    const again = (await f.ask("w", f.say("w", "deploy it"), "deploy it")) as Fresh;
    expect(again.input).toContain("deploy it");
    expect(lines(again)[1]).toMatch(/^1\+1\|agent: x+…/);
    f.reply("w", "Deployed.");
    f.done("w");
    await f.memory.ingest("w");
    expect(f.log(scope).slice(2)).toEqual(["user: deploy it", "agent: Deployed."]);
  });
});

describe("R12 review round 1", () => {
  /** What a pending line starts from: the whole message on one line (the reference, read in full). */
  const flat = (text: string) => text.replace(/\s+/g, (run) => (run.includes("\n") ? " " : run)).trim();

  it("P1: a long run of whitespace costs linear time (the old newline regex took 0.7 s per 30,000 spaces)", async () => {
    const texts = Array.from({ length: 8 }, (_, k) => `agent: ${k}${" ".repeat(30_000)}tail\n\n  ${"z ".repeat(300)}`);
    const start = performance.now();
    const out = texts.map(pendingLine);
    expect(performance.now() - start).toBeLessThan(100);
    // A cut never ends in the spaces it fell among.
    expect(out[0]).toBe(`agent: 0…${PENDING}`);
    // And through a turn's readiness check, which renders every pending line.
    const { f, scope } = await worker();
    f.memory.useSummarizer(stuckLuna);
    for (const text of texts) f.turn("w", text);
    await f.memory.ingest("w");
    const check = performance.now();
    expect((f.memory as unknown as { fits(scope: string, count: number): boolean }).fits(scope, 16)).toBe(true);
    expect(performance.now() - check).toBeLessThan(200);
  });

  it("P1: reading only the start gives the line reading the whole message gives", () => {
    const pieces = ["word", "é", "🙂", " ", "   ", "\n", " \n\t ", " ".repeat(700), "x".repeat(1_500), "\r\n"];
    let seed = 7;
    const next = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed % n);
    for (let k = 0; k < 2_000; k++) {
      const text = Array.from({ length: next(40) }, () => pieces[next(pieces.length)]).join("");
      expect(pendingLine(text)).toBe(pendingLine(flat(text)));
      expect(Buffer.byteLength(pendingLine(text))).toBeLessThanOrEqual(TARGET_BYTES);
    }
    expect(pendingLine("  a\n\n   b   c \n ")).toBe(`a b   c${PENDING}`);
    expect(pendingLine(" \n ")).toBe(PENDING);
  });

  it("P2: a readiness check reads a backlog's messages only until its view passes the ceiling, and each message once", async () => {
    const { f, scope } = await worker();
    f.memory.useSummarizer(stuckLuna);
    const n = 10_000;
    f.store.append("w", Array.from({ length: n }, (_, i) => ({ kind: "agent" as const, text: `source ${i} `.repeat(250), at: i, threadId: "w", seq: i + 1 })), n);
    const fits = (f.memory as unknown as { fits(scope: string, count: number): boolean }).fits.bind(f.memory);
    let reads = 0;
    const read = f.store.message.bind(f.store);
    f.store.message = (scopeId, i) => (reads++, read(scopeId, i));
    expect(fits(scope, n)).toBe(false);
    // Each pending line is about 520 bytes: the ceiling holds about 490 of them.
    expect(reads).toBeGreaterThan(400);
    expect(reads).toBeLessThan(Math.ceil(CEILING_BYTES / 500));
    reads = 0;
    expect(fits(scope, n)).toBe(false);
    expect(reads).toBe(0);
  });

  it("P2: a turn asked again after a reload has only what is left of its short wait", async () => {
    const { f } = await worker();
    f.memory.useSummarizer(stuckLuna);
    f.turn("w", "the deploy plan", "y".repeat(5_000));
    // The fixture's short wait is 1 s, its deadline 1.5 s: 1 s already spent leaves no short wait.
    let start = Date.now();
    let answer = (await f.ask("w", f.say("w", "go"), "go", { elapsedMs: 1_000 })) as Fresh;
    expect(since(start)).toBeLessThan(250);
    expect(lines(answer)[1]).toMatch(/^1\+1\|agent: y+… \(not summarized yet: zoom it\)$/);
    // 700 ms spent leaves 300 ms of it.
    start = Date.now();
    answer = (await f.ask("w", f.say("w", "again"), "again", { elapsedMs: 700 })) as Fresh;
    expect(since(start)).toBeGreaterThanOrEqual(250);
    expect(since(start)).toBeLessThan(600);
  });
});

describe("R12 expert review", () => {
  it("P2: a summary that failed is stable until its retry, so its line enters the frozen prefix and later turns reuse it", async () => {
    const { f } = await worker();
    f.memory.useSummarizer(async () => ({ ok: false, reason: "failed", error: "400 rejected" }));
    f.turn("w", "earlier", "x".repeat(3_000));
    await f.idle("w");
    f.memory.useSummarizer(fakeLuna);
    f.turn("w", "later", "y".repeat(3_000));
    await f.idle("w");
    const a = (await f.ask("w", f.say("w", "go"), "go")) as Fresh;
    // The failed line, and every line after it, is in the cached part of the prompt.
    expect(a.systemPrompt).toMatch(/1\+1\|agent: x+… \(not summarized yet: zoom it\)/);
    expect(a.systemPrompt).toContain("3+1|summary of 3");
    f.reply("w", "done");
    f.done("w");
    const b = (await f.ask("w", f.say("w", "again"), "again")) as Fresh;
    expect(b.systemPrompt).toBe(a.systemPrompt);
  });

  it("P2: a frozen failed line whose summary lands since recuts the prefix, and one still coming stays out of it", () => {
    const pending = (i: number) => pendingLine(`agent: message ${i} ${"word ".repeat(200)}`);
    const chat: [number, number][] = [[0, 0], [0, 1], [0, 2]];
    const nodes = new Map([["0:0", "summary of 0"], ["0:2", "summary of 2"]]);
    const failed = new Set([1]);
    const stalled = (i: number) => failed.has(i);
    const a = turnView({ chat, fed: 3, nodes, cut: 3, frozen: null, pending, stalled });
    expect(a.frozenLines).toHaveLength(3);
    expect(a.frozenLines[1]).toContain("not summarized yet");
    // Kept while its text is the same.
    expect(turnView({ chat, fed: 3, nodes, cut: 4, frozen: a.frozenLines, pending, stalled }).frozenLines).toEqual(a.frozenLines);
    // A fourth line is built since; the tail stays small, so an unchanged prefix would be kept and leave it in the tail.
    const grown: [number, number][] = [...chat, [0, 3]];
    nodes.set("0:3", "summary of 3");
    const kept = turnView({ chat: grown, fed: 4, nodes, cut: 4, frozen: a.frozenLines, pending, stalled });
    expect(kept.frozenLines).toEqual(a.frozenLines);
    expect(kept.tailLines).toEqual(["3+1|summary of 3"]);
    // Its summary lands: the prefix's text changed, so it is cut again, and the cut moves past the fourth line.
    nodes.set("0:1", "summary of 1");
    failed.clear();
    const b = turnView({ chat: grown, fed: 4, nodes, cut: 4, frozen: a.frozenLines, pending, stalled });
    expect(b.frozenLines).toEqual(["0+1|summary of 0", "1+1|summary of 1", "2+1|summary of 2", "3+1|summary of 3"]);
    expect(b.tailLines).toEqual([]);
    // Its retry started (no longer stalled, still unbuilt): the prefix stops before it.
    nodes.delete("0:1");
    expect(turnView({ chat: grown, fed: 4, nodes, cut: 4, frozen: a.frozenLines, pending, stalled }).frozenLines).toEqual(["0+1|summary of 0"]);
  });

  it("P3: does not wait while the summarizer is paused past the wait (a rate limit)", async () => {
    const { f } = await worker();
    f.memory.useSummarizer(async () => ({ ok: false, reason: "rate-limited", error: "429 slow down" }));
    f.turn("w", "the deploy plan", "y".repeat(5_000));
    await f.ask("w", f.say("w", "go"), "go");
    const start = Date.now();
    const answer = (await f.ask("w", f.say("w", "again"), "again")) as Fresh;
    expect(since(start)).toBeLessThan(250);
    expect(lines(answer)[1]).toMatch(/^1\+1\|agent: y+… \(not summarized yet: zoom it\)$/);
  });
});
