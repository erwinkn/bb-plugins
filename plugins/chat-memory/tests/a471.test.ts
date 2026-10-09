import { makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCompaction } from "../lib/compaction";
import { GATE_TRIES, TURN_CONTEXT_TOOL } from "../lib/memory";
import plugin from "../server";
import { fixture, type Fixture } from "./fixture";

/**
 * A471 (W288's review of T145 v2): one regression per finding, each failing on v2. Findings 1-3
 * are mostly closed in BB's fork (FORK.md: a turn asks for its context by the tools BB resolves
 * for that turn, and a provider that cannot answer it refuses the turn); these tests hold this
 * plugin's half: what it selects for each turn, and what its gate decides. Finding 4 is in
 * import.test.ts.
 */

const tools = async (f: Fixture, threadId: string, options?: Parameters<Fixture["configureAgent"]>[1]) => (await f.configureAgent(threadId, options)).tools.map((t) => t.name).sort();
const WITH_HOOK = [TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"];

/** An imported Initiative coordinator in OptChat that has never asked for its turn context. */
function imported(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  f.thread("coord", { originPluginId: "initiatives", title: "Coordinator" });
  f.thread("codex", { originPluginId: "initiatives", title: "Codex coordinator", providerId: "codex" });
  f.store.ensureScope("initiatives:p", "initiatives");
  f.store.setMembers("initiatives:p", ["coord"]);
  f.store.saveSettings("initiatives:p", { mode: "optchat", compactTokens: null });
  return f;
}

describe("A471 1: every turn of an OptChat thread carries what enforces its mode, on any path", () => {
  it("selects the hook for each turn of an OptChat member: a Claude Code one asks, any other provider is refused by BB", async () => {
    const f = imported();
    // The tools BB resolves for every turn, a parent notice or Send now included, never only at the gate.
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual(WITH_HOOK);
    await f.setScope("initiatives", "p", ["coord", "codex"]);
    expect(await tools(f, "codex", { providerId: "codex", origin: "initiatives" })).toEqual(WITH_HOOK);
    // In another mode a Codex thread runs as it is, and a Claude Code one still asks (and goes on).
    await f.configure("coord", { mode: "hybrid" });
    expect(await tools(f, "codex", { providerId: "codex", origin: "initiatives" })).toEqual(["memory_read", "memory_zoom"]);
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual(WITH_HOOK);
    f.memory.dispose();
  });
});

describe("A471 2: a runtime whose capability is unknown is not admitted to OptChat", () => {
  it("refuses OptChat everywhere, visibly, once a turn shows the provider is older than protocol 4", async () => {
    const f = imported();
    await f.setScope("initiatives", "p", ["coord"]);
    f.thread("other", { originPluginId: "initiatives" });
    await f.setScope("initiatives", "q", ["other"]);
    // Another scope's thread asks with protocol 3: its session was built with the hook, by the old fork.
    expect(await f.ask("other", f.say("other", "hi"), "hi", { protocol: 3 })).toEqual({});
    // The imported coordinator's session may lack the hook; on that provider it would not ask.
    expect(await f.dispatch("coord")).toMatchObject({ action: "reject", message: expect.stringMatching(/older than protocol 4.*not sent/) });
    await expect(f.ask("coord", f.say("coord", "go"), "go", { protocol: 3 })).rejects.toThrow(/older than protocol 4/);
    expect((await f.memory.status("initiatives:p")).problems).toContainEqual(expect.stringMatching(/older than protocol 4/));
    await f.configure("coord", { mode: "hybrid" });
    await expect(f.configure("coord", { mode: "optchat" })).rejects.toThrow(/older than protocol 4/);
    f.memory.dispose();
  });

  it("records the protocol each member's turn asked with, for the cutover's check", async () => {
    const f = imported();
    await f.setScope("initiatives", "p", ["coord"]);
    expect(f.store.member("initiatives:p", "coord")).toMatchObject({ askedAt: null, askedProtocol: null });
    await f.ask("coord", f.say("coord", "go"), "go");
    expect((await f.memory.status("initiatives:p")).threads[0]).toMatchObject({ askedAt: expect.any(Number), askedProtocol: 4 });
    f.memory.dispose();
  });
});

describe("A471 3: a session configured while another plugin held the hook is never blocked for it", () => {
  it("lets its messages go once the hook is held, and after the plugin is rebuilt over the same database", async () => {
    const f = imported({ hookHeldBy: "initiatives" });
    // Initiatives before T145 adds its own hook to this resolution; this plugin's part has none.
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual(["memory_read", "memory_zoom"]);
    f.holdHook(null);
    expect(await f.dispatch("coord")).toEqual({ action: "proceed" });
    expect(await tools(f, "coord", { origin: "initiatives" })).toEqual(WITH_HOOK);
    // Nothing persisted holds it after a rebuild over the same database either.
    const rebuilt = await f.harness.lifecycle.reload((bb) => void plugin(bb));
    const gate = rebuilt.harness.inspection.registrations.hooks["message.dispatch"]!;
    const context = makeMessageDispatchHookContext({
      thread: makeThreadResponse({ id: "coord", providerId: "claude-code", originPluginId: "initiatives" }),
      requestedExecution: { providerId: "claude-code", model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
      attempt: "start-turn",
    } as never);
    expect(await gate(context)).toEqual({ action: "proceed" });
    expect(((await rebuilt.harness.behavior.callRpc("status", { threadId: "coord" })) as { problems: string[] }).problems).toEqual([]);
    await rebuilt.harness.lifecycle.dispose();
  });
});

describe("A471 5: the gate's waits are bounded, then refused with the message kept", () => {
  it("holds an OptChat message while the hook is another plugin's, GATE_TRIES times, then refuses it", async () => {
    const f = imported({ hookHeldBy: "initiatives" });
    await f.ask("coord", "creq_none", "unused").catch(() => undefined);
    for (let n = 1; n < GATE_TRIES; n++)
      expect(await f.dispatch("coord")).toMatchObject({ action: "wait", reason: expect.stringMatching(new RegExp(`taking over its turn hook.*\\(${n} of ${GATE_TRIES}\\)`)), sendAt: expect.any(Number) });
    expect(await f.dispatch("coord")).toMatchObject({ action: "reject", message: expect.stringMatching(/taking over its turn hook.*not sent after 3 tries; send it again/) });
    // The count starts over for the next message.
    expect(await f.dispatch("coord")).toMatchObject({ action: "wait", reason: expect.stringMatching(/\(1 of 3\)/) });
    f.memory.dispose();
  });

  it("refuses a Codex OptChat message at once, and bounds a failed read of where a new thread goes", async () => {
    const f = imported();
    await f.setScope("initiatives", "p", ["coord", "codex"]);
    expect(await f.dispatch("codex")).toMatchObject({ action: "reject", message: expect.stringMatching(/Claude Code only.*not sent/) });
    f.thread("codex-next", { providerId: "codex", originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    f.memory["deps"].ownerMetadata = async () => {
      throw new Error("503 metadata unavailable");
    };
    expect(await f.dispatch("codex-next")).toMatchObject({ action: "wait", reason: expect.stringMatching(/could not read which memory this thread joins \(503 metadata unavailable\).*\(1 of 3\)/) });
    expect(await f.dispatch("codex-next")).toMatchObject({ action: "wait" });
    expect(await f.dispatch("codex-next")).toMatchObject({ action: "reject", message: expect.stringMatching(/503 metadata unavailable.*not sent after 3 tries/) });
    f.memory.dispose();
  });
});

describe("A471 6: a failed read of the context size is a visible, retried compaction failure", () => {
  it("keeps the read's error on the member, shows it, retries it within the bound, and clears it once a read works", async () => {
    const f = fixture();
    f.thread("coord", { title: "Coordinator" });
    await f.setScope("initiatives", "p", ["coord"]);
    await f.configure("coord", { mode: "hybrid" });
    let reads = 0;
    let failing = true;
    const c = createCompaction({
      store: f.store,
      limit: (s) => f.memory.compactLimit(s),
      log: () => {},
      sdk: {
        threads: {
          events: {
            list: async () => {
              reads++;
              if (failing) throw new Error("503 events unavailable");
              return [{ seq: 7, type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens: 1_000 } } }];
            },
          },
          compact: async () => ({}),
        },
      } as never,
    });
    const signal = new AbortController().signal;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(f.store.member("initiatives:p", "coord")!.compactError).toBe("reading its context size failed: 503 events unavailable");
    expect((await f.memory.status("initiatives:p")).problems).toContainEqual(expect.stringMatching(/Compacting "Coordinator" failed: reading its context size failed: 503 events unavailable/));
    expect(f.store.compactFailures(3)).toEqual([{ scope: "initiatives:p", threadId: "coord" }]);
    // Not read again at once; again once the retry wait is over; the sweep stops after three.
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(reads).toBe(1);
    const due = () => f.store.handle.prepare(`UPDATE members SET compact_tried_at = 0`).run();
    due();
    await c.afterIdle("coord", signal);
    due();
    await c.afterIdle("coord", signal);
    expect(reads).toBe(3);
    expect(f.store.compactFailures(3)).toEqual([]);
    // A later turn reads again; a read that works clears the problem.
    due();
    failing = false;
    expect(await c.afterIdle("coord", signal)).toBe(false);
    expect(f.store.member("initiatives:p", "coord")).toMatchObject({ compactError: null, compactTries: 0 });
    expect((await f.memory.status("initiatives:p")).problems).toEqual([]);
    f.memory.dispose();
  });
});
