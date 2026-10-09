import { describe, expect, it } from "vitest";
import { TURN_CONTEXT_TOOL, type MemoryStatus } from "../lib/memory";
import { createCompaction } from "../lib/compaction";
import { fixture, type Fixture } from "./fixture";

/**
 * A469 (W286's review of T145): each test reproduces one finding's failure, adapted from W286's
 * probes, and asserts the behavior D458-D460 ask for instead.
 */

const fresh = (answer: unknown) => answer as { session: "fresh"; sessionId: string; systemPrompt: string; input: string };
const tools = async (f: Fixture, threadId: string, options?: Parameters<Fixture["configureAgent"]>[1]) => (await f.configureAgent(threadId, options)).tools.map((t) => t.name).sort();

/** An Initiative coordinator in OptChat whose session has asked for its turn context. */
async function optchat() {
  const f = fixture();
  f.thread("coord", { originPluginId: "initiatives", title: "Coordinator" });
  await f.configureAgent("coord", { origin: "initiatives" });
  await f.setScope("initiatives", "p", ["coord"]);
  await f.ask("coord", f.say("coord", "warmup"), "warmup");
  await f.idle("coord");
  await f.configure("coord", { mode: "optchat" });
  return f;
}

describe("A469 1: no OptChat runtime runs without the turn hook across a reload gap", () => {
  it("while another plugin holds the hook: sessions get the memory tools without it, and OptChat messages wait", async () => {
    // Installed while the Initiatives plugin before T145 still holds the name; its coordinator imported.
    const g = fixture({ hookHeldBy: "initiatives" });
    g.thread("coord", { originPluginId: "initiatives", title: "Coordinator" });
    g.store.ensureScope("initiatives:p", "initiatives");
    g.store.setMembers("initiatives:p", ["coord"]);
    g.store.saveSettings("initiatives:p", { mode: "optchat", compactTokens: null });
    // The configuration BB's real normalizer accepts: memory tools, no hook it does not hold.
    expect(await tools(g, "coord", { origin: "initiatives" })).toEqual(["memory_read", "memory_zoom"]);
    expect(await g.dispatch("coord")).toMatchObject({ action: "wait", reason: expect.stringMatching(/taking over its turn hook.*\(1 of 3\)/), sendAt: expect.any(Number) });
    expect((await g.memory.status("initiatives:p")).problems).toContainEqual(expect.stringMatching(/turn hook is still held by another plugin/));
    await expect(g.configure("coord", { mode: "hybrid" })).resolves.toMatchObject({ mode: "hybrid" });
    await expect(g.configure("coord", { mode: "optchat" })).rejects.toThrow(/turn hook is still held by another plugin/);
    // The holder reloads without it: the next call takes the name, no reload of this plugin needed.
    g.holdHook(null);
    const rechecks = g.harness.inspection.recheckCount;
    await g.setScope("initiatives", "p", ["coord"]);
    expect(g.harness.inspection.recheckCount).toBeGreaterThan(rechecks);
    expect(await tools(g, "coord", { origin: "initiatives" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    g.memory.dispose();
  });

  it("a session built in the gap needs no proof: once the hook is held, each turn's tools have it, so the turn asks (A471)", async () => {
    const f = fixture({ hookHeldBy: "initiatives" });
    f.thread("coord", { originPluginId: "initiatives" });
    await f.setScope("initiatives", "p", ["coord"]);
    f.store.saveSettings("initiatives:p", { mode: "optchat", compactTokens: null });
    // BB builds the coordinator's session while nobody it can reach holds the hook.
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual(["memory_read", "memory_zoom"]);
    f.holdHook(null);
    // The gate takes the name; the turn's own resolution then selects it.
    expect(await f.dispatch("coord")).toEqual({ action: "proceed" });
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(fresh(await f.ask("coord", f.say("coord", "go"), "go")).session).toBe("fresh");
    f.memory.dispose();
  });

  it("answers configure, the gate and resident turns from the members close() left while a reload disposes it", async () => {
    const f = await optchat();
    f.memory.dispose();
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(await f.dispatch("coord")).toEqual({ action: "proceed" });
    // An OptChat turn fails visibly; it never goes on resident.
    await expect(f.ask("coord", "creq_x", "hi")).rejects.toThrow(/OptChat memory unavailable for this turn: Chat memory is closed/);
  });
});

describe("A469 2: a membership still to come is never answered as none", () => {
  it("fails the turn of a new coordinator its owner has not registered by the deadline, every time, and answers once it has", async () => {
    const f = await optchat();
    f.thread("new-coord", { originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    await f.configureAgent("new-coord", { origin: "initiatives" });
    const requestId = f.say("new-coord", "continue");
    await expect(f.ask("new-coord", requestId, "continue")).rejects.toThrow(/OptChat memory unavailable for this turn: the initiatives plugin has not added it to its memory yet/);
    // Nothing is latched: the next ask waits again.
    await expect(f.ask("new-coord", requestId, "continue")).rejects.toThrow(/has not added it/);
    await f.setScope("initiatives", "p", ["new-coord"]);
    expect(fresh(await f.ask("new-coord", requestId, "continue")).session).toBe("fresh");
    f.memory.dispose();
  });

  it("answers no memory at once for a thread its owner names no scope for, one that left the scope, and one expected in a resident mode", async () => {
    const f = await optchat();
    f.thread("writer", { originPluginId: "initiatives" });
    const started = Date.now();
    expect(await f.ask("writer", "creq_w", "write the handover")).toEqual({});
    f.thread("next", { originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    await f.setScope("initiatives", "p", ["next"]);
    // The former coordinator, retired from the scope, carries the same metadata.
    f.threads.get("coord")!.metadata = { memoryScope: "p" };
    expect(await f.ask("coord", "creq_c", "hi")).toEqual({});
    await f.configure("next", { mode: "hybrid" });
    f.thread("other", { originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    expect(await f.ask("other", "creq_o", "hi")).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
    f.memory.dispose();
  });

  it("fails the turn when the owner's metadata cannot be read, after retrying it", async () => {
    const f = await optchat();
    f.thread("new-coord", { originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    let reads = 0;
    f.memory["deps"].ownerMetadata = async () => {
      reads++;
      throw new Error("503 metadata unavailable");
    };
    await expect(f.ask("new-coord", "creq_n", "hi")).rejects.toThrow(/metadata on the thread could not be read \(503 metadata unavailable\)/);
    expect(reads).toBe(3);
    f.memory.dispose();
  });
});

describe("A469 3: OptChat capability is checked for every member, on every change", () => {
  it("refuses the messages of a Codex coordinator that joins an OptChat scope, keeping the mode, and makes BB refuse its every turn", async () => {
    const f = await optchat();
    f.thread("codex-coord", { providerId: "codex", originPluginId: "initiatives", title: "Codex coordinator" });
    await f.setScope("initiatives", "p", ["codex-coord"]);
    // The hook in a Codex thread's tools makes BB refuse each of its turns, notices and Send now included (FORK.md).
    expect(await tools(f, "codex-coord", { providerId: "codex", origin: "initiatives" })).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    expect(f.store.currentScopeOf("codex-coord")?.mode).toBe("optchat");
    expect(await f.dispatch("codex-coord")).toMatchObject({ action: "reject", message: expect.stringMatching(/OptChat runs on Claude Code only for now \(T146\): "Codex coordinator" runs on codex, so this message was not sent/) });
    expect((await f.memory.status("initiatives:p")).problems).toContainEqual(expect.stringMatching(/OptChat cannot run in "Codex coordinator" \(codex\)/));
    // Joining a running turn, or another mode, goes on.
    expect(await f.dispatch("codex-coord", { attempt: "join-turn" })).toEqual({ action: "proceed" });
    await f.configure("codex-coord", { mode: "hybrid" });
    expect(await f.dispatch("codex-coord")).toEqual({ action: "proceed" });
    expect(await tools(f, "codex-coord", { providerId: "codex", origin: "initiatives" })).toEqual(["memory_read", "memory_zoom"]);
    f.memory.dispose();
  });

  it("refuses a new Codex coordinator its owner will add to an OptChat scope, from its first message", async () => {
    const f = await optchat();
    f.thread("codex-next", { providerId: "codex", originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    expect(await f.dispatch("codex-next")).toMatchObject({ action: "reject", message: expect.stringMatching(/Claude Code only/) });
    f.thread("codex-adhoc", { providerId: "codex", originPluginId: "initiatives" });
    expect(await f.dispatch("codex-adhoc")).toEqual({ action: "proceed" });
    f.memory.dispose();
  });

  it("re-enabling a memory whose session was rebuilt while it was off keeps OptChat, and its next turn asks (W286, A471)", async () => {
    const f = fixture();
    f.thread("plain", { title: "Plain" });
    await f.configure("plain", {});
    await f.ask("plain", f.say("plain", "warmup"), "warmup");
    await f.idle("plain");
    await f.configure("plain", { mode: "optchat" });
    await f.configure("plain", { enabled: false });
    // BB builds its session while memory is off: no memory tools, no hook.
    expect(await tools(f, "plain")).toEqual([]);
    const on = (await f.configure("plain", { enabled: true })) as MemoryStatus;
    expect(on.mode).toBe("optchat");
    expect(on.problems).toEqual([]);
    expect(await f.dispatch("plain")).toEqual({ action: "proceed" });
    expect(await tools(f, "plain")).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    f.memory.dispose();
  });

  it("an owner adopting an existing thread into an OptChat scope: its next turn's tools have the hook (A471)", async () => {
    const f = await optchat();
    f.thread("adopted");
    // Its session was built outside every scope.
    expect(await tools(f, "adopted")).toEqual([]);
    await f.setScope("initiatives", "p", ["adopted"]);
    expect(await f.dispatch("adopted")).toEqual({ action: "proceed" });
    expect(await tools(f, "adopted")).toEqual([TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"]);
    f.memory.dispose();
  });

  it("does not refuse a switch away and back for a member never seen either way (an imported coordinator)", async () => {
    const f = fixture();
    f.thread("live");
    f.store.ensureScope("initiatives:p", "initiatives");
    f.store.setMembers("initiatives:p", ["live"]);
    f.store.saveSettings("initiatives:p", { mode: "optchat", compactTokens: null });
    expect(f.store.member("initiatives:p", "live")).toMatchObject({ askedAt: null });
    await f.configure("live", { mode: "hybrid" });
    await expect(f.configure("live", { mode: "optchat" })).resolves.toMatchObject({ mode: "optchat" });
    expect(await f.dispatch("live")).toEqual({ action: "proceed" });
    f.memory.dispose();
  });
});

describe("A469 4: a summary that keeps failing fails the turn, never a clipped message", () => {
  it("fails the OptChat turn after the bounded tries, with the message's critical end never in a line", async () => {
    const f = await optchat();
    f.memory.useSummarizer(async () => ({ ok: false, reason: "failed", error: "400 rejected" }));
    f.say("coord", `${"background ".repeat(200)} NEVER DEPLOY TO PRODUCTION`);
    await expect(f.ask("coord", f.say("coord", "proceed"), "proceed")).rejects.toThrow(/OptChat memory unavailable for this turn: message \d+ could not be summarized \(400 rejected\)/);
    const status = await f.memory.status("initiatives:p");
    expect(status.tree.failed).toBeGreaterThan(0);
    expect(status.tree.fallbacks).toBe(0);
    expect(status.problems).toContainEqual(expect.stringMatching(/could not be summarized/));
    const lines = f.store.handle.prepare(`SELECT text, how FROM nodes WHERE scope = 'initiatives:p'`).all() as Array<{ text: string; how: string }>;
    expect(lines.some((n) => n.how === "fallback" || n.text.includes("background background"))).toBe(false);
    f.memory.dispose();
  });
});

describe("A469 5: a retry's original request must be read", () => {
  it("tries the original's lookup again, then cuts before it; fails the turn when it stays unreadable", async () => {
    const f = await optchat();
    const original = f.say("coord", "Ship it");
    const retry = f.say("coord", "Ship it", { retryOfRequestId: original, retryAttempt: 2, initiator: "system" });
    const list = f.memory["deps"].list;
    let finds = 0;
    let failing = 1;
    f.memory["deps"].list = async (args) => {
      if (args.types.length === 1 && args.types[0] === "client/turn/requested" && args.order === "desc" && ++finds >= 2 && failing-- > 0) throw new Error("503 original request unavailable");
      return list(args);
    };
    const answer = fresh(await f.ask("coord", retry, "Ship it"));
    expect(`${answer.systemPrompt}\n${answer.input}`).not.toMatch(/\|user: Ship it/);
    finds = 0;
    failing = Infinity;
    await expect(f.ask("coord", retry, "Ship it")).rejects.toThrow(/the original of retried request .+ could not be read \(503 original request unavailable\)/);
    f.memory.dispose();
  });
});

describe("A469 8 and 9: compaction failures are visible and retried; an owner's hold stops it", () => {
  const failing = (f: Fixture, fail: () => boolean) =>
    createCompaction({
      store: f.store,
      limit: (s) => f.memory.compactLimit(s),
      log: () => {},
      sdk: {
        threads: {
          events: { list: async () => [{ seq: 1, type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens: 200_000 } } }] },
          compact: async () => {
            if (fail()) throw new Error("503 BB unavailable");
            return {};
          },
        },
      } as never,
    });

  it("records a failed compaction as failed, shows it, and tries the same snapshot again at most three times", async () => {
    const f = fixture();
    f.thread("coord", { title: "Coordinator" });
    await f.setScope("initiatives", "p", ["coord"]);
    await f.configure("coord", { mode: "hybrid" });
    let fails = true;
    let tries = 0;
    const c = failing(f, () => (tries++, fails));
    const signal = new AbortController().signal;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    const status = await f.memory.status("initiatives:p");
    expect(status.threads[0]).toMatchObject({ compactedAt: null, compactError: "503 BB unavailable" });
    expect(status.problems).toContainEqual(expect.stringMatching(/Compacting "Coordinator" failed: 503 BB unavailable/));
    // Not again at once; again once the retry wait is over; never more than three times a snapshot.
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(tries).toBe(1);
    expect(f.store.compactFailures(3)).toEqual([{ scope: "initiatives:p", threadId: "coord" }]);
    const due = () => f.store.handle.prepare(`UPDATE members SET compact_tried_at = 0`).run();
    for (let n = 0; n < 3; n++) {
      due();
      await c.afterIdle("coord", signal);
    }
    expect(tries).toBe(3);
    // The problem stays; the sweep stops trying this snapshot.
    expect(f.store.member("initiatives:p", "coord")!.compactError).toBe("503 BB unavailable");
    expect(f.store.compactFailures(3)).toEqual([]);
    // A later snapshot starts over; a success clears the problem.
    f.store.handle.prepare(`UPDATE members SET compacted_seq = 0`).run();
    fails = false;
    expect(await c.afterIdle("coord", signal)).toBe(true);
    expect((await f.memory.status("initiatives:p")).problems).toEqual([]);
    expect(f.store.member("initiatives:p", "coord")!.compactedAt).not.toBeNull();
    f.memory.dispose();
  });

  it("starts no automatic compaction while the owner holds it (a paused Initiative)", async () => {
    const f = fixture();
    await f.setScope("initiatives", "p", [f.thread("coord")]);
    await f.configure("coord", { compactTokens: 100_000 });
    await f.setScope("initiatives", "p", ["coord"], true);
    f.usage("coord", 150_000);
    await f.idle("coord");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.compacts).toEqual([]);
    await f.setScope("initiatives", "p", ["coord"], false);
    f.usage("coord", 160_000);
    await f.idle("coord");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.compacts).toEqual(["coord"]);
    f.memory.dispose();
  });
});
