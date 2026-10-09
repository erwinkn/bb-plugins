import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { TURN_CONTEXT_TOOL } from "../lib/memory";
import { fixture, type Fixture } from "./fixture";

/**
 * A473 (W290's review of T145 v3), finding 1; findings 2 and 3 are in BB's fork. Send now skips
 * the gate, and BB resolves a turn's tools before the owner's registration of a new coordinator
 * reaches this plugin, so what a pending coordinator's turn carries comes from its owner's
 * metadata on it, which BB's fork gives every configure (origin.pluginMetadata).
 */

const tools = async (f: Fixture, threadId: string, providerId = "codex") =>
  (await f.configureAgent(threadId, { providerId, origin: "initiatives" })).tools.map((t) => t.name).sort();
const WITH_HOOK = [TURN_CONTEXT_TOOL, "memory_read", "memory_zoom"];

/** An Initiative in OptChat whose replacement coordinator, on Codex, is spawned but not added yet. */
function pending() {
  const f = fixture();
  f.thread("coord", { originPluginId: "initiatives", title: "Coordinator" });
  f.thread("next", { originPluginId: "initiatives", title: "Replacement", providerId: "codex", metadata: { memoryScope: "p" } });
  f.store.ensureScope("initiatives:p", "initiatives");
  f.store.setMembers("initiatives:p", ["coord"]);
  f.store.saveSettings("initiatives:p", { mode: "optchat", compactTokens: null });
  return f;
}

describe("A473 1: a pending coordinator's turns carry its memory's mode before its owner adds it", () => {
  it("selects the hook for a pending Codex coordinator of an OptChat memory, so BB refuses its Send now too", async () => {
    const f = pending();
    // The gate refuses its ordinary messages...
    expect(await f.dispatch("next")).toMatchObject({ action: "reject", message: expect.stringMatching(/OptChat runs on Claude Code only/) });
    // ...and Send now, which skips the gate, still carries the hook: BB's adapter refuses the turn.
    expect(await tools(f, "next")).toEqual(WITH_HOOK);
    // Once added, the same.
    await f.setScope("initiatives", "p", ["coord", "next"]);
    expect(await tools(f, "next")).toEqual(WITH_HOOK);
    f.memory.dispose();
  });

  it("runs a pending Codex coordinator as it is in any other mode, and a Codex thread its owner names no memory for", async () => {
    const f = pending();
    await f.configure("coord", { mode: "hybrid" });
    expect(await tools(f, "next")).toEqual(["memory_read", "memory_zoom"]);
    await f.configure("coord", { mode: "optchat" });
    f.thread("adhoc", { originPluginId: "initiatives", providerId: "codex", metadata: { role: "adhoc" } });
    expect(await tools(f, "adhoc")).toEqual(["memory_read", "memory_zoom"]);
    // A Claude Code coordinator asks in every mode, pending or not.
    f.thread("claude-next", { originPluginId: "initiatives", metadata: { memoryScope: "p" } });
    expect(await tools(f, "claude-next", "claude-code")).toEqual(WITH_HOOK);
    f.memory.dispose();
  });

  it("runs a former Codex coordinator as it is: it left the memory its metadata still names", async () => {
    const f = pending();
    await f.setScope("initiatives", "p", ["coord", "next"]);
    await f.setScope("initiatives", "p", ["coord"]);
    expect(await tools(f, "next")).toEqual(["memory_read", "memory_zoom"]);
    expect(await f.dispatch("next")).toEqual({ action: "proceed" });
    f.memory.dispose();
  });

  it("refuses a pending Codex thread when BB does not say which memory it joins", async () => {
    const f = pending();
    const resolved = await f.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "next", title: null, parentThreadId: null, sourceThreadId: null },
        provider: { id: "codex", model: "gpt", capabilities: { supportsNativeUserQuestion: false } },
        origin: { kind: null, pluginId: "initiatives" },
      } as never),
    );
    expect(resolved.tools.map((t) => t.name).sort()).toEqual(WITH_HOOK);
    f.memory.dispose();
  });
});
