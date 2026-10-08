import { describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import { MIGRATIONS } from "../lib/store";
import { MEMORY_MIGRATIONS } from "../lib/memory/store";
import type { Summarizer, SummarizerRequest } from "../lib/memory/summarizer";

// W220 (D431): every Initiative keeps a memory log of its coordinators, read from BB's events,
// and (D447) builds the summary tree over it in every mode; its coordinator reads, zooms and dates it.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let seq = 500_000;
let at = 1_790_000_000_000;
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => {
  const out = await f.harness.callAgentTool(name, input, { threadId });
  try {
    return JSON.parse(out as string);
  } catch {
    return out;
  }
};
const say = (f: Fx, threadId: string, text: string, extra: Record<string, unknown> = {}) =>
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: ++at, threadId, data: { direction: "outbound", source: "tell", initiator: "user", input: [{ type: "text", text }], ...extra } } as never);
const reply = (f: Fx, threadId: string, text: string) =>
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: ++at, threadId, data: { item: { type: "agentMessage", id: `i${seq}`, text } } } as never);
const command = (f: Fx, threadId: string, cmd: string, output: string) =>
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: ++at, threadId, data: { item: { type: "commandExecution", id: `i${seq}`, command: cmd, exitCode: 0, aggregatedOutput: output } } } as never);
/** The coordinator's turn ends; the detached log read (and build) finish. */
const idles = async (f: Fx, threadId = "coordinator") => {
  await f.runtime.onThreadIdle(f.idle(threadId));
  await f.service.memory.settled();
};
const log = (f: Fx, projectId: string) => f.service.memory.store.messages(projectId).map((m) => `${m.kind}: ${m.text}`);
const config = (f: Fx, threadId = "coordinator") => f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get(threadId)! }));
/** A fake Luna: a short line naming the node it was asked for. */
const fakeLuna: Summarizer = async (r: SummarizerRequest) => {
  const task = (r.input[0]!.content[1] as { text: string }).text;
  const name = /compress message (\d+)/.exec(task)?.[1] ?? /merge lines (\d+\+\d+ and \d+\+\d+)/.exec(task)![1];
  return { ok: true, text: `summary of ${name} `.padEnd(300, "."), usage: { input: 2000, cached: 1500, output: 100, reasoning: 50 }, latencyMs: 1 };
};
const big = (n: number) => `${n}: `.padEnd(800, "z");

describe("W220 memory log", () => {
  it("is a migration of new tables only", () => {
    // Deployed at indexes 72–76; later migrations append after them.
    expect(MIGRATIONS.slice(72, 72 + MEMORY_MIGRATIONS.length)).toEqual(MEMORY_MIGRATIONS);
    expect(MEMORY_MIGRATIONS.every((m) => m.startsWith("CREATE TABLE memory_"))).toBe(true);
  });

  it("logs the coordinator's messages from BB's events when its turn ends, once each, in every mode", async () => {
    const { f, project } = await projectFixture();
    expect(f.service.memory.settings(project.id).mode).toBe("regular");
    say(f, "coordinator", "Ship the search fix");
    reply(f, "coordinator", "On it.");
    command(f, "coordinator", "git status", "clean");
    await idles(f);
    expect(log(f, project.id)).toEqual(["user: Ship the search fix", "coord: On it.", "tool: Bash git status", "echo: exit 0\nclean"]);
    await idles(f);
    expect(log(f, project.id)).toHaveLength(4);
    reply(f, "coordinator", "Done.");
    await idles(f);
    expect(log(f, project.id).at(-1)).toBe("coord: Done.");
    // D447: regular mode builds the tree too, so a switch is instant.
    expect(f.service.memory.settings(project.id).mode).toBe("regular");
    expect(f.service.memory.status(project.id).tree).toMatchObject({ state: "idle", summarized: 5 });
  });

  it("names a worker's messages by its W# and logs a worker's report notice as work", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    say(f, "coordinator", `[bb message from thread:${w.threadId}]\n\nIt is done.`, { initiator: "agent", senderThreadId: w.threadId });
    await idles(f);
    expect(log(f, project.id)).toContain("work: [W1] It is done.");
  });

  it("seeds a first log from earlier coordinators back to the last handover, the handover as a note", async () => {
    const { f, project } = await projectFixture();
    const gen = (generation: number, threadId: string) =>
      f.store.db.prepare(`INSERT INTO generations (project_id, worker_num, generation, thread_id, started_at, ended_at) VALUES (?, 0, ?, ?, ?, ?)`).run(project.id, generation, threadId, generation, generation + 1);
    gen(-3, "older");
    gen(-2, "handed");
    gen(-1, "plain");
    for (const id of ["older", "handed", "plain"]) f.threads.set(id, makeThreadResponse({ id, projectId: "proj_a", status: "idle" }));
    say(f, "older", "Long gone");
    say(f, "handed", 'This thread is starting as the replacement coordinator of the Initiative "Search".\n\nHandover from the previous coordinator:\n\nT4 is half done.', { source: "spawn" });
    reply(f, "handed", "Confirmed.");
    say(f, "plain", "Keep going");
    say(f, "coordinator", "And now?");
    await idles(f);
    expect(log(f, project.id)).toEqual([
      expect.stringMatching(/^note: This thread is starting as the replacement coordinator[\s\S]*T4 is half done\.$/),
      "coord: Confirmed.",
      "user: Keep going",
      "user: And now?",
    ]);
    // Former coordinators are read until quiet, then left alone.
    expect(f.service.memory.store.cursors(project.id).map((c) => [c.threadId, c.done])).toEqual([["handed", true], ["plain", true], ["coordinator", false]]);
  });
});

