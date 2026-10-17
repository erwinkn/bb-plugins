import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MemoryStore } from "../lib/store";
import plugin from "../server";
import { settingsDescriptors } from "../lib/settings";
import { fixture } from "./fixture";

/** R3 (Erwin, 2026-10-17): the mode follows the role, nobody chooses it: coordinators OptChat, every other memory Regular. */
describe("R3 the mode follows the role", () => {
  it("starts a coordinator's memory on OptChat, however its first thread arrives", async () => {
    const f = fixture();
    // Its owner attaches an existing thread, or spawns one carrying memoryScope.
    await f.attach("initiatives", "prj_1", f.thread("adopted"));
    f.thread("spawned", { originPluginId: "initiatives", metadata: { role: "coordinator", memoryScope: "prj_2" } });
    await f.configureAgent("spawned", { origin: "initiatives" });
    for (const id of ["initiatives:prj_1", "initiatives:prj_2"]) {
      expect(f.store.scope(id)!.mode).toBe("optchat");
      expect((await f.memory.status(id)).mode).toBe("optchat");
      expect(f.memory.compactLimit(f.store.scope(id)!)).toBe(0);
    }
    expect(f.store.handle.prepare(`SELECT mode FROM scopes WHERE id = 'initiatives:prj_1'`).pluck().get()).toBe("optchat");
  });

  it("keeps every other memory Regular: a personal thread's, and any other owner's", async () => {
    const f = fixture();
    f.thread("plain");
    expect(((await f.configure("plain", {})) as { mode: string }).mode).toBe("regular");
    await f.attach("someone-else", "k", f.thread("other"));
    for (const id of ["chat-memory:plain", "someone-else:k"]) expect(f.store.scope(id)!.mode).toBe("regular");
    expect(f.memory.compactLimit(f.store.scope("chat-memory:plain")!)).toBe(300_000);
    // A worker of an Adventure carries no memoryScope: it gets no memory at all.
    f.thread("worker", { originPluginId: "initiatives", metadata: { role: "worker" } });
    expect((await f.configureAgent("worker", { origin: "initiatives" })).tools).toEqual([]);
  });

  it("reads the mode from the owner, never from the stored column, and no RPC writes one", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("coord"));
    f.thread("plain");
    await f.configure("plain", {});
    f.store.handle.prepare(`UPDATE scopes SET mode = 'hybrid' WHERE id = 'initiatives:prj_1'`).run();
    f.store.handle.prepare(`UPDATE scopes SET mode = 'optchat' WHERE id = 'chat-memory:plain'`).run();
    expect(f.store.scope("initiatives:prj_1")!.mode).toBe("optchat");
    expect(f.store.scope("chat-memory:plain")!.mode).toBe("regular");
    for (const thread of ["coord", "plain"])
      for (const mode of ["regular", "hybrid", "optchat"]) await expect(f.configure(thread, { mode })).rejects.toThrow(/rpc input validation failed/);
    expect(f.store.scope("initiatives:prj_1")!.mode).toBe("optchat");
    expect(f.store.scope("chat-memory:plain")!.mode).toBe("regular");
  });

  it("aligns the stored column with the role at every start: existing scopes, and ones an older version created after a rollback", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    const add = db.prepare(`INSERT INTO scopes (id, owner, mode, compact_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`);
    add.run("initiatives:verification", "initiatives", "regular", null);
    add.run("initiatives:solera", "initiatives", "hybrid", 120_000);
    add.run("initiatives:done", "initiatives", "optchat", null);
    add.run("chat-memory:thr_1", "chat-memory", "regular", null);
    add.run("chat-memory:scratch", "chat-memory", "hybrid", 90_000);
    const modes = () => db.prepare(`SELECT id, mode, compact_tokens FROM scopes ORDER BY id`).all();
    const store = new MemoryStore(db);
    store.alignModes();
    const aligned = [
      { id: "chat-memory:scratch", mode: "regular", compact_tokens: 90_000 },
      { id: "chat-memory:thr_1", mode: "regular", compact_tokens: null },
      { id: "initiatives:done", mode: "optchat", compact_tokens: null },
      { id: "initiatives:solera", mode: "optchat", compact_tokens: 120_000 },
      { id: "initiatives:verification", mode: "optchat", compact_tokens: null },
    ];
    expect(modes()).toEqual(aligned);
    // Idempotent; the store reads the same modes.
    store.alignModes();
    expect(modes()).toEqual(aligned);
    expect(store.scope("initiatives:verification")!.mode).toBe("optchat");
    expect(store.scope("chat-memory:scratch")!.mode).toBe("regular");
    // Rolled back to the old code, which created a coordinator's scope on Regular; upgraded again.
    add.run("initiatives:new", "initiatives", "regular", null);
    store.alignModes();
    expect(db.prepare(`SELECT mode FROM scopes WHERE id = 'initiatives:new'`).pluck().get()).toBe("optchat");
  });

  it("aligns the columns when the plugin starts", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("coord"));
    f.store.handle.prepare(`UPDATE scopes SET mode = 'regular'`).run();
    let started: ReturnType<typeof plugin> | undefined;
    await f.harness.lifecycle.reload((bb) => void (started = plugin(bb)));
    expect(started!.store.handle.prepare(`SELECT mode FROM scopes`).pluck().get()).toBe("optchat");
  });

  it("shows no compaction problem on a converted coordinator, and the sweep skips it", async () => {
    const f = fixture();
    await f.attach("initiatives", "prj_1", f.thread("coord", { title: "Coordinator" }));
    await f.attach("chat-memory", "t", f.thread("plain", { title: "Plain" }));
    f.store.handle.prepare(`UPDATE threads SET compact_error = '503', compact_tries = 1`).run();
    expect((await f.memory.status("initiatives:prj_1")).problems).toEqual([]);
    expect((await f.memory.status("chat-memory:t")).problems).toEqual([expect.stringMatching(/Compacting "Plain" failed: 503/)]);
    expect(f.store.compactFailures(3)).toEqual(["plain"]);
  });

  it("offers no Hybrid setting", () => {
    expect(Object.keys(settingsDescriptors)).toEqual(["regularCompactTokens", "summarizerEffort", "summarizerConcurrency"]);
  });
});
