import { describe, expect, it } from "vitest";
import { TURN_CONTEXT_TOOL } from "../lib/memory";
import { fixture, type Fixture } from "./fixture";

/**
 * T149 (D446, D447, D482, D483, D491): an Initiative's coordinator and its discussions share one
 * memory, the scope "initiatives:<id>". Initiatives spawns each with {memoryScope: <id>} and its
 * workers with no key; this plugin attaches what that key names, once, and nothing else decides who
 * is in the memory. BB's archive state only changes what the threads do, never their attachment.
 */
const P = "initiatives:prj_1";
const tools = async (f: Fixture, threadId: string) => (await f.configureAgent(threadId, { origin: "initiatives" })).tools.map((t) => t.name).sort();
const threadsOf = async (f: Fixture) => (await f.memory.status(P)).threads.map((t) => t.threadId);

/** A coordinator, a discussion and a worker of Initiative prj_1, each configured once as BB would. */
async function initiative() {
  const f = fixture();
  f.thread("coord", { originPluginId: "initiatives", metadata: { role: "coordinator", memoryScope: "prj_1" } });
  f.thread("disc", { originPluginId: "initiatives", title: "Discussion 1", metadata: { role: "discussion", memoryScope: "prj_1" } });
  f.thread("worker", { originPluginId: "initiatives", metadata: { role: "worker", projectId: "prj_1" } });
  for (const id of ["coord", "disc", "worker"]) await tools(f, id);
  return f;
}

describe("T149 the coordinator and its discussions share the Initiative's memory", () => {
  it("attaches the coordinator and the discussion, never the worker; each logs into one memory", async () => {
    const f = await initiative();
    expect(await threadsOf(f)).toEqual(["coord", "disc"]);
    expect(await tools(f, "worker")).toEqual([]);
    expect(f.store.thread("worker")).toBeNull();
    f.turn("disc", "Keep the 5m TTL");
    await f.idle("disc");
    f.turn("worker", "implementation chatter");
    await f.idle("worker");
    f.turn("coord", "Noted the TTL");
    await f.idle("coord");
    expect(f.log(P)).toEqual(["user: Keep the 5m TTL", "agent: re: Keep the 5m TTL", "user: Noted the TTL", "agent: re: Noted the TTL"]);
  });

  it("one mode for all of them, switched from any of their Memory panels, from each one's next turn", async () => {
    const f = await initiative();
    await f.configure("disc", { mode: "optchat" });
    expect(f.store.scope(P)!.mode).toBe("optchat");
    for (const id of ["coord", "disc"]) expect(await tools(f, id)).toContain(TURN_CONTEXT_TOOL);
    await f.configure("coord", { mode: "hybrid" });
    for (const id of ["coord", "disc"]) expect(await tools(f, id)).toEqual(["memory_read", "memory_zoom"]);
    expect(await tools(f, "worker")).toEqual([]);
  });

  it("keeps an archived discussion in the memory; restored, its next turn is logged there", async () => {
    const f = await initiative();
    f.turn("disc", "before the archive");
    await f.archived("disc");
    expect(await threadsOf(f)).toEqual(["coord", "disc"]);
    expect(f.log(P)).toHaveLength(2);
    // BB restores it: nothing to tell anyone.
    f.threads.get("disc")!.archived = false;
    f.turn("disc", "after the restore");
    await f.idle("disc");
    expect(f.log(P).slice(2)).toEqual(["user: after the restore", "agent: re: after the restore"]);
  });

  it("forgets a discussion BB deleted; what it said stays in the memory", async () => {
    const f = await initiative();
    f.turn("disc", "a thought");
    await f.idle("disc");
    f.threads.delete("disc");
    await f.memory.sweep(true);
    expect(await threadsOf(f)).toEqual(["coord"]);
    expect(f.log(P)).toHaveLength(2);
  });

  it("attaching and detaching is one swap of the thread's row (D491): before stays, after goes to the new memory", async () => {
    const f = await initiative();
    f.turn("disc", "for prj_1");
    await f.idle("disc");
    const cursor = f.store.thread("disc")!.cursor;
    expect(await f.attach("initiatives", "prj_2", "disc")).toBe("initiatives:prj_2");
    expect(f.store.thread("disc")).toMatchObject({ scope: "initiatives:prj_2", cursor });
    f.turn("disc", "for prj_2");
    await f.idle("disc");
    f.memory.attach("disc", null);
    f.turn("disc", "for none");
    await f.idle("disc");
    expect(f.log(P)).toEqual(["user: for prj_1", "agent: re: for prj_1"]);
    expect(f.log("initiatives:prj_2")).toEqual(["user: for prj_2", "agent: re: for prj_2"]);
    expect(f.store.thread("disc")!.scope).toBeNull();
    // Its spawn key never attaches it again: the swap stands.
    expect(await tools(f, "disc")).toEqual([]);
  });
});