describe("W220 memory modes", () => {
  it("is set per Initiative by command; the coordinator's tools and guidance are the same in every mode, so a switch needs no new session", async () => {
    const { f, project } = await projectFixture();
    const before = await config(f);
    expect(before.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["initiative_zoom", "initiative_date"]));
    expect(before.instructions).toContain("Memory: every message of this Initiative is logged and summarized");
    expect(before.instructions!.length).toBeLessThanOrEqual(4096);
    expect(before.instructions).toMatch(/Current Initiative membership: \{.*\}\n\nMemory: /);
    const status = await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    expect(status).toMatchObject({ mode: "hybrid", effectiveMode: "hybrid", compactTokens: 150_000 });
    // A coordinator built since every coordinator got the tools has no session note (W244).
    expect(status).toMatchObject({ session: null });
    expect(await config(f)).toEqual(before);
    expect(f.store.activity(project.id, 5).map((a) => a.summary)).toContain("Memory set to hybrid by you, from the next turn");
    // W240: optchat runs from the coordinator's next turn, each a fresh session over the view.
    expect(await f.perform(project.id, { action: "memory", mode: "optchat" }, "user", null)).toMatchObject({ mode: "optchat", effectiveMode: "optchat", note: expect.stringMatching(/fresh session/) });
    expect(await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null)).toMatchObject({ mode: "regular", compactTokens: 300_000 });
  });

  it("through bb initiative command, with a per-Initiative compaction limit that wins over the mode's default", async () => {
    const { f, project } = await projectFixture();
    const run = await f.harness.runCli(["command", JSON.stringify({ action: "memory", mode: "hybrid", compactTokens: 200_000 }), project.id]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout!)).toMatchObject({ mode: "hybrid", compactTokens: 200_000, compactTokensOverride: 200_000 });
    expect(f.service.memory.compactLimit(project.id)).toBe(200_000);
    await f.perform(project.id, { action: "memory", compactTokens: null }, "user", null);
    expect(f.service.memory.compactLimit(project.id)).toBe(150_000);
  });

  it("compacts a hybrid coordinator at the lower hybrid limit", async () => {
    const { f, project } = await projectFixture();
    const turnEnds = (usedTokens: number) =>
      f.history.push({ type: "thread/contextWindowUsage/updated", seq: ++seq, createdAt: Date.now(), threadId: "coordinator", data: { contextWindowUsage: { usedTokens, modelContextWindow: 1_000_000, estimated: true } } } as never);
    turnEnds(200_000);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.runtime.compactionsSettled();
    expect(f.compact).not.toHaveBeenCalled();
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    f.service.memory.useSummarizer(fakeLuna);
    turnEnds(210_000);
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    await f.runtime.compactionsSettled();
    expect(f.compact).toHaveBeenCalledTimes(1);
    expect(f.store.activity(project.id, 20).map((a) => a.summary)).toContain("Coordinator context at ~210k tokens (limit 150k): compacting it between turns");
    await f.service.memory.settled();
  });
});

describe("W220 hybrid memory: tree, view, zoom and date", () => {
  async function hybrid() {
    const { f, project } = await projectFixture();
    f.service.memory.useSummarizer(fakeLuna);
    await f.perform(project.id, { action: "memory", mode: "hybrid" }, "user", null);
    for (let n = 0; n < 6; n++) {
      say(f, "coordinator", big(n));
      reply(f, "coordinator", `ok ${n}`);
    }
    await idles(f);
    return { f, project };
  }

  it("builds the tree in the background and reports its progress and cost", async () => {
    const { f, project } = await hybrid();
    const status = f.service.memory.status(project.id);
    expect(status.log.messages).toBe(12);
    expect(status.tree).toMatchObject({ summarized: 12, nodes: 12 + 6 + 3 + 1, total: 22, state: "idle" });
    expect(status.cost.calls).toBeGreaterThan(0);
    expect(status.cost.usd).toBeGreaterThan(0);
    expect((await f.overview(project.id)).memory).toMatchObject({ mode: "hybrid", log: { messages: 12 } });
  });

  it("serves the memory view, zoom and date to the coordinator", async () => {
    const { f } = await hybrid();
    const memory = await tool(f, "initiative_read", { view: "memory" });
    expect(memory.messages).toBe(12);
    expect(memory.view.split("\n")[0]).toMatch(/^0\+1\|summary of 0 /);
    expect(memory.note).toContain("initiative_zoom {id:64,n:32}");
    // Message 1 is short: its parent with message 0 needed no call and keeps both lines.
    expect(await tool(f, "initiative_zoom", { id: 0, n: 4 })).toMatch(/^0\+2\|summary of 0 \.+ coord: ok 0\n2\+2\|summary of 2 \.+ coord: ok 1$/);
    expect(await tool(f, "initiative_zoom", { id: 0, n: 1 })).toBe(`user: ${big(0)}`);
    expect(await tool(f, "initiative_zoom", { id: 1, n: 1 })).toBe("coord: ok 0");
    expect(await tool(f, "initiative_date", { id: 1 })).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    await expect(f.harness.callAgentTool("initiative_zoom", { id: 3, n: 2 }, { threadId: "coordinator" })).rejects.toThrow(/no line/);
    await expect(f.harness.callAgentTool("initiative_zoom", { id: 8, n: 8 }, { threadId: "coordinator" })).rejects.toThrow(/past the last message, 11/);
    const cli = await f.harness.runCli(["zoom", "0", "1"], { threadId: "coordinator" });
    expect(JSON.parse(cli.stdout!)).toBe(`user: ${big(0)}`);
  });

  it("keeps building after a switch back to regular, so switching again is instant (D447)", async () => {
    const { f, project } = await hybrid();
    await f.perform(project.id, { action: "memory", mode: "regular" }, "user", null);
    say(f, "coordinator", big(6));
    await idles(f);
    expect(f.service.memory.status(project.id).tree).toMatchObject({ state: "idle", summarized: 13, nodes: 23 });
    expect(await tool(f, "initiative_read", { view: "memory" })).toMatchObject({ messages: 13, view: expect.stringMatching(/^0\+1\|summary of 0 /) });
  });

  it("stops building once the Initiative is archived", async () => {
    const { f, project } = await hybrid();
    f.store.db.prepare(`UPDATE projects SET archived_at = 1 WHERE id = ?`).run(project.id);
    expect(f.service.memory.building(project.id)).toBe(false);
    expect(await f.service.memory.waitSummarized(project.id, 13, new AbortController().signal)).toBe(false);
  });

  it("logs as the coordinator works, not only when its turn ends", async () => {
    const { f, project } = await hybrid();
    reply(f, "coordinator", "Halfway there.");
    await f.harness.emitThreadEvent("experimental_thread.events" as never, { thread: f.threads.get("coordinator"), sequence: seq } as never);
    await f.service.memory.settled();
    expect(f.service.memory.store.count(project.id)).toBe(13);
  });
});

describe("W220 phase 2 interface", () => {
  it("waits until earlier messages are summarized before a turn, and frames the turn's message", async () => {
    const { f, project } = await projectFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.service.memory.useSummarizer(async (r) => (await gate, fakeLuna(r)));
    await f.perform(project.id, { action: "memory", mode: "optchat" }, "user", null);
    say(f, "coordinator", big(0));
    await f.runtime.onThreadIdle(f.idle("coordinator"));
    const waiting = f.service.memory.waitSummarized(project.id, 1, new AbortController().signal);
    let done = false;
    void waiting.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    expect(await waiting).toBe(true);
    await f.service.memory.settled();
    expect(f.service.memory.view(project.id, "chat").lines).toEqual([expect.stringMatching(/^0\+1\|summary of 0 /)]);
    const { turnMessage } = await import("../lib/memory/prompt");
    expect(turnMessage(Date.UTC(2026, 9, 8, 9, 22), "W12 reported")).toBe("Now: 2026-10-08 09:22 UTC.\n\nNew message:\nW12 reported");
  });
});
